// Mass properties (mass, CG, principal inertias) of each component as a function of its
// propellant load. Component frames = body frames of vehicleSpec (origin at nozzle exit / base).

import { F9 } from '../core/vehicleSpec';
import { SIM_FIGURES } from './simconst';

export interface MassProps {
  m: number;
  /** CG in the component frame */
  cx: number;
  cy: number;
  cz: number;
  /** principal inertias about the CG (body axes): X/Z transverse, Y axial */
  Ixx: number;
  Iyy: number;
  Izz: number;
}

export function mp(): MassProps {
  return { m: 0, cx: 0, cy: 0, cz: 0, Ixx: 0, Iyy: 0, Izz: 0 };
}

interface Part { m: number; y: number; len: number; r: number }
interface Tank { frac: number; y0: number; y1: number; r: number }

function accumulateParts(parts: Part[], out: MassProps): void {
  let m = 0, my = 0;
  for (const p of parts) { m += p.m; my += p.m * p.y; }
  const cy = my / m;
  let It = 0, Ia = 0;
  for (const p of parts) {
    const d = p.y - cy;
    It += p.m * (p.len * p.len / 12 + p.r * p.r / 2 + d * d);
    Ia += p.m * p.r * p.r;
  }
  out.m = m; out.cx = 0; out.cy = cy; out.cz = 0; out.Ixx = It; out.Iyy = Ia; out.Izz = It;
}

/** Add a propellant tank filled from its bottom: fraction `fill` of capacity `cap`. */
function addTank(out: MassProps, cap: number, fill: number, t: Tank): void {
  const m = cap * t.frac * fill;
  if (m <= 0) return;
  const h = (t.y1 - t.y0) * Math.min(1, fill) + 0.05;
  const y = t.y0 + h / 2;
  const mt = out.m + m;
  const cy = (out.m * out.cy + m * y) / mt;
  const d0 = out.cy - cy, d1 = y - cy;
  const Iown = m * (h * h / 12 + t.r * t.r / 4);
  out.Ixx = out.Ixx + out.m * d0 * d0 + Iown + m * d1 * d1;
  out.Izz = out.Ixx;
  out.Iyy += m * t.r * t.r / 2;
  out.m = mt;
  out.cy = cy;
}

// ---------------- S1 ----------------
const S1_DRY = mp();
accumulateParts([
  { m: 4_230, y: 2.0, len: 2.9, r: 1.25 }, // 9 × Merlin 1D
  { m: 2_000, y: 3.0, len: 1.5, r: 1.6 }, // octaweb / thrust structure / heat shield
  { m: 2_100, y: 6.0, len: 8.6, r: 1.9 }, // 4 carbon/Al legs (stowed)
  { m: 12_000, y: 21.6, len: 37.3, r: 1.83 }, // Al-Li tanks + common dome
  { m: 3_000, y: 44.0, len: 6.7, r: 1.83 }, // interstage, grid fins, RCS pods
  { m: SIM_FIGURES.s1Dry - 23_330, y: 20.0, len: 30, r: 1.5 }, // plumbing, avionics, COPVs, TPS
], S1_DRY);

const S1_RP1: Tank = { frac: 1 / 3.56, y0: F9.s1.tankBottomY, y1: 17.1, r: 1.8 };
const S1_LOX: Tank = { frac: 2.56 / 3.56, y0: 17.4, y1: F9.s1.tankTopY, r: 1.8 };

export function s1MassProps(prop: number, out: MassProps): MassProps {
  Object.assign(out, S1_DRY);
  const cap = SIM_FIGURES.s1Prop;
  const f = Math.max(0, prop) / cap;
  addTank(out, cap, f, S1_RP1);
  addTank(out, cap, f, S1_LOX);
  return out;
}

// ---------------- S2 ----------------
const S2_DRY = mp();
accumulateParts([
  { m: 620, y: 3.0, len: 4.5, r: 1.2 }, // MVac + niobium extension
  { m: 2_400, y: 9.0, len: 9.4, r: 1.83 }, // tanks
  { m: SIM_FIGURES.s2Dry - 3_020, y: 12.8, len: 2.0, r: 1.6 }, // avionics, payload adapter, RCS
], S2_DRY);
const S2_LOX: Tank = { frac: 2.56 / 3.56, y0: F9.s2.tankBottomY, y1: 10.0, r: 1.8 };
const S2_RP1: Tank = { frac: 1 / 3.56, y0: 10.1, y1: 13.5, r: 1.8 };

export function s2MassProps(prop: number, out: MassProps): MassProps {
  Object.assign(out, S2_DRY);
  const cap = SIM_FIGURES.s2Prop;
  const f = Math.max(0, prop) / cap;
  addTank(out, cap, f, S2_LOX);
  addTank(out, cap, f, S2_RP1);
  return out;
}

// ---------------- fairing halves (origin = fairing base center, half A on +X) ----------------
export function fairingMassProps(side: 1 | -1, out: MassProps): MassProps {
  const m = F9.fairing.massEach;
  const L = F9.fairing.length, R = F9.fairing.diameter / 2;
  out.m = m;
  out.cx = side * (2 / Math.PI) * R * 0.85;
  out.cy = L * 0.4;
  out.cz = 0;
  out.Ixx = m * (L * L / 12 + R * R / 2);
  out.Iyy = m * R * R * 0.6;
  out.Izz = m * (L * L / 12 + R * R / 3);
  return out;
}

// ---------------- payload stack (origin = stack base) ----------------
export function payloadMassProps(out: MassProps): MassProps {
  const m = SIM_FIGURES.payloadMass;
  const H = 8.5, R = 1.9;
  out.m = m; out.cx = 0; out.cy = H * 0.5; out.cz = 0;
  out.Ixx = m * (H * H / 12 + R * R / 4);
  out.Iyy = m * R * R / 2;
  out.Izz = out.Ixx;
  return out;
}

/** Combine component props placed at (0, offY, 0) in the root frame into `acc` (acc must start zeroed). */
export function combine(acc: MassProps, c: MassProps, offY: number): void {
  const m0 = acc.m, m1 = c.m;
  if (m1 <= 0) return;
  const mt = m0 + m1;
  const cx1 = c.cx, cy1 = c.cy + offY, cz1 = c.cz;
  const cx = (m0 * acc.cx + m1 * cx1) / mt;
  const cy = (m0 * acc.cy + m1 * cy1) / mt;
  const cz = (m0 * acc.cz + m1 * cz1) / mt;
  // shift both to the new CG (parallel axis)
  const a0x = acc.cx - cx, a0y = acc.cy - cy, a0z = acc.cz - cz;
  const a1x = cx1 - cx, a1y = cy1 - cy, a1z = cz1 - cz;
  acc.Ixx += m0 * (a0y * a0y + a0z * a0z) + c.Ixx + m1 * (a1y * a1y + a1z * a1z);
  acc.Iyy += m0 * (a0x * a0x + a0z * a0z) + c.Iyy + m1 * (a1x * a1x + a1z * a1z);
  acc.Izz += m0 * (a0x * a0x + a0y * a0y) + c.Izz + m1 * (a1x * a1x + a1y * a1y);
  acc.m = mt; acc.cx = cx; acc.cy = cy; acc.cz = cz;
}
