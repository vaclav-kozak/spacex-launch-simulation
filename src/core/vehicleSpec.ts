// Falcon 9 Block 5 geometry + published performance figures.
// Shared by the physics (sim/) and the visual models (render/vehicles/, Blender scripts).
// Lengths in meters. Body frame: +Y along the axis toward the nose; each stage's origin is the
// center of its engine nozzle-exit plane. Engine ring angles are measured in the body XZ plane
// from +X toward +Z. Grid fins / legs / RCS pods sit at 45°, 135°, 225°, 315°.

export const F9 = {
  totalHeight: 70.0,
  diameter: 3.66,
  radius: 1.83,

  s1: {
    /** nozzle-exit plane (y=0) to interstage top */
    length: 47.0,
    octawebBottomY: 1.35, // heat shield plane; nozzles protrude below it
    tankBottomY: 3.0,
    tankTopY: 40.3,
    interstageBottomY: 40.3,
    interstageTopY: 47.0,
    dryMass: 25_600, // kg incl. interstage, legs, grid fins
    propMass: 411_000, // kg LOX + RP-1 (O/F ≈ 2.56)
    engineCount: 9,
    /** index 0 = center, 1..8 outer ring at angle (k-1)*45° */
    engineRingRadius: 1.25,
    engineAngleDeg: (k: number) => (k - 1) * 45,
    nozzleExitRadius: 0.46,
    engineLength: 2.9, // Merlin 1D incl. nozzle
    entryBurnEngines: [0, 1, 5] as const, // center + two opposite outer
    landingBurnEngines: [0] as const,
    gridFin: { y: 45.2, width: 1.5, height: 1.2, angleDeg: [45, 135, 225, 315] },
    leg: {
      count: 4,
      angleDeg: [0, 90, 180, 270],
      hingeY: 1.6, hingeRadius: 1.85, length: 8.6,
      /** deployed footpad height relative to nozzle exit (m) */
      footY: -2.0,
      span: 18.0, // footpad-to-footpad deployed
    },
    rcs: {
      // Cold-gas N2 thruster pods near the top of the interstage: 2 pods (at 90° and 270°),
      // 4 nozzles each. BodyState.rcs[i] (0..1) maps to nozzles[i]. `dir` = exhaust direction
      // (unit, body frame, pod at angle a has outward radial (cos a, 0, sin a)).
      podY: 44.0,
      podAngleDeg: [90, 270],
      nozzles: [
        { pod: 0, dir: [1, 0, 0] }, { pod: 0, dir: [-1, 0, 0] }, // tangential ±  (roll / yaw)
        { pod: 0, dir: [0, 0.5, 0.866] }, { pod: 0, dir: [0, -0.5, 0.866] }, // outward up/down (pitch)
        { pod: 1, dir: [1, 0, 0] }, { pod: 1, dir: [-1, 0, 0] },
        { pod: 1, dir: [0, 0.5, -0.866] }, { pod: 1, dir: [0, -0.5, -0.866] },
      ] as const,
      thrustPerNozzle: 450, // N (approx.)
    },
    cams: {
      /** onboard camera on interstage looking down the side at the ocean / ship */
      down: { y: 43.5, radius: 2.05, angleDeg: 20 },
    },
  },

  s2: {
    /** S2 origin (MVac nozzle exit) in S1 body coordinates when stacked */
    mountY: 43.1,
    length: 13.8,
    tankBottomY: 4.4, // bottom of the S2 tank dome (MVac + extension below)
    dryMass: 4_000,
    propMass: 111_500,
    mvac: { exitRadius: 1.65, nozzleExtensionLength: 2.4, throatY: 3.6 },
    cams: { engine: { y: 4.9, radius: 1.95, angleDeg: 200 } },
  },

  fairing: {
    /** fairing base in S2 body coordinates */
    baseY: 13.8,
    length: 13.1,
    diameter: 5.2,
    massEach: 950,
    /** half A is on body +X, half B on body -X */
  },

  payload: {
    /** stack base in S2 body coordinates */
    baseY: 13.8,
    count: 22,
    massEach: 740,
  },
} as const;

// Engine performance (Block 5, published / widely quoted figures)
export const MERLIN_1D = {
  thrustSL: 845_000, // N per engine (190 klbf)
  thrustVac: 914_000,
  ispSL: 282,
  ispVac: 311,
  minThrottle: 0.40,
  maxThrottle: 1.0,
  startupTime: 0.9, // s to reach full thrust
  gimbalLimitDeg: 5,
};

export const MERLIN_VAC = {
  thrustVac: 981_000,
  ispVac: 348,
  minThrottle: 0.39,
  maxThrottle: 1.0,
  gimbalLimitDeg: 5,
};

// OCISLY (Marmac 300 barge + wing extensions)
export const OCISLY = {
  hullLength: 91.4,
  hullBeam: 30.5,
  deckLength: 91.4,
  deckWidth: 52.0, // with wings
  deckHeight: 3.2, // above mean waterline
  /** deck center is the landing aim point; ship body frame: +Y up, +Z toward bow */
  xMarkRadius: 12.0,
};
