// Simulation figures + GNC tuning. OWNER: sim. Values derived from core/vehicleSpec.ts;
// any deviation from vehicleSpec is documented in docs/notes/sim.md.

import { F9, MERLIN_1D, MERLIN_VAC } from '../core/vehicleSpec';
import { G0 } from '../core/constants';

/** S1 nozzle-exit plane height above the pad surface while on the launch mount (m) */
export const PAD_MOUNT_HEIGHT = 4.0;

export const SIM_FIGURES = {
  s1Dry: F9.s1.dryMass,
  s1Prop: F9.s1.propMass,
  s2Dry: F9.s2.dryMass,
  s2Prop: F9.s2.propMass,
  payloadMass: F9.payload.count * F9.payload.massEach,
  fairingMass: F9.fairing.massEach,
};

/** Merlin 1D: constant mass flow per throttle setting; thrust = F_vac·thr − p·A_exit. */
export const M1D = {
  thrustVac: MERLIN_1D.thrustVac,
  /** exit area implied by the published SL/vac thrust pair (≈ 0.68 m², r ≈ 0.466 m) */
  exitArea: (MERLIN_1D.thrustVac - MERLIN_1D.thrustSL) / 101_325,
  mdot: MERLIN_1D.thrustVac / (MERLIN_1D.ispVac * G0),
  ispVac: MERLIN_1D.ispVac,
  minThrottle: MERLIN_1D.minThrottle,
  startup: MERLIN_1D.startupTime,
  shutdown: 0.35,
  gimbalLimit: (MERLIN_1D.gimbalLimitDeg * Math.PI) / 180,
  gimbalRate: (25 * Math.PI) / 180,
  throttleRate: 0.9, // 1/s
  pivotY: 2.6,
};

export const MVAC = {
  thrustVac: MERLIN_VAC.thrustVac,
  exitArea: Math.PI * F9.s2.mvac.exitRadius * F9.s2.mvac.exitRadius,
  mdot: MERLIN_VAC.thrustVac / (MERLIN_VAC.ispVac * G0),
  ispVac: MERLIN_VAC.ispVac,
  minThrottle: MERLIN_VAC.minThrottle,
  startup: 1.6,
  shutdown: 0.5,
  gimbalLimit: (MERLIN_VAC.gimbalLimitDeg * Math.PI) / 180,
  gimbalRate: (15 * Math.PI) / 180,
  throttleRate: 0.5,
  pivotY: F9.s2.mvac.throatY,
  /** ambient pressure above which the MVac nozzle extension suffers destructive flow separation */
  maxIgnitionPressure: 12_000,
};

export const RCS = {
  /** N per nozzle. vehicleSpec quotes ~450 N; Block 5 upgraded N2 thrusters modelled at ~2× to get the
   * published-looking ~5°/s flip rates (see docs/notes/sim.md). */
  s1Thrust: F9.s1.rcs.thrustPerNozzle * 2,
  s2Thrust: 180,
  s2PodY: 12.9,
  minOn: 0.08, // s minimum impulse bit (visible puffs)
};

export const GNC = {
  /** fixed physics step (s) */
  dt: 0.01,
  /** coarse step for unpowered / passive phases (vacuum coast, parafoil, landed) */
  dtCoast: 0.05,

  // ---- ascent ----
  towerClearAlt: 90,
  kickT: 7,
  kickDuration: 3,
  kickAngleDeg: 1.2,
  /** from here on the attitude tracks the reference flight-path-angle program (closed loop) */
  gammaTrackT: 22,
  gammaGain: 1.5,
  /** ascent reference program: Earth-relative flight-path elevation (deg) vs Earth-relative speed
   * (m/s) — a speed-scheduled gravity turn, robust to throttle-profile changes */
  gammaProfile: [
    [0, 90], [43, 89.6], [88, 86.5], [145, 81.5], [213, 75.5], [298, 69.5], [382, 63.5], [484, 58.3],
    [614, 53.5], [776, 49.2], [967, 45.2], [1189, 41.3], [1447, 37.5], [1747, 34], [2099, 30.8], [2400, 28], [2800, 24],
  ] as [number, number][],
  /** scales the pitch-over of the reference program (>1 flatter); 1.025 trims the booster apogee to
   * ~130 km so the entry burn lands at ~T+6:20 */
  gammaScale: 1.025,
  /** fraction of the wind-induced AoA relieved at high q (0 = none, 1 = fly zero AoA) */
  loadRelief: 0.6,
  /** planned S1 throttle profile (mission s → throttle): the throttle bucket through max-Q */
  throttleProfile: [[0, 1], [40, 1], [47, 0.72], [54, 0.72], [64, 1]] as [number, number][],
  /** q-limiter safety net: thr ≤ 1 − gain·(q − bucketQ)/bucketQ, floor bucketThrottle */
  bucketQ: 34_000,
  bucketGain: 3,
  bucketThrottle: 0.62,
  /** S1 prop remaining at MECO (entry + landing burn reserve; ~2 t left at touchdown) */
  mecoReserve: 26_000,
  sepDelay: 3,
  sesDelay: 7,
  manualSepDelay: 2,
  manualSesDelay: 4,
  /** free-molecular heating limit for fairing jettison (W/m²) */
  fairingHeatLimit: 1135,
  fairingMinDelay: 15,
  fairingMinAlt: 102_000,
  // ---- S2 ----
  /** S2 insertion: perigee (insertion) altitude and apogee altitude of the parking orbit */
  insertAlt: 215_000,
  targetAlt: 300_000,
  targetInclinationDeg: 70,
  s2DeployDelay: 412,
  // ---- booster ----
  flipDelay: 4,
  gridfinDelay: 12,
  flipRateDeg: 5,
  /** entry-burn ignition: dynamic pressure at which the booster lights (Pa) — ~70 km on a 130 km lob */
  entryIgnQ: 200,
  /** entry-burn cutoff speed window (Earth-relative m/s) */
  entryVNominal: 900,
  entryVMax: 1300,
  entryVMin: 750,
  /** propellant that must remain after the entry burn (landing burn + margin) */
  landingReserve: 6_000,
  /** landing-burn planning throttle (margin for disturbances) */
  landingPlanThrottle: 0.72,
  /** light the landing burn when the predicted stop height (at planning throttle) drops below this (m) */
  landingIgnMargin: 0,
  touchdownSpeed: 1.6,
  legsLeadTime: 7,
  legsDeployTime: 3.2,
  maxAoaDeg: 9,
  // ---- limits ----
  stackNormalLimit: 480_000,
  boosterNormalLimit: 800_000,
  upperNormalLimit: 350_000,
};
