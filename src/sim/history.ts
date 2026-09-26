// Ring buffer of compact snapshots for slow-motion replay (≥ 120 s at 30 Hz of sim time).
// Positions stored as float64, everything else float32. sample(t) interpolates (lerp pos/vel,
// slerp quat, lerp scalars) and returns a full SimSnapshot (reused object).

import { Vector3, Quaternion } from 'three';
import type { BodyId, BodyState, BodyStatus, S1Phase, SimSnapshot } from '../core/types';
import { makeBody } from './bodies';

export const BODY_IDS: BodyId[] = ['S1', 'S2', 'FAIRING_A', 'FAIRING_B', 'PAYLOAD', 'SHIP'];
const STATUSES: BodyStatus[] = ['stacked', 'free', 'landed', 'tipped', 'splashed', 'destroyed', 'orbit', 'deployed', 'gone'];
const PHASES: S1Phase[] = ['PRELAUNCH', 'ASCENT', 'COAST', 'FLIP', 'ENTRY_BURN', 'AERO', 'LANDING_BURN', 'LANDED', 'LOST', 'BOOST'];

const PER_BODY = 34;
const ENG_FIELDS = 7;
const N_ENG = 10; // S1 9 + S2 1
const F32_LEN = BODY_IDS.length * PER_BODY + N_ENG * ENG_FIELDS + 16 + 3 + 6;
const F64_LEN = BODY_IDS.length * 3 + 1 + 3;

export class History {
  readonly cap: number;
  private f32: Float32Array;
  private f64: Float64Array;
  private count = 0;
  private head = 0; // next write index
  private out: SimSnapshot;
  private tmpA: Float32Array;
  private tmpB: Float32Array;
  interval = 1 / 30;
  private nextT = -Infinity;

  constructor(seconds = 120, hz = 30) {
    this.cap = Math.ceil(seconds * hz);
    this.interval = 1 / hz;
    this.f32 = new Float32Array(this.cap * F32_LEN);
    this.f64 = new Float64Array(this.cap * F64_LEN);
    this.tmpA = new Float32Array(F32_LEN);
    this.tmpB = new Float32Array(F32_LEN);
    const bodies = {} as Record<BodyId, BodyState>;
    for (const id of BODY_IDS) bodies[id] = makeBody(id);
    this.out = {
      t: 0, paused: false, countdownHeld: false, warp: 1, bodies, wind: new Vector3(), timeline: [],
      landing: { impactPoint: new Vector3(), missDistance: 0, burnStartT: 0, touchdownT: 0, manual: false },
    };
  }

  get start(): number {
    if (this.count === 0) return 0;
    const i = (this.head - this.count + this.cap) % this.cap;
    return this.f64[i * F64_LEN + BODY_IDS.length * 3];
  }

  get end(): number {
    if (this.count === 0) return 0;
    const i = (this.head - 1 + this.cap) % this.cap;
    return this.f64[i * F64_LEN + BODY_IDS.length * 3];
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    this.nextT = -Infinity;
  }

  /** Record if due (called every sim step with the current full snapshot). */
  maybeRecord(s: SimSnapshot): void {
    if (s.t < this.nextT) return;
    this.nextT = s.t + this.interval * 0.999;
    if (this.count > 0 && s.t <= this.end) return;
    this.record(s);
  }

  record(s: SimSnapshot): void {
    const i = this.head;
    const a = this.f32, d = this.f64;
    let o = i * F32_LEN, o64 = i * F64_LEN;
    for (const id of BODY_IDS) {
      const b = s.bodies[id];
      d[o64++] = b.pos.x; d[o64++] = b.pos.y; d[o64++] = b.pos.z;
      a[o++] = b.vel.x; a[o++] = b.vel.y; a[o++] = b.vel.z;
      a[o++] = b.quat.x; a[o++] = b.quat.y; a[o++] = b.quat.z; a[o++] = b.quat.w;
      a[o++] = b.angVel.x; a[o++] = b.angVel.y; a[o++] = b.angVel.z;
      a[o++] = STATUSES.indexOf(b.status);
      a[o++] = b.phase ? PHASES.indexOf(b.phase) : -1;
      a[o++] = b.mass; a[o++] = b.propMass; a[o++] = b.propCapacity;
      a[o++] = b.altitude; a[o++] = b.speedInertial; a[o++] = b.speed; a[o++] = b.verticalSpeed;
      a[o++] = b.mach; a[o++] = b.dynPressure; a[o++] = b.ambientPressure; a[o++] = b.density;
      a[o++] = b.downrange; a[o++] = b.gLoad; a[o++] = b.thrust; a[o++] = b.heating;
      a[o++] = b.parafoil ?? -1; a[o++] = b.legs ?? -1;
      const gf = b.gridFins;
      a[o++] = gf ? gf.deploy : -1;
      a[o++] = gf ? gf.angles[0] : 0; a[o++] = gf ? gf.angles[1] : 0; a[o++] = gf ? gf.angles[2] : 0; a[o++] = gf ? gf.angles[3] : 0;
    }
    for (const id of ['S1', 'S2'] as BodyId[]) {
      for (const e of s.bodies[id].engines) {
        a[o++] = e.on ? 1 : 0; a[o++] = e.throttle; a[o++] = e.gimbalX; a[o++] = e.gimbalZ;
        a[o++] = e.spool; a[o++] = e.thrust; a[o++] = isFinite(e.ignitionT) ? e.ignitionT : -1e9;
      }
    }
    for (const id of ['S1', 'S2'] as BodyId[]) for (let k = 0; k < 8; k++) a[o++] = s.bodies[id].rcs[k] ?? 0;
    a[o++] = s.wind.x; a[o++] = s.wind.y; a[o++] = s.wind.z;
    const L = s.landing;
    a[o++] = L ? 1 : 0;
    a[o++] = L ? L.missDistance : 0; a[o++] = L ? L.burnStartT : 0; a[o++] = L ? L.touchdownT : 0; a[o++] = L && L.manual ? 1 : 0;
    a[o++] = 0;
    d[o64++] = s.t;
    d[o64++] = L ? L.impactPoint.x : 0; d[o64++] = L ? L.impactPoint.y : 0; d[o64++] = L ? L.impactPoint.z : 0;
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
  }

  private timeAt(k: number): number {
    const i = (this.head - this.count + k + this.cap) % this.cap;
    return this.f64[i * F64_LEN + BODY_IDS.length * 3];
  }

  private idx(k: number): number {
    return (this.head - this.count + k + this.cap) % this.cap;
  }

  /** Interpolated snapshot at mission time t (null if empty). `live` supplies timeline/warp flags. */
  sample(t: number, live?: SimSnapshot): SimSnapshot | null {
    if (this.count === 0) return null;
    let lo = 0, hi = this.count - 1;
    if (t <= this.timeAt(0)) hi = 0;
    else if (t >= this.timeAt(hi)) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.timeAt(mid) <= t) lo = mid;
        else hi = mid;
      }
    }
    const ia = this.idx(lo), ib = this.idx(hi);
    const ta = this.timeAt(lo), tb = this.timeAt(hi);
    const f = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
    const A = this.tmpA, B = this.tmpB;
    A.set(this.f32.subarray(ia * F32_LEN, (ia + 1) * F32_LEN));
    B.set(this.f32.subarray(ib * F32_LEN, (ib + 1) * F32_LEN));
    const da = ia * F64_LEN, db = ib * F64_LEN;
    const s = this.out;
    s.t = t;
    if (live) {
      s.timeline = live.timeline; s.paused = live.paused; s.warp = live.warp; s.countdownHeld = live.countdownHeld;
    }
    const lerp = (k: number) => A[k] + (B[k] - A[k]) * f;
    const near = (k: number) => (f < 0.5 ? A[k] : B[k]);
    let o = 0, o64 = 0;
    for (const id of BODY_IDS) {
      const b = s.bodies[id];
      const x = this.f64[da + o64] + (this.f64[db + o64] - this.f64[da + o64]) * f; o64++;
      const y = this.f64[da + o64] + (this.f64[db + o64] - this.f64[da + o64]) * f; o64++;
      const z = this.f64[da + o64] + (this.f64[db + o64] - this.f64[da + o64]) * f; o64++;
      b.pos.set(x, y, z);
      b.vel.set(lerp(o), lerp(o + 1), lerp(o + 2)); o += 3;
      _qa.set(A[o], A[o + 1], A[o + 2], A[o + 3]);
      _qb.set(B[o], B[o + 1], B[o + 2], B[o + 3]);
      b.quat.copy(_qa).slerp(_qb, f); o += 4;
      b.angVel.set(lerp(o), lerp(o + 1), lerp(o + 2)); o += 3;
      b.status = STATUSES[near(o)] ?? 'gone'; o++;
      const ph = near(o); o++;
      b.phase = ph >= 0 ? PHASES[ph] : undefined;
      b.mass = lerp(o++); b.propMass = lerp(o++); b.propCapacity = lerp(o++);
      b.altitude = lerp(o++); b.speedInertial = lerp(o++); b.speed = lerp(o++); b.verticalSpeed = lerp(o++);
      b.mach = lerp(o++); b.dynPressure = lerp(o++); b.ambientPressure = lerp(o++); b.density = lerp(o++);
      b.downrange = lerp(o++); b.gLoad = lerp(o++); b.thrust = lerp(o++); b.heating = lerp(o++);
      const pf = lerp(o++); if (b.parafoil !== undefined || pf >= 0) b.parafoil = Math.max(0, pf);
      const lg = lerp(o++); if (b.legs !== undefined || lg >= 0) b.legs = Math.max(0, lg);
      const gd = lerp(o++);
      if (b.gridFins) {
        b.gridFins.deploy = Math.max(0, gd);
        for (let k = 0; k < 4; k++) b.gridFins.angles[k] = lerp(o + k);
      }
      o += 4;
    }
    for (const id of ['S1', 'S2'] as BodyId[]) {
      for (const e of s.bodies[id].engines) {
        e.on = near(o) > 0.5; e.throttle = lerp(o + 1); e.gimbalX = lerp(o + 2); e.gimbalZ = lerp(o + 3);
        e.spool = lerp(o + 4); e.thrust = lerp(o + 5); e.ignitionT = near(o + 6) < -1e8 ? -Infinity : near(o + 6);
        o += ENG_FIELDS;
      }
    }
    for (const id of ['S1', 'S2'] as BodyId[]) for (let k = 0; k < 8; k++) s.bodies[id].rcs[k] = lerp(o++);
    s.wind.set(lerp(o), lerp(o + 1), lerp(o + 2)); o += 3;
    const hasL = near(o) > 0.5;
    if (hasL && s.landing) {
      s.landing.missDistance = lerp(o + 1); s.landing.burnStartT = lerp(o + 2); s.landing.touchdownT = lerp(o + 3);
      s.landing.manual = near(o + 4) > 0.5;
      const ko = BODY_IDS.length * 3 + 1;
      s.landing.impactPoint.set(
        this.f64[da + ko] + (this.f64[db + ko] - this.f64[da + ko]) * f,
        this.f64[da + ko + 1] + (this.f64[db + ko + 1] - this.f64[da + ko + 1]) * f,
        this.f64[da + ko + 2] + (this.f64[db + ko + 2] - this.f64[da + ko + 2]) * f,
      );
    }
    return s;
  }
}

const _qa = new Quaternion();
const _qb = new Quaternion();
