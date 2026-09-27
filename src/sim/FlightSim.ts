// Headless flight simulation core (no DOM / rendering). OWNER: sim.
// Fixed-step 6-DOF dynamics of every free vehicle in the rotating W frame, closed-loop GNC for the
// ascent, S2 (PEG) and booster recovery, droneship motion, events, callouts and predictions.
// The real-time wrapper (Simulation.ts) owns warp / pause / interpolation / history.

import { Vector3, Quaternion } from 'three';
import type { Settings } from '../core/settings';
import type { BodyId, BodyState, S1Phase, SimEvent, SimEventType, TimelineMarker } from '../core/types';
import {
  COUNTDOWN_START, EARTH_RADIUS, G0, LAUNCH_AZIMUTH_DEG, PAD_ELEVATION,
} from '../core/constants';
import { F9, OCISLY } from '../core/vehicleSpec';
import { padHeadingDir } from '../core/frames';
import { RigidBody } from './rigidbody';
import { atmosphere, makeAtmo, type AtmoSample } from './atmosphere';
import { WindModel, type GustState } from './wind';
import { SHAPES, computeAero, makeAeroOut, type AeroOut } from './aero';
import { EngineSet } from './engines';
import { AttitudeCtrl, GridFins, Rcs, allocateGimbal, type CtrlGains } from './control';
import { combine, fairingMassProps, mp, payloadMassProps, s1MassProps, s2MassProps, type MassProps } from './massprops';
import { GNC, M1D, MVAC, PAD_MOUNT_HEIGHT, RCS, SIM_FIGURES } from './simconst';
import { Peg, inertialVel, orbitElements, type OrbitElements } from './guidance/peg';
import {
  FOOT_DROP, entryIgnitionDue, landingStopHeight, makeRolloutOut, rollout,
  landingProfile, LANDING_PROFILE as LP, type LandingProfileOut,
  BOOSTER_S, type RolloutOut,
} from './guidance/predict';
import { ShipModel, makeShipPose, type ShipPose } from './ship';
import { makeBody } from './bodies';
import { CALLOUTS, type CalloutId } from './callouts';
import { quatFromAxisRef } from './control';

export type VehKind = 'STACK' | 'BOOSTER' | 'UPPER' | 'FAIRING' | 'PAYLOAD';

export interface ManualInput {
  /** 0..1 lever: 0 = landing engine off / not lit, > 0 lit (clamped to the 40 % minimum) */
  throttle: number;
  /** −1..1 in the SHIP/deck frame: pitch+ pushes the booster toward ship +Z (bow), yaw+ toward ship +X */
  pitch: number;
  yaw: number;
}

interface Member { id: BodyId; offY: number }

const D2R = Math.PI / 180;
const ALL_IDS: BodyId[] = ['S1', 'S2', 'FAIRING_A', 'FAIRING_B', 'PAYLOAD', 'SHIP'];
const S2_MOUNT = F9.s2.mountY;
const FAIRING_BASE = F9.fairing.baseY;

// ---- controller gain sets ----
const G_ASCENT: CtrlGains = { kp: 1.2, kr: 4, wMax: 3 * D2R, wMaxRoll: 2 * D2R, aMax: new Vector3(), ff: 0.9 };
const G_TVC: CtrlGains = { kp: 1.3, kr: 5, wMax: 6 * D2R, wMaxRoll: 4 * D2R, aMax: new Vector3(), ff: 0.8 };
const G_LAND: CtrlGains = { kp: 1.2, kr: 5, wMax: 8 * D2R, wMaxRoll: 4 * D2R, aMax: new Vector3(), ff: 0.8 };
const G_FINS: CtrlGains = { kp: 1.6, kr: 4.5, wMax: 9 * D2R, wMaxRoll: 6 * D2R, aMax: new Vector3(), ff: 0.7 };
const G_RCS: CtrlGains = { kp: 0.5, kr: 3, wMax: GNC.flipRateDeg * D2R, wMaxRoll: 2 * D2R, aMax: new Vector3(), ff: 0 };
const G_HOLD: CtrlGains = { kp: 0.35, kr: 3, wMax: 1.5 * D2R, wMaxRoll: 1 * D2R, aMax: new Vector3(), ff: 0 };
const MASK_ALL = { x: true, y: true, z: true };
const MASK_ROLL = { x: false, y: true, z: false };
const MASK_NONE = { x: false, y: false, z: false };

// scratch
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _lgN = new Vector3();
const _lgV = new Vector3();
const _lgH = new Vector3();
const _lgA = new Vector3();
const _lgL = new Vector3();
const _lgE = new Vector3();
const _lgU = new Vector3();
const _q1 = new Quaternion();
const _slU = new Vector3();
const _slW = new Vector3();
const _slAero = makeAeroOut();
const _up = new Vector3();
const _mp = mp();
const _mpc = mp();
const _achG = new Vector3();
const _achF = new Vector3();
const _tauRem = new Vector3();

function upOf(p: Vector3, out: Vector3): Vector3 {
  return out.set(p.x, p.y + EARTH_RADIUS, p.z).normalize();
}
function altOf(p: Vector3): number {
  const y = p.y + EARTH_RADIUS;
  return Math.sqrt(p.x * p.x + y * y + p.z * p.z) - EARTH_RADIUS;
}
/** reference Earth-relative flight-path elevation (deg) at Earth-relative speed V (GNC.gammaProfile) */
function gammaRef(V: number): number {
  return 90 - (90 - interpTable(GNC.gammaProfile, V)) * GNC.gammaScale;
}
function interpTable(tab: [number, number][], x: number): number {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tab[tab.length - 1][1];
}
function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

export class Vehicle {
  readonly rb = new RigidBody();
  engines: EngineSet | null = null;
  fins: GridFins | null = null;
  rcs: Rcs | null = null;
  readonly ctrl = new AttitudeCtrl();
  gust: GustState;
  alive = true;
  clamped = false;
  // environment cache
  alt = 0;
  readonly atmo: AtmoSample = makeAtmo();
  readonly wind = new Vector3();
  readonly vAir = new Vector3();
  readonly uBody = new Vector3();
  readonly aero: AeroOut = makeAeroOut();
  readonly origin = new Vector3();
  // attitude command
  readonly axis = new Vector3(0, 1, 0);
  readonly rollRef = new Vector3(0, 0, 1);
  useRoll = false;
  gains: CtrlGains = G_HOLD;
  useGimbal = false;
  useFins = false;
  rcsMask: { x: boolean; y: boolean; z: boolean } = MASK_NONE;
  rcsDb = 0.2 * D2R;
  heat = 0;
  /** coarse steps allowed (passive, vacuum / parafoil / landed) */
  passive = false;
  kinematic = false;
  goneAt = Infinity;
  /** set by guidance when it moved the body kinematically this step (parafoil glide) */
  skipDyn = false;
  /** destroyed: no guidance, ballistic debris until goneAt */
  wrecked = false;

  constructor(readonly kind: VehKind, public members: Member[], public shape: string, gust: GustState) {
    this.gust = gust;
  }
  get root(): BodyId {
    return this.members[0].id;
  }
  has(id: BodyId): boolean {
    for (const m of this.members) if (m.id === id) return true;
    return false;
  }
}

export interface Touchdown {
  t: number;
  outcome: 'success' | 'hard' | 'tipped' | 'offdeck';
  vVert: number;
  vHor: number;
  tiltDeg: number;
  miss: number;
  prop: number;
}

interface Scheduled { t: number; id: CalloutId }

export interface FlightOptions {
  presim?: boolean;
  /** ship station (sea-level point, W); null => no droneship (pre-sim) */
  station?: Vector3 | null;
  /** nominal event times from the pre-sim (timeline) */
  nominal?: Partial<Record<SimEventType, number>> | null;
  startT?: number;
}

const COUNTDOWN_SCRIPT: { t: number; id: CalloutId }[] = [
  { t: -59.6, id: 'lc_startup' },
  { t: -56, id: 'host_welcome' },
  { t: -45, id: 'lc_go_for_launch' },
  { t: -40.5, id: 'host_ship_ready' },
  { t: -30, id: 'host_t30' },
  { t: -15, id: 'lc_t15' },
  { t: -10, id: 'lc_10' }, { t: -9, id: 'lc_9' }, { t: -8, id: 'lc_8' }, { t: -7, id: 'lc_7' },
  { t: -6, id: 'lc_6' }, { t: -5, id: 'lc_5' }, { t: -4, id: 'lc_4' },
  { t: -3, id: 'lc_ignition' }, { t: -1.9, id: 'lc_2' }, { t: -0.95, id: 'lc_1' }, { t: 0, id: 'lc_0' },
];

const IGNITION_ORDER: { dt: number; k: number[] }[] = [
  { dt: 0, k: [0] }, { dt: 0.12, k: [1, 5] }, { dt: 0.24, k: [3, 7] }, { dt: 0.36, k: [2, 6] }, { dt: 0.48, k: [4, 8] },
];

export class FlightSim {
  t: number;
  envT = 0;
  held = false;
  aborted = false;
  recyclePending = false;
  private abortT = 0;
  seeking = false;
  readonly presim: boolean;
  readonly bodies: Record<BodyId, BodyState>;
  vehicles: Vehicle[] = [];
  readonly wind: WindModel;
  ship: ShipModel | null = null;
  readonly shipPose: ShipPose = makeShipPose();
  private shipPoseT = NaN;
  readonly timeline: TimelineMarker[] = [];
  readonly nominal: Partial<Record<SimEventType, number>>;
  readonly eventTimes: Partial<Record<SimEventType, number>> = {};
  manual: ManualInput = { throttle: 0, pitch: 0, yaw: 0 };
  settings: Settings;

  // propellant (kg)
  s1Prop: number = SIM_FIGURES.s1Prop;
  s2Prop: number = SIM_FIGURES.s2Prop;
  readonly s1Eng: EngineSet;
  readonly s2Eng: EngineSet;
  readonly fins: GridFins;
  readonly s1Rcs: Rcs;
  readonly s2Rcs: Rcs;
  legs = 0;
  legsCmd = false;

  // sequencing
  private scriptIdx = 0;
  private scheduled: Scheduled[] = [];
  ignited = false;
  private ignT = NaN;
  released = false;
  private towerCleared = false;
  private s1NominalSaid = false;
  private supersonic = false;
  qPeak = 0;
  tPeak = 0;
  maxQDone = false;
  private bucket: 'pre' | 'down' | 'done' = 'pre';
  mecoT = NaN;
  mecoState: { alt: number; speedI: number; speed: number; prop: number; fpaDeg: number } | null = null;
  sepT = NaN;
  private sepDue = NaN;
  private sesDue = NaN;
  sesT = NaN;
  manualStaging = false;
  fairingSepT = NaN;
  fairingSepQ = 0;
  fairingSepHeat = 0;
  manualFairing = false;
  autoFairing = true;
  payloadDamaged = false;
  secoT = NaN;
  orbit: OrbitElements | null = null;
  s2InOrbit = false;
  s2Failed = false;
  s2FailReason = '';
  deployT = NaN;
  private deployDue = NaN;
  missionEnded = false;
  private s2SaidNominal = false;
  readonly peg = new Peg(GNC.insertAlt, GNC.targetAlt);
  private pegNextUpd = 0;
  private s2HoldAxis = new Vector3();
  private readonly launchPlaneN = new Vector3();
  private readonly headingDir = new Vector3();

  // booster recovery
  bPhase: S1Phase = 'PRELAUNCH';
  private flipT = NaN;
  private finsT = NaN;
  apogeeT = NaN;
  entryStartT = NaN;
  entryEndT = NaN;
  /** booster altitude at entry-burn ignition (m) */
  entryAlt = NaN;
  entryDone = false;
  landingStartT = NaN;
  private landingEngines: number[] = [0];
  private aeroT = NaN;
  private boostDecided = false;
  boostStartT = NaN;
  boostEndT = NaN;
  private boostLit = false;
  private readonly pred: RolloutOut = makeRolloutOut();
  private readonly pred2: RolloutOut = makeRolloutOut();
  predValid = false;
  private predNext = 0;
  private readonly ipErr = new Vector3();
  private readonly fairingDrogue: Partial<Record<BodyId, boolean>> = {};
  private ipErrValid = false;
  private readonly latCmd = new Vector3();
  private aoaK = 0;
  private readonly lgProf: LandingProfileOut = { aReq: 0, finalSeg: false, w: 0 };
  private readonly lgAxis = new Vector3();
  private lgAxisT = -1;
  private claEst = 0.5;
  private readonly latDir = new Vector3();
  private lastBoosterMach = 0;
  sonicBoomT = NaN;
  touchdown: Touchdown | null = null;
  boosterFate = '';
  boosterMaxHeat = 0;
  private readonly landedRelPos = new Vector3();
  private readonly landedRelQuat = new Quaternion();
  private tip: { axis: Vector3; theta: number; rate: number; pivot: Vector3; q0: Quaternion; relPivot: Vector3; done: boolean } | null = null;
  private manualStarts = 0;
  private readonly lastLandingInfo = { burnStartT: NaN, touchdownT: NaN, miss: NaN, impact: new Vector3(), valid: false };
  private flameoutS1 = false;
  private overheatTimer = 0;
  private heatLimitH = 1.1;

  constructor(settings: Settings, private emitFn: (e: SimEvent) => void, opts: FlightOptions = {}) {
    this.settings = { ...settings };
    this.presim = !!opts.presim;
    this.nominal = opts.nominal ?? {};
    this.t = opts.startT ?? COUNTDOWN_START;
    const bodies = {} as Record<BodyId, BodyState>;
    for (const id of ALL_IDS) bodies[id] = makeBody(id);
    this.bodies = bodies;
    this.wind = new WindModel(settings.windSpeed, settings.windFromDeg);
    // the pre-sim flies the day-of-launch mean winds (no gusts): the droneship is stationed where the
    // booster naturally comes down in today's winds
    if (this.presim) this.wind.gusts = false;
    this.s1Eng = new EngineSet(M1D, bodies.S1.engines, F9.s1.engineRingRadius, F9.s1.engineAngleDeg);
    this.s2Eng = new EngineSet(MVAC, bodies.S2.engines, 0, () => 0);
    this.fins = new GridFins(bodies.S1.gridFins!.angles);
    this.s1Rcs = new Rcs(bodies.S1.rcs, F9.s1.rcs.podY, F9.radius + 0.1, RCS.s1Thrust);
    this.s2Rcs = new Rcs(bodies.S2.rcs, RCS.s2PodY, 1.9, RCS.s2Thrust);
    if (opts.station) {
      this.ship = new ShipModel(opts.station, settings.seaState, settings.windFromDeg);
    }
    padHeadingDir(LAUNCH_AZIMUTH_DEG, this.headingDir);
    this.launchPlaneN.crossVectors(new Vector3(0, 1, 0), this.headingDir).normalize();
    this.initStack();
    this.buildTimeline();
    // skip script entries already in the past
    while (this.scriptIdx < COUNTDOWN_SCRIPT.length && COUNTDOWN_SCRIPT[this.scriptIdx].t < this.t - 0.5) this.scriptIdx++;
    this.publish();
  }

  // =============================================================================================
  // setup

  private initStack(): void {
    const members: Member[] = [
      { id: 'S1', offY: 0 },
      { id: 'S2', offY: S2_MOUNT },
      { id: 'FAIRING_A', offY: S2_MOUNT + FAIRING_BASE },
      { id: 'FAIRING_B', offY: S2_MOUNT + FAIRING_BASE },
      { id: 'PAYLOAD', offY: S2_MOUNT + F9.payload.baseY },
    ];
    const v = new Vehicle('STACK', members, 'stack', this.wind.makeGust(1));
    v.engines = this.s1Eng;
    v.rcs = this.s1Rcs;
    v.clamped = true;
    const rb = v.rb;
    quatFromAxisRef(_v1.set(0, 1, 0), this.headingDir, rb.quat);
    this.updateMass(v);
    rb.setOrigin(_v2.set(0, PAD_ELEVATION + PAD_MOUNT_HEIGHT, 0));
    rb.vel.set(0, 0, 0);
    this.vehicles.push(v);
    for (const id of ['S1', 'S2', 'FAIRING_A', 'FAIRING_B', 'PAYLOAD'] as BodyId[]) this.bodies[id].status = 'stacked';
    this.bodies.S1.phase = 'PRELAUNCH';
  }

  private buildTimeline(): void {
    const N = this.nominal;
    const m = (type: SimEventType, label: string, dflt: number): TimelineMarker => ({ type, label, t: N[type] ?? dflt, done: false });
    this.timeline.push(
      m('LIFTOFF', 'LIFTOFF', 0), m('MAX_Q', 'MAX-Q', 72), m('MECO', 'MECO', 147), m('STAGE_SEP', 'STAGE SEP', 150),
      m('SES1', 'SES-1', 157), m('FAIRING_SEP', 'FAIRING', 187), m('ENTRY_BURN_START', 'ENTRY BURN', 381),
      m('LANDING_BURN_START', 'LANDING BURN', 483), m('TOUCHDOWN', 'LANDING', 508), m('SECO', 'SECO', 525),
      m('PAYLOAD_DEPLOY', 'DEPLOY', 932),
    );
  }

  // =============================================================================================
  // events

  private ev(type: SimEventType, body?: BodyId, data?: Record<string, unknown>, t = this.t): void {
    this.eventTimes[type] ??= t;
    for (const mk of this.timeline) if (mk.type === type && !mk.done) { mk.done = true; mk.t = t; }
    const e: SimEvent = { type, t, body, data };
    if (this.seeking) e.seeking = true;
    this.emitFn(e);
  }

  say(id: CalloutId, delay = 0): void {
    if (this.presim) return;
    if (delay > 0) { this.scheduled.push({ t: this.t + delay, id }); return; }
    if (this.seeking) return;
    const c = CALLOUTS[id];
    const e: SimEvent = { type: 'CALLOUT', t: this.t, data: { id, text: c.text, voice: c.voice } };
    this.emitFn(e);
  }

  private cancel(type: SimEventType): void {
    for (const mk of this.timeline) if (mk.type === type && !mk.done) mk.cancelled = true;
  }

  // =============================================================================================
  // public commands

  toggleHold(): void {
    if (this.released) return;
    if (!this.ignited) {
      this.held = !this.held;
      if (this.held) {
        this.ev('COUNTDOWN_HOLD');
        this.say('lc_hold');
        this.say('lc_holding', 2.2);
      } else {
        this.ev('COUNTDOWN_RESUME');
        this.say('lc_resume');
      }
      return;
    }
    if (!this.aborted) {
      // hold after ignition = abort: engines shut down, recycle to T-60
      this.aborted = true;
      this.abortT = this.envT;
      this.s1Eng.command('none', this.t);
      this.ev('COUNTDOWN_HOLD', 'S1', { abort: true });
      this.say('lc_abort');
    }
  }

  liftoffNow(): void {
    if (this.ignited || this.aborted) return;
    if (this.held) { this.held = false; this.ev('COUNTDOWN_RESUME'); }
    if (this.t < -3.05) {
      this.t = -3.05;
      while (this.scriptIdx < COUNTDOWN_SCRIPT.length && COUNTDOWN_SCRIPT[this.scriptIdx].t < this.t) this.scriptIdx++;
      this.scheduled = this.scheduled.filter((s) => s.t >= this.t);
    }
  }

  stageSeparation(): void {
    if (!this.released || !Number.isNaN(this.sepT) || !Number.isNaN(this.sepDue)) return;
    const stack = this.find('STACK');
    if (!stack) return;
    this.manualStaging = true;
    this.say('lc_manual_staging');
    if (Number.isNaN(this.mecoT)) this.doMeco(true);
    this.sepDue = this.t + GNC.manualSepDelay;
  }

  fairingSeparation(): void {
    if (!this.released || !Number.isNaN(this.fairingSepT)) return;
    this.manualFairing = true;
    this.say('lc_manual_fairing');
    this.separateFairing();
  }

  /** seek helper: jump the quiet countdown forward to mission time t (≤ −3.5) */
  liftoffNowSeek(t: number): void {
    if (this.ignited || t <= this.t) return;
    this.envT += t - this.t;
    this.t = t;
    this.held = false;
    while (this.scriptIdx < COUNTDOWN_SCRIPT.length && COUNTDOWN_SCRIPT[this.scriptIdx].t < this.t) this.scriptIdx++;
  }

  /** drop delayed callouts that are already in the past (after a seek) */
  dropStaleCallouts(): void {
    this.scheduled = this.scheduled.filter((s) => s.t >= this.t - 0.5);
  }

  setAutoFairing(on: boolean): void {
    this.autoFairing = on;
  }

  setManualInput(i: ManualInput): void {
    this.manual.throttle = clamp(i.throttle, 0, 1);
    this.manual.pitch = clamp(i.pitch, -1, 1);
    this.manual.yaw = clamp(i.yaw, -1, 1);
  }

  applySettings(s: Settings): void {
    const seaChanged = s.seaState !== this.settings.seaState || s.windFromDeg !== this.settings.windFromDeg;
    this.settings = { ...s };
    if (!this.presim) this.wind.set(s.windSpeed, s.windFromDeg);
    if (seaChanged && this.ship) {
      this.ship.setSea(s.seaState, s.windFromDeg);
      this.shipPoseT = NaN;
    }
  }

  find(kind: VehKind, root?: BodyId): Vehicle | null {
    for (const v of this.vehicles) if (v.kind === kind && v.alive && !v.wrecked && (!root || v.root === root)) return v;
    return null;
  }

  vehicleOf(id: BodyId): Vehicle | null {
    for (const v of this.vehicles) if (v.has(id)) return v;
    return null;
  }

  // =============================================================================================
  // time stepping

  /** Largest stable step for the current state. */
  chooseDt(): number {
    if (this.t < -3.5 && !this.ignited) return 0.02;
    for (const v of this.vehicles) {
      if (!v.alive || v.kinematic) continue;
      if (!v.passive) return GNC.dt;
    }
    return GNC.dtCoast;
  }

  step(dt: number): void {
    const frozen = (this.held && !this.ignited) || this.aborted;
    if (!frozen) this.t += dt;
    this.envT += dt;
    this.sequence(dt);
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (!v.alive) continue;
      this.stepVehicle(v, dt);
    }
    // retire gone vehicles
    for (const v of this.vehicles) {
      if (v.alive && this.envT >= v.goneAt) {
        v.alive = false;
        for (const m of v.members) this.bodies[m.id].status = 'gone';
      }
    }
    if (this.vehicles.length > 8) this.vehicles = this.vehicles.filter((v) => v.alive);
    this.checkMissionEnd();
    this.publish();
  }

  // =============================================================================================
  // sequencing (countdown, staging timers, scheduled callouts)

  private sequence(dt: number): void {
    const t = this.t;
    while (this.scriptIdx < COUNTDOWN_SCRIPT.length && COUNTDOWN_SCRIPT[this.scriptIdx].t <= t) {
      const s = COUNTDOWN_SCRIPT[this.scriptIdx++];
      if (!this.aborted) this.say(s.id);
    }
    if (this.scheduled.length) {
      for (let i = this.scheduled.length - 1; i >= 0; i--) {
        if (this.scheduled[i].t <= t) {
          const s = this.scheduled.splice(i, 1)[0];
          this.say(s.id);
        }
      }
    }
    if (this.aborted) {
      if (this.envT - this.abortT > 8 && !this.recyclePending) {
        this.recyclePending = true;
        this.say('lc_recycle');
      }
      return;
    }
    // ignition sequence
    if (!this.ignited && t >= -3) {
      this.ignited = true;
      this.ignT = t;
      this.ev('IGNITION_SEQUENCE', 'S1');
    }
    if (this.ignited && !this.released) {
      for (const g of IGNITION_ORDER) if (t - this.ignT >= g.dt) for (const k of g.k) this.s1Eng.start(k, this.ignT + g.dt);
      this.s1Eng.cmdThrottle = 1;
      if (t >= 0) {
        let ok = true;
        for (const e of this.bodies.S1.engines) if (e.spool < 0.95) ok = false;
        if (ok) this.release();
      }
    }
    // staging timers
    if (!Number.isNaN(this.sepDue) && t >= this.sepDue) {
      this.sepDue = NaN;
      this.separateStages();
    }
    if (!Number.isNaN(this.sesDue) && t >= this.sesDue) {
      this.sesDue = NaN;
      this.startS2();
    }
    if (!Number.isNaN(this.deployDue) && t >= this.deployDue) {
      this.deployDue = NaN;
      this.deployPayload();
    }
  }

  private release(): void {
    const v = this.find('STACK');
    if (!v) return;
    v.clamped = false;
    this.released = true;
    this.t = 0;
    this.bPhase = 'ASCENT';
    this.bodies.S1.phase = 'ASCENT';
    this.ev('LIFTOFF', 'S1');
    this.say('lc_liftoff', 0.4);
    this.say('host_liftoff', 1.8);
  }

  // =============================================================================================
  // per-vehicle step

  private updateMass(v: Vehicle): void {
    const acc = _mp;
    acc.m = 0; acc.cx = acc.cy = acc.cz = 0; acc.Ixx = acc.Iyy = acc.Izz = 0;
    for (const m of v.members) {
      let c: MassProps;
      switch (m.id) {
        case 'S1': c = s1MassProps(this.s1Prop, _mpc); break;
        case 'S2': c = s2MassProps(this.s2Prop, _mpc); break;
        case 'FAIRING_A': c = fairingMassProps(1, _mpc); break;
        case 'FAIRING_B': c = fairingMassProps(-1, _mpc); break;
        case 'PAYLOAD': c = payloadMassProps(_mpc); break;
        default: continue;
      }
      combine(acc, c, m.offY);
    }
    v.rb.setMassProps(acc.m, acc.cx, acc.cy, acc.cz, acc.Ixx, acc.Iyy, acc.Izz);
  }

  private stepVehicle(v: Vehicle, dt: number): void {
    const rb = v.rb;
    if (v.kinematic) {
      if (v.kind === 'BOOSTER') this.stepLandedBooster(v, dt);
      return;
    }
    this.updateMass(v);
    // ---- environment ----
    rb.origin(v.origin);
    const h = altOf(rb.pos);
    v.alt = h;
    atmosphere(h, v.atmo);
    const V0 = v.vAir.length();
    this.wind.sample(rb.pos, h, V0, dt, v.gust, v.wind);
    v.vAir.copy(rb.vel).sub(v.wind);
    _q1.copy(rb.quat).invert();
    v.uBody.copy(v.vAir).applyQuaternion(_q1);
    const finDeploy = v.kind === 'BOOSTER' ? this.fins.deploy : 0;
    let retro = 0;
    if (v.engines && v.engines.totalThrust > 0) {
      const qS = 0.5 * v.atmo.rho * V0 * V0 * 10.5;
      retro = Math.min(1, v.engines.totalThrust / Math.max(1, qS * 3));
    }
    computeAero(SHAPES[v.shape], { finDeploy, retro, legs: v.kind === 'BOOSTER' ? this.legs : 0 }, v.uBody, v.atmo.rho, v.atmo.a, rb.cg, rb.angVel, v.aero);

    // ---- guidance ----
    v.useGimbal = false; v.useFins = false; v.rcsMask = MASK_NONE;
    if (v.wrecked) {
      rb.clearForces();
      rb.addBodyForceTorque(v.aero.F, v.aero.T);
      rb.integrate(dt);
      rb.angVel.multiplyScalar(Math.exp(-dt * 0.2));
      rb.origin(v.origin);
      return;
    }
    switch (v.kind) {
      case 'STACK': this.gncStack(v, dt); break;
      case 'BOOSTER': this.gncBooster(v, dt); break;
      case 'UPPER': this.gncUpper(v, dt); break;
      case 'FAIRING': this.gncFairing(v, dt); break;
      case 'PAYLOAD': v.passive = true; break;
    }
    if (!v.alive || v.kinematic) return;
    if (v.skipDyn) {
      v.skipDyn = false;
      rb.origin(v.origin);
      return;
    }

    // ---- control ----
    this.control(v, dt);

    // ---- propulsion ----
    let mdot = 0;
    if (v.engines) {
      const prop = v.engines === this.s1Eng ? this.s1Prop : this.s2Prop;
      v.engines.step(dt, v.atmo.p, rb.cg, prop);
      mdot = v.engines.mdot;
      if (v.engines.flameout) this.onFlameout(v);
    }

    // ---- forces ----
    rb.clearForces();
    rb.addBodyForceTorque(v.aero.F, v.aero.T);
    if (v.engines && v.engines.totalThrust > 0) rb.addBodyForceTorque(v.engines.force, v.engines.torque);
    if (v.kind === 'BOOSTER') {
      this.fins.step(dt);
      this.fins.apply(rb, v.aero.q, v.aero.mach, v.aero.flowSign);
    }
    if (v.rcs) v.rcs.apply(rb, dt);
    if (v.clamped) {
      rb.vel.set(0, 0, 0);
      rb.angVel.set(0, 0, 0);
      rb.aNG.copy(upOf(rb.pos, _up)).multiplyScalar(9.81);
    } else {
      rb.integrate(dt);
    }
    if (mdot > 0) {
      if (v.engines === this.s1Eng) this.s1Prop = Math.max(0, this.s1Prop - mdot * dt);
      else this.s2Prop = Math.max(0, this.s2Prop - mdot * dt);
    }
    // legs animation
    if (v.kind === 'BOOSTER' && this.legsCmd) this.legs = Math.min(1, this.legs + dt / GNC.legsDeployTime);
    this.postChecks(v, dt);
  }

  // =============================================================================================
  // actuators

  private control(v: Vehicle, dt: number): void {
    const rb = v.rb;
    const g = v.gains;
    // actuator capability for braking curves
    if (v.useGimbal && v.engines) {
      const L = rb.cg.y - v.engines.spec.pivotY;
      const F = Math.max(v.engines.totalThrust, 1);
      const a = (F * L * Math.sin(v.engines.spec.gimbalLimit)) / rb.inertia.x;
      g.aMax.set(a, a * 0.3, a);
    } else if (v.useFins) {
      const a = Math.max(1e-4, this.fins.authority / rb.inertia.x);
      g.aMax.set(a, a * 0.5, a);
      if (v.rcs && v.rcsMask !== MASK_NONE) {
        v.rcs.updateAMax(rb);
        g.aMax.x += v.rcs.aMax.x; g.aMax.y += v.rcs.aMax.y; g.aMax.z += v.rcs.aMax.z;
      }
    } else if (v.rcs) {
      v.rcs.updateAMax(rb);
      g.aMax.copy(v.rcs.aMax);
    }
    v.ctrl.update(rb, v.axis, v.useRoll ? v.rollRef : null, g, g.ff > 0 ? v.aero.T : null);
    _tauRem.copy(v.ctrl.tauDes);
    if (v.useGimbal && v.engines) {
      allocateGimbal(v.engines, _tauRem, rb.cg, _achG);
      _tauRem.sub(_achG);
    } else if (v.engines) {
      v.engines.setGimbalAll(0, 0);
    }
    if (v.kind === 'BOOSTER') {
      if (v.useFins) {
        this.fins.allocate(_tauRem, v.aero.q, v.aero.mach, v.aero.flowSign, rb.cg, _achF);
      } else {
        for (let i = 0; i < 4; i++) this.fins.cmd[i] = 0;
      }
    }
    if (v.rcs) {
      if (v.rcsMask === MASK_NONE) v.rcs.off();
      else v.rcs.control(dt, v.ctrl.wDes, rb.angVel, v.rcsMask, v.rcsDb, v.rcsDb * 0.25);
    }
  }

  // =============================================================================================
  // STACK: ascent guidance

  private gncStack(v: Vehicle, dt: number): void {
    const rb = v.rb;
    const t = this.t;
    v.passive = false;
    upOf(rb.pos, _up);
    if (!this.released) {
      v.axis.copy(_up);
      v.useRoll = false;
      v.gains = G_ASCENT;
      return;
    }
    const q = v.aero.q;
    // ---- attitude program ----
    // vertical rise, pitch kick in the launch plane, then closed-loop tracking of a reference
    // flight-path-angle program (Earth-relative velocity) with q-dependent authority + load relief.
    const h = this.launchHorizontal(rb.pos, _v4);
    let el: number;
    if (t < GNC.kickT) el = 90;
    else if (t < GNC.gammaTrackT) {
      const f = clamp((t - GNC.kickT) / GNC.kickDuration, 0, 1);
      el = 90 - GNC.kickAngleDeg * f;
      // blend from the open-loop kick toward the reference program
      const b = clamp((t - GNC.kickT - GNC.kickDuration) / (GNC.gammaTrackT - GNC.kickT - GNC.kickDuration), 0, 1);
      el = el * (1 - b) + gammaRef(rb.vel.length()) * b;
    } else {
      const V = rb.vel.length();
      const gam = Math.asin(clamp(rb.vel.dot(_up) / Math.max(1, V), -1, 1)) / D2R;
      const ref = gammaRef(V);
      const lim = q > 20_000 ? 1.2 : q > 10_000 ? 2.5 : 5;
      el = gam + clamp(GNC.gammaGain * (ref - gam), -lim, lim);
    }
    el = clamp(el, -10, 90) * D2R;
    v.axis.copy(_up).multiplyScalar(Math.sin(el)).addScaledVector(h, Math.cos(el));
    // out-of-plane correction (keep the launch plane)
    const n = this.launchPlaneN;
    if (t > GNC.kickT) {
      const vn = rb.vel.dot(n) / Math.max(50, rb.vel.length());
      const pn = rb.pos.dot(n) / 40_000;
      v.axis.addScaledVector(n, -clamp(vn * 0.5 + pn, -0.02, 0.02));
    }
    // aerodynamic load relief: lean partially into the relative wind at high q
    if (q > 5_000 && v.vAir.lengthSq() > 100) {
      const k = clamp((q - 5_000) / 20_000, 0, 1) * GNC.loadRelief;
      const vd = _v1.copy(v.vAir).normalize();
      const vg = _v2.copy(rb.vel).normalize();
      v.axis.addScaledVector(vd.sub(vg), k);
    }
    v.axis.normalize();
    v.rollRef.crossVectors(this.launchPlaneN, v.axis);
    v.useRoll = true;
    v.gains = G_ASCENT;
    v.useGimbal = true;

    // ---- throttle (bucket through max-Q) ----
    if (Number.isNaN(this.mecoT)) {
      // throttle bucket through the transonic / max-Q region: pre-planned throttle profile
      // (GNC.throttleProfile, mission time → throttle) plus a dynamic-pressure limiter as a safety
      // net for off-nominal trajectories (thr ≤ 1 − gain·(q − bucketQ)/bucketQ, floor bucketThrottle)
      let thr = interpTable(GNC.throttleProfile, t);
      if (t > 20) thr = Math.min(thr, clamp(1 - GNC.bucketGain * (q - GNC.bucketQ) / GNC.bucketQ, GNC.bucketThrottle, 1));
      if (this.bucket === 'pre' && thr < 0.97) {
        this.bucket = 'down';
        this.ev('THROTTLE_DOWN', 'S1', { q });
        this.say('lc_throttle_down');
      } else if (this.bucket === 'down' && thr >= 0.999) {
        this.bucket = 'done';
        this.ev('THROTTLE_UP', 'S1', { q });
        this.say('lc_throttle_up');
      }
      this.s1Eng.cmdThrottle = thr;
      // ---- MECO ----
      if (this.s1Prop <= GNC.mecoReserve) this.doMeco(false);
    }
    // ---- events ----
    if (!this.towerCleared && v.origin.y > PAD_ELEVATION + GNC.towerClearAlt) {
      this.towerCleared = true;
      this.say('lc_cleared_tower');
    }
    if (!this.s1NominalSaid && t > 22) {
      this.s1NominalSaid = true;
      this.say('lc_s1_nominal');
    }
    if (!this.supersonic && v.aero.mach >= 1) {
      this.supersonic = true;
      this.ev('SUPERSONIC', 'S1', { alt: v.alt });
      this.say('lc_supersonic');
    }
    if (!this.maxQDone) {
      if (q > this.qPeak) { this.qPeak = q; this.tPeak = t; }
      else if (v.aero.mach > 1.1 && q < this.qPeak * 0.9) {
        this.maxQDone = true;
        this.ev('MAX_Q', 'S1', { q: this.qPeak, alt: v.alt, mach: v.aero.mach }, this.tPeak);
        this.say('lc_maxq');
        this.say('host_maxq', 2.5);
      }
    }
  }

  /** unit horizontal direction of the launch plane at p (downrange) */
  private launchHorizontal(p: Vector3, out: Vector3): Vector3 {
    upOf(p, _up);
    const n = this.launchPlaneN;
    out.crossVectors(n, _up).normalize();
    // n = up0 × heading, so n × up = heading at the pad
    return out;
  }

  private doMeco(manual: boolean): void {
    this.mecoT = this.t;
    this.s1Eng.command('none', this.t);
    const v = this.find('STACK');
    if (v) {
      const vi = inertialVel(v.rb.pos, v.rb.vel, _v1);
      upOf(v.rb.pos, _up);
      const vr = v.rb.vel.dot(_up);
      this.mecoState = {
        alt: v.alt, speedI: vi.length(), speed: v.rb.vel.length(), prop: this.s1Prop,
        fpaDeg: Math.asin(clamp(vr / Math.max(1, v.rb.vel.length()), -1, 1)) / D2R,
      };
    }
    this.ev('MECO', 'S1', { manual, ...(this.mecoState ?? {}) });
    this.say('lc_meco');
    if (!manual) this.sepDue = this.t + GNC.sepDelay;
  }

  // =============================================================================================
  // separation events

  private separateStages(): void {
    const st = this.find('STACK');
    if (!st) return;
    const rb = st.rb;
    this.sepT = this.t;
    // S1 engines must be off
    this.s1Eng.command('none', this.t);
    const upper: Member[] = st.members.filter((m) => m.id !== 'S1').map((m) => ({ id: m.id, offY: m.offY - S2_MOUNT }));
    const booster = new Vehicle('BOOSTER', [{ id: 'S1', offY: 0 }], 'booster', this.wind.makeGust(2));
    booster.engines = this.s1Eng;
    booster.rcs = this.s1Rcs;
    const hasFairing = upper.some((m) => m.id === 'FAIRING_A');
    const up = new Vehicle('UPPER', upper, hasFairing ? 'upperFairing' : 'upperBare', this.wind.makeGust(3));
    up.engines = this.s2Eng;
    up.rcs = this.s2Rcs;
    this.spawnFrom(st, booster, 0);
    this.spawnFrom(st, up, S2_MOUNT);
    // pneumatic pushers: ~0.9 m/s relative, momentum conserving along the axis
    const axis = _v1.set(0, 1, 0).applyQuaternion(rb.quat);
    const m1 = booster.rb.mass, m2 = up.rb.mass;
    const dv = 0.9;
    booster.rb.vel.addScaledVector(axis, (-dv * m2) / (m1 + m2));
    up.rb.vel.addScaledVector(axis, (dv * m1) / (m1 + m2));
    st.alive = false;
    this.vehicles = this.vehicles.filter((x) => x !== st);
    this.vehicles.push(booster, up);
    this.bodies.S1.status = 'free';
    this.bodies.S2.status = 'free';
    this.bPhase = 'COAST';
    this.s2HoldAxis.copy(axis);
    this.ev('STAGE_SEP', 'S2', { manual: this.manualStaging, q: st.aero.q, alt: st.alt });
    this.say('lc_stage_sep');
    this.sesDue = this.t + (this.manualStaging ? GNC.manualSesDelay : GNC.sesDelay);
    this.flipT = this.t + GNC.flipDelay;
    this.finsT = this.t + GNC.gridfinDelay;
    this.predNext = this.t + 1;
  }

  /** Initialise child vehicle `c` from parent `p`; c's origin sits at parent-frame y = offY. */
  private spawnFrom(p: Vehicle, c: Vehicle, offY: number, offX = 0): void {
    const prb = p.rb, crb = c.rb;
    crb.quat.copy(prb.quat);
    crb.angVel.copy(prb.angVel);
    this.updateMass(c);
    // origin of child in W
    const o = _v2.set(offX, offY, 0).applyQuaternion(prb.quat).add(p.origin.copy(prb.pos).sub(_v3.copy(prb.cg).applyQuaternion(prb.quat)));
    crb.setOrigin(o);
    // velocity of the child's CG point = parent CG velocity + ω × r
    const r = _v3.copy(crb.pos).sub(prb.pos);
    const wW = _v4.copy(prb.angVel).applyQuaternion(prb.quat);
    crb.vel.crossVectors(wW, r).add(prb.vel);
    c.alt = p.alt;
    c.vAir.copy(p.vAir);
    Object.assign(c.atmo, p.atmo);
    c.origin.copy(o);
  }

  separateFairing(): void {
    if (!Number.isNaN(this.fairingSepT)) return;
    let host: Vehicle | null = this.find('UPPER') ?? this.find('STACK');
    if (!host || !host.has('FAIRING_A')) return;
    const q = host.aero.q;
    const heatFlux = 0.5 * host.atmo.rho * Math.pow(host.vAir.length(), 3);
    this.fairingSepT = this.t;
    this.fairingSepQ = q;
    this.fairingSepHeat = heatFlux;
    const base = host.members.find((m) => m.id === 'FAIRING_A')!.offY;
    host.members = host.members.filter((m) => m.id !== 'FAIRING_A' && m.id !== 'FAIRING_B');
    host.shape = host.kind === 'STACK' ? 'stackBare' : 'upperBare';
    const axisX = _v1.set(1, 0, 0).applyQuaternion(host.rb.quat).clone();
    if (this.presim) {
      this.updateMass(host);
      this.ev('FAIRING_SEP', 'FAIRING_A', { bodies: ['FAIRING_A', 'FAIRING_B'] });
      if (host.kind === 'UPPER') host.alive = false;
      return;
    }
    for (const side of [1, -1] as const) {
      const id: BodyId = side > 0 ? 'FAIRING_A' : 'FAIRING_B';
      const f = new Vehicle('FAIRING', [{ id, offY: 0 }], 'fairingHalf', this.wind.makeGust(side > 0 ? 4 : 5));
      this.spawnFrom(host, f, base);
      f.rb.vel.addScaledVector(axisX, side * 1.6);
      // clamshell opening: rotate the top outward (about body −Z for +X half)
      f.rb.angVel.z += -side * 0.22;
      f.rb.angVel.x += side * 0.03;
      f.passive = false;
      this.vehicles.push(f);
      this.bodies[id].status = 'free';
    }
    this.updateMass(host);
    // payload damage from aerodynamic heating / loads (free-molecular flux limit 1135 W/m²)
    if (heatFlux > 3 * GNC.fairingHeatLimit || q > 1500) {
      this.payloadDamaged = true;
      this.say('host_payload_damaged', 3);
    }
    // one event for the pair (body kept as FAIRING_A for older consumers)
    this.ev('FAIRING_SEP', 'FAIRING_A', { bodies: ['FAIRING_A', 'FAIRING_B'], manual: this.manualFairing, q, heatFlux, damaged: this.payloadDamaged });
    this.say('lc_fairing_sep');
    if (!this.payloadDamaged) this.say('host_fairing', 3.5);
  }

  private deployPayload(): void {
    const up = this.find('UPPER');
    if (!up || !up.has('PAYLOAD')) return;
    if (up.has('FAIRING_A')) {
      this.say('host_fairing_stuck');
      this.s2Failed = true;
      this.s2FailReason = 'fairing did not separate';
      this.cancel('PAYLOAD_DEPLOY');
      return;
    }
    const base = up.members.find((m) => m.id === 'PAYLOAD')!.offY;
    up.members = up.members.filter((m) => m.id !== 'PAYLOAD');
    const p = new Vehicle('PAYLOAD', [{ id: 'PAYLOAD', offY: 0 }], 'payload', this.wind.makeGust(6));
    this.spawnFrom(up, p, base);
    const axis = _v1.set(0, 1, 0).applyQuaternion(up.rb.quat);
    p.rb.vel.addScaledVector(axis, 0.35);
    p.rb.angVel.set(0.004, 0.01, -0.003);
    p.passive = true;
    this.updateMass(up);
    this.vehicles.push(p);
    this.bodies.PAYLOAD.status = 'deployed';
    this.deployT = this.t;
    this.ev('PAYLOAD_DEPLOY', 'PAYLOAD', { damaged: this.payloadDamaged });
    this.say('lc_deploy');
    if (!this.payloadDamaged) this.say('host_deploy', 3.5);
  }

  // =============================================================================================
  // UPPER: second stage

  private startS2(): void {
    const up = this.find('UPPER');
    if (!up) return;
    this.sesT = this.t;
    this.s2Eng.command([0], this.t);
    this.s2Eng.cmdThrottle = 1;
    const vi = inertialVel(up.rb.pos, up.rb.vel, _v1);
    this.peg.initPlane(this.t, up.rb.pos, vi, GNC.targetInclinationDeg);
    this.pegNextUpd = this.t;
    this.ev('SES1', 'S2', { p: up.atmo.p });
    this.say('lc_mvac_ignition');
    this.say('host_s2_burning', 7);
    // destructive flow separation of the niobium extension in dense air
    if (up.atmo.p > MVAC.maxIgnitionPressure) {
      this.s2Eng.command('none', this.t);
      this.s2Failed = true;
      this.s2FailReason = 'MVac nozzle extension failed (ignited in dense air)';
      this.say('lc_mvac_failure', 1.5);
      this.ev('FLAMEOUT', 'S2', { reason: 'nozzle' });
      this.cancel('SECO');
      this.cancel('PAYLOAD_DEPLOY');
    }
  }

  private gncUpper(v: Vehicle, dt: number): void {
    const rb = v.rb;
    const t = this.t;
    v.passive = false;
    v.useRoll = false;
    const burning = !Number.isNaN(this.sesT) && Number.isNaN(this.secoT) && !this.s2Failed && this.s2Eng.activeCount() > 0;
    if (Number.isNaN(this.sesT) || (!burning && Number.isNaN(this.secoT))) {
      // coast before SES-1 (or after an engine failure): hold attitude on RCS
      v.axis.copy(this.s2HoldAxis);
      v.gains = G_HOLD;
      v.rcsMask = MASK_ALL;
      v.rcsDb = 0.3 * D2R;
      v.passive = false;
    } else if (burning) {
      const vi = inertialVel(rb.pos, rb.vel, _v1);
      const a = Math.max(0.5, v.engines!.totalThrust / rb.mass);
      const ve = MVAC.ispVac * G0;
      if (t >= this.pegNextUpd) {
        this.pegNextUpd = t + 1;
        const aNom = Math.max(a, (MVAC.thrustVac * 0.95) / rb.mass);
        this.peg.update(t, rb.pos, vi, aNom, ve);
      }
      // first seconds: hold the separation attitude while MVac spools up and clears the interstage
      if (t - this.sesT < 4) v.axis.copy(this.s2HoldAxis);
      else {
        this.peg.steer(t, rb.pos, vi, a, ve, _v2);
        // slew limit handled by the controller rate limit
        v.axis.copy(_v2);
      }
      v.rollRef.crossVectors(this.peg.n, v.axis);
      v.useRoll = true;
      v.gains = G_TVC;
      v.useGimbal = true;
      v.rcsMask = MASK_ROLL;
      v.rcsDb = 0.3 * D2R;
      // SECO: orbital energy reached target circular energy
      const r = altOf(rb.pos) + EARTH_RADIUS;
      const energy = vi.lengthSq() / 2 - 3.986004418e14 / r;
      const eT = -3.986004418e14 / (2 * this.peg.aT);
      if (energy >= eT && t - this.sesT > 30) this.doSeco(v, false);
      if (!this.s2SaidNominal && t - this.sesT > 45) {
        this.s2SaidNominal = true;
        this.say('lc_s2_nominal');
      }
      // automatic fairing jettison once free-molecular heating is below the payload limit
      if (this.autoFairing && Number.isNaN(this.fairingSepT) && v.has('FAIRING_A') && t - this.sesT > GNC.fairingMinDelay) {
        const flux = 0.5 * v.atmo.rho * Math.pow(v.vAir.length(), 3);
        if (flux < GNC.fairingHeatLimit && v.alt > GNC.fairingMinAlt) this.separateFairing();
      }
    } else {
      // post-SECO: hold prograde (inertial velocity), RCS attitude hold
      const vi = inertialVel(rb.pos, rb.vel, _v1);
      v.axis.copy(vi).normalize();
      v.gains = G_HOLD;
      v.rcsMask = MASK_ALL;
      v.rcsDb = 0.25 * D2R;
      v.passive = v.alt > 120_000;
      if (v.passive) {
        // coarse coast steps: the cold-gas hold is modelled kinematically (slew ≤ 1.5°/s toward
        // prograde, body rates nulled) — a PD loop on RCS pulses is not stable at dtCoast
        const cur = _v3.set(0, 1, 0).applyQuaternion(rb.quat);
        const ang = Math.acos(clamp(cur.dot(v.axis), -1, 1));
        const step = Math.min(ang, 1.5 * D2R * dt);
        if (ang > 1e-6) {
          const tgt = _v4.copy(cur).lerp(v.axis, step / ang).normalize();
          _q1.setFromUnitVectors(cur, tgt);
          rb.quat.premultiply(_q1).normalize();
        }
        rb.angVel.set(0, 0, 0);
        v.rcsMask = MASK_NONE;
      }
    }
    // automatic fairing jettison also works during coast phases
    if (!burning && this.autoFairing && Number.isNaN(this.fairingSepT) && v.has('FAIRING_A') && !Number.isNaN(this.sesT) && t - this.sesT > GNC.fairingMinDelay) {
      const flux = 0.5 * v.atmo.rho * Math.pow(v.vAir.length(), 3);
      if (flux < GNC.fairingHeatLimit && v.alt > GNC.fairingMinAlt) this.separateFairing();
    }
    // failed to reach orbit: reentry breakup
    if (!this.s2InOrbit && !Number.isNaN(this.sesT) && v.alt < 70_000 && rb.vel.dot(upOf(rb.pos, _up)) < 0) {
      if (v.aero.q > 25_000 || v.alt < 35_000) this.destroy(v, 'reentry breakup');
    }
  }

  private doSeco(v: Vehicle, flameout: boolean): void {
    if (!Number.isNaN(this.secoT)) return;
    this.secoT = this.t;
    this.s2Eng.command('none', this.t);
    const vi = inertialVel(v.rb.pos, v.rb.vel, _v1);
    this.orbit = orbitElements(v.rb.pos, vi);
    this.s2InOrbit = this.orbit.perigee > 140_000;
    this.ev('SECO', 'S2', { flameout, perigee: this.orbit.perigee, apogee: this.orbit.apogee, inc: this.orbit.incDeg, prop: this.s2Prop });
    this.say('lc_seco');
    if (this.s2InOrbit) {
      for (const m of v.members) if (m.id === 'S2' || m.id === 'PAYLOAD') this.bodies[m.id].status = 'orbit';
      this.ev('ORBIT', 'S2', { ...this.orbit });
      this.say('host_orbit', 1.6);
      this.deployDue = this.t + GNC.s2DeployDelay;
    } else {
      this.s2Failed = true;
      this.s2FailReason = 'suborbital';
      this.say('host_no_orbit', 2);
      this.cancel('PAYLOAD_DEPLOY');
    }
  }

  // =============================================================================================
  // FAIRING halves

  private gncFairing(v: Vehicle, dt: number): void {
    const rb = v.rb;
    const b = this.bodies[v.root];
    const pf = b.parafoil ?? 0;
    const drogue = !!this.fairingDrogue[v.root];
    v.passive = pf > 0.3 || drogue || (v.alt > 130_000);
    if (pf <= 0 && !drogue) {
      // tumbling ballistic flight; cold-gas thrusters are not modelled (passive)
      if (v.alt < 11_000 && rb.vel.dot(upOf(rb.pos, _up)) < 0 && v.vAir.length() < 260) {
        this.fairingDrogue[v.root] = true;
        this.ev('PARAFOIL_DEPLOY', v.root, { alt: v.alt, stage: 'drogue' });
      }
      return;
    }
    if (pf <= 0 && v.alt < 2_500) {
      b.parafoil = 0.001;
      this.ev('PARAFOIL_DEPLOY', v.root, { alt: v.alt, stage: 'parafoil' });
    }
    // drogue (≈25 m/s sink) → parafoil: kinematic glide (L/D ≈ 3) toward the recovery zone,
    // hanging below the canopy
    const main = (b.parafoil ?? 0) > 0;
    if (main) b.parafoil = Math.min(1, (b.parafoil ?? 0) + dt / 14);
    const pfNow = b.parafoil ?? 0;
    upOf(rb.pos, _up);
    const k = Math.min(1, dt / (!main ? 4 : pfNow < 0.9 ? 3 : 1.5));
    // glide direction: continue along track, crabbing into the wind
    const hd = _v1.copy(rb.vel).addScaledVector(_up, -rb.vel.dot(_up));
    if (hd.lengthSq() < 1) hd.copy(this.headingDir);
    hd.normalize();
    const sink = !main ? 25 : pfNow < 0.9 ? 12 : 4.8;
    const air = !main ? 2 : pfNow < 0.9 ? 6 : 14.5;
    const target = _v2.copy(v.wind).addScaledVector(_up, -v.wind.dot(_up)).addScaledVector(hd, air).addScaledVector(_up, -sink);
    rb.vel.lerp(target, k);
    rb.angVel.multiplyScalar(1 - k);
    // attitude: body +Y up (tilted 15° forward), concave side facing aft
    const ax = _v3.copy(_up).addScaledVector(hd, 0.27).normalize();
    quatFromAxisRef(ax, hd, _q1);
    rb.quat.slerp(_q1, k * 0.5);
    rb.clearForces();
    rb.pos.addScaledVector(rb.vel, dt);
    v.kinematic = false;
    // splashdown
    if (v.alt <= 0.5) {
      b.status = 'splashed';
      rb.vel.set(0, 0, 0);
      v.passive = true;
      this.ev('SPLASHDOWN', v.root, { speed: sink });
      v.goneAt = this.envT + 90;
      v.kinematic = true;
    }
    // skip the regular dynamics this step (we moved it kinematically)
    v.useGimbal = false;
    v.rcsMask = MASK_NONE;
    v.skipDyn = true;
  }

  // =============================================================================================
  // BOOSTER recovery GNC

  private shipTarget(tMission: number): ShipPose | null {
    if (!this.ship) return null;
    let te = tMission + (this.envT - this.t);
    // the exact deck motion only matters close to the deck; elsewhere a 0.1 s grid is plenty
    if (!this.shipExact()) te = Math.round(te * 10) / 10;
    if (this.shipPoseT !== te) {
      this.ship.pose(te, this.shipPose);
      this.shipPoseT = te;
    }
    return this.shipPose;
  }

  private shipExact(): boolean {
    if (this.bPhase === 'LANDING_BURN') return true;
    if (this.bPhase === 'LANDED') return !!this.tip && !this.tip.done;
    return false;
  }

  /** deck plane height of the booster's feet (m, along deck normal) */
  private heightAboveDeck(v: Vehicle, ship: ShipPose | null): number {
    if (ship) return _v1.copy(v.origin).sub(ship.pos).dot(ship.up) - FOOT_DROP;
    return altOf(v.origin) - OCISLY.deckHeight - FOOT_DROP;
  }

  private runPrediction(v: Vehicle, cutEntryNow: boolean, out: RolloutOut, vCut?: number): RolloutOut {
    const rb = v.rb;
    return rollout({
      p: rb.pos, v: rb.vel, t: this.t, dry: rb.mass - this.s1Prop, prop: this.s1Prop, cgY: 15.5,
      entryDone: this.entryDone, entryActive: this.bPhase === 'ENTRY_BURN', landingActive: this.bPhase === 'LANDING_BURN',
      vCut: vCut ?? GNC.entryVNominal, cutEntryNow, wind: this.wind,
    }, out);
  }

  /** target - predicted impact, horizontal at the target (W). */
  private readonly shipPredPose = makeShipPose();

  private computeIpErr(v: Vehicle, pred: RolloutOut, out: Vector3): boolean {
    if (!this.ship) { out.set(0, 0, 0); return false; }
    const tm = Number.isFinite(pred.tdT) ? pred.tdT : this.t + 60;
    const ship = this.ship.pose(tm + (this.envT - this.t), this.shipPredPose);
    // CG → origin (upright at touchdown)
    const up = upOf(ship.pos, _v4);
    out.copy(ship.pos).sub(pred.tdPos);
    out.addScaledVector(up, -out.dot(up));
    return true;
  }

  private gncBooster(v: Vehicle, dt: number): void {
    const rb = v.rb;
    const t = this.t;
    const b = this.bodies.S1;
    v.passive = false;
    upOf(rb.pos, _up);
    const vUp = rb.vel.dot(_up);
    const V = v.vAir.length();
    const ship = this.shipTarget(t);
    const manualMode = this.settings.manualLanding && !this.presim;

    // ---- predictions (2 Hz) ----
    if (!this.presim && t >= this.predNext && (this.bPhase === 'COAST' || this.bPhase === 'FLIP' || this.bPhase === 'BOOST' || this.bPhase === 'AERO' || this.bPhase === 'ENTRY_BURN' || this.bPhase === 'LANDING_BURN')) {
      this.predNext = t + (this.bPhase === 'ENTRY_BURN' || this.bPhase === 'LANDING_BURN' ? 0.25 : this.bPhase === 'AERO' ? 0.5 : 1);
      this.runPrediction(v, false, this.pred);
      this.predValid = true;
      this.ipErrValid = this.computeIpErr(v, this.pred, this.ipErr);
    }

    // ---- events ----
    if (Number.isNaN(this.apogeeT) && vUp < 0 && t - this.sepT > 2) {
      this.apogeeT = t;
      this.ev('APOGEE', 'S1', { alt: v.alt });
      this.say('host_apogee', 1);
    }
    if (Number.isNaN(this.finsT) === false && t >= this.finsT && !this.fins.deployCmd) {
      this.fins.deployCmd = true;
      this.ev('GRIDFINS_DEPLOY', 'S1');
      this.say('lc_gridfins');
    }
    const M = v.aero.mach;
    if (this.lastBoosterMach > 1 && M <= 1 && vUp < 0 && Number.isNaN(this.sonicBoomT) && v.alt < 40_000) {
      this.sonicBoomT = t;
      this.ev('SONIC_BOOM', 'S1', { pos: { x: rb.pos.x, y: rb.pos.y, z: rb.pos.z }, alt: v.alt, t });
      this.say('lc_transonic');
    }
    this.lastBoosterMach = M;

    // ---- phase logic ----
    const q = v.aero.q;
    switch (this.bPhase) {
      case 'COAST':
      case 'FLIP': {
        // boost-toward-ship decision (early staging leaves the booster short of the droneship)
        if (!this.presim && !this.boostDecided && t - this.sepT > 8 && this.predValid && ship) {
          this.boostDecided = true;
          const e = this.ipErr.length();
          const along = this.alongDir(rb, _v2);
          const short = this.ipErr.dot(along);
          const need = this.s1Prop - this.pred.propTD + 3000;
          if (short > 8000 && q < 1500 && this.s1Prop - need > 1500 && e > 8000) {
            this.bPhase = 'BOOST';
            this.boostStartT = t;
          }
        }
        if (this.bPhase === 'BOOST') break;
        if (t < this.flipT) {
          // clear the second stage: hold attitude, rate damping only
          v.axis.set(0, 1, 0).applyQuaternion(rb.quat);
          v.gains = G_HOLD;
          v.rcsMask = MASK_ALL;
          v.rcsDb = 0.3 * D2R;
        } else {
          if (this.bPhase === 'COAST' && Number.isNaN(this.entryStartT) && b.phase !== 'FLIP' && !this.flipStarted) {
            this.flipStarted = true;
            this.bPhase = 'FLIP';
            this.ev('BOOSTER_FLIP', 'S1');
            this.say('lc_flip');
            this.say('host_flip', 5);
          }
          this.entryAttitude(v, _v2);
          v.axis.copy(_v2);
          v.gains = G_RCS;
          v.rcsMask = MASK_ALL;
          v.rcsDb = 0.25 * D2R;
          if (v.fins && this.fins.deploy > 0.98 && q > 800) { v.useFins = true; v.gains = G_FINS; }
          if (this.bPhase === 'FLIP' && v.ctrl.errAngle < 6 * D2R && rb.angVel.length() < 1 * D2R) this.bPhase = 'COAST';
        }
        if (!this.entryDone && entryIgnitionDue(q, -vUp, V)) this.startEntryBurn();
        else if (!this.entryDone && vUp < 0 && v.alt < 30_000) {
          // never needed an entry burn (slow, low energy trajectory)
          this.entryDone = true;
          this.cancel('ENTRY_BURN_START');
        }
        if (this.entryDone && Number.isNaN(this.aeroT) && vUp < 0 && (q > 2000 || v.alt < 40_000)) {
          this.bPhase = 'AERO';
          this.aeroT = t;
        }
        break;
      }
      case 'BOOST': {
        // 3-engine burn toward the ship, then flip for entry
        const dir = _v2.copy(this.ipErrValid ? this.ipErr : this.headingDir);
        dir.addScaledVector(_up, -dir.dot(_up)).normalize().addScaledVector(_up, 0.35).normalize();
        v.axis.copy(dir);
        v.gains = this.boostLit ? G_TVC : G_RCS;
        v.useGimbal = this.boostLit;
        v.rcsMask = this.boostLit ? MASK_NONE : MASK_ALL;
        v.rcsDb = 0.25 * D2R;
        if (!this.boostLit && v.ctrl.errAngle < 4 * D2R) {
          this.boostLit = true;
          this.s1Eng.command([0, 1, 5], t);
          this.s1Eng.cmdThrottle = 1;
        }
        if (this.boostLit) {
          const along = this.alongDir(rb, _v3);
          const short = this.ipErr.dot(along);
          const need = this.s1Prop - this.pred.propTD + 3000;
          if (short < 500 || this.s1Prop < need + 500 || t - this.boostStartT > 120) {
            this.s1Eng.command('none', t);
            this.boostEndT = t;
            this.bPhase = 'FLIP';
            this.flipStarted = true;
            this.ev('BOOSTER_FLIP', 'S1', { afterBoost: true });
          }
        }
        break;
      }
      case 'ENTRY_BURN': {
        // thrust retrograde, tilted to pull the cross-range impact error toward the ship
        const axis = _v2.copy(v.vAir).multiplyScalar(-1 / Math.max(1, V));
        if (this.ipErrValid) {
          const along = this.alongDir(rb, _v3);
          const cross = _v4.copy(this.ipErr).addScaledVector(along, -this.ipErr.dot(along));
          const tRem = Math.max(30, (Number.isFinite(this.pred.tdT) ? this.pred.tdT : t + 120) - t);
          const aT = Math.max(5, this.s1Eng.totalThrust / rb.mass);
          const tilt = clamp(cross.length() / (0.5 * tRem * aT * 8), 0, 8 * D2R);
          if (cross.lengthSq() > 1) axis.addScaledVector(cross.normalize(), Math.tan(tilt)).normalize();
        }
        v.axis.copy(axis);
        v.gains = G_TVC;
        v.useGimbal = true;
        v.useFins = this.fins.deploy > 0.98;
        v.rcsMask = q < 1500 ? MASK_ROLL : MASK_NONE;
        // cutoff: heating window + impact-point along-track error, landing reserve
        let cut = false;
        if (this.s1Prop <= GNC.landingReserve) cut = true;
        else if (V <= GNC.entryVMin) cut = true;
        else if (V <= GNC.entryVMax) {
          if (this.presim || !ship) cut = V <= GNC.entryVNominal;
          else if (t >= this.cutCheckT) {
            this.cutCheckT = t + 0.2;
            this.runPrediction(v, true, this.pred2);
            this.computeIpErr(v, this.pred2, _v3);
            const along = this.alongDir(rb, _v4);
            if (_v3.dot(along) >= 0) cut = true; // would now land at/short of the ship
          }
        }
        if (cut) {
          this.s1Eng.command('none', t);
          this.entryDone = true;
          this.entryEndT = t;
          this.bPhase = 'AERO';
          this.aeroT = t;
          this.ev('ENTRY_BURN_END', 'S1', { v: V, prop: this.s1Prop });
          this.say('lc_entry_end');
          this.say('host_gridfins_steer', 12);
        }
        break;
      }
      case 'AERO': {
        this.aeroGuidance(v, V, manualMode, dt);
        // landing ignition: light when the burn started now would just stop at the deck
        const hDeck = this.heightAboveDeck(v, ship);
        const vRel = _v1.copy(rb.vel);
        if (ship) vRel.sub(ship.vel);
        const nUp = ship ? ship.up : _up;
        const vRelDown = -vRel.dot(nUp);
        const vHor = Math.sqrt(Math.max(0, vRel.lengthSq() - vRelDown * vRelDown));
        const m = rb.mass;
        const nEng = this.landingEngineCount(m);
        if (vRelDown > 0 && hDeck < 20_000 && t >= this.lbNextCheck) {
          const tdAlt = v.alt - hDeck;
          const hs = landingStopHeight(hDeck, vRelDown, vHor, m, nEng, tdAlt);
          this.lbLastHs = hs;
          this.lbNextCheck = t + Math.min(0.5, Math.max(0, hs) / (3 * Math.max(1, vRelDown)));
          // time until ignition ≈ excess stop height / (descent rate − rate at which the stop height shrinks)
          this.lastLandingInfo.burnStartT = t + Math.max(0, hs) / Math.max(20, vRelDown * 0.35);
        }
        if (manualMode) {
          if (this.manual.throttle > 0 && v.alt < 20_000) this.startLandingBurn(v, true);
        } else if (this.lbLastHs <= GNC.landingIgnMargin && vRelDown > 0 && hDeck < 20_000) {
          this.startLandingBurn(v, false);
        }
        break;
      }
      case 'LANDING_BURN':
        this.landingGuidance(v, dt, manualMode);
        break;
      default:
        break;
    }
    b.phase = this.bPhase;
  }

  private flipStarted = false;
  private cutCheckT = 0;
  private lbNextCheck = 0;
  private lbLastHs = Infinity;

  private landingEngineCount(m: number): number {
    const T1 = M1D.thrustVac - 101_325 * M1D.exitArea;
    return T1 * 0.9 / (m * 9.81) > 1.25 ? 1 : 3;
  }

  /**
   * Net side-force slope (N/rad) of tilting the thrust axis by a small angle δ off the relative wind
   * (engines-first): thrust component T·sinδ plus the aerodynamic side force of the body at AoA δ
   * (crossflow + grid fins push AWAY from the tilt, the tilted axial drag pushes toward it; the
   * plume shields part of the axial drag). Negative when aerodynamics dominate (high q): the
   * engines must then be tilted AWAY from the target, as in the unpowered aero phase.
   * Also returns the normal force at 3° in `slN3` (for a load limit).
   */
  private lateralSlope(v: Vehicle, T: number): number {
    const V = v.vAir.length();
    const q = v.aero.q;
    this.slN3 = 0;
    if (V < 1 || q < 20) return T;
    const d = 3 * D2R;
    _slU.set(V * Math.sin(d), -V * Math.cos(d), 0);
    const retro = Math.min(1, T / Math.max(1, q * 10.5 * 3));
    computeAero(SHAPES[v.shape], { finDeploy: this.fins.deploy, retro, legs: this.legs }, _slU, v.atmo.rho, v.atmo.a, v.rb.cg, _slW.set(0, 0, 0), _slAero);
    this.slN3 = _slAero.normal;
    const side = _slAero.F.x * Math.cos(d) + _slAero.F.y * Math.sin(d);
    return (T * Math.sin(d) + side) / d;
  }
  private slN3 = 0;

  /**
   * Tilt the thrust direction `d` so the booster accelerates sideways by `aLat` (W, ⟂ d) as far as
   * physics allows: tilt = m·|aLat| / slope, clamped to `maxTilt` and to 35 % of the structural
   * normal-force limit. Returns the achieved lateral acceleration (m/s²).
   */
  private divertAxis(v: Vehicle, d: Vector3, aLat: Vector3, T: number, maxTilt: number, out: Vector3): number {
    out.copy(d);
    const a = aLat.length();
    if (a < 1e-4) return 0;
    const k = this.lateralSlope(v, T);
    const m = v.rb.mass;
    let tilt = Math.min(maxTilt, (m * a) / Math.max(1, Math.abs(k)));
    if (this.slN3 > 1) tilt = Math.min(tilt, 3 * D2R * (0.35 * GNC.boosterNormalLimit) / this.slN3);
    // smooth sign change around the thrust/aero cross-over (no authority there anyway)
    const sgn = k / (Math.abs(k) + 0.15 * Math.max(1, T));
    out.addScaledVector(aLat, (Math.tan(tilt) * sgn) / a).normalize();
    return (Math.abs(k) * tilt) / m;
  }

  /** horizontal unit direction of motion (W) */
  private alongDir(rb: RigidBody, out: Vector3): Vector3 {
    upOf(rb.pos, _v1);
    out.copy(rb.vel).addScaledVector(_v1, -rb.vel.dot(_v1));
    if (out.lengthSq() < 1) out.copy(this.headingDir);
    return out.normalize();
  }

  /** engines-first attitude along the expected entry velocity */
  private entryAttitude(v: Vehicle, out: Vector3): void {
    const rb = v.rb;
    if (this.predValid && this.pred.vEntry.lengthSq() > 100 && v.alt > 50_000) {
      out.copy(this.pred.vEntry).normalize().negate();
      return;
    }
    if (v.alt < 55_000 && v.vAir.lengthSq() > 100) {
      out.copy(v.vAir).normalize().negate();
      return;
    }
    // ballistic mirror estimate: same horizontal velocity, vertical velocity reversed at ~60 km
    upOf(rb.pos, _up);
    const vr = rb.vel.dot(_up);
    const vh = _v3.copy(rb.vel).addScaledVector(_up, -vr);
    const vz = -Math.sqrt(Math.max(0, vr * vr + 2 * 9.6 * Math.max(0, v.alt - 60_000)));
    out.copy(vh).addScaledVector(_up, vz).normalize().negate();
  }

  private startEntryBurn(): void {
    const t = this.t;
    this.bPhase = 'ENTRY_BURN';
    this.entryStartT = t;
    this.entryAlt = this.find('BOOSTER')?.alt ?? NaN;
    this.s1Eng.command(F9.s1.entryBurnEngines, t);
    this.s1Eng.cmdThrottle = 1;
    this.ev('ENTRY_BURN_START', 'S1');
    this.say('lc_entry_start');
    this.say('host_entry', 4);
  }

  private aeroGuidance(v: Vehicle, V: number, manual: boolean, dt: number): void {
    const rb = v.rb;
    const ship = this.shipTarget(this.t);
    // desired lateral acceleration toward the target (drives angle of attack / body lift)
    const lat = this.latCmd.set(0, 0, 0);
    if (manual && ship) {
      lat.copy(ship.starboard).multiplyScalar(this.manual.yaw).addScaledVector(ship.bow, this.manual.pitch);
      if (lat.lengthSq() > 1) lat.normalize();
      lat.multiplyScalar(6);
    } else if (this.ipErrValid) {
      const tLb = Math.max(8, (Number.isFinite(this.pred.lbStartT) ? this.pred.lbStartT : this.t + 30) - this.t);
      lat.copy(this.ipErr).multiplyScalar(3.5 / (tLb * tLb));
    }
    const q = v.aero.q;
    const vhat = _v2.copy(v.vAir).multiplyScalar(1 / Math.max(1, V));
    lat.addScaledVector(vhat, -lat.dot(vhat));
    // adaptive estimate of the net lateral force slope (crossflow + fins − tilted axial force), per rad,
    // measured from the aero force actually produced along the previous lift direction
    if (q > 1500 && this.aoaK > 0.5 * D2R && this.latDir.lengthSq() > 0.5) {
      const Fw = _v3.copy(v.aero.F).applyQuaternion(rb.quat);
      const meas = Fw.dot(this.latDir) / (q * BOOSTER_S * this.aoaK);
      const k = Math.min(1, dt / 1.0);
      this.claEst += (clamp(meas, 0.12, 4) - this.claEst) * k;
    }
    let alpha = 0;
    const la = lat.length();
    if (q > 50 && la > 1e-4) {
      alpha = clamp((rb.mass * la) / (q * BOOSTER_S * this.claEst), 0, GNC.maxAoaDeg * D2R);
      // limit normal load
      alpha = Math.min(alpha, Math.sqrt(GNC.boosterNormalLimit * 0.35 / Math.max(1, q * BOOSTER_S * 12)));
      this.latDir.copy(lat).multiplyScalar(1 / la);
    } else this.latDir.set(0, 0, 0);
    // engines-first: nose opposite the airflow, engines tilted toward the desired lift direction
    const axis = v.axis.copy(vhat).negate();
    if (alpha > 0) axis.addScaledVector(this.latDir, -Math.tan(alpha)).normalize();
    v.useRoll = false;
    v.gains = G_FINS;
    v.useFins = this.fins.deploy > 0.98;
    v.rcsMask = q < 4000 || !v.useFins ? MASK_ALL : MASK_NONE;
    v.rcsDb = 0.35 * D2R;
    this.aoaK = alpha;
  }

  private startLandingBurn(v: Vehicle, manual: boolean): void {
    const t = this.t;
    this.bPhase = 'LANDING_BURN';
    this.landingStartT = t;
    this.landingEngines = this.landingEngineCount(v.rb.mass) === 1 ? [...F9.s1.landingBurnEngines] : [0, 1, 5];
    this.s1Eng.command(this.landingEngines, t);
    this.s1Eng.cmdThrottle = GNC.landingPlanThrottle;
    if (manual) this.manualStarts++;
    this.ev('LANDING_BURN_START', 'S1', { manual, engines: this.landingEngines.length });
    this.say('lc_landing_start');
    if (manual) this.say('host_manual', 1.5);
  }

  private landingGuidance(v: Vehicle, dt: number, manual: boolean): void {
    const rb = v.rb;
    const t = this.t;
    const ship = this.shipTarget(t);
    // guidance frame: local vertical (the deck normal rocks with the sea state)
    const nUp = _lgN.copy(upOf(rb.pos, _up));
    let h = this.heightAboveDeck(v, ship);
    if (ship && h < 200) {
      // well off the deck at the end of the burn: the surface below is the sea, not the deck plane
      const eh = _lgE.copy(ship.pos).sub(v.origin);
      eh.addScaledVector(nUp, -eh.dot(nUp));
      if (eh.length() > OCISLY.deckLength * 0.5 + 25) h = altOf(v.origin) - FOOT_DROP;
    }
    const vRel = _lgV.copy(rb.vel);
    if (ship) vRel.sub(ship.vel);
    const vDown = -vRel.dot(nUp);
    const vh = _lgH.copy(vRel).addScaledVector(nUp, vDown); // horizontal (deck-plane) relative velocity
    const m = rb.mass;
    const nEng = this.landingEngines.length;
    const pA = v.atmo.p * M1D.exitArea;
    const Tmax = nEng * Math.max(1, M1D.thrustVac - pA);
    const g = 9.80665;
    // aero drag component along the deck normal (helps decelerate)
    const dUp = _lgA.copy(v.aero.F).applyQuaternion(rb.quat).dot(nUp);
    const vt = GNC.touchdownSpeed;
    const tgo = Math.max(0.5, (2 * Math.max(0, h)) / Math.max(0.5, vDown + vt));
    // legs
    if (!this.legsCmd && tgo <= GNC.legsLeadTime) {
      this.legsCmd = true;
      this.ev('LEGS_DEPLOY', 'S1');
      this.say('lc_legs');
    }
    let thr: number;
    const acc = _lgA;
    if (manual) {
      const lever = this.manual.throttle;
      if (lever <= 0) {
        if (this.s1Eng.activeCount() > 0) this.s1Eng.command('none', t);
        thr = 0;
      } else {
        if (this.s1Eng.activeCount() === 0 && this.manualStarts < 3 && this.s1Prop > 0) {
          this.s1Eng.command(this.landingEngines, t);
          this.manualStarts++;
        }
        thr = Math.max(M1D.minThrottle, lever);
      }
      // Assisted attitude (fly-by-wire: the pilot never commands the gimbal directly). Stick = where
      // the booster should go in the deck frame (pitch+ → bow, yaw+ → starboard/+X).
      //  * high (> ~200 m above the deck): neutral = lean against the drift relative to the deck
      //    (retrograde while fast — the burn cancels the drift like the autopilot's gravity turn);
      //    |stick| = 1 adds 14° of thrust tilt. At high dynamic pressure the body lift of the tilted
      //    booster outweighs the thrust component, so the assist tilts the engines the other way
      //    (same physics as the autopilot's divert); near the cross-over the stick has no authority.
      //  * low: velocity command — |stick| = 1 asks for 8 m/s of drift over the deck, neutral holds
      //    station over the deck; the assist leans (≤ 20°, ≤ 8° in the last metres) to get there.
      const lowH = clamp((h - 3) / 60, 0, 1); // 0 at the deck … 1 above ~60 m
      const wHigh = clamp((h - 150) / 100, 0, 1);
      const vhL = vh.length();
      const aL = _lgL.set(0, 0, 0);
      if (ship) aL.copy(ship.starboard).multiplyScalar(this.manual.yaw).addScaledVector(ship.bow, this.manual.pitch);
      const sLen = Math.min(1, aL.length());
      // high-regime axis
      const leanMax = 35 * D2R;
      const lean = Math.min(Math.atan2(vhL, Math.max(15, vDown)), leanMax);
      const dHi = _lgU.copy(nUp);
      if (vhL > 0.05) dHi.addScaledVector(vh, -Math.tan(lean) / vhL).normalize();
      if (sLen > 1e-3 && wHigh > 0) {
        const s2 = _lgE.copy(aL).addScaledVector(dHi, -aL.dot(dHi));
        const l2 = s2.length();
        if (l2 > 1e-3) {
          const T = Math.max(1, this.s1Eng.totalThrust, thr * nEng * M1D.thrustVac * 0.9);
          const k = this.lateralSlope(v, T);
          const sgn = k / (Math.abs(k) + 0.15 * T);
          dHi.addScaledVector(s2, (Math.tan(sLen * 14 * D2R) * sgn) / l2).normalize();
        }
      }
      // low-regime axis: horizontal acceleration toward the commanded drift, produced by leaning
      const aT = Math.max(3, g + Math.max(0, vDown) * 0.5);
      const aH = _lgE.copy(aL).multiplyScalar(8 / Math.max(1, aL.length())).sub(vh).multiplyScalar(1 / 1.6);
      aH.addScaledVector(nUp, -aH.dot(nUp));
      const tiltLo = (8 + 12 * lowH) * D2R;
      const aHl = aH.length();
      const aHmax = aT * Math.tan(tiltLo);
      if (aHl > aHmax) aH.multiplyScalar(aHmax / aHl);
      acc.copy(nUp).multiplyScalar(aT).add(aH).normalize();
      if (wHigh > 0) acc.multiplyScalar(1 - wHigh).addScaledVector(dHi, wHigh).normalize();
      v.axis.copy(acc);
    } else {
      // two-segment vertical profile: constant deceleration to V1 at H1 above the deck, then a
      // gentle final descent (≈3 s) at near-hover throttle so the lateral correction can finish upright
      const Ve = rb.vel.length();
      const P = landingProfile(vDown, h, Ve, v.aero.q, this.lgProf);
      // vertical acceleration the engine must provide (along the local vertical)
      // (drag may exceed the requirement early in the burn: thrust can only push up → min throttle)
      const aVert = Math.max(3, P.aReq + g - dUp / m);
      const aLat = _lgL.set(0, 0, 0);
      const e = _lgE.set(0, 0, 0);
      if (ship) {
        e.copy(ship.pos).sub(v.origin);
        e.addScaledVector(nUp, -e.dot(nUp));
      }
      if (!P.finalSeg) {
        // gravity turn (as modelled by the predictor) + correction toward the deck from the
        // predicted impact error
        const d = _lgU.copy(rb.vel).multiplyScalar(-(1 - P.w) / Ve);
        const Va = v.vAir.length();
        if (Va > 0.1) d.addScaledVector(v.vAir, -P.w / Va);
        d.normalize();
        const A0 = aVert / Math.max(0.3, d.dot(nUp));
        acc.copy(d);
        if (this.ipErrValid && Number.isFinite(this.pred.tdT)) {
          // lateral correction toward the deck from the predicted impact error; the tilt accounts
          // for the aerodynamic side force (at high q it outweighs the thrust component)
          const tg = Math.max(3, this.pred.tdT - t);
          aLat.copy(this.ipErr).addScaledVector(d, -this.ipErr.dot(d)).multiplyScalar(LP.kIp / (tg * tg));
          this.divertAxis(v, d, aLat, m * A0, LP.ipTiltDeg * D2R, acc);
        }
      } else {
        // final descent: ZEM/ZEV position hold relative to the (moving) deck, small tilt
        const tg = Math.max(LP.tgMin, (2 * Math.max(0, h - LP.H1)) / Math.max(1, vDown + LP.V1) + 2);
        aLat.copy(e).multiplyScalar(6 / (tg * tg)).addScaledVector(vh, -4 / tg);
        if (h < LP.H1 + 1) aLat.copy(vh).multiplyScalar(-LP.kVel);
        const tiltDeg = 3 + (LP.finalTiltDeg - 3) * clamp(h / LP.hFinal, 0, 1);
        const lim = aVert * Math.tan(tiltDeg * D2R);
        const al = aLat.length();
        if (al > lim) aLat.multiplyScalar(lim / al);
        acc.copy(nUp).multiplyScalar(aVert).add(aLat).normalize();
      }
      // vertical thrust share from the commanded and the actual axis (attitude lag at the end)
      const axNow = _lgE.set(0, 1, 0).applyQuaternion(rb.quat);
      const cosUp = Math.max(0.3, Math.min(acc.dot(nUp), axNow.dot(nUp)));
      const need = (m * aVert) / cosUp;
      // per-engine thrust = thr·F_vac − p·A_exit
      thr = clamp((need / nEng + pA) / M1D.thrustVac, M1D.minThrottle, 1);
      if (need > Tmax * 1.02) thr = 1;
      // rate-limit the commanded axis so the TVC loop can follow it
      if (this.lgAxisT < 0 || t - this.lgAxisT > 0.5) this.lgAxis.copy(acc);
      else {
        const ang = Math.acos(clamp(this.lgAxis.dot(acc), -1, 1));
        const maxStep = 8 * D2R * dt;
        if (ang > maxStep) this.lgAxis.lerp(acc, maxStep / ang).normalize();
        else this.lgAxis.copy(acc);
      }
      this.lgAxisT = t;
      v.axis.copy(this.lgAxis);
      // hoverslam: cannot hover (T/W at min throttle > 1) — cut at contact or if stalled above deck
      if (vDown < 0.25 && h > 0.3 && h < 6) {
        this.s1Eng.command('none', t);
      }
    }
    this.s1Eng.cmdThrottle = thr;
    v.gains = v.aero.q < 8000 ? G_LAND : G_TVC;
    v.useGimbal = this.s1Eng.totalThrust > 1000;
    v.useFins = this.fins.deploy > 0.98 && v.aero.q > 500;
    v.rcsMask = nEng === 1 ? (v.useGimbal ? MASK_ROLL : MASK_ALL) : MASK_NONE;
    v.rcsDb = 0.3 * D2R;
    v.useRoll = false;
    // prediction for HUD
    const L = this.lastLandingInfo;
    L.touchdownT = t + tgo;
    L.valid = true;
  }

  // =============================================================================================
  // post-step checks: loads, touchdown, splashdown, heating

  private postChecks(v: Vehicle, dt: number): void {
    const rb = v.rb;
    rb.origin(v.origin);
    const kind = v.kind;
    // structural loads
    const N = v.aero.normal;
    const lim = kind === 'STACK' ? GNC.stackNormalLimit : kind === 'BOOSTER' ? GNC.boosterNormalLimit : kind === 'UPPER' ? GNC.upperNormalLimit : Infinity;
    if (N > lim && v.alive) {
      this.destroy(v, this.breakupReason(v), { q: v.aero.q, aoa: this.aoaDeg(v), normal: N });
      return;
    }
    // heating
    const H = Math.sqrt(v.atmo.rho / 1.225) * Math.pow(v.vAir.length() / 1000, 3);
    if (kind === 'BOOSTER') {
      let target = 1 - Math.exp(-H / 0.22);
      if (this.bPhase === 'ENTRY_BURN' && v.aero.q > 80) target = Math.max(target, 0.35 + 0.4 * (this.bodies.S1.engines[0].spool));
      const k = target > v.heat ? dt / 1.5 : dt / 7;
      v.heat += (target - v.heat) * Math.min(1, k);
      this.boosterMaxHeat = Math.max(this.boosterMaxHeat, H);
      // overheating (e.g. entering too fast without an entry burn)
      if (H > this.heatLimitH) this.overheatTimer += dt;
      else this.overheatTimer = Math.max(0, this.overheatTimer - dt);
      if (this.overheatTimer > 4) { this.destroy(v, 'entry heating'); return; }
    } else if (kind === 'STACK' || kind === 'UPPER') {
      const target = 1 - Math.exp(-H / 0.15);
      v.heat += (target - v.heat) * Math.min(1, dt / 2);
    } else if (kind === 'FAIRING') {
      const target = 1 - Math.exp(-H / 0.3);
      v.heat += (target - v.heat) * Math.min(1, dt / 2);
    }
    if (kind === 'BOOSTER') this.boosterContact(v);
    else if (v.alt < 0 && kind !== 'FAIRING' && v.alive) {
      if (kind === 'STACK' && !this.released) return;
      this.ev('SPLASHDOWN', v.root, { speed: rb.vel.length() });
      this.destroy(v, 'impact');
    }
  }

  /** angle between the body axis and the relative wind, either end first (deg) */
  private aoaDeg(v: Vehicle): number {
    const a = v.aero.alpha;
    return Math.min(a, Math.PI - a) / D2R;
  }

  /** why the normal-force limit was exceeded, in words (RUD reason shown to the viewer) */
  private breakupReason(v: Vehicle): string {
    const aoa = this.aoaDeg(v);
    const qk = (v.aero.q / 1000).toFixed(v.aero.q < 10_000 ? 1 : 0);
    const who = v.kind === 'BOOSTER' ? 'booster' : v.kind === 'UPPER' ? 'second stage' : 'vehicle';
    const recentSep = Number.isFinite(this.sepT) && this.t - this.sepT < 20;
    if (recentSep && v.kind === 'UPPER') {
      return `second stage separated in thick air (${qk} kPa), pitched ${aoa.toFixed(0)}° off the airflow and broke up`;
    }
    if (aoa > 30) {
      if (v.kind === 'BOOSTER' && this.bPhase === 'FLIP') {
        return `booster tumbled out of control (cold-gas thrusters too weak for ${Math.round(v.rb.mass / 1000)} t in thick air) and broke up at ${qk} kPa`;
      }
      return `${who} tumbling at ${aoa.toFixed(0)}° angle of attack broke up (${qk} kPa)`;
    }
    const burning = v.engines && v.engines.activeCount() > 0;
    return `structural failure: aerodynamic side load at ${qk} kPa, ${aoa.toFixed(0)}° angle of attack${burning ? ' during the burn' : ''}`;
  }

  private destroy(v: Vehicle, reason: string, extra?: Record<string, unknown>): void {
    if (!v.alive || v.goneAt < Infinity) return;
    for (const m of v.members) {
      const b = this.bodies[m.id];
      b.status = 'destroyed';
    }
    if (v.engines) v.engines.command('none', this.t);
    v.rcs?.off();
    this.ev('RUD', v.root, { reason, members: v.members.map((m) => m.id), ...extra });
    v.goneAt = this.envT + 12;
    v.passive = true;
    v.wrecked = true;
    if (v.kind === 'STACK') {
      this.say('lc_anomaly');
      this.say('host_anomaly', 3);
      this.s2Failed = true;
      this.s2FailReason = reason;
      this.bPhase = 'LOST';
      this.boosterFate = `lost with the stack (${reason})`;
      for (const k of ['MAX_Q', 'MECO', 'STAGE_SEP', 'SES1', 'FAIRING_SEP', 'ENTRY_BURN_START', 'LANDING_BURN_START', 'TOUCHDOWN', 'SECO', 'PAYLOAD_DEPLOY'] as SimEventType[]) this.cancel(k);
    } else if (v.kind === 'BOOSTER') {
      this.bPhase = 'LOST';
      this.bodies.S1.phase = 'LOST';
      if (!this.boosterFate) this.boosterFate = `destroyed (${reason})`;
      if (!this.touchdown) this.say('host_booster_lost', 2);
      for (const k of ['ENTRY_BURN_START', 'LANDING_BURN_START', 'TOUCHDOWN'] as SimEventType[]) this.cancel(k);
    } else if (v.kind === 'UPPER') {
      if (!this.s2Failed) { this.s2Failed = true; this.s2FailReason = reason; }
      if (!this.s2InOrbit) this.say('host_anomaly', 1);
      this.cancel('SECO');
      this.cancel('PAYLOAD_DEPLOY');
    }
  }

  private onFlameout(v: Vehicle): void {
    if (v.engines === this.s1Eng) {
      if (this.flameoutS1) return;
      this.flameoutS1 = true;
      this.ev('FLAMEOUT', 'S1', { phase: this.bPhase });
      this.say('lc_s1_flameout');
      if (v.kind === 'STACK' && Number.isNaN(this.mecoT)) this.doMeco(false);
    } else {
      this.ev('FLAMEOUT', 'S2', {});
      this.say('lc_s2_flameout');
      if (Number.isNaN(this.secoT)) this.doSeco(v, true);
    }
  }

  // ---- touchdown ----

  private boosterContact(v: Vehicle): void {
    if (!v.alive || v.goneAt < Infinity || this.bPhase === 'LANDED' || this.bPhase === 'LOST') return;
    if (Number.isNaN(this.sepT)) return;
    const rb = v.rb;
    const ship = this.shipTarget(this.t);
    const bAxis = _v2.set(0, 1, 0).applyQuaternion(rb.quat);
    // after an off-deck contact the booster slides off the edge: only the ocean check remains
    if (ship && this.touchdown?.outcome !== 'offdeck') {
      const rel = _v1.copy(v.origin).sub(ship.pos);
      const hOrigin = rel.dot(ship.up);
      if (hOrigin < 40 && hOrigin > -12) {
        // contact points: feet (legs deployed) or engine skirt
        const legs = this.legs;
        const footR = 1.85 + (F9.s1.leg.span / 2 - 1.85) * legs;
        const footY = 8 + (F9.s1.leg.footY - 8) * legs;
        let minH = Infinity, onDeck = 0, total = 0;
        for (let i = 0; i < 4; i++) {
          const a = (F9.s1.leg.angleDeg[i] * Math.PI) / 180;
          const fp = _v3.set(footR * Math.cos(a), legs > 0.3 ? footY : 0, footR * Math.sin(a)).applyQuaternion(rb.quat).add(v.origin).sub(ship.pos);
          const dh = fp.dot(ship.up);
          const dx = fp.dot(ship.starboard), dz = fp.dot(ship.bow);
          total++;
          if (Math.abs(dx) <= OCISLY.deckWidth / 2 && Math.abs(dz) <= OCISLY.deckLength / 2) {
            onDeck++;
            if (dh < minH) minH = dh;
          }
        }
        if (onDeck > 0 && minH <= 0) {
          this.evaluateTouchdown(v, ship, onDeck, total);
          return;
        }
      }
    }
    // ocean
    const seaH = this.ship ? this.ship.seaHeightAt(v.origin.x, v.origin.z, this.envT) : 0;
    const lowY = this.presim ? OCISLY.deckHeight + FOOT_DROP : seaH;
    if (altOf(v.origin) <= lowY) {
      if (this.presim) {
        // pre-sim: virtual deck at the natural landing point
        this.touchdown = { t: this.t, outcome: 'success', vVert: -rb.vel.dot(upOf(rb.pos, _up)), vHor: 0, tiltDeg: 0, miss: 0, prop: this.s1Prop };
        this.bPhase = 'LANDED';
        this.ev('TOUCHDOWN', 'S1', { outcome: 'success', presim: true });
        v.alive = false;
        return;
      }
      const speed = rb.vel.length();
      this.ev('SPLASHDOWN', 'S1', { speed, dist: ship ? _v1.copy(v.origin).sub(ship.pos).length() : 0 });
      this.s1Eng.command('none', this.t);
      if (!this.touchdown) {
        const miss = ship ? Math.round(_v1.copy(v.origin).sub(ship.pos).length()) : 0;
        this.boosterFate = speed < 25 ? `soft splashdown ${miss} m from the droneship` : `crashed into the ocean ${miss} m from the droneship`;
        this.say(miss > 2000 ? 'host_splash_short' : 'host_offdeck', 1);
      }
      if (speed < 25) {
        this.bodies.S1.status = 'splashed';
        this.bPhase = 'LOST';
        v.kinematic = true;
        v.goneAt = this.envT + 40;
        rb.vel.set(0, 0, 0);
        rb.angVel.set(0, 0, 0);
      } else {
        this.destroy(v, 'ocean impact');
      }
      this.cancel('TOUCHDOWN');
      this.cancel('LANDING_BURN_START');
    }
    void bAxis;
  }

  private evaluateTouchdown(v: Vehicle, ship: ShipPose, onDeck: number, total: number): void {
    const rb = v.rb;
    const vRel = _v1.copy(rb.vel).sub(ship.vel);
    const vVert = -vRel.dot(ship.up);
    const vHor = vRel.addScaledVector(ship.up, vRel.dot(ship.up) * -1).length();
    const axis = _v2.set(0, 1, 0).applyQuaternion(rb.quat);
    const tilt = Math.acos(clamp(axis.dot(ship.up), -1, 1)) / D2R;
    const rel = _v3.copy(v.origin).sub(ship.pos);
    const dx = rel.dot(ship.starboard), dz = rel.dot(ship.bow);
    const miss = Math.hypot(dx, dz);
    const centerOn = Math.abs(dx) <= OCISLY.deckWidth / 2 - 1 && Math.abs(dz) <= OCISLY.deckLength / 2 - 1;
    let outcome: Touchdown['outcome'];
    let rud = false;
    if (!centerOn) outcome = 'offdeck';
    else if (this.legs < 0.9) { outcome = 'hard'; rud = true; }
    else if (vVert > 12) { outcome = 'hard'; rud = true; }
    else if (vVert > 6) outcome = 'hard';
    else if (tilt > 8 || vHor > 2 || onDeck < total) outcome = 'tipped';
    else outcome = 'success';
    this.touchdown = { t: this.t, outcome, vVert, vHor, tiltDeg: tilt, miss, prop: this.s1Prop };
    this.s1Eng.command('none', this.t);
    this.ev('TOUCHDOWN', 'S1', { outcome, vVert, vHor, tilt, miss, prop: this.s1Prop, legs: this.legs });
    this.lastLandingInfo.valid = false;
    if (outcome === 'offdeck') {
      this.boosterFate = `missed the deck by ${Math.round(Math.max(0, miss - OCISLY.deckWidth / 2))} m`;
      this.say('host_offdeck', 1);
      // keeps falling past the deck edge into the water (handled by the ocean check)
      rb.pos.addScaledVector(ship.up, 0.0);
      return;
    }
    if (rud) {
      this.boosterFate = `hard landing ${vVert.toFixed(1)} m/s — destroyed`;
      this.say('host_hard_landing', 1);
      this.attachToShip(v, ship, false);
      this.destroy(v, 'hard landing');
      v.kinematic = true;
      return;
    }
    if (outcome === 'success') {
      this.bPhase = 'LANDED';
      this.bodies.S1.status = 'landed';
      this.boosterFate = `landed on OCISLY (${vVert.toFixed(1)} m/s, ${miss.toFixed(1)} m from centre)`;
      this.say('lc_landed', 0.6);
      this.say('host_landed', 1.4);
      this.attachToShip(v, ship, true);
      return;
    }
    // hard (legs crushed) or tipped: topple over on the deck
    this.boosterFate = outcome === 'hard' ? `hard landing ${vVert.toFixed(1)} m/s — legs crushed, toppled` : `tipped over (tilt ${tilt.toFixed(1)}°, ${vHor.toFixed(1)} m/s lateral)`;
    this.say(outcome === 'hard' ? 'host_hard_landing' : 'host_tipped', 1);
    this.bPhase = 'LANDED';
    this.bodies.S1.status = 'tipped';
    this.attachToShip(v, ship, false);
    // topple direction: horizontal velocity / tilt direction in the deck plane
    const dir = _v4.copy(axis).addScaledVector(ship.up, -axis.dot(ship.up));
    const vh = _v1.copy(rb.vel).sub(ship.vel);
    vh.addScaledVector(ship.up, -vh.dot(ship.up));
    dir.addScaledVector(vh, 0.05);
    if (dir.lengthSq() < 1e-8) dir.copy(ship.starboard);
    dir.normalize();
    const tipAxisW = new Vector3().crossVectors(ship.up, dir).normalize();
    // pivot at the foot on the tilt side, in ship frame
    const pivotW = new Vector3().copy(v.origin).addScaledVector(dir, 6).addScaledVector(ship.up, -FOOT_DROP);
    const inv = _q1.copy(ship.quat).invert();
    this.tip = {
      axis: tipAxisW.applyQuaternion(inv), theta: Math.max(2 * D2R, tilt * D2R), rate: 0.05,
      pivot: pivotW, q0: this.landedRelQuat.clone(), relPivot: pivotW.clone().sub(ship.pos).applyQuaternion(inv), done: false,
    };
  }

  private attachToShip(v: Vehicle, ship: ShipPose, upright: boolean): void {
    const rb = v.rb;
    const inv = _q1.copy(ship.quat).invert();
    this.landedRelPos.copy(v.origin).sub(ship.pos).applyQuaternion(inv);
    this.landedRelQuat.copy(inv).multiply(rb.quat);
    if (upright) {
      // settle on the legs: body axis to deck normal, feet on deck
      const ax = _v1.set(0, 1, 0).applyQuaternion(this.landedRelQuat);
      _q1.setFromUnitVectors(ax, _v2.set(0, 1, 0));
      this.landedRelQuat.premultiply(_q1).normalize();
      this.landedRelPos.y = FOOT_DROP;
    }
    v.kinematic = true;
    v.passive = true;
    rb.angVel.set(0, 0, 0);
    this.fins.deployCmd = true;
    for (let i = 0; i < 4; i++) this.fins.cmd[i] = 0;
    this.s1Rcs.off();
  }

  private stepLandedBooster(v: Vehicle, dt: number): void {
    const ship = this.shipTarget(this.t);
    const rb = v.rb;
    this.s1Eng.step(dt, 101_325, rb.cg, this.s1Prop);
    this.fins.step(dt);
    this.s1Rcs.apply(null, dt);
    if (!ship) return;
    if (this.tip && !this.tip.done) {
      const tp = this.tip;
      // inverted pendulum about the foot pivot
      const r = rb.cg.y + FOOT_DROP;
      const I = rb.inertia.x + rb.mass * r * r;
      const acc = (rb.mass * 9.81 * r * Math.sin(tp.theta)) / I;
      tp.rate += acc * dt;
      const dth = tp.rate * dt;
      tp.theta += dth;
      _q1.setFromAxisAngle(tp.axis, dth);
      // rotate relative pose about the pivot (ship frame)
      this.landedRelQuat.premultiply(_q1).normalize();
      this.landedRelPos.sub(tp.relPivot).applyQuaternion(_q1).add(tp.relPivot);
      if (tp.theta > 84 * D2R) {
        tp.done = true;
        this.ev('RUD', 'S1', { reason: 'toppled on deck' });
      }
    }
    rb.quat.copy(ship.quat).multiply(this.landedRelQuat);
    const o = _v1.copy(this.landedRelPos).applyQuaternion(ship.quat).add(ship.pos);
    rb.setOrigin(o);
    v.origin.copy(o);
    rb.vel.copy(ship.vel);
    v.alt = altOf(rb.pos);
    atmosphere(v.alt, v.atmo);
    v.vAir.copy(rb.vel);
    v.aero.q = 0; v.aero.mach = 0;
    v.heat *= Math.exp(-dt / 20);
  }

  // =============================================================================================
  // mission end

  private checkMissionEnd(): void {
    if (this.missionEnded || this.presim) return;
    const s1 = this.bodies.S1.status;
    const boosterDone = ['landed', 'tipped', 'destroyed', 'splashed', 'gone'].includes(s1) && (this.bPhase === 'LANDED' || this.bPhase === 'LOST');
    const s2Done = this.s2Failed || !Number.isNaN(this.deployT) || this.bodies.S2.status === 'destroyed';
    if (boosterDone && s2Done && this.released) {
      this.missionEnded = true;
      this.ev('MISSION_END', undefined, { outcome: this.summaryOutcome() });
    }
  }

  summaryOutcome(): string {
    const td = this.touchdown;
    const landed = td?.outcome === 'success' && this.bodies.S1.status !== 'destroyed';
    const orbit = this.s2InOrbit && !this.payloadDamaged && !Number.isNaN(this.deployT);
    if (landed && orbit) return 'MISSION SUCCESS · BOOSTER LANDED';
    if (orbit) return 'PAYLOAD DEPLOYED · BOOSTER LOST';
    if (landed) return 'BOOSTER LANDED · MISSION FAILURE';
    return 'MISSION FAILURE';
  }

  // =============================================================================================
  // publishing (BodyState contract)

  publish(): void {
    const bodies = this.bodies;
    for (const v of this.vehicles) {
      if (!v.alive && v.goneAt === Infinity) continue;
      const rb = v.rb;
      rb.origin(v.origin);
      upOf(v.origin, _up);
      const vi = inertialVel(rb.pos, rb.vel, _v4);
      const speedI = vi.length();
      const gL = rb.aNG.dot(_v3.set(0, 1, 0).applyQuaternion(rb.quat)) / G0;
      for (const m of v.members) {
        const b = bodies[m.id];
        const off = _v1.set(0, m.offY, 0);
        b.pos.copy(off).applyQuaternion(rb.quat).add(v.origin);
        rb.pointVel(off, b.vel);
        b.quat.copy(rb.quat);
        b.angVel.copy(rb.angVel);
        b.altitude = altOf(b.pos);
        b.speedInertial = speedI;
        b.speed = b.vel.length();
        b.verticalSpeed = b.vel.dot(_up);
        b.mach = v.aero.mach;
        b.dynPressure = v.aero.q;
        b.ambientPressure = v.atmo.p;
        b.density = v.atmo.rho;
        b.downrange = Math.acos(clamp((b.pos.y + EARTH_RADIUS) / (b.altitude + EARTH_RADIUS), -1, 1)) * EARTH_RADIUS;
        b.gLoad = v.clamped ? 1 : gL;
        b.heating = m.id === 'S1' ? (v.kind === 'BOOSTER' ? v.heat : 0) : m.id === 'FAIRING_A' || m.id === 'FAIRING_B' ? v.heat : m.id === 'S2' && v.kind === 'UPPER' && !v.has('FAIRING_A') ? v.heat * 0.4 : 0;
        switch (m.id) {
          case 'S1': b.mass = SIM_FIGURES.s1Dry + this.s1Prop; b.propMass = this.s1Prop; b.propCapacity = SIM_FIGURES.s1Prop; break;
          case 'S2': b.mass = SIM_FIGURES.s2Dry + this.s2Prop; b.propMass = this.s2Prop; b.propCapacity = SIM_FIGURES.s2Prop; break;
          case 'PAYLOAD': b.mass = SIM_FIGURES.payloadMass; b.propMass = 0; b.propCapacity = 1; break;
          default: b.mass = SIM_FIGURES.fairingMass; b.propMass = 0; b.propCapacity = 1; break;
        }
        b.thrust = m.id === 'S1' ? this.s1Eng.totalThrust : m.id === 'S2' ? this.s2Eng.totalThrust : 0;
      }
    }
    const s1 = bodies.S1, s2 = bodies.S2;
    s1.propLox = this.s1Prop * (2.56 / 3.56); s1.propFuel = this.s1Prop / 3.56;
    s2.propLox = this.s2Prop * (2.56 / 3.56); s2.propFuel = this.s2Prop / 3.56;
    s1.legs = this.legs;
    s1.gridFins!.deploy = this.fins.deploy;
    if (this.bPhase !== 'PRELAUNCH') s1.phase = this.bPhase;
    // ship
    const sh = bodies.SHIP;
    if (this.ship) {
      const p = this.shipTarget(this.t)!;
      sh.pos.copy(p.pos); sh.quat.copy(p.quat); sh.vel.copy(p.vel);
      sh.altitude = OCISLY.deckHeight + p.heave;
      sh.speed = p.vel.length();
      sh.downrange = Math.acos(clamp((p.pos.y + EARTH_RADIUS) / (sh.altitude + EARTH_RADIUS), -1, 1)) * EARTH_RADIUS;
      sh.status = 'free';
    }
  }

  /** Ship pose at an arbitrary environment time (for render-time interpolation). */
  shipPoseAtEnv(envT: number, out: ShipPose): ShipPose | null {
    if (!this.ship) return null;
    return this.ship.pose(envT, out);
  }

  // =============================================================================================
  // predictions (timeline + HUD)

  landingInfo(): { valid: boolean; impact: Vector3; miss: number; burnStartT: number; touchdownT: number } {
    const L = this.lastLandingInfo;
    const ship = this.shipTarget(this.t);
    const active = ['COAST', 'FLIP', 'BOOST', 'ENTRY_BURN', 'AERO', 'LANDING_BURN'].includes(this.bPhase);
    L.valid = active && !!ship;
    if (!L.valid || !ship) return { valid: false, impact: L.impact, miss: 0, burnStartT: NaN, touchdownT: NaN };
    const v = this.find('BOOSTER');
    if (this.bPhase === 'LANDING_BURN' && v && !this.predValid) {
      // constant-deceleration extrapolation of the horizontal motion
      const tgo = Math.max(0, L.touchdownT - this.t);
      const vh = _v1.copy(v.rb.vel).sub(ship.vel);
      vh.addScaledVector(ship.up, -vh.dot(ship.up));
      L.impact.copy(v.origin).addScaledVector(vh, tgo * 0.5);
      L.impact.addScaledVector(ship.up, -_v2.copy(L.impact).sub(ship.pos).dot(ship.up));
    } else if (this.predValid) {
      L.impact.copy(this.pred.tdPos);
      upOf(ship.pos, _up);
      L.impact.addScaledVector(_up, -_v2.copy(L.impact).sub(ship.pos).dot(_up));
      if (this.bPhase !== 'AERO' && this.bPhase !== 'LANDING_BURN') L.burnStartT = this.pred.lbStartT;
      if (this.bPhase !== 'LANDING_BURN') L.touchdownT = this.pred.tdT;
    }
    const d = _v2.copy(L.impact).sub(ship.pos);
    d.addScaledVector(ship.up, -d.dot(ship.up));
    L.miss = d.length();
    return { valid: true, impact: L.impact, miss: L.miss, burnStartT: L.burnStartT, touchdownT: L.touchdownT };
  }

  /** Refine pending timeline markers from live state. */
  updatePredictions(): void {
    const N = this.nominal;
    const t = this.t;
    const mk = (type: SimEventType) => this.timeline.find((m) => m.type === type)!;
    const setPred = (type: SimEventType, v: number) => {
      const m = mk(type);
      if (m && !m.done && !m.cancelled && Number.isFinite(v)) m.t = v;
    };
    // MECO from propellant flow
    let mecoPred = this.mecoT;
    if (Number.isNaN(mecoPred)) {
      const md = this.s1Eng.mdot;
      if (this.released && md > 100) mecoPred = t + Math.max(0, this.s1Prop - GNC.mecoReserve) / md;
      else mecoPred = (N.MECO ?? 147) + (this.released ? 0 : 0);
      setPred('MECO', mecoPred);
    }
    const shift = mecoPred - (N.MECO ?? mecoPred);
    const sepPred = Number.isNaN(this.sepT) ? (Number.isNaN(this.sepDue) ? mecoPred + GNC.sepDelay : this.sepDue) : this.sepT;
    setPred('STAGE_SEP', sepPred);
    const sesPred = Number.isNaN(this.sesT) ? (Number.isNaN(this.sesDue) ? sepPred + GNC.sesDelay : this.sesDue) : this.sesT;
    setPred('SES1', sesPred);
    if (N.FAIRING_SEP !== undefined) setPred('FAIRING_SEP', Math.max(t, N.FAIRING_SEP + shift));
    // booster
    if (Number.isNaN(this.sepT)) {
      for (const k of ['ENTRY_BURN_START', 'LANDING_BURN_START', 'TOUCHDOWN'] as SimEventType[]) if (N[k] !== undefined) setPred(k, N[k]! + shift);
    } else if (this.predValid) {
      if (!this.entryDone && Number.isFinite(this.pred.ebStartT)) setPred('ENTRY_BURN_START', this.pred.ebStartT);
      if (this.bPhase === 'AERO' && Number.isFinite(this.lastLandingInfo.burnStartT)) setPred('LANDING_BURN_START', this.lastLandingInfo.burnStartT);
      else if (Number.isFinite(this.pred.lbStartT)) setPred('LANDING_BURN_START', this.pred.lbStartT);
      if (Number.isFinite(this.pred.tdT)) setPred('TOUCHDOWN', this.bPhase === 'LANDING_BURN' ? this.lastLandingInfo.touchdownT : this.pred.tdT);
    }
    if (this.bPhase === 'LANDING_BURN') setPred('TOUCHDOWN', this.lastLandingInfo.touchdownT);
    // S2
    if (Number.isNaN(this.secoT)) {
      // PEG's time-to-go is measured from its last major cycle (frozen for the last ~8 s)
      if (!Number.isNaN(this.sesT) && this.peg.ok && this.peg.tUpd >= 0) setPred('SECO', this.peg.tUpd + this.peg.T);
      else if (N.SECO !== undefined) setPred('SECO', N.SECO + shift);
    }
    const seco = Number.isNaN(this.secoT) ? mk('SECO').t : this.secoT;
    if (Number.isNaN(this.deployT)) setPred('PAYLOAD_DEPLOY', seco + GNC.s2DeployDelay);
  }

  /** Next pending key event time (for warp auto-drop). */
  nextKeyEventT(): number {
    let best = Infinity;
    if (!this.ignited) best = -3;
    for (const m of this.timeline) if (!m.done && !m.cancelled && m.t > this.t - 1 && m.t < best) best = m.t;
    return best;
  }

  /** True while any engine is burning or a vehicle is under active powered control. */
  anyBurning(): boolean {
    if (this.ignited && !this.released && !this.aborted) return true;
    return this.s1Eng.anyOn() || this.s2Eng.anyOn();
  }
}
