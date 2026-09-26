// Attitude control + actuator allocation: engine gimbal (TVC), grid fins, cold-gas RCS.
//
// Conventions (also documented in core/types.ts):
//  * Engine gimbal: thrust direction in body = Rz(gimbalZ)·Rx(gimbalX)·(0,1,0)
//      = (−sin gZ·cos gX, cos gZ·cos gX, sin gX). The nozzle (exhaust) points opposite.
//      three.js: engineMesh.rotation.set(gimbalX, 0, gimbalZ, 'ZXY').
//  * Grid fin i sits at body angle φ_i = 45°, 135°, 225°, 315° (from +X toward +Z);
//      angles[i] = rotation (rad) of the fin about its outward radial axis (right-hand rule).
//  * RCS: BodyState.rcs[i] = intensity of vehicleSpec.s1.rcs.nozzles[i] (exhaust `dir`).

import { Vector3, Quaternion, Matrix4 } from 'three';
import type { RigidBody } from './rigidbody';
import type { EngineSet } from './engines';
import { F9 } from '../core/vehicleSpec';
import { FIN_CNDELTA, interp } from './aero';

const _m = new Matrix4();
const _qd = new Quaternion();
const _qe = new Quaternion();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _t = new Vector3();

/** Desired orientation with body +Y along `axis` and body +Z as close as possible to `ref`. */
export function quatFromAxisRef(axis: Vector3, ref: Vector3, out: Quaternion): Quaternion {
  _y.copy(axis).normalize();
  _z.copy(ref).addScaledVector(_y, -ref.dot(_y));
  if (_z.lengthSq() < 1e-10) {
    _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
    if (_z.lengthSq() < 1e-10) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  }
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

export interface CtrlGains {
  /** attitude error -> rate command (1/s) */
  kp: number;
  /** rate error -> accel command (1/s) */
  kr: number;
  /** max commanded rate (rad/s), transverse and roll */
  wMax: number;
  wMaxRoll: number;
  /** actuator angular-accel capability per axis (rad/s²) for braking-curve shaping */
  aMax: Vector3;
  /** fraction of the aero torque fed forward (0..1) */
  ff: number;
}

export class AttitudeCtrl {
  readonly err = new Vector3();
  readonly wDes = new Vector3();
  readonly tauDes = new Vector3();
  errAngle = 0;

  update(rb: RigidBody, axisW: Vector3, rollRefW: Vector3 | null, g: CtrlGains, aeroTorque: Vector3 | null): void {
    // desired orientation
    if (rollRefW) quatFromAxisRef(axisW, rollRefW, _qd);
    else {
      _t.set(0, 0, 1).applyQuaternion(rb.quat);
      quatFromAxisRef(axisW, _t, _qd);
    }
    _qe.copy(rb.quat).invert().multiply(_qd);
    if (_qe.w < 0) { _qe.x = -_qe.x; _qe.y = -_qe.y; _qe.z = -_qe.z; _qe.w = -_qe.w; }
    const sh = Math.sqrt(_qe.x * _qe.x + _qe.y * _qe.y + _qe.z * _qe.z);
    const ang = 2 * Math.atan2(sh, _qe.w);
    this.errAngle = ang;
    if (sh > 1e-9) this.err.set(_qe.x, _qe.y, _qe.z).multiplyScalar(ang / sh);
    else this.err.set(0, 0, 0);
    if (!rollRefW) this.err.y = 0;
    const e = this.err, w = rb.angVel, I = rb.inertia;
    const wd = this.wDes;
    wd.x = shape(e.x, g.kp, g.wMax, g.aMax.x);
    wd.y = shape(e.y, g.kp, g.wMaxRoll, g.aMax.y);
    wd.z = shape(e.z, g.kp, g.wMax, g.aMax.z);
    const Iwx = I.x * w.x, Iwy = I.y * w.y, Iwz = I.z * w.z;
    this.tauDes.set(
      I.x * g.kr * (wd.x - w.x) + (w.y * Iwz - w.z * Iwy),
      I.y * g.kr * (wd.y - w.y) + (w.z * Iwx - w.x * Iwz),
      I.z * g.kr * (wd.z - w.z) + (w.x * Iwy - w.y * Iwx),
    );
    if (aeroTorque && g.ff > 0) this.tauDes.addScaledVector(aeroTorque, -g.ff);
  }
}

/** rate command from attitude error with a braking curve (time-optimal-ish, no overshoot) */
function shape(e: number, kp: number, wMax: number, aMax: number): number {
  const ae = Math.abs(e);
  let w = Math.min(wMax, kp * ae);
  if (aMax > 0) w = Math.min(w, Math.sqrt(2 * 0.55 * aMax * ae));
  return e >= 0 ? w : -w;
}

// ---------------------------------------------------------------------------------------------
// TVC allocation

/**
 * Command engine gimbals to produce body torque tau (about the CG). Pitch/yaw from common
 * gimbal, roll from differential (tangential) gimbal of outer engines. Returns achieved torque
 * estimate in `achieved`.
 */
export function allocateGimbal(es: EngineSet, tau: Vector3, cg: Vector3, achieved: Vector3): boolean {
  let F = 0, Fout = 0;
  for (let k = 0; k < es.n; k++) {
    if (!es.cmdOn[k]) continue;
    const T = es.states[k].thrust;
    F += T;
    if (es.radius[k] > 0) Fout += T * es.radius[k];
  }
  achieved.set(0, 0, 0);
  if (F < 1000) { es.setGimbalAll(0, 0); return false; }
  const L = cg.y - es.spec.pivotY;
  const lim = es.spec.gimbalLimit;
  let gx = -tau.x / (F * L);
  let gz = -tau.z / (F * L);
  gx = Math.max(-lim, Math.min(lim, gx));
  gz = Math.max(-lim, Math.min(lim, gz));
  let d = 0;
  if (Fout > 0) d = Math.max(-lim * 0.4, Math.min(lim * 0.4, -tau.y / Fout));
  for (let k = 0; k < es.n; k++) {
    const R = es.radius[k];
    if (R > 0) {
      es.cmdGX[k] = gx + (d * es.x[k]) / R;
      es.cmdGZ[k] = gz + (d * es.z[k]) / R;
    } else {
      es.cmdGX[k] = gx;
      es.cmdGZ[k] = gz;
    }
  }
  achieved.set(-F * L * gx, -Fout * d, -F * L * gz);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Grid fins

const FIN_PHI = F9.s1.gridFin.angleDeg.map((a) => (a * Math.PI) / 180);
const FIN_COS = FIN_PHI.map(Math.cos);
const FIN_SIN = FIN_PHI.map(Math.sin);
const FIN_AREA = F9.s1.gridFin.width * F9.s1.gridFin.height;
const FIN_R = F9.radius + F9.s1.gridFin.width * 0.5;
const FIN_MAX = (22 * Math.PI) / 180;
const FIN_RATE = (90 * Math.PI) / 180;

export class GridFins {
  deploy = 0;
  deployCmd = false;
  readonly cmd = [0, 0, 0, 0];
  /** max torque (per transverse axis) available at the last allocation */
  authority = 0;
  constructor(readonly angles: [number, number, number, number], readonly finY = F9.s1.gridFin.y) {}

  step(dt: number): void {
    if (this.deployCmd) this.deploy = Math.min(1, this.deploy + dt / 2.0);
    const r = FIN_RATE * dt;
    for (let i = 0; i < 4; i++) {
      const target = this.deploy > 0.98 ? this.cmd[i] : 0;
      this.angles[i] += Math.max(-r, Math.min(r, target - this.angles[i]));
    }
  }

  /** Allocate body torque tau to fin deflections. flowSign: +1 nose-first flow, −1 engines-first. */
  allocate(tau: Vector3, q: number, mach: number, flowSign: number, cg: Vector3, achieved: Vector3): void {
    achieved.set(0, 0, 0);
    const k = q * FIN_AREA * interp(FIN_CNDELTA, mach) * this.deploy;
    const h = this.finY - cg.y;
    this.authority = 2.83 * h * k * FIN_MAX;
    if (k < 1 || this.deploy < 0.98) {
      for (let i = 0; i < 4; i++) this.cmd[i] = 0;
      return;
    }
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < 4; i++) {
      const Ft = (tau.x * FIN_COS[i]) / (2 * h) + (tau.z * FIN_SIN[i]) / (2 * h) - tau.y / (4 * FIN_R);
      let d = Ft / (flowSign * k);
      d = Math.max(-FIN_MAX, Math.min(FIN_MAX, d));
      this.cmd[i] = d;
      const f = flowSign * k * d;
      ax += f * h * FIN_COS[i];
      ay += -f * FIN_R;
      az += f * h * FIN_SIN[i];
    }
    achieved.set(ax, ay, az);
  }

  /** Apply the physical fin control forces (actual deflections) to the body. */
  apply(rb: RigidBody, q: number, mach: number, flowSign: number): void {
    if (this.deploy <= 0 || q <= 0) return;
    const k = q * FIN_AREA * interp(FIN_CNDELTA, mach) * this.deploy;
    for (let i = 0; i < 4; i++) {
      const f = flowSign * k * this.angles[i];
      if (f === 0) continue;
      // force along tangential t_i = (−sin φ, 0, cos φ) at (R cos φ, finY, R sin φ)
      rb.addBodyForceAt(-FIN_SIN[i] * f, 0, FIN_COS[i] * f, FIN_R * FIN_COS[i], this.finY, FIN_R * FIN_SIN[i]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// RCS (cold gas), bang-bang with hysteresis and a minimum impulse bit

interface Nozzle { px: number; py: number; pz: number; fx: number; fy: number; fz: number }

// axis -> [positive nozzles, negative nozzles]
const RCS_MAP: Record<'x' | 'y' | 'z', [number[], number[]]> = {
  x: [[6, 7], [2, 3]],
  y: [[1, 4], [0, 5]],
  z: [[0, 4], [1, 5]],
};

export class Rcs {
  readonly nozzles: Nozzle[] = [];
  private fire = new Float64Array(8);
  private onTimer = new Float64Array(8);
  private axisState = { x: 0, y: 0, z: 0 };
  /** max angular acceleration per axis for the given inertia */
  readonly aMax = new Vector3();
  /** remaining N2 (kg) — cosmetic budget */
  gas = 900;

  constructor(readonly out: number[], podY: number, podR: number, readonly thrust: number) {
    const podAng = F9.s1.rcs.podAngleDeg.map((a) => (a * Math.PI) / 180);
    for (const n of F9.s1.rcs.nozzles) {
      const a = podAng[n.pod];
      this.nozzles.push({
        px: podR * Math.cos(a), py: podY, pz: podR * Math.sin(a),
        fx: -n.dir[0] * thrust, fy: -n.dir[1] * thrust, fz: -n.dir[2] * thrust,
      });
    }
  }

  updateAMax(rb: RigidBody): void {
    const h = Math.abs(this.nozzles[0].py - rb.cg.y);
    const R = Math.abs(this.nozzles[0].pz);
    this.aMax.set((2 * 0.866 * this.thrust * h) / rb.inertia.x, (2 * this.thrust * R) / rb.inertia.y, (2 * this.thrust * h) / rb.inertia.z);
  }

  /**
   * Per-axis phase-plane logic on rate error (wDes − w). mask selects axes the RCS controls.
   * dbOn/dbOff: rate error thresholds (rad/s).
   */
  control(dt: number, wDes: Vector3, w: Vector3, mask: { x: boolean; y: boolean; z: boolean }, dbOn: number, dbOff: number): void {
    const cmd = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const ax of ['x', 'y', 'z'] as const) {
      if (!mask[ax]) { this.axisState[ax] = 0; continue; }
      const r = wDes[ax] - w[ax];
      let s = this.axisState[ax];
      if (s === 0) {
        if (r > dbOn) s = 1;
        else if (r < -dbOn) s = -1;
      } else if (s * r < dbOff) s = 0;
      this.axisState[ax] = s;
      if (s !== 0) for (const i of RCS_MAP[ax][s > 0 ? 0 : 1]) cmd[i] = 1;
    }
    // opposing tangential nozzles on the same pod cancel
    if (cmd[0] && cmd[1]) cmd[0] = cmd[1] = 0;
    if (cmd[4] && cmd[5]) cmd[4] = cmd[5] = 0;
    for (let i = 0; i < 8; i++) {
      if (cmd[i]) { this.fire[i] = 1; this.onTimer[i] = Math.max(this.onTimer[i], RCS.minOnDefault); }
      else if (this.onTimer[i] > 0) this.onTimer[i] -= dt;
      else this.fire[i] = 0;
    }
  }

  off(): void {
    this.fire.fill(0);
    this.onTimer.fill(0);
    this.axisState.x = this.axisState.y = this.axisState.z = 0;
  }

  /** Apply forces for the step and update the visual intensities (smoothed). */
  apply(rb: RigidBody | null, dt: number): void {
    const k = Math.min(1, dt / 0.03);
    let any = false;
    for (let i = 0; i < 8; i++) {
      const f = this.fire[i];
      this.out[i] += (f - this.out[i]) * k;
      if (this.out[i] < 1e-3) this.out[i] = 0;
      if (f > 0 && rb) {
        const n = this.nozzles[i];
        rb.addBodyForceAt(n.fx, n.fy, n.fz, n.px, n.py, n.pz);
        any = true;
      }
    }
    if (any) this.gas = Math.max(0, this.gas - dt * 0.6);
  }
}

const RCS = { minOnDefault: 0.08 };
