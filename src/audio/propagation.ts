// Acoustic propagation helpers + emitter history for speed-of-sound delay.
//
// Every sound-emitting body (S1, S2) records its acoustic source state into a ring buffer each
// frame (mission time). A listener at x_L hears, at mission time t, the state emitted at the
// retarded time τ solving  c·(t − τ) = |x_L − x_S(τ)|  (air at rest in W). We take the most recent
// root (the branch that catches up with the present); a supersonic source approaching the listener
// has no root until its Mach cone arrives — silence, then the boom — and a camera riding a
// supersonic vehicle never hears its engines through the air. All of that falls out of the solver.

import type { Vector3 } from 'three';
import type { BodyState } from '../core/types';
import { EARTH_RADIUS } from '../core/constants';

// ---- field layout of one history record
export const H = {
  T: 0, PX: 1, PY: 2, PZ: 3, VX: 4, VY: 5, VZ: 6, AX: 7, AY: 8, AZ: 9,
  THRUST: 10, NON: 11, SPOOL: 12, THROT: 13, PAMB: 14, RHO: 15, MACH: 16, Q: 17,
  RCS0: 18, RCS1: 19, ALT: 20, ALIVE: 21,
} as const;
export const STRIDE = 22;

const _ax = { x: 0, y: 0, z: 0 };
/** body +Y axis in W from a quaternion (no allocation) */
export function bodyAxis(q: { x: number; y: number; z: number; w: number }) {
  const { x, y, z, w } = q;
  _ax.x = 2 * (x * y - w * z);
  _ax.y = 1 - 2 * (x * x + z * z);
  _ax.z = 2 * (y * z + w * x);
  return _ax;
}

export class EmitterHistory {
  readonly cap: number;
  private buf: Float64Array;
  /** absolute sequence number of the next record */
  private seq = 0;
  count = 0;
  constructor(cap = 16384) {
    this.cap = cap;
    this.buf = new Float64Array(cap * STRIDE);
  }
  clear(): void { this.seq = 0; this.count = 0; }
  get lastT(): number { return this.count ? this.at(this.seq - 1, H.T) : -Infinity; }
  get firstSeq(): number { return this.seq - this.count; }
  get lastSeq(): number { return this.seq - 1; }
  at(seq: number, f: number): number { return this.buf[(seq % this.cap) * STRIDE + f]; }

  /** record the acoustic source state of `b` (source point = nozzle exit shifted `plumeOffset` m aft) */
  push(t: number, b: BodyState, plumeOffset: number): void {
    const o = (this.seq % this.cap) * STRIDE;
    const B = this.buf;
    const ax = bodyAxis(b.quat);
    B[o + H.T] = t;
    B[o + H.PX] = b.pos.x - ax.x * plumeOffset;
    B[o + H.PY] = b.pos.y - ax.y * plumeOffset;
    B[o + H.PZ] = b.pos.z - ax.z * plumeOffset;
    B[o + H.VX] = b.vel.x; B[o + H.VY] = b.vel.y; B[o + H.VZ] = b.vel.z;
    B[o + H.AX] = ax.x; B[o + H.AY] = ax.y; B[o + H.AZ] = ax.z;
    let thrust = 0, non = 0, spool = 0, thr = 0;
    for (const e of b.engines) {
      thrust += Math.max(0, e.thrust || 0);
      if (e.on || e.spool > 0.02) { non++; spool += e.spool; thr += e.throttle; }
    }
    B[o + H.THRUST] = thrust;
    B[o + H.NON] = non;
    B[o + H.SPOOL] = non ? spool / non : 0;
    B[o + H.THROT] = non ? thr / non : 0;
    B[o + H.PAMB] = b.ambientPressure;
    B[o + H.RHO] = b.density;
    B[o + H.MACH] = b.mach;
    B[o + H.Q] = b.dynPressure;
    let r0 = 0, r1 = 0;
    const n = b.rcs.length, half = n >> 1;
    for (let i = 0; i < n; i++) { if (i < half) r0 += b.rcs[i]; else r1 += b.rcs[i]; }
    B[o + H.RCS0] = Math.min(1.5, r0);
    B[o + H.RCS1] = Math.min(1.5, r1);
    B[o + H.ALT] = b.altitude;
    B[o + H.ALIVE] = b.status === 'destroyed' || b.status === 'gone' ? 0 : 1;
    this.seq++;
    if (this.count < this.cap) this.count++;
  }

  /** g(seq) = c·(t − T) − |x_L − P| (≥ 0 → that emission has already reached the listener) */
  private g(seq: number, t: number, L: Vector3, c: number): number {
    const o = (seq % this.cap) * STRIDE, B = this.buf;
    const dx = L.x - B[o + H.PX], dy = L.y - B[o + H.PY], dz = L.z - B[o + H.PZ];
    return c * (t - B[o + H.T]) - Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Retarded state for a listener at L, mission time t. Writes the interpolated record into `out`
   * and returns the propagation distance r (m), or -1 if nothing recorded yet. `result.clamped`
   * is true when no root exists inside the history (then the oldest/none state is used).
   */
  retarded(t: number, L: Vector3, c: number, out: Float64Array, result: { clamped: boolean }): number {
    result.clamped = false;
    if (!this.count) return -1;
    const first = this.firstSeq, last = this.lastSeq;
    // newest emission already heard? (only when the history is ahead of t, e.g. replay)
    let hi = last;
    // skip records "in the future" of t (replay plays back older mission times)
    if (this.at(hi, H.T) > t) {
      let lo = first, h2 = last;
      while (h2 - lo > 1) { const m = (lo + h2) >> 1; if (this.at(m, H.T) > t) h2 = m; else lo = m; }
      hi = this.at(lo, H.T) <= t ? lo : first;
    }
    if (this.g(hi, t, L, c) >= 0) { this.copy(hi, out); return c * (t - out[H.T]); }
    // walk back (coarse, then fine) to the most recent root
    const step = 8;
    let j = hi;
    let found = -1;
    while (j > first) {
      const k = Math.max(first, j - step);
      if (this.g(k, t, L, c) >= 0) {
        // root between k and j: refine
        let a = k, b = j;
        for (let s = b - 1; s > a; s--) if (this.g(s, t, L, c) >= 0) { a = s; break; }
        b = a + 1;
        const ga = this.g(a, t, L, c), gb = this.g(b, t, L, c);
        const u = ga / Math.max(1e-9, ga - gb);
        this.lerp(a, b, Math.min(1, Math.max(0, u)), out);
        found = 1;
        break;
      }
      j = k;
    }
    if (found < 0) {
      // No emission in the history has reached the listener yet. If the history simply does not go
      // back far enough (page loaded / seeked while the vehicle was already far) use the oldest
      // record so a seek does not produce minutes of silence; its true distance keeps it quiet.
      result.clamped = true;
      this.copy(first, out);
      const dx = L.x - out[H.PX], dy = L.y - out[H.PY], dz = L.z - out[H.PZ];
      // (A supersonic source approaching the listener lands here too; its oldest record is then far
      // away — e.g. the booster's liftoff seen from the droneship — so distance keeps it inaudible.)
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const dx = L.x - out[H.PX], dy = L.y - out[H.PY], dz = L.z - out[H.PZ];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private copy(seq: number, out: Float64Array): void {
    const o = (seq % this.cap) * STRIDE;
    for (let f = 0; f < STRIDE; f++) out[f] = this.buf[o + f];
  }
  private lerp(a: number, b: number, u: number, out: Float64Array): void {
    const oa = (a % this.cap) * STRIDE, ob = (b % this.cap) * STRIDE, B = this.buf;
    for (let f = 0; f < STRIDE; f++) out[f] = B[oa + f] + (B[ob + f] - B[oa + f]) * u;
    // engine count is discrete: take the nearer record
    out[H.NON] = u < 0.5 ? B[oa + H.NON] : B[ob + H.NON];
  }
}

// ---- atmosphere / acoustics

/** US Standard Atmosphere speed of sound (m/s) at geometric altitude h (m). */
export function speedOfSound(h: number): number {
  let T: number;
  if (h < 11000) T = 288.15 - 0.0065 * h;
  else if (h < 20000) T = 216.65;
  else if (h < 32000) T = 216.65 + 0.001 * (h - 20000);
  else if (h < 47000) T = 228.65 + 0.0028 * (h - 32000);
  else T = 270.65;
  return 20.0468 * Math.sqrt(Math.max(150, T));
}

/** effective (travel-time averaged) speed of sound between two altitudes */
export function pathSoundSpeed(h1: number, h2: number): number {
  let inv = 0;
  for (let i = 0; i < 5; i++) {
    const h = h1 + (h2 - h1) * (i + 0.5) / 5;
    inv += 1 / speedOfSound(Math.max(0, h));
  }
  return 5 / inv;
}

export function altitudeOfXYZ(x: number, y: number, z: number): number {
  const yy = y + EARTH_RADIUS;
  return Math.sqrt(x * x + yy * yy + z * z) - EARTH_RADIUS;
}

/** approx. standard-atmosphere density ratio ρ/ρ0 */
export function densityRatio(h: number): number {
  return Math.exp(-Math.max(0, h) / 8500);
}

// ISO 9613-1 air absorption, 20 °C, 70 % RH, 1 atm (dB/km)
const ABS_F = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const ABS_A = [0.1, 0.3, 1.1, 2.8, 5.0, 9.0, 22.9, 76.6, 250];

/**
 * Low-pass corner (Hz) that mimics atmospheric absorption over r meters: the frequency whose
 * absorption loss reaches `lossDb` (the 2×2-pole cascade we drive is −6 dB there).
 * `thin` (0..1] scales absorption for the thin upper air along a slant path (absorption per
 * meter falls with pressure at low frequencies roughly ∝ p, ignore that subtlety: use as-is).
 */
export function absorptionCutoff(r: number, lossDb = 6): number {
  const km = Math.max(1e-3, r / 1000);
  const aNeed = lossDb / km; // dB/km at the corner
  if (aNeed <= ABS_A[0]) return 60 * Math.pow(ABS_A[0] / aNeed, 0.5); // extremely far: below 63 Hz
  for (let i = 1; i < ABS_A.length; i++) {
    if (aNeed <= ABS_A[i]) {
      const u = Math.log(aNeed / ABS_A[i - 1]) / Math.log(ABS_A[i] / ABS_A[i - 1]);
      return ABS_F[i - 1] * Math.pow(ABS_F[i] / ABS_F[i - 1], u);
    }
  }
  return 18000;
}

/** broadband excess attenuation (dB) of the energetic 100–300 Hz region over r meters */
export function absorptionBroadbandDb(r: number): number {
  return 0.6 * (r / 1000);
}

/**
 * Jet-noise directivity (dB) vs. the angle θ between the plume (exhaust) direction and the
 * direction from the source to the listener. Peak ~40° off the downstream jet axis, −9 dB ahead.
 */
export function jetDirectivityDb(cosTheta: number): number {
  const th = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const d = th - 0.7; // 40°
  const x = (1 - Math.cos(d)) / 2;
  return -9 * Math.pow(Math.max(0, x), 0.8);
}

export function dbToGain(db: number): number { return Math.pow(10, db / 20); }
export function gainToDb(g: number): number { return 20 * Math.log10(Math.max(1e-9, g)); }

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
