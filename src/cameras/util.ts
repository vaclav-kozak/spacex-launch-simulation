// Camera math helpers (floating-origin friendly: everything W-frame doubles). OWNER: cameras.
import * as THREE from 'three';
import { PAD_ELEVATION, LAUNCH_AZIMUTH_DEG } from '../core/constants';
import { altitudeOf, upAt, enuAt } from '../core/frames';
import type { BodyId, SimSnapshot } from '../core/types';
import { F9, MERLIN_1D } from '../core/vehicleSpec';

export const RAD = Math.PI / 180;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** first-order exponential smoothing factor for time constant tau */
export const expK = (dt: number, tau: number) => (tau <= 1e-6 ? 1 : 1 - Math.exp(-dt / tau));

/** Critically damped spring (Unity SmoothDamp), stable for large dt. Mutates cur + vel. */
export function smoothDampVec(cur: THREE.Vector3, vel: THREE.Vector3, target: THREE.Vector3, smoothTime: number, dt: number): void {
  if (dt <= 0) return;
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x, cy = cur.y - target.y, cz = cur.z - target.z;
  const tx = (vel.x + omega * cx) * dt, ty = (vel.y + omega * cy) * dt, tz = (vel.z + omega * cz) * dt;
  vel.set((vel.x - omega * tx) * exp, (vel.y - omega * ty) * exp, (vel.z - omega * tz) * exp);
  cur.set(target.x + (cx + tx) * exp, target.y + (cy + ty) * exp, target.z + (cz + tz) * exp);
}

export function smoothDampScalar(cur: number, vel: { v: number }, target: number, smoothTime: number, dt: number): number {
  if (dt <= 0) return cur;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const c = cur - target;
  const t = (vel.v + omega * c) * dt;
  vel.v = (vel.v - omega * t) * exp;
  return target + (c + t) * exp;
}

/** Smooth pseudo-random noise in -1..1 (sum of incommensurate sines). */
export function noise1(t: number, seed: number): number {
  const a = Math.sin(t * 1.0 + seed * 12.9898) * 0.5;
  const b = Math.sin(t * 2.2317 + seed * 78.233) * 0.3;
  const c = Math.sin(t * 5.1731 + seed * 37.719) * 0.2;
  return a + b + c;
}

const _m4 = new THREE.Matrix4();
const ZERO = new THREE.Vector3();
const _altUp = new THREE.Vector3();

/** Quaternion of a camera at the origin looking along `dir` with `up`. */
export function lookQuat(dir: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const d = dir.lengthSq() < 1e-20 ? _altUp.set(0, 0, -1) : dir;
  let u = up;
  const c = Math.abs(d.dot(up)) / Math.sqrt(d.lengthSq() * up.lengthSq());
  if (c > 0.99999) u = _altUp.set(up.y, up.z, up.x); // degenerate: any perpendicular-ish
  _m4.lookAt(ZERO, d, u);
  return out.setFromRotationMatrix(_m4);
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
/** Multiply a small random rotation (radians amplitude) onto q. */
export function applyShake(q: THREE.Quaternion, amp: number, freq: number, t: number, seed: number): void {
  if (amp <= 1e-7) return;
  const tt = t * freq;
  _e.set(noise1(tt, seed + 1) * amp, noise1(tt * 1.13, seed + 2) * amp, noise1(tt * 0.87, seed + 3) * amp * 0.45);
  q.multiply(_q.setFromEuler(_e));
}

// ---------------------------------------------------------------------------------------------
// Terrain / surface guard (approximate: the env owns the real terrain)

const PAD_POS = new THREE.Vector3(0, 0, 0);
/** Approximate ground height (m above sea level) under a W point. */
export function groundHeightApprox(p: THREE.Vector3): number {
  // SLC-4E sits on a coastal terrace ~60 m ASL; ocean to the west/south within ~1 km.
  const dx = p.x - PAD_POS.x, dz = p.z - PAD_POS.z;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r < 1500) return PAD_ELEVATION;
  if (r < 3000) return PAD_ELEVATION * (1 - (r - 1500) / 1500);
  return 0;
}

const _up = new THREE.Vector3();
/** Push p up along the local vertical so it stays `clearance` m above the approximate surface. */
export function clampAboveSurface(p: THREE.Vector3, clearance = 3, minGround?: number): void {
  const alt = altitudeOf(p);
  const g = minGround ?? groundHeightApprox(p);
  const need = g + clearance;
  if (alt < need) p.addScaledVector(upAt(p, _up), need - alt);
}

// ---------------------------------------------------------------------------------------------
// Body framing

export interface Framing {
  /** W center of the interesting shape */
  center: THREE.Vector3;
  /** long dimension (m) */
  size: number;
  /** body +Y in W */
  axis: THREE.Vector3;
}

const Y = new THREE.Vector3(0, 1, 0);

export function bodyAxis(snap: SimSnapshot, id: BodyId, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(Y).applyQuaternion(snap.bodies[id].quat);
}

export function isStacked(snap: SimSnapshot): boolean {
  return snap.bodies.S2.status === 'stacked';
}

export function bodyFraming(snap: SimSnapshot, id: BodyId, out?: Framing): Framing {
  const f = out ?? { center: new THREE.Vector3(), size: 1, axis: new THREE.Vector3() };
  const b = snap.bodies[id];
  bodyAxis(snap, id, f.axis);
  let len = 10, c = 5;
  switch (id) {
    case 'S1': {
      if (isStacked(snap)) {
        const fairingOn = snap.bodies.FAIRING_A.status === 'stacked';
        len = fairingOn ? F9.totalHeight : F9.s2.mountY + 22;
      } else len = F9.s1.length;
      c = len / 2;
      break;
    }
    case 'S2': {
      const fairingOn = snap.bodies.FAIRING_A.status === 'stacked';
      const payloadOn = snap.bodies.PAYLOAD.status === 'stacked';
      len = fairingOn ? F9.s2.length + F9.fairing.length : payloadOn ? F9.s2.length + 8 : F9.s2.length;
      c = len / 2;
      break;
    }
    case 'FAIRING_A':
    case 'FAIRING_B':
      len = F9.fairing.length; c = len * 0.5; break;
    case 'PAYLOAD':
      len = 8; c = 4; break;
    case 'SHIP':
      f.center.copy(b.pos); f.size = 90; return f;
  }
  f.center.copy(b.pos).addScaledVector(f.axis, c);
  f.size = len;
  return f;
}

/** Visible exhaust plume length estimate (m) for framing (0 when engines are off). */
export function plumeLength(snap: SimSnapshot, id: BodyId): number {
  const b = snap.bodies[id];
  if (!(b.thrust > 1) || (id !== 'S1' && id !== 'S2')) {
    if (id === 'S2' && isStacked(snap)) return plumeLength(snap, 'S1');
    return 0;
  }
  const p = clamp(b.ambientPressure / 101325, 0, 1);
  const base = id === 'S1' ? 45 : 20;
  // plume expands enormously as ambient pressure drops (but becomes faint in vacuum for MVac)
  return base * (1 + 5 * (1 - p) * (id === 'S1' ? 1 : 0.3));
}

/** Expanded exhaust-plume boundary: R(a) = Rc + tanT * L * (((a + a0) / L)^p - (a0 / L)^p). */
export interface PlumeBoundary { L: number; Rc: number; tanT: number; p: number; a0: number }

/**
 * Visible boundary of vfx's plume volume for a burning stage (same shape law and constants as `PlumeVolume` /
 * `plumeRadiusAt` in render/vfx/plume.ts, restated here because cameras only depend on core; keep in sync).
 * Ascent only (no retro cushion). Null when the engines are off or the stage is stacked under another.
 */
export function plumeBoundary(snap: SimSnapshot, id: BodyId, out: PlumeBoundary): PlumeBoundary | null {
  if (id !== 'S1' && id !== 'S2') return null;
  const b = snap.bodies[id];
  if (!(b.thrust > 1) || (id === 'S2' && isStacked(snap))) return null;
  const vac = id === 'S2';
  const pA = Math.max(b.ambientPressure, 1e-4);
  const e = clamp(Math.log10((vac ? 650 : 72_000) / pA), -0.3, 6.5); // expansion level log10(pExit / pAmb)
  const ex = smoothstep(0.15, vac ? 2.6 : 3.4, e);
  out.Rc = vac ? F9.s2.mvac.exitRadius : F9.s1.engineRingRadius + F9.s1.nozzleExitRadius;
  out.tanT = vac ? 0.35 + 1.3 * ex : 0.055 + 1.75 * Math.pow(ex, 1.35);
  const mass = clamp(b.thrust / MERLIN_1D.thrustSL, 0.45, 9);
  out.L = vac ? 60 + 900 * ex : (70 + 2400 * Math.pow(ex, 1.6)) * (0.45 + 0.55 * Math.sqrt(mass / 9));
  out.p = 1 - 0.38 * smoothstep(1.0, 3.2, e);
  out.a0 = out.p < 0.999 ? Math.min(out.L, out.L * Math.pow(2.75 / (out.p * out.tanT), 1 / (out.p - 1))) : 0;
  return out;
}

/** Plume radius at axial distance `a` aft of the nozzle-exit plane (cluster radius upstream of it). */
export function plumeRadius(pb: PlumeBoundary, a: number): number {
  const L = Math.max(pb.L, 1);
  const x = clamp(a, 0, 4 * L);
  return pb.Rc + pb.tanT * L * (Math.pow((x + pb.a0) / L, pb.p) - Math.pow(pb.a0 / L, pb.p));
}

/** Stable "travel" horizontal direction for chase framing (never degenerate). */
export function travelBasis(pos: THREE.Vector3, dir: THREE.Vector3, outSide: THREE.Vector3, outUp: THREE.Vector3): void {
  upAt(pos, outUp);
  const h = new THREE.Vector3().copy(dir).addScaledVector(outUp, -dir.dot(outUp));
  const enu = enuAt(pos);
  const az = LAUNCH_AZIMUTH_DEG * RAD;
  const heading = new THREE.Vector3().copy(enu.north).multiplyScalar(Math.cos(az)).addScaledVector(enu.east, Math.sin(az));
  const hl = h.length();
  const w = smoothstep(0.05, 0.4, hl);
  if (hl > 1e-9) h.multiplyScalar(1 / hl);
  h.multiplyScalar(w).addScaledVector(heading, 1 - w).normalize();
  outSide.crossVectors(h, outUp).normalize(); // right of travel
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
