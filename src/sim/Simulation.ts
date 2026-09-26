// Real-time wrapper around the headless FlightSim. OWNER: sim.
// Fixed-step accumulator with warp, pause, countdown hold/abort/recycle, render-time
// interpolation, replay history, seek (fast-forward / rebuild), mission summary.

import { Vector3, Quaternion } from 'three';
import type { EventBus } from '../core/events';
import type { Settings } from '../core/settings';
import type { BodyId, BodyState, SimEvent, SimEventType, SimSnapshot } from '../core/types';
import { COUNTDOWN_START, LAUNCH_AZIMUTH_DEG, SHIP_NOMINAL_DOWNRANGE } from '../core/constants';
import { pointAlongAzimuth } from '../core/frames';
import { F9 } from '../core/vehicleSpec';
import { FlightSim, type ManualInput } from './FlightSim';
import { History, BODY_IDS } from './history';
import { copyBody, makeBody } from './bodies';
import { makeShipPose } from './ship';
import { SIM_FIGURES } from './simconst';

export type { ManualInput } from './FlightSim';

export interface MissionSummary {
  outcome: string;
  lines: { label: string; value: string }[];
}

export interface SimHistory {
  /** mission-time range available */
  readonly start: number;
  readonly end: number;
  sample(t: number): SimSnapshot | null;
}

const WARPS = [1, 2, 4, 8, 30, 100];
/** max real ms spent stepping per frame (sim falls behind real time beyond this) */
const FRAME_BUDGET_MS = 28;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fmtFlux(w: number): string {
  if (w >= 1e6) return `${(w / 1e6).toFixed(1)} MW/m²`;
  if (w >= 1e4) return `${(w / 1e3).toFixed(0)} kW/m²`;
  return `${w.toFixed(0)} W/m²`;
}

function fmtT(t: number): string {
  if (!Number.isFinite(t)) return '—';
  const s = Math.abs(Math.round(t));
  const m = Math.floor(s / 60);
  return `T${t < 0 ? '−' : '+'}${m}:${String(s % 60).padStart(2, '0')}`;
}

interface Nominal {
  station: Vector3;
  times: Partial<Record<SimEventType, number>>;
  ms: number;
  ok: boolean;
}

let nominalCache: { key: string; nom: Nominal } | null = null;

/** Deterministic nominal pre-simulation (no wind, no ship) to place the droneship. */
export function runNominal(settings: Settings): Nominal {
  const key = 'v1';
  if (nominalCache && nominalCache.key === key) return nominalCache.nom;
  const t0 = now();
  const times: Partial<Record<SimEventType, number>> = {};
  const fs = new FlightSim(settings, () => {}, { presim: true, station: null, startT: -3.2 });
  let ok = false;
  const station = new Vector3();
  try {
    while (fs.t < 800) {
      fs.step(fs.chooseDt() * (fs.t > 0 ? 2 : 1));
      if (fs.touchdown) {
        ok = true;
        const b = fs.bodies.S1;
        station.copy(b.pos);
        break;
      }
      if (fs.bPhase === 'LOST') break;
    }
  } catch (e) {
    console.error('[sim] nominal pre-sim failed', e);
  }
  Object.assign(times, fs.eventTimes);
  if (!ok) pointAlongAzimuth(SHIP_NOMINAL_DOWNRANGE, LAUNCH_AZIMUTH_DEG, 0, station);
  const nom: Nominal = { station, times, ms: now() - t0, ok };
  nominalCache = { key, nom };
  return nom;
}

export class Simulation {
  paused = false;
  warp = 1;
  private core!: FlightSim;
  private nominal: Nominal;
  private acc = 0;
  private snap: SimSnapshot;
  private live: SimSnapshot;
  private prev: Record<BodyId, BodyState>;
  private prevT = 0;
  private prevEnvT = 0;
  private hist = new History(120, 30);
  private failed = false;
  private recycleT = NaN;
  private lastMaxWarp = 8;
  private readonly shipTmp = makeShipPose();
  readonly history: SimHistory;
  /** real ms of the last pre-sim */
  readonly nominalMs: number;

  constructor(public settings: Settings, private events: EventBus) {
    this.nominal = runNominal(settings);
    this.nominalMs = this.nominal.ms;
    const mk = (): Record<BodyId, BodyState> => {
      const b = {} as Record<BodyId, BodyState>;
      for (const id of BODY_IDS) b[id] = makeBody(id);
      return b;
    };
    this.prev = mk();
    this.snap = {
      t: COUNTDOWN_START, paused: false, countdownHeld: false, warp: 1, maxWarp: 8, envT: 0, bodies: mk(),
      wind: new Vector3(), timeline: [],
      landing: { impactPoint: new Vector3(), missDistance: 0, burnStartT: NaN, touchdownT: NaN, manual: false, valid: false },
    };
    this.live = {
      t: COUNTDOWN_START, paused: false, countdownHeld: false, warp: 1, maxWarp: 8, envT: 0, bodies: mk(),
      wind: new Vector3(), timeline: [],
      landing: { impactPoint: new Vector3(), missDistance: 0, burnStartT: NaN, touchdownT: NaN, manual: false, valid: false },
    };
    const self = this;
    this.history = {
      get start() { return self.hist.start; },
      get end() { return self.hist.end; },
      sample: (t: number) => self.hist.sample(t, self.snap),
    };
    this.rebuild(COUNTDOWN_START);
    this.compose(0);
  }

  // ------------------------------------------------------------------------------------------
  get t(): number {
    return this.snap.t;
  }
  get held(): boolean {
    return this.core.held || this.core.aborted;
  }
  /** direct access for tests / tooling */
  get flight(): FlightSim {
    return this.core;
  }

  private emit = (e: SimEvent): void => {
    this.events.emit(e);
  };

  private rebuild(startT: number): void {
    this.core = new FlightSim(this.settings, this.emit, {
      station: this.nominal.station, nominal: this.nominal.times, startT,
    });
    this.acc = 0;
    this.hist.clear();
    this.syncPrev();
    this.recycleT = NaN;
  }

  private syncPrev(): void {
    for (const id of BODY_IDS) copyBody(this.prev[id], this.core.bodies[id]);
    this.prevT = this.core.t;
    this.prevEnvT = this.core.envT;
  }

  private stepCore(dt: number): void {
    try {
      this.core.step(dt);
    } catch (e) {
      if (!this.failed) console.error('[sim] step failed', e);
      this.failed = true;
      this.paused = true;
    }
  }

  // ------------------------------------------------------------------------------------------
  // time

  advance(realDt: number): void {
    if (this.paused || this.failed) {
      this.compose(this.alpha());
      return;
    }
    realDt = Math.min(Math.max(realDt, 0), 0.1);
    this.updateWarpLimit();
    this.acc += realDt * this.warp;
    const t0 = now();
    let n = 0;
    for (;;) {
      const dt = this.core.chooseDt();
      if (this.acc < dt) break;
      // keep the state before the last step of this frame for interpolation
      if (this.acc - dt < this.core.chooseDt()) this.syncPrev();
      this.stepCore(dt);
      this.acc -= dt;
      n++;
      this.recordHistory();
      if ((n & 15) === 0 && now() - t0 > FRAME_BUDGET_MS) {
        this.acc = 0;
        this.syncPrev();
        break;
      }
      if (this.failed) break;
    }
    if ((n & 7) === 0 || n > 0) this.core.updatePredictions();
    this.handleRecycle();
    this.compose(this.alpha());
  }

  private alpha(): number {
    const dt = this.core.chooseDt();
    return Math.max(0, Math.min(1, this.acc / dt));
  }

  private handleRecycle(): void {
    if (this.core.recyclePending) {
      if (Number.isNaN(this.recycleT)) this.recycleT = this.core.envT + 4;
      else if (this.core.envT >= this.recycleT) {
        this.rebuild(COUNTDOWN_START);
        this.emit({ type: 'COUNTDOWN_RESUME', t: this.core.t, data: { recycled: true } });
      }
    }
  }

  private maxWarpNow(): number {
    const c = this.core;
    if (!c.released) return 8;
    if (c.anyBurning()) return 8;
    let allPassive = true;
    for (const v of c.vehicles) if (v.alive && !v.kinematic && !v.passive) allPassive = false;
    const dtNext = c.nextKeyEventT() - c.t;
    let w = 8;
    if (dtNext > 30 * 4) w = 30;
    if (w === 30 && allPassive && dtNext > 100 * 4) w = 100;
    return w;
  }

  private updateWarpLimit(): void {
    const m = this.maxWarpNow();
    this.lastMaxWarp = m;
    if (this.warp > m) {
      this.warp = m;
      this.emit({ type: 'WARP_CHANGED', t: this.core.t, data: { warp: m, auto: true } });
    }
  }

  private recordHistory(): void {
    this.fillLive();
    this.hist.maybeRecord(this.live);
  }

  private fillLive(): void {
    const s = this.live, c = this.core;
    s.t = c.t;
    s.envT = c.envT;
    s.paused = this.paused;
    s.countdownHeld = this.held;
    s.warp = this.warp;
    s.maxWarp = this.lastMaxWarp;
    s.timeline = c.timeline;
    s.bodies = c.bodies;
    this.fillWind(s.wind);
    this.fillLanding(s);
  }

  private fillWind(out: Vector3): void {
    const en = { e: 0, n: 0 };
    this.core.wind.meanEN(10, en);
    // at the pad: east = +X, north = −Z
    out.set(en.e, 0, -en.n);
  }

  private fillLanding(s: SimSnapshot): void {
    const L = this.core.landingInfo();
    const d = s.landing!;
    d.valid = L.valid;
    d.manual = !!this.settings.manualLanding;
    if (L.valid) {
      d.impactPoint.copy(L.impact);
      d.missDistance = L.miss;
      d.burnStartT = L.burnStartT;
      d.touchdownT = L.touchdownT;
    }
  }

  /** Build the render snapshot interpolated between the previous and current core state. */
  private compose(alpha: number): void {
    const s = this.snap, c = this.core;
    const a = alpha;
    s.t = this.prevT + (c.t - this.prevT) * a;
    s.envT = this.prevEnvT + (c.envT - this.prevEnvT) * a;
    s.paused = this.paused;
    s.countdownHeld = this.held;
    s.warp = this.warp;
    s.maxWarp = this.lastMaxWarp;
    s.timeline = c.timeline;
    for (const id of BODY_IDS) {
      const dst = s.bodies[id], cur = c.bodies[id], pr = this.prev[id];
      copyBody(dst, cur);
      if (id !== 'SHIP' && pr.status === cur.status && a < 1) {
        dst.pos.copy(pr.pos).lerp(cur.pos, a);
        dst.vel.copy(pr.vel).lerp(cur.vel, a);
        dst.quat.copy(pr.quat).slerp(cur.quat, a);
      }
    }
    // ship at the exact render time (waves run on envT)
    const sp = c.shipPoseAtEnv(s.envT, this.shipTmp);
    if (sp) {
      const b = s.bodies.SHIP;
      b.pos.copy(sp.pos); b.quat.copy(sp.quat); b.vel.copy(sp.vel);
    }
    // landed booster rides the deck: keep the relative pose consistent with the render-time ship pose
    const s1 = s.bodies.S1;
    if (sp && (s1.status === 'landed' || s1.status === 'tipped') && c.bodies.S1.status === s1.status) {
      const cs = c.bodies.SHIP;
      _rel.copy(c.bodies.S1.pos).sub(cs.pos).applyQuaternion(_qi.copy(cs.quat).invert());
      _qr.copy(_qi).multiply(c.bodies.S1.quat);
      s1.pos.copy(_rel).applyQuaternion(sp.quat).add(sp.pos);
      s1.quat.copy(sp.quat).multiply(_qr);
    }
    this.fillWind(s.wind);
    this.fillLanding(s);
  }

  getSnapshot(): SimSnapshot {
    return this.snap;
  }

  /** Fast-forward to mission time t (s). Rebuilds from the start when seeking backwards. */
  seek(t: number): void {
    if (!Number.isFinite(t)) return;
    t = Math.max(COUNTDOWN_START, Math.min(t, 3600));
    if (t < this.core.t - 1e-6 || this.core.aborted) this.rebuild(COUNTDOWN_START);
    const c = this.core;
    if (c.held && !c.ignited) c.toggleHold();
    c.seeking = true;
    const histFrom = t - this.hist.cap / 30;
    try {
      while (c.t < t - 1e-9) {
        if (c.t < -3.5 && t > -3) {
          // skip the quiet part of the countdown
          c.liftoffNowSeek(Math.min(t, -3.5));
        }
        const dt = c.chooseDt();
        this.stepCore(dt);
        if (c.t >= histFrom) this.recordHistory();
        if (this.failed) break;
        if (c.recyclePending) break;
      }
    } finally {
      c.seeking = false;
    }
    c.dropStaleCallouts();
    c.updatePredictions();
    this.acc = 0;
    this.syncPrev();
    this.updateWarpLimit();
    this.compose(1);
  }

  // ------------------------------------------------------------------------------------------
  // actions

  liftoffNow(): void {
    this.core.liftoffNow();
    this.syncPrev();
  }
  toggleHold(): void {
    this.core.toggleHold();
  }
  stageSeparation(): void {
    this.core.stageSeparation();
  }
  fairingSeparation(): void {
    this.core.fairingSeparation();
  }
  /** Disable the automatic fairing jettison (off-nominal testing / "never" option). */
  setAutoFairing(on: boolean): void {
    this.core.setAutoFairing(on);
  }
  setWarp(w: number): void {
    let best = 1;
    for (const x of WARPS) if (x <= w) best = x;
    const m = this.maxWarpNow();
    this.lastMaxWarp = m;
    best = Math.min(best, m);
    if (best === this.warp) return;
    this.warp = best;
    this.emit({ type: 'WARP_CHANGED', t: this.core.t, data: { warp: best } });
  }
  setPaused(p: boolean): void {
    this.paused = p;
    this.snap.paused = p;
  }
  setManualInput(i: ManualInput): void {
    this.core.setManualInput(i);
  }
  applySettings(s: Settings): void {
    this.settings = { ...s };
    this.core.applySettings(this.settings);
  }

  getSummary(): MissionSummary {
    return buildSummary(this.core, this.settings);
  }
}

const _rel = new Vector3();
const _qi = new Quaternion();
const _qr = new Quaternion();

export function buildSummary(c: FlightSim, settings: Settings): MissionSummary {
  const lines: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => lines.push({ label, value });
  const E = c.eventTimes;
  if (E.MAX_Q !== undefined) add('Max-Q', `${fmtT(E.MAX_Q)} · ${(c.qPeak / 1000).toFixed(1)} kPa`);
  if (c.mecoState) {
    add('MECO', `${fmtT(c.mecoT)} · ${(c.mecoState.speedI / 1000).toFixed(2)} km/s · ${(c.mecoState.alt / 1000).toFixed(1)} km${c.manualStaging ? ' (manual staging)' : ''}`);
    add('Booster reserve at MECO', `${(c.mecoState.prop / 1000).toFixed(1)} t`);
  }
  if (!Number.isNaN(c.fairingSepT)) {
    add('Fairing separation', `${fmtT(c.fairingSepT)}${c.manualFairing ? ' (manual)' : ''} · ${fmtFlux(c.fairingSepHeat)}${c.payloadDamaged ? ' — payload overheated' : ''}`);
  } else if (c.released) add('Fairing separation', 'did not separate');
  if (!Number.isNaN(c.secoT) && c.orbit) {
    const o = c.orbit;
    add('SECO', `${fmtT(c.secoT)} · ${c.s2InOrbit ? `orbit ${(o.perigee / 1000).toFixed(0)} × ${(o.apogee / 1000).toFixed(0)} km, i ${o.incDeg.toFixed(1)}°` : `suborbital (perigee ${(o.perigee / 1000).toFixed(0)} km)`}`);
    add('S2 propellant left', `${(c.s2Prop / 1000).toFixed(1)} t`);
  } else if (c.s2Failed) add('Second stage', c.s2FailReason || 'failed');
  if (!Number.isNaN(c.deployT)) add('Payload deploy', `${fmtT(c.deployT)}${c.payloadDamaged ? ' · satellites damaged' : ` · ${F9.payload.count} Starlink`}`);
  // booster
  if (!Number.isNaN(c.boostStartT)) add('Booster boost-back', `${fmtT(c.boostStartT)} → ${fmtT(c.boostEndT)}`);
  if (!Number.isNaN(c.entryStartT)) add('Entry burn', `${fmtT(c.entryStartT)} · ${Number.isNaN(c.entryEndT) ? '—' : `${(c.entryEndT - c.entryStartT).toFixed(1)} s`}`);
  if (!Number.isNaN(c.landingStartT)) add('Landing burn', `${fmtT(c.landingStartT)}`);
  const td = c.touchdown;
  if (td) {
    add('Touchdown', `${fmtT(td.t)} · ${td.vVert.toFixed(1)} m/s · ${td.miss.toFixed(1)} m from centre · tilt ${td.tiltDeg.toFixed(1)}°`);
    add('Booster propellant left', `${(td.prop / 1000).toFixed(2)} t of ${(SIM_FIGURES.s1Prop / 1000).toFixed(0)} t`);
  }
  add('Booster', c.boosterFate || (c.released ? 'in flight' : 'on the pad'));
  const fa = c.bodies.FAIRING_A.status, fb = c.bodies.FAIRING_B.status;
  if (fa === 'splashed' || fb === 'splashed') add('Fairing halves', `${[fa, fb].filter((s) => s === 'splashed').length}/2 under parafoil, splashdown`);
  add('Conditions', `sea state ${settings.seaState} · wind ${settings.windSpeed} m/s from ${settings.windFromDeg}°${settings.manualLanding ? ' · manual landing' : ''}`);
  return { outcome: c.summaryOutcome(), lines };
}
