// Aerodynamics: Mach-dependent axial coefficients (nose-first / tail-first), slender-body
// potential normal force + viscous crossflow (gives body lift at angle of attack), grid fins as
// stabilising / control surfaces, pitch damping, retro-propulsion plume shielding.
// Forces are computed in the BODY frame from the body-frame air velocity.

import { Vector3 } from 'three';

export interface Table { M: number[]; v: number[] }

export function interp(t: Table, M: number): number {
  const xs = t.M, ys = t.v;
  if (M <= xs[0]) return ys[0];
  const n = xs.length - 1;
  if (M >= xs[n]) return ys[n];
  let i = 0;
  while (M > xs[i + 1]) i++;
  const f = (M - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + (ys[i + 1] - ys[i]) * f;
}

interface PotTerm { cna: number; y: number }

export interface AeroShape {
  name: string;
  /** reference area (m²) and length (m) */
  S: number;
  L: number;
  caNose: Table;
  caTail: Table;
  potNose: PotTerm[];
  potTail: PotTerm[];
  /** η·A_plan/S (viscous crossflow factor) and planform centroid y */
  crossK: number;
  yPlan: number;
  /** grid fins: y station, total normal-force slope (ref S) when deployed, drag increment table */
  finY?: number;
  finCNa?: number;
  finCd?: Table;
  /** tumbling body: isotropic drag coefficient on S, applied at body point (0, isoY, 0) */
  iso?: { cd: number; y: number };
}

const CDC: Table = { M: [0, 0.8, 1.2, 2, 4, 10], v: [1.2, 1.3, 1.65, 1.55, 1.4, 1.33] };
const M_STD = [0, 0.5, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0, 3.0, 4.0, 6.0, 10];
const CA_STACK_NOSE: Table = { M: M_STD, v: [0.30, 0.30, 0.33, 0.40, 0.52, 0.56, 0.55, 0.48, 0.40, 0.32, 0.28, 0.25, 0.24] };
export const CA_BLUNT_TAIL: Table = { M: M_STD, v: [0.66, 0.68, 0.76, 0.88, 1.05, 1.20, 1.28, 1.33, 1.32, 1.28, 1.26, 1.25, 1.24] };
const CA_OPEN_NOSE: Table = { M: M_STD, v: [0.95, 0.97, 1.05, 1.15, 1.30, 1.40, 1.45, 1.42, 1.38, 1.32, 1.28, 1.26, 1.26] };
const CA_UPPER_BARE: Table = { M: M_STD, v: [0.55, 0.56, 0.62, 0.75, 0.95, 1.05, 1.05, 1.0, 0.92, 0.85, 0.82, 0.80, 0.80] };
export const FIN_CD: Table = { M: [0, 0.8, 0.95, 1.2, 1.5, 3, 10], v: [0.10, 0.12, 0.28, 0.26, 0.16, 0.10, 0.08] };
/** grid-fin control effectiveness per fin, per rad, referenced to the fin planform (1.8 m²) */
export const FIN_CNDELTA: Table = { M: [0, 0.7, 0.9, 1.1, 1.4, 2, 3, 5, 10], v: [2.5, 2.6, 1.6, 1.2, 1.7, 1.5, 1.1, 0.8, 0.6] };

const S_BODY = Math.PI * 1.83 * 1.83; // 10.52
const S_FAIRING = Math.PI * 2.6 * 2.6; // 21.24

export const SHAPES: Record<string, AeroShape> = {
  // full stack, S1 origin; fairing ogive CP ~y 66, boat-tail (5.2 → 3.66 m) at y 56.5
  stack: {
    name: 'stack', S: S_FAIRING, L: 70,
    caNose: CA_STACK_NOSE, caTail: CA_BLUNT_TAIL,
    potNose: [{ cna: 2.0, y: 66 }, { cna: -1.0, y: 56.5 }],
    potTail: [{ cna: 0.25, y: 1.5 }],
    crossK: 0.6 * 276 / S_FAIRING, yPlan: 37,
  },
  stackBare: {
    name: 'stackBare', S: S_BODY, L: 66,
    caNose: CA_UPPER_BARE, caTail: CA_BLUNT_TAIL,
    potNose: [{ cna: 1.0, y: 64 }],
    potTail: [{ cna: 0.25, y: 1.5 }],
    crossK: 0.6 * 240 / S_BODY, yPlan: 33,
  },
  // booster alone, engines-first descent is the design case
  booster: {
    name: 'booster', S: S_BODY, L: 47,
    caNose: CA_OPEN_NOSE, caTail: CA_BLUNT_TAIL,
    potNose: [{ cna: 0.5, y: 46 }],
    potTail: [{ cna: 0.5, y: 1.5 }],
    crossK: 0.6 * 172 / S_BODY, yPlan: 23.5,
    finY: 45.2, finCNa: 0.68, finCd: FIN_CD,
  },
  // S2 + payload + fairing, S2 origin
  upperFairing: {
    name: 'upperFairing', S: S_FAIRING, L: 27,
    caNose: CA_STACK_NOSE, caTail: CA_BLUNT_TAIL,
    potNose: [{ cna: 2.0, y: 23.4 }, { cna: -1.0, y: 13.6 }],
    potTail: [{ cna: 0.25, y: 1.0 }],
    crossK: 0.6 * 118.6 / S_FAIRING, yPlan: 14.6,
  },
  upperBare: {
    name: 'upperBare', S: S_BODY, L: 22,
    caNose: CA_UPPER_BARE, caTail: CA_BLUNT_TAIL,
    potNose: [{ cna: 0.6, y: 21 }],
    potTail: [{ cna: 0.25, y: 1.0 }],
    crossK: 0.6 * 80 / S_BODY, yPlan: 11,
  },
  fairingHalf: {
    name: 'fairingHalf', S: 28, L: 13.1,
    caNose: CA_BLUNT_TAIL, caTail: CA_BLUNT_TAIL, potNose: [], potTail: [], crossK: 0, yPlan: 6.5,
    iso: { cd: 1.15, y: 6.6 },
  },
  payload: {
    name: 'payload', S: 12, L: 8.5,
    caNose: CA_BLUNT_TAIL, caTail: CA_BLUNT_TAIL, potNose: [], potTail: [], crossK: 0, yPlan: 4,
    iso: { cd: 1.2, y: 4.25 },
  },
};

export interface AeroOut {
  /** body-frame force (N) and torque about CG (N·m) */
  F: Vector3;
  T: Vector3;
  q: number;
  mach: number;
  V: number;
  /** total angle of attack (rad), 0 = nose into the wind, π = engines-first */
  alpha: number;
  /** normal (crossflow) force magnitude (N) — structural load metric */
  normal: number;
  /** +1 air flowing nose→tail over the body (nose-first flight), −1 engines-first */
  flowSign: number;
}

export function makeAeroOut(): AeroOut {
  return { F: new Vector3(), T: new Vector3(), q: 0, mach: 0, V: 0, alpha: 0, normal: 0, flowSign: 1 };
}

/** fraction of the engines-first axial drag removed by the retro-thrust plume (strong when supersonic) */
export function retroShield(M: number, retro: number): number {
  const r = Math.min(1, Math.max(0, retro));
  const k = M >= 1.3 ? 1 : 0.3 + 0.7 * Math.max(0, (M - 0.6) / 0.7);
  return 0.8 * r * k;
}

export interface AeroConfig {
  finDeploy: number;
  /** 0..1 retro-thrust fraction (plume shielding of the engines-first face) */
  retro: number;
  legs: number;
}

/**
 * @param u body-frame velocity of the body relative to the air (m/s)
 * @param w body angular velocity (rad/s)
 * @param cg body-frame CG
 */
export function computeAero(
  sh: AeroShape, cfg: AeroConfig, u: Vector3, rho: number, a: number, cg: Vector3, w: Vector3, out: AeroOut,
): AeroOut {
  const V = u.length();
  out.V = V;
  out.F.set(0, 0, 0);
  out.T.set(0, 0, 0);
  out.normal = 0;
  if (V < 0.05 || rho < 1e-12) {
    out.q = 0; out.mach = 0; out.alpha = 0; out.flowSign = 1;
    return out;
  }
  const q = 0.5 * rho * V * V;
  const M = V / Math.max(1, a);
  out.q = q; out.mach = M;
  const qS = q * sh.S;

  if (sh.iso) {
    // tumbling body: drag along -u applied at the geometric centre (offset from CG => weathervaning)
    const k = -qS * sh.iso.cd / V;
    out.F.set(u.x * k, u.y * k, u.z * k);
    const rx = -cg.x, ry = sh.iso.y - cg.y, rz = -cg.z;
    const F = out.F;
    out.T.set(ry * F.z - rz * F.y, rz * F.x - rx * F.z, rx * F.y - ry * F.x);
    const damp = (qS / V) * sh.L * sh.L * 0.35;
    out.T.x -= damp * w.x; out.T.y -= damp * w.y * 0.5; out.T.z -= damp * w.z;
    out.alpha = Math.acos(Math.max(-1, Math.min(1, u.y / V)));
    out.flowSign = u.y >= 0 ? 1 : -1;
    out.normal = Math.hypot(F.x, F.z);
    return out;
  }

  const cosA = u.y / V;
  const nose = cosA >= 0;
  out.flowSign = nose ? 1 : -1;
  const lat = Math.sqrt(u.x * u.x + u.z * u.z);
  const sinA = lat / V;
  out.alpha = Math.atan2(lat, u.y);
  const acA = Math.abs(cosA);

  // ---- axial ----
  let ca = interp(nose ? sh.caNose : sh.caTail, M);
  if (sh.finCd && cfg.finDeploy > 0) ca += interp(sh.finCd, M) * cfg.finDeploy;
  if (!nose && cfg.retro > 0) ca *= 1 - retroShield(M, cfg.retro); // retro-propulsion plume shielding
  if (cfg.legs > 0) ca += 0.25 * cfg.legs;
  out.F.y = -qS * ca * cosA;

  // ---- normal ----
  const pots = nose ? sh.potNose : sh.potTail;
  const sc = sinA * acA;
  let cn = 0, mom = 0, dampK = 0;
  for (let i = 0; i < pots.length; i++) {
    const p = pots[i];
    cn += p.cna * sc;
    mom += p.cna * sc * p.y;
    const d = p.y - cg.y;
    dampK += Math.abs(p.cna) * d * d;
  }
  const cdc = interp(CDC, M);
  const cx = sh.crossK * cdc * sinA * sinA;
  cn += cx;
  mom += cx * sh.yPlan;
  {
    const d = sh.yPlan - cg.y;
    dampK += sh.crossK * cdc * 0.5 * (sh.L * sh.L / 12 + d * d) * 0.3;
  }
  let rollDamp = 0.02 * sh.L;
  if (sh.finY !== undefined && sh.finCNa && cfg.finDeploy > 0) {
    // fins stall beyond ~25° local incidence
    const sEff = Math.min(sinA, 0.42) * acA;
    const cf = sh.finCNa * cfg.finDeploy * sEff;
    cn += cf;
    mom += cf * sh.finY;
    const d = sh.finY - cg.y;
    dampK += sh.finCNa * cfg.finDeploy * d * d;
    rollDamp += sh.finCNa * cfg.finDeploy * 2.5 * 2.5 * 2;
  }
  if (cfg.legs > 0) {
    const cl = 0.35 * cfg.legs * sc;
    cn += cl;
    mom += cl * 2.0;
  }
  if (lat > 1e-6 && cn !== 0) {
    const yCp = mom / cn;
    const Fn = qS * cn;
    const fx = (-Fn * u.x) / lat, fz = (-Fn * u.z) / lat;
    out.F.x = fx;
    out.F.z = fz;
    out.normal = Math.abs(Fn);
    // torque of the normal force applied at (0, yCp, 0), axial force along the axis
    const rx = -cg.x, ry = yCp - cg.y, rz = -cg.z;
    const Fy = out.F.y;
    out.T.set(ry * fz - rz * Fy, rz * fx - rx * fz, rx * Fy - ry * fx);
  } else {
    const Fy = out.F.y;
    out.T.set(cg.z * Fy, 0, -cg.x * Fy);
  }
  // ---- pitch / yaw / roll damping ----
  const kd = qS / V;
  out.T.x -= kd * dampK * w.x;
  out.T.z -= kd * dampK * w.z;
  out.T.y -= kd * rollDamp * w.y;
  return out;
}
