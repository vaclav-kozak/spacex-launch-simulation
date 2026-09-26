// 6-DOF rigid body in the rotating Earth-fixed W frame.
// Translation: RK4 on (p, v) with gravity μ/r², Coriolis −2Ω×v and centrifugal −Ω×(Ω×r); the
// non-gravitational acceleration (thrust, aero, RCS) is held constant over the step.
// Rotation: Euler's equations with principal inertias, quaternion exponential update.

import { Vector3, Quaternion } from 'three';
import { EARTH_MU, EARTH_RADIUS } from '../core/constants';
import { EARTH_OMEGA_W } from '../core/frames';

const OY = EARTH_OMEGA_W.y, OZ = EARTH_OMEGA_W.z; // Ωx = 0 in W

/** Gravity + fictitious accelerations at (p, v) (W) into out[0..2]. */
export function accelField(px: number, py: number, pz: number, vx: number, vy: number, vz: number, out: Float64Array, o = 0): void {
  const rx = px, ry = py + EARTH_RADIUS, rz = pz;
  const r2 = rx * rx + ry * ry + rz * rz;
  const r = Math.sqrt(r2);
  const k = -EARTH_MU / (r2 * r);
  // Ω × v   with Ω = (0, OY, OZ)
  const cx = OY * vz - OZ * vy, cy = OZ * vx, cz = -OY * vx;
  // Ω × (Ω × r)
  const wrx = OY * rz - OZ * ry, wry = OZ * rx, wrz = -OY * rx;
  const ccx = OY * wrz - OZ * wry, ccy = OZ * wrx, ccz = -OY * wrx;
  out[o] = k * rx - 2 * cx - ccx;
  out[o + 1] = k * ry - 2 * cy - ccy;
  out[o + 2] = k * rz - 2 * cz - ccz;
}

const K = new Float64Array(12);
const A = new Float64Array(3);
const _v = new Vector3();
const _q = new Quaternion();

export class RigidBody {
  /** CG position (W) */
  readonly pos = new Vector3();
  /** CG Earth-relative velocity (W) */
  readonly vel = new Vector3();
  /** body -> W */
  readonly quat = new Quaternion();
  /** body-frame angular velocity */
  readonly angVel = new Vector3();
  mass = 1;
  /** CG in body frame (relative to the body origin) */
  readonly cg = new Vector3();
  /** principal inertias (body X, Y, Z) */
  readonly inertia = new Vector3(1, 1, 1);
  /** accumulated non-gravitational force (W) */
  readonly force = new Vector3();
  /** accumulated torque about CG (body) */
  readonly torque = new Vector3();
  /** last non-gravitational acceleration (W) */
  readonly aNG = new Vector3();
  /** clamp: kinematic (pose driven externally) */
  kinematic = false;

  /** body origin (nozzle exit / base) in W */
  origin(out: Vector3): Vector3 {
    return out.copy(this.cg).applyQuaternion(this.quat).negate().add(this.pos);
  }

  /** Set pose from origin position (W). */
  setOrigin(o: Vector3): void {
    this.pos.copy(this.cg).applyQuaternion(this.quat).add(o);
  }

  /** W velocity of a body-frame point. */
  pointVel(bp: Vector3, out: Vector3): Vector3 {
    out.copy(bp).sub(this.cg).applyQuaternion(this.quat);
    _v.copy(this.angVel).applyQuaternion(this.quat);
    return out.crossVectors(_v, out).add(this.vel);
  }

  /** Update mass properties keeping the body origin fixed in space. */
  setMassProps(m: number, cx: number, cy: number, cz: number, Ixx: number, Iyy: number, Izz: number): void {
    _v.set(cx - this.cg.x, cy - this.cg.y, cz - this.cg.z).applyQuaternion(this.quat);
    this.pos.add(_v);
    this.cg.set(cx, cy, cz);
    this.mass = m;
    this.inertia.set(Ixx, Iyy, Izz);
  }

  clearForces(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /** Add a body-frame force applied at body point (bx,by,bz). */
  addBodyForceAt(fx: number, fy: number, fz: number, bx: number, by: number, bz: number): void {
    _v.set(fx, fy, fz).applyQuaternion(this.quat);
    this.force.add(_v);
    const rx = bx - this.cg.x, ry = by - this.cg.y, rz = bz - this.cg.z;
    this.torque.x += ry * fz - rz * fy;
    this.torque.y += rz * fx - rx * fz;
    this.torque.z += rx * fy - ry * fx;
  }

  /** Add a body-frame force through the CG plus a body torque. */
  addBodyForceTorque(F: Vector3, T: Vector3): void {
    _v.copy(F).applyQuaternion(this.quat);
    this.force.add(_v);
    this.torque.add(T);
  }

  integrate(dt: number): void {
    if (this.kinematic) return;
    const im = 1 / this.mass;
    const ax = this.force.x * im, ay = this.force.y * im, az = this.force.z * im;
    this.aNG.set(ax, ay, az);
    const p = this.pos, v = this.vel;
    const h = dt, h2 = dt / 2;
    // RK4
    accelField(p.x, p.y, p.z, v.x, v.y, v.z, K, 0);
    const k1vx = K[0] + ax, k1vy = K[1] + ay, k1vz = K[2] + az;
    const p2x = p.x + h2 * v.x, p2y = p.y + h2 * v.y, p2z = p.z + h2 * v.z;
    const v2x = v.x + h2 * k1vx, v2y = v.y + h2 * k1vy, v2z = v.z + h2 * k1vz;
    accelField(p2x, p2y, p2z, v2x, v2y, v2z, K, 3);
    const k2vx = K[3] + ax, k2vy = K[4] + ay, k2vz = K[5] + az;
    const p3x = p.x + h2 * v2x, p3y = p.y + h2 * v2y, p3z = p.z + h2 * v2z;
    const v3x = v.x + h2 * k2vx, v3y = v.y + h2 * k2vy, v3z = v.z + h2 * k2vz;
    accelField(p3x, p3y, p3z, v3x, v3y, v3z, K, 6);
    const k3vx = K[6] + ax, k3vy = K[7] + ay, k3vz = K[8] + az;
    const p4x = p.x + h * v3x, p4y = p.y + h * v3y, p4z = p.z + h * v3z;
    const v4x = v.x + h * k3vx, v4y = v.y + h * k3vy, v4z = v.z + h * k3vz;
    accelField(p4x, p4y, p4z, v4x, v4y, v4z, K, 9);
    const k4vx = K[9] + ax, k4vy = K[10] + ay, k4vz = K[11] + az;
    const h6 = h / 6;
    p.x += h6 * (v.x + 2 * v2x + 2 * v3x + v4x);
    p.y += h6 * (v.y + 2 * v2y + 2 * v3y + v4y);
    p.z += h6 * (v.z + 2 * v2z + 2 * v3z + v4z);
    v.x += h6 * (k1vx + 2 * k2vx + 2 * k3vx + k4vx);
    v.y += h6 * (k1vy + 2 * k2vy + 2 * k3vy + k4vy);
    v.z += h6 * (k1vz + 2 * k2vz + 2 * k3vz + k4vz);

    // rotation (body frame): I ω' = τ − ω × Iω
    const w = this.angVel, I = this.inertia, T = this.torque;
    const Iwx = I.x * w.x, Iwy = I.y * w.y, Iwz = I.z * w.z;
    const gx = w.y * Iwz - w.z * Iwy, gy = w.z * Iwx - w.x * Iwz, gz = w.x * Iwy - w.y * Iwx;
    w.x += ((T.x - gx) / I.x) * dt;
    w.y += ((T.y - gy) / I.y) * dt;
    w.z += ((T.z - gz) / I.z) * dt;
    const wl = w.length();
    if (wl > 1e-12) {
      const ang = wl * dt;
      const s = Math.sin(ang / 2) / wl;
      _q.set(w.x * s, w.y * s, w.z * s, Math.cos(ang / 2));
      this.quat.multiply(_q).normalize();
    }
  }
}

/** gravity + fictitious acceleration at p (W, allocation-free helper) */
export function gravityAt(p: Vector3, v: Vector3, out: Vector3): Vector3 {
  accelField(p.x, p.y, p.z, v.x, v.y, v.z, A, 0);
  return out.set(A[0], A[1], A[2]);
}
