// Second-stage closed-loop ascent guidance: Powered Explicit Guidance (linear-tangent-like
// radial steering A + B·t + C with iterative time-to-go from the angular-momentum deficit),
// plus plane control to a target inclination. Works from the ACTUAL state, so it re-plans after
// off-nominal staging and degrades gracefully (max-horizontal fallback) when orbit is infeasible.

import { Vector3 } from 'three';
import { EARTH_MU, EARTH_OMEGA, EARTH_RADIUS } from '../../core/constants';
import { EARTH_OMEGA_W } from '../../core/frames';

const K_AXIS = EARTH_OMEGA_W.clone().normalize();
const _r = new Vector3();
const _k = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

/** Rotate v about the Earth axis by angle th (rad). */
export function rotEarthAxis(v: Vector3, th: number, out: Vector3): Vector3 {
  const c = Math.cos(th), s = Math.sin(th);
  _k.copy(K_AXIS);
  const kd = _k.dot(v);
  _a.crossVectors(_k, v);
  return out.copy(v).multiplyScalar(c).addScaledVector(_a, s).addScaledVector(_k, kd * (1 - c));
}

/** Inertial velocity (W axes, instantaneous) from W position/Earth-relative velocity. */
export function inertialVel(p: Vector3, v: Vector3, out: Vector3): Vector3 {
  _r.set(p.x, p.y + EARTH_RADIUS, p.z);
  return out.crossVectors(EARTH_OMEGA_W, _r).add(v);
}

export interface OrbitElements { a: number; e: number; perigee: number; apogee: number; incDeg: number; energy: number }

export function orbitElements(p: Vector3, vI: Vector3): OrbitElements {
  const r = _r.set(p.x, p.y + EARTH_RADIUS, p.z);
  const rm = r.length(), v2 = vI.lengthSq();
  const energy = v2 / 2 - EARTH_MU / rm;
  const h = _a.crossVectors(r, vI);
  const hm = h.length();
  const a = -EARTH_MU / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * hm * hm) / (EARTH_MU * EARTH_MU)));
  const inc = Math.acos(Math.max(-1, Math.min(1, h.dot(K_AXIS) / Math.max(1e-9, hm)))) * (180 / Math.PI);
  const rp = energy < 0 ? a * (1 - e) : (hm * hm) / (EARTH_MU * (1 + e));
  const ra = energy < 0 ? a * (1 + e) : Infinity;
  return { a, e, perigee: rp - EARTH_RADIUS, apogee: ra - EARTH_RADIUS, incDeg: inc, energy };
}

export class Peg {
  readonly rT: number;
  readonly vT: number;
  /** target plane normal (W axes) at time t0 */
  readonly n0 = new Vector3();
  t0 = 0;
  A = 0;
  B = 0;
  T = 0;
  tUpd = -1;
  ok = false;
  frozen = false;
  /** max radial thrust fraction (low-T/W start: PEG asks for fr > 1 which is infeasible; capping it
   * lets the vertical velocity decay while the horizontal speed builds, then PEG re-plans) */
  frMax = 0.9;
  /** plane normal at the current time */
  readonly n = new Vector3();

  /** semi-major axis of the target orbit */
  readonly aT: number;

  /**
   * Insert at perigee: radius R + insertAlt with zero radial velocity and the speed of an orbit whose
   * apogee is at R + apoAlt (insertAlt = apoAlt → circular).
   */
  constructor(insertAlt: number, apoAlt = insertAlt) {
    this.rT = EARTH_RADIUS + insertAlt;
    const rA = EARTH_RADIUS + Math.max(apoAlt, insertAlt);
    this.aT = (this.rT + rA) / 2;
    this.vT = Math.sqrt(EARTH_MU * (2 / this.rT - 1 / this.aT));
  }

  /** Choose the target plane of inclination incDeg through the current position, closest to the current motion. */
  initPlane(t: number, p: Vector3, vI: Vector3, incDeg: number): void {
    const rh = _r.set(p.x, p.y + EARTH_RADIUS, p.z).normalize();
    const kp = _b.copy(K_AXIS).addScaledVector(rh, -K_AXIS.dot(rh));
    const kpl = kp.length();
    kp.normalize();
    const e2 = new Vector3().crossVectors(rh, kp);
    const ci = Math.cos((incDeg * Math.PI) / 180);
    const al = Math.min(1, ci / Math.max(1e-6, kpl));
    const be = Math.sqrt(Math.max(0, 1 - al * al));
    let best = -Infinity;
    for (const sgn of [1, -1]) {
      const n = new Vector3().copy(kp).multiplyScalar(al).addScaledVector(e2, sgn * be);
      const dir = new Vector3().crossVectors(n, rh);
      const score = dir.dot(vI);
      if (score > best) { best = score; this.n0.copy(n); }
    }
    this.t0 = t;
    this.n.copy(this.n0);
  }

  planeAt(t: number): Vector3 {
    return rotEarthAxis(this.n0, -EARTH_OMEGA * (t - this.t0), this.n);
  }

  /**
   * Major cycle: update A, B, T from the current state.
   * @param a thrust acceleration (m/s²), ve exhaust velocity (m/s)
   */
  update(t: number, p: Vector3, vI: Vector3, a: number, ve: number): void {
    if (this.frozen) return;
    const n = this.planeAt(t);
    const rv = _r.set(p.x, p.y + EARTH_RADIUS, p.z);
    const r = rv.length();
    const u = _b.copy(rv).multiplyScalar(1 / r);
    const hd = _a.crossVectors(n, u);
    const vr = vI.dot(u);
    const vt = vI.dot(hd);
    const tau = ve / Math.max(0.01, a);
    let T = this.T > 0 ? this.T - (this.tUpd >= 0 ? t - this.tUpd : 0) : tau * (1 - Math.exp(-Math.max(100, this.vT - vt) / ve));
    T = Math.max(1, Math.min(T, tau * 0.995));
    const omega = vt / r;
    let A = this.A, B = this.B;
    let ok = true;
    for (let it = 0; it < 6; it++) {
      const L = Math.log(1 - T / tau);
      const b0 = -ve * L;
      const b1 = b0 * tau - ve * T;
      const c0 = b0 * T - b1;
      const c1 = c0 * tau - (ve * T * T) / 2;
      const det = b0 * c1 - b1 * c0;
      if (!isFinite(det) || Math.abs(det) < 1e-9) { ok = false; break; }
      const dv = 0 - vr;
      const dr = this.rT - r - vr * T;
      A = (dv * c1 - b1 * dr) / det;
      B = (b0 * dr - c0 * dv) / det;
      // time-to-go from angular momentum
      const h0 = r * vt, hT = this.rT * this.vT, dh = hT - h0;
      const rbar = (r + this.rT) / 2;
      const C0 = (EARTH_MU / (r * r) - omega * omega * r) / a;
      const aT = a / (1 - T / tau);
      const wT = this.vT / this.rT;
      const CT = (EARTH_MU / (this.rT * this.rT) - wT * wT * this.rT) / aT;
      const fr0 = A + C0;
      const frT = A + B * T + CT;
      const frd = (frT - fr0) / T;
      const ft0 = 1 - (fr0 * fr0) / 2;
      const ftd = -fr0 * frd;
      const ftdd = -(frd * frd) / 2;
      let dvReq = dh / rbar + ve * T * (ftd + ftdd * tau) + (ftdd * ve * T * T) / 2;
      dvReq /= ft0 + ftd * tau + ftdd * tau * tau;
      if (!isFinite(dvReq) || dvReq <= 0) { ok = false; break; }
      const Tn = tau * (1 - Math.exp(-dvReq / ve));
      if (!isFinite(Tn) || Tn >= tau * 0.995) { ok = false; T = tau * 0.995; break; }
      const conv = Math.abs(Tn - T) < 0.05;
      T = Tn;
      if (conv) break;
    }
    this.ok = ok && isFinite(A) && isFinite(B) && Math.abs(A) < 3;
    if (this.ok) { this.A = A; this.B = B; }
    this.T = T;
    this.tUpd = t;
    if (this.ok && T < 8) this.frozen = true;
  }

  /** Thrust direction (W unit) at time t. */
  steer(t: number, p: Vector3, vI: Vector3, a: number, ve: number, out: Vector3): Vector3 {
    const n = this.planeAt(t);
    const rv = _r.set(p.x, p.y + EARTH_RADIUS, p.z);
    const r = rv.length();
    const u = _b.copy(rv).multiplyScalar(1 / r);
    const hd = _a.crossVectors(n, u);
    const vt = vI.dot(hd);
    const vn = vI.dot(n);
    const omega = vt / r;
    const C = (EARTH_MU / (r * r) - omega * omega * r) / Math.max(0.01, a);
    let fr: number;
    if (this.ok) fr = this.A + this.B * (t - this.tUpd) + C;
    else fr = Math.max(0, C) * 0.9; // infeasible: hold altitude-ish, maximise horizontal speed
    fr = Math.max(-0.5, Math.min(this.frMax, fr));
    const Tgo = Math.max(10, this.T - (t - this.tUpd));
    const dvLeft = ve * Math.log(1 / Math.max(0.05, 1 - Math.min(0.95, Tgo * a / ve)));
    let fn = -vn / Math.max(200, dvLeft) * 1.2;
    fn = Math.max(-0.25, Math.min(0.25, fn));
    const fh = Math.sqrt(Math.max(0, 1 - fr * fr - fn * fn));
    return out.copy(u).multiplyScalar(fr).addScaledVector(hd, fh).addScaledVector(n, fn).normalize();
  }

  get timeToGo(): number {
    return this.T;
  }
}
