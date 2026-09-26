// Booster trajectory predictor: fast 3-DOF point-mass rollout of the remaining flight using the
// SAME guidance rules as the 6-DOF booster (entry-burn ignition/cutoff, landing-burn ignition,
// closed-loop landing throttle). Used for impact-point targeting, entry-burn cutoff, boost-back
// style decisions, HUD predictions and timeline refinement.

import { Vector3 } from 'three';
import { EARTH_RADIUS } from '../../core/constants';
import { OCISLY } from '../../core/vehicleSpec';
import { accelField } from '../rigidbody';
import { atmosphere, makeAtmo } from '../atmosphere';
import { CA_BLUNT_TAIL, FIN_CD, interp, retroShield } from '../aero';
import { GNC, M1D } from '../simconst';
import type { WindModel } from '../wind';
import { localENU } from '../wind';

export const BOOSTER_S = Math.PI * 1.83 * 1.83;
/** body origin height above the deck at touchdown (legs deployed, feet at y = −2) */
export const FOOT_DROP = 2.0;

// ---------------- shared rules ----------------

/** Entry burn: ignite when descending into q ≥ entryIgnQ with more speed than the heating limit allows. */
export function entryIgnitionDue(q: number, vDown: number, V: number): boolean {
  return vDown > 0 && q >= GNC.entryIgnQ && V > GNC.entryVMax * 0.98;
}

/** Tail-first drag coefficient with grid fins deployed and retro-plume shielding. */
export function boosterCd(M: number, retro: number): number {
  let cd = interp(CA_BLUNT_TAIL, M) + interp(FIN_CD, M);
  if (retro > 0) cd *= 1 - retroShield(M, retro);
  return cd;
}

const _atmL = makeAtmo();

// ---- fast tabulated atmosphere for the predictors (−2 … 40 km, 25 m spacing, linear) ----
const FA_H0 = -2000, FA_DH = 25, FA_N = Math.ceil((40_000 - FA_H0) / FA_DH) + 1;
const FA_RHO = new Float64Array(FA_N), FA_P = new Float64Array(FA_N), FA_A = new Float64Array(FA_N);
{
  const s = makeAtmo();
  for (let i = 0; i < FA_N; i++) {
    atmosphere(FA_H0 + i * FA_DH, s);
    FA_RHO[i] = s.rho; FA_P[i] = s.p; FA_A[i] = s.a;
  }
}
/** Tabulated US76 (rho, p, a) — falls back to the exact model outside −2 … 40 km. */
export function atmosphereFast(h: number, out: { rho: number; p: number; a: number; T: number }): void {
  const x = (h - FA_H0) / FA_DH;
  if (x < 0 || x >= FA_N - 1) { atmosphere(h, out as ReturnType<typeof makeAtmo>); return; }
  const i = x | 0, f = x - i;
  out.rho = FA_RHO[i] + (FA_RHO[i + 1] - FA_RHO[i]) * f;
  out.p = FA_P[i] + (FA_P[i + 1] - FA_P[i]) * f;
  out.a = FA_A[i] + (FA_A[i + 1] - FA_A[i]) * f;
}

/**
 * Landing-burn ignition test: simulate lighting `nEng` engines NOW at the planning throttle
 * (spool-up lag, altitude-varying drag with plume shielding, retrograde thrust) and return the
 * height above touchdown at which the descent rate reaches touchdownSpeed. Ignite when ≤ margin.
 * @param h height above touchdown (m), vDown descent rate, vHor horizontal speed (air-relative)
 * @param tdAlt altitude (MSL) of the touchdown reference (origin height at touchdown)
 */
export function landingStopHeight(h: number, vDown: number, vHor: number, m: number, nEng: number, tdAlt: number): number {
  let vz = vDown, vh = Math.abs(vHor);
  const thr = GNC.landingPlanThrottle;
  const g = 9.80665;
  // spool-up lag (~0.9 s startup, ~half effective)
  const lag = 0.5;
  atmosphereFast(tdAlt + h, _atmL);
  const V0 = Math.hypot(vz, vh);
  const aD0 = (0.5 * _atmL.rho * V0 * V0 * BOOSTER_S * boosterCd(V0 / _atmL.a, 0)) / m;
  vz += (g - (aD0 * vz) / Math.max(1, V0)) * lag;
  h -= vz * lag;
  for (let i = 0; i < 900; i++) {
    const dt = vz > 80 ? 0.2 : 0.1;
    atmosphereFast(tdAlt + Math.max(0, h), _atmL);
    const V = Math.hypot(vz, vh);
    const q = 0.5 * _atmL.rho * V * V;
    const T = nEng * Math.max(0, thr * M1D.thrustVac - _atmL.p * M1D.exitArea);
    const retro = Math.min(1, T / Math.max(1, q * BOOSTER_S * 3));
    const D = q * BOOSTER_S * boosterCd(V / _atmL.a, retro);
    const k = (T + D) / (m * Math.max(0.1, V));
    vz += (g - k * vz) * dt;
    vh -= k * vh * dt;
    h -= vz * dt;
    m -= nEng * thr * M1D.mdot * dt;
    if (vz <= GNC.touchdownSpeed) return h;
    if (h < -300) return h;
  }
  return h;
}

/**
 * Landing-burn law shared by the 6-DOF guidance and the predictor.
 *  vertical: constant deceleration to V1 at H1 above the deck, then to touchdownSpeed at 0;
 *  attitude: gravity turn (thrust anti-parallel to the Earth-relative velocity) above hFinal — the
 *            horizontal velocity decays faster than the vertical one, so the booster ends up vertical;
 *            below hFinal (or when slow) a near-vertical final descent with a small position hold.
 *  The 6-DOF guidance adds a small lateral correction toward the deck from the predicted impact error.
 */
export const LANDING_PROFILE = {
  H1: 5, V1: 3.5,
  /** final descent below this height (m) or Earth-relative speed (m/s) */
  hFinal: 30, vFinal: 8,
  /** air-relative retrograde weight w = clamp((q − q0)/q1) */
  q0: 4_000, q1: 8_000,
  /** IP-correction gain (a = k·e/tgo²) and max tilt from the gravity-turn direction (deg) */
  kIp: 5, ipTiltDeg: 10,
  /** final descent: ZEM/ZEV min time-to-go (s), max tilt (deg), velocity damping below H1 (1/s) */
  tgMin: 5, finalTiltDeg: 10, kVel: 0.5,
};
export interface LandingProfileOut { aReq: number; finalSeg: boolean; w: number }
/** h: feet above the deck, V: Earth-relative speed, q: dynamic pressure. w = weight of the air-relative
 * retrograde direction (high q: zero AoA, no body lift) vs the Earth-relative one (low q). */
export function landingProfile(vDown: number, h: number, V: number, q: number, out: LandingProfileOut): LandingProfileOut {
  const P = LANDING_PROFILE;
  out.w = Math.min(1, Math.max(0, (q - P.q0) / P.q1));
  const main = h > P.H1 + 1 && vDown > P.V1;
  out.aReq = main ? (vDown * vDown - P.V1 * P.V1) / (2 * (h - P.H1)) : landingRequiredAccel(vDown, h);
  out.finalSeg = h <= P.hFinal || V < P.vFinal;
  return out;
}

/** Closed-loop landing throttle: constant-deceleration profile to touchdownSpeed at h = 0. */
export function landingRequiredAccel(vDown: number, h: number): number {
  const vt = GNC.touchdownSpeed;
  return (vDown * vDown - vt * vt) / (2 * Math.max(0.3, h));
}

// ---------------- rollout ----------------

export interface RolloutIn {
  p: Vector3; // CG, W
  v: Vector3; // Earth-relative, W
  t: number;
  dry: number;
  prop: number;
  /** body CG height above the nozzle exit (m) */
  cgY: number;
  entryDone: boolean;
  entryActive: boolean;
  landingActive: boolean;
  /** entry-burn cutoff speed (air-relative) */
  vCut: number;
  /** skip the entry burn entirely from now on (e.g. evaluating "cut now") */
  cutEntryNow?: boolean;
  /** deck height above MSL of the touchdown surface */
  deckAlt?: number;
  /** extra impulsive Δv (W) applied at start (sensitivity studies) */
  dv?: Vector3;
  wind?: WindModel | null;
  maxT?: number;
}

export interface RolloutOut {
  ok: boolean;
  /** CG position at touchdown / impact (W) */
  tdPos: Vector3;
  tdT: number;
  tdVel: Vector3;
  ebStartT: number;
  ebEndT: number;
  lbStartT: number;
  propTD: number;
  /** air-relative velocity at entry-burn ignition (or at 60 km if no burn) */
  vEntry: Vector3;
  /** apogee time (NaN if already past) */
  apogeeT: number;
  maxQ: number;
  steps: number;
}

export function makeRolloutOut(): RolloutOut {
  return {
    ok: false, tdPos: new Vector3(), tdT: NaN, tdVel: new Vector3(), ebStartT: NaN, ebEndT: NaN, lbStartT: NaN,
    propTD: 0, vEntry: new Vector3(), apogeeT: NaN, maxQ: 0, steps: 0,
  };
}

const atm = makeAtmo();
const K = new Float64Array(3);
const _p = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _en = { e: 0, n: 0 };
const _lp: LandingProfileOut = { aReq: 0, finalSeg: false, w: 0 };

function altOf(x: number, y: number, z: number): number {
  const yy = y + EARTH_RADIUS;
  return Math.sqrt(x * x + yy * yy + z * z) - EARTH_RADIUS;
}

export function rollout(inp: RolloutIn, out: RolloutOut): RolloutOut {
  const p = _p.copy(inp.p), v = _v.copy(inp.v);
  if (inp.dv) v.add(inp.dv);
  let t = inp.t, prop = inp.prop;
  const dry = inp.dry;
  let entryDone = inp.entryDone || !!inp.cutEntryNow;
  let entry = inp.entryActive && !inp.cutEntryNow;
  let landing = inp.landingActive;
  const deckAlt = inp.deckAlt ?? OCISLY.deckHeight;
  const tdAlt = deckAlt + FOOT_DROP + inp.cgY;
  const maxT = inp.maxT ?? inp.t + 900;
  out.ok = false;
  out.ebStartT = inp.entryActive ? inp.t : NaN;
  out.ebEndT = NaN;
  out.lbStartT = landing ? inp.t : NaN;
  out.apogeeT = NaN;
  out.maxQ = 0;
  out.vEntry.set(0, 0, 0);
  let vEntrySet = false;
  let steps = 0;
  let lastVr = NaN;
  let nextLbCheck = -Infinity;
  const wind = inp.wind;
  const mdot1 = M1D.mdot;

  while (t < maxT && steps < 6000) {
    steps++;
    const h = altOf(p.x, p.y, p.z);
    atmosphereFast(h, atm);
    // air-relative velocity (mean wind only)
    let wx = 0, wy = 0, wz = 0;
    if (wind && h < 60_000 && wind.enabled) {
      localENU(p, _e, _n, _u);
      wind.meanEN(h, _en);
      wx = _e.x * _en.e + _n.x * _en.n; wy = _e.y * _en.e + _n.y * _en.n; wz = _e.z * _en.e + _n.z * _en.n;
    }
    const ax0 = v.x - wx, ay0 = v.y - wy, az0 = v.z - wz;
    const V = Math.sqrt(ax0 * ax0 + ay0 * ay0 + az0 * az0);
    const upx = p.x / (EARTH_RADIUS + h), upy = (p.y + EARTH_RADIUS) / (EARTH_RADIUS + h), upz = p.z / (EARTH_RADIUS + h);
    const vr = v.x * upx + v.y * upy + v.z * upz;
    const vDown = -vr;
    if (!Number.isNaN(lastVr) && lastVr > 0 && vr <= 0) out.apogeeT = t;
    lastVr = vr;
    const q = 0.5 * atm.rho * V * V;
    if (q > out.maxQ) out.maxQ = q;
    const M = V / atm.a;
    const m = dry + prop;
    const g = 9.80665 * (EARTH_RADIUS / (EARTH_RADIUS + h)) ** 2;

    // ---- guidance rules ----
    if (!entryDone && !entry && entryIgnitionDue(q, vDown, V)) {
      entry = true;
      out.ebStartT = t;
    }
    if (!vEntrySet && (entry || (vDown > 0 && h < 60_000))) {
      out.vEntry.set(ax0, ay0, az0);
      vEntrySet = true;
    }
    if (entry && (V <= inp.vCut || prop <= GNC.landingReserve)) {
      entry = false;
      entryDone = true;
      out.ebEndT = t;
    }
    const hAbove = h - tdAlt;
    let nEng = 0, thr = 0;
    if (entry) { nEng = 3; thr = 1; }
    if (!landing && !entry && vDown > 0 && hAbove < 15_000 && t >= nextLbCheck) {
      const vHor = Math.sqrt(Math.max(0, V * V - vDown * vDown));
      const hs = landingStopHeight(hAbove, vDown, vHor, m, 1, tdAlt);
      if (hs <= GNC.landingIgnMargin) {
        landing = true;
        out.lbStartT = t;
      } else {
        // re-check sooner when close
        nextLbCheck = t + Math.min(2, hs / (3 * Math.max(1, vDown)));
      }
    }
    // landing-burn thrust vector (same law as the 6-DOF guidance with no target offset)
    let tdx = 0, tdy = 0, tdz = 0, Tl = 0;
    if (landing) {
      nEng = 1;
      const Tmax = Math.max(1, M1D.thrustVac - atm.p * M1D.exitArea);
      const Tmin = Math.max(0, M1D.minThrottle * M1D.thrustVac - atm.p * M1D.exitArea);
      const Ve = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      landingProfile(vDown, hAbove, Ve, q, _lp);
      const dragUp = V > 0.1 ? (q * BOOSTER_S * boosterCd(M, 0.5) * vDown) / V : 0;
      const aVert = Math.max(3, _lp.aReq + g - dragUp / m);
      if (!_lp.finalSeg) {
        const w = _lp.w, wa = w / Math.max(0.1, V), we = (1 - w) / Ve;
        tdx = -(v.x * we + ax0 * wa); tdy = -(v.y * we + ay0 * wa); tdz = -(v.z * we + az0 * wa);
        const tn = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
        tdx /= tn; tdy /= tn; tdz /= tn;
      } else {
        // horizontal (Earth-relative) velocity damping, small tilt
        const hx = v.x - upx * vr, hy = v.y - upy * vr, hz = v.z - upz * vr;
        let lx = -hx, ly = -hy, lz = -hz;
        const lMax = aVert * 0.14;
        const lm = Math.sqrt(lx * lx + ly * ly + lz * lz);
        if (lm > lMax) { lx *= lMax / lm; ly *= lMax / lm; lz *= lMax / lm; }
        tdx = upx * aVert + lx; tdy = upy * aVert + ly; tdz = upz * aVert + lz;
        const tn = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
        tdx /= tn; tdy /= tn; tdz /= tn;
      }
      const cosUp = Math.max(0.3, tdx * upx + tdy * upy + tdz * upz);
      Tl = Math.min(Tmax, Math.max(Tmin, (m * aVert) / cosUp));
      thr = (Tl + atm.p * M1D.exitArea) / M1D.thrustVac;
    }
    if (prop <= 0) { nEng = 0; Tl = 0; }

    // ---- forces ----
    const Tn = nEng > 0 ? nEng * Math.max(0, thr * M1D.thrustVac - atm.p * M1D.exitArea) : 0;
    const retro = nEng > 0 ? Math.min(1, Tn / Math.max(1, q * BOOSTER_S * 4)) : 0;
    const D = q * BOOSTER_S * boosterCd(M, retro);
    let fx = 0, fy = 0, fz = 0;
    if (V > 0.1) {
      const k = -(D + (landing ? 0 : Tn)) / V;
      fx = ax0 * k; fy = ay0 * k; fz = az0 * k;
    }
    if (landing && Tl > 0) { fx += tdx * Tl; fy += tdy * Tl; fz += tdz * Tl; }
    // adaptive step
    let dt: number;
    if (landing) dt = 0.05;
    else if (entry) dt = 0.2;
    else if (q < 30 && h > 60_000) dt = 1.0;
    else if (h < 8_000) dt = 0.1;
    else dt = 0.25;
    if (landing && hAbove < 30) dt = 0.02;

    // ---- touchdown / impact ----
    if (hAbove <= 0 || (landing && vDown <= 0.05 && hAbove < 15)) {
      out.ok = landing;
      out.tdPos.copy(p);
      out.tdT = t;
      out.tdVel.copy(v);
      out.propTD = prop;
      out.steps = steps;
      return out;
    }

    // ---- integrate (Heun) ----
    const im = 1 / m;
    accelField(p.x, p.y, p.z, v.x, v.y, v.z, K, 0);
    const a1x = K[0] + fx * im, a1y = K[1] + fy * im, a1z = K[2] + fz * im;
    const px2 = p.x + v.x * dt, py2 = p.y + v.y * dt, pz2 = p.z + v.z * dt;
    const vx2 = v.x + a1x * dt, vy2 = v.y + a1y * dt, vz2 = v.z + a1z * dt;
    accelField(px2, py2, pz2, vx2, vy2, vz2, K, 0);
    // re-evaluate drag/thrust direction at the predicted velocity (same magnitudes)
    const bx = vx2 - wx, by = vy2 - wy, bz = vz2 - wz;
    const V2 = Math.sqrt(bx * bx + by * by + bz * bz);
    let f2x = 0, f2y = 0, f2z = 0;
    if (V2 > 0.1) {
      const h2 = altOf(px2, py2, pz2);
      const rho2 = h2 < h + 2000 ? atm.rho * Math.exp(-(h2 - h) / 7500) : atm.rho;
      const D2 = D * (rho2 / Math.max(1e-15, atm.rho)) * (V2 * V2) / Math.max(1e-6, V * V);
      const k = -(D2 + (landing ? 0 : Tn)) / V2;
      f2x = bx * k; f2y = by * k; f2z = bz * k;
      if (landing && Tl > 0) { f2x += tdx * Tl; f2y += tdy * Tl; f2z += tdz * Tl; }
    }
    const a2x = K[0] + f2x * im, a2y = K[1] + f2y * im, a2z = K[2] + f2z * im;
    p.x += 0.5 * (v.x + vx2) * dt;
    p.y += 0.5 * (v.y + vy2) * dt;
    p.z += 0.5 * (v.z + vz2) * dt;
    v.x += 0.5 * (a1x + a2x) * dt;
    v.y += 0.5 * (a1y + a2y) * dt;
    v.z += 0.5 * (a1z + a2z) * dt;
    prop -= nEng * thr * mdot1 * dt;
    if (prop < 0) prop = 0;
    t += dt;
  }
  out.ok = false;
  out.tdPos.copy(p);
  out.tdT = t;
  out.tdVel.copy(v);
  out.propTD = prop;
  out.steps = steps;
  return out;
}

void _w;
