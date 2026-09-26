// Snapshot + event contract between the simulation and every consumer
// (render, cameras, audio, HUD). OWNER: sim. Others read only.
// Vectors are three.js Vector3/Quaternion holding W-frame doubles (see frames.ts).

import type { Vector3, Quaternion } from 'three';

export type BodyId = 'S1' | 'S2' | 'FAIRING_A' | 'FAIRING_B' | 'PAYLOAD' | 'SHIP';

export type BodyStatus =
  | 'stacked' // attached to the stack (pose derived from S1)
  | 'free' // flying on its own
  | 'landed' // S1 on deck
  | 'tipped' // S1 fell over on deck
  | 'splashed' // in the ocean
  | 'destroyed' // RUD
  | 'orbit' // S2/payload reached orbit
  | 'deployed' // payload released
  | 'gone'; // no longer simulated / rendered

export type S1Phase =
  | 'PRELAUNCH'
  | 'ASCENT'
  | 'COAST'
  | 'FLIP'
  | 'ENTRY_BURN'
  | 'AERO'
  | 'LANDING_BURN'
  | 'LANDED'
  | 'LOST'
  /** off-nominal only: 3-engine burn toward the droneship after an early staging (nose forward) */
  | 'BOOST';

/**
 * Engine semantics (sim):
 *  - S1 engines[0] = center, [1..8] outer ring at (k-1)*45° (vehicleSpec.engineAngleDeg).
 *    Entry burn: [0,1,5]; landing burn: [0]. S2 engines[0] = MVac.
 *  - gimbal: thrust direction in body = Rz(gimbalZ)·Rx(gimbalX)·(0,1,0)
 *      = (−sin gZ·cos gX, cos gZ·cos gX, sin gX); the nozzle/exhaust points the opposite way.
 *    three.js: engineMesh.rotation.set(gimbalX, 0, gimbalZ, 'ZXY') about the gimbal pivot.
 *  - spool: startup ramp ~0.9 s (MVac 1.6 s), shutdown ~0.35 s; `on` stays true while spooling down.
 */
export interface EngineState {
  on: boolean;
  /** 0..1 fraction of max thrust (0 when off) */
  throttle: number;
  /** gimbal angles (rad) about body X and body Z */
  gimbalX: number;
  gimbalZ: number;
  /** 0..1 spool-up/down factor (startup transient; plume/audio should scale with it) */
  spool: number;
  /** sim time of last ignition command (s), -Infinity if never */
  ignitionT: number;
  /** current thrust (N) */
  thrust: number;
}

export interface BodyState {
  id: BodyId;
  status: BodyStatus;
  /** W position of the body reference point (nozzle-exit center / deck center for SHIP) */
  pos: Vector3;
  /** Earth-relative velocity in W (m/s) */
  vel: Vector3;
  /** body -> W rotation */
  quat: Quaternion;
  /** body-frame angular velocity (rad/s) */
  angVel: Vector3;
  mass: number;
  propMass: number;
  propCapacity: number;

  // derived telemetry (filled by sim every step)
  altitude: number;
  /** inertial speed (m/s) — what the webcast shows */
  speedInertial: number;
  /** Earth-relative speed */
  speed: number;
  verticalSpeed: number;
  mach: number;
  dynPressure: number; // Pa
  ambientPressure: number; // Pa
  density: number; // kg/m^3
  /** surface distance from pad (m) */
  downrange: number;
  /** body-axis acceleration felt (g) */
  gLoad: number;

  engines: EngineState[];
  /** total thrust (N) */
  thrust: number;
  /** RCS thruster firing intensity 0..1 per nozzle: rcs[i] ↔ vehicleSpec.s1.rcs.nozzles[i] (exhaust
   * `dir` in body frame). S1: pods at interstage y=44. S2 uses the same 8-nozzle layout with pods at
   * S2 body y=12.9 (radius 1.9). Fires in pulses (bang-bang, ≥80 ms) — render as puffs. */
  rcs: number[];
  /** S1 only. Fin i at body angle 45°+90°·i (from +X toward +Z). angles[i] = rotation (rad, ±0.38) of
   * fin i about its OUTWARD RADIAL axis (right-hand rule); 0 = fin plane contains the body axis. */
  gridFins?: { deploy: number; angles: [number, number, number, number] };
  /** S1 only, 0..1 */
  legs?: number;
  /** 0..1 aerothermal heating glow (octaweb during entry, fairing/S2 nose at max-Q etc.) */
  heating: number;
  /** fairing halves: 0..1 parafoil deployment. While deployed the canopy flies ~45 m above the body
   * origin along local up (W), the half hangs below it with body +Y roughly up. */
  parafoil?: number;
  phase?: S1Phase;
  /** S1/S2: propellant split (kg), O/F 2.56 */
  propLox?: number;
  propFuel?: number;
}

export type SimEventType =
  | 'CALLOUT' // data.text: countdown / launch-control line, data.voice: 'lc' | 'host'
  | 'COUNTDOWN_HOLD'
  | 'COUNTDOWN_RESUME'
  | 'IGNITION_SEQUENCE' // T-3: TEA-TEB green flash, engines start
  | 'LIFTOFF'
  | 'MAX_Q'
  | 'THROTTLE_DOWN'
  | 'THROTTLE_UP'
  | 'SUPERSONIC'
  | 'MECO'
  | 'STAGE_SEP'
  | 'SES1' // S2 ignition
  | 'FAIRING_SEP'
  | 'BOOSTER_FLIP'
  | 'GRIDFINS_DEPLOY'
  | 'APOGEE' // booster
  | 'ENTRY_BURN_START'
  | 'ENTRY_BURN_END'
  | 'SONIC_BOOM' // booster decelerated through Mach 1 (audio schedules arrival per listener)
  | 'LANDING_BURN_START'
  | 'LEGS_DEPLOY'
  | 'TOUCHDOWN' // data.outcome: 'success' | 'hard' | 'tipped' | 'offdeck'
  | 'SPLASHDOWN' // body
  | 'RUD' // body, data.reason
  | 'PARAFOIL_DEPLOY'
  | 'SECO'
  | 'ORBIT'
  | 'PAYLOAD_DEPLOY'
  | 'FLAMEOUT' // ran out of propellant
  | 'MISSION_END'
  | 'WARP_CHANGED'
  | 'SETTINGS_CHANGED';

export interface SimEvent {
  type: SimEventType;
  /** mission time (s rel. T-0) */
  t: number;
  /** true when emitted while fast-forwarding (seek / pre-sim catch-up): update state, skip effects */
  seeking?: boolean;
  body?: BodyId;
  data?: Record<string, unknown>;
}

/** Key mission events with nominal/predicted times for the HUD timeline arc + warp auto-drop. */
export interface TimelineMarker {
  type: SimEventType;
  label: string;
  /** predicted/actual mission time */
  t: number;
  done: boolean;
  /** event will not happen any more (e.g. booster lost before touchdown) */
  cancelled?: boolean;
}

export interface SimSnapshot {
  /** mission time (s rel. T-0; negative during countdown) */
  t: number;
  paused: boolean;
  countdownHeld: boolean;
  warp: number;
  /** current allowed warp ceiling (8 during burns / near key events, 100 in coast) */
  maxWarp?: number;
  /** environment clock (s since sim start; runs during countdown holds, stops when paused). Use it
   * for waves / ship motion (the sim samples core/waves.ts at this time). */
  envT?: number;
  bodies: Record<BodyId, BodyState>;
  /** wind vector at 10 m in W (m/s, direction the air moves) */
  wind: Vector3;
  timeline: TimelineMarker[];
  /** booster guidance extras for HUD / manual landing */
  landing?: {
    /** predicted impact point (W) and miss distance vs deck center (m) */
    impactPoint: Vector3;
    missDistance: number;
    /** predicted time of landing-burn ignition / touchdown (mission time) */
    burnStartT: number;
    touchdownT: number;
    manual: boolean;
    /** true while the prediction is meaningful (booster descending toward the ship) */
    valid?: boolean;
  };
}
