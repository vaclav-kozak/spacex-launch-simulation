// PLACEHOLDER simulation (parametric, not physics). OWNER: sim agent — replace entirely,
// keeping the public API below (App, HUD, cameras, audio call it).

import { Vector3, Quaternion } from 'three';
import type { EventBus } from '../core/events';
import type { Settings } from '../core/settings';
import type { BodyId, BodyState, EngineState, SimSnapshot, TimelineMarker } from '../core/types';
import { COUNTDOWN_START, SHIP_NOMINAL_DOWNRANGE, LAUNCH_AZIMUTH_DEG, PAD_ELEVATION } from '../core/constants';
import { F9, OCISLY } from '../core/vehicleSpec';
import { altitudeOf, pointAlongAzimuth, padHeadingDir, upAt, quatFromAxis } from '../core/frames';

export interface ManualInput {
  /** 0..1 */
  throttle: number;
  /** -1..1 gimbal commands (body X / body Z) */
  pitch: number;
  yaw: number;
}

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

function engines(n: number): EngineState[] {
  return Array.from({ length: n }, () => ({
    on: false, throttle: 0, gimbalX: 0, gimbalZ: 0, spool: 0, ignitionT: -Infinity, thrust: 0,
  }));
}

function body(id: BodyId, nEng: number): BodyState {
  return {
    id, status: 'stacked', pos: new Vector3(), vel: new Vector3(), quat: new Quaternion(), angVel: new Vector3(),
    mass: 0, propMass: 0, propCapacity: 1, altitude: 0, speedInertial: 0, speed: 0, verticalSpeed: 0, mach: 0,
    dynPressure: 0, ambientPressure: 101325, density: 1.225, downrange: 0, gLoad: 1, engines: engines(nEng),
    thrust: 0, rcs: new Array(8).fill(0), heating: 0,
  };
}

export class Simulation {
  t = COUNTDOWN_START;
  paused = false;
  held = false;
  warp = 1;
  private snap: SimSnapshot;
  readonly history: SimHistory = { start: 0, end: 0, sample: () => null };

  constructor(public settings: Settings, private events: EventBus) {
    const bodies = {
      S1: body('S1', 9), S2: body('S2', 1), FAIRING_A: body('FAIRING_A', 0), FAIRING_B: body('FAIRING_B', 0),
      PAYLOAD: body('PAYLOAD', 0), SHIP: body('SHIP', 0),
    } as Record<BodyId, BodyState>;
    bodies.S1.gridFins = { deploy: 0, angles: [0, 0, 0, 0] };
    bodies.S1.legs = 0;
    bodies.S1.phase = 'PRELAUNCH';
    bodies.SHIP.status = 'free';
    pointAlongAzimuth(SHIP_NOMINAL_DOWNRANGE, LAUNCH_AZIMUTH_DEG, OCISLY.deckHeight, bodies.SHIP.pos);
    quatFromAxis(upAt(bodies.SHIP.pos), new Vector3(0, 0, 1), bodies.SHIP.quat);
    this.snap = { t: this.t, paused: false, countdownHeld: false, warp: 1, bodies, wind: new Vector3(3, 0, 1), timeline: this.buildTimeline() };
    this.compute();
  }

  private buildTimeline(): TimelineMarker[] {
    const m = (type: TimelineMarker['type'], label: string, t: number): TimelineMarker => ({ type, label, t, done: false });
    return [
      m('LIFTOFF', 'LIFTOFF', 0), m('MAX_Q', 'MAX-Q', 70), m('MECO', 'MECO', 147), m('STAGE_SEP', 'STAGE SEP', 150),
      m('SES1', 'SES-1', 157), m('FAIRING_SEP', 'FAIRING', 190), m('ENTRY_BURN_START', 'ENTRY BURN', 380),
      m('LANDING_BURN_START', 'LANDING BURN', 485), m('TOUCHDOWN', 'LANDING', 510), m('SECO', 'SECO', 525),
      m('PAYLOAD_DEPLOY', 'DEPLOY', 900),
    ];
  }

  /** Fast-forward to mission time t (s). */
  seek(t: number): void { this.t = t; this.compute(); }

  advance(realDt: number): void {
    if (this.paused) return;
    if (this.held && this.t < -3) return;
    this.t += realDt * this.warp;
    this.compute();
  }

  getSnapshot(): SimSnapshot { return this.snap; }

  // ---- actions ----
  liftoffNow(): void { if (this.t < -3) this.t = -3.2; }
  toggleHold(): void { this.held = !this.held; this.events.emit({ type: this.held ? 'COUNTDOWN_HOLD' : 'COUNTDOWN_RESUME', t: this.t }); }
  stageSeparation(): void {}
  fairingSeparation(): void {}
  setWarp(w: number): void { this.warp = w; this.events.emit({ type: 'WARP_CHANGED', t: this.t, data: { warp: w } }); }
  setPaused(p: boolean): void { this.paused = p; }
  setManualInput(_i: ManualInput): void {}
  applySettings(s: Settings): void { this.settings = s; }
  getSummary(): MissionSummary { return { outcome: 'placeholder', lines: [] }; }

  private compute(): void {
    const t = this.t, s = this.snap, b = s.bodies;
    s.t = t; s.paused = this.paused; s.countdownHeld = this.held; s.warp = this.warp;
    const tf = Math.max(0, t);
    const dir = padHeadingDir(LAUNCH_AZIMUTH_DEG);
    const alt = PAD_ELEVATION + 4 + 0.5 * 12 * tf * tf * Math.max(0.1, 1 - tf / 400);
    const down = Math.pow(Math.max(0, tf - 20), 2) * 6;
    const p = new Vector3(0, alt, 0).addScaledVector(dir, down);
    const pitch = Math.min(1.3, Math.max(0, (tf - 10) / 150));
    const axis = new Vector3(0, Math.cos(pitch), 0).addScaledVector(dir, Math.sin(pitch));
    b.S1.pos.copy(p);
    quatFromAxis(axis, new Vector3(0, 0, 1), b.S1.quat);
    const on = t > -3 && t < 147;
    b.S1.engines.forEach((e) => { e.on = on; e.throttle = on ? 1 : 0; e.spool = on ? 1 : 0; e.thrust = on ? 845e3 : 0; });
    b.S1.phase = t < 0 ? 'PRELAUNCH' : 'ASCENT';
    const s2off = new Vector3(0, F9.s2.mountY, 0).applyQuaternion(b.S1.quat);
    b.S2.pos.copy(p).add(s2off);
    b.S2.quat.copy(b.S1.quat);
    const foff = new Vector3(0, F9.fairing.baseY, 0).applyQuaternion(b.S2.quat);
    for (const id of ['FAIRING_A', 'FAIRING_B', 'PAYLOAD'] as BodyId[]) { b[id].pos.copy(b.S2.pos).add(foff); b[id].quat.copy(b.S2.quat); }
    for (const id of Object.keys(b) as BodyId[]) {
      const bb = b[id];
      bb.altitude = altitudeOf(bb.pos);
      bb.speed = bb.speedInertial = tf * 15;
      bb.ambientPressure = 101325 * Math.exp(-bb.altitude / 8400);
      bb.density = 1.225 * Math.exp(-bb.altitude / 8400);
    }
    for (const m of s.timeline) m.done = t >= m.t;
  }
}
