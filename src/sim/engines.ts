// Engine cluster model: per-engine spool transient, rate-limited throttle and gimbal,
// pressure-dependent thrust (F = thr·F_vac − p·A_exit), constant mass flow per throttle.

import { Vector3 } from 'three';
import type { EngineState } from '../core/types';
import { M1D, MVAC } from './simconst';

export type EngineSpec = typeof M1D | typeof MVAC;

export function makeEngineStates(n: number): EngineState[] {
  return Array.from({ length: n }, () => ({
    on: false, throttle: 0, gimbalX: 0, gimbalZ: 0, spool: 0, ignitionT: -Infinity, thrust: 0,
  }));
}

function ss(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

export class EngineSet {
  readonly n: number;
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly radius: number[] = [];
  readonly cmdOn: boolean[];
  cmdThrottle = 1;
  readonly cmdGX: number[];
  readonly cmdGZ: number[];
  private phase: number[];
  private thr: number[];
  readonly force = new Vector3();
  readonly torque = new Vector3();
  mdot = 0;
  totalThrust = 0;
  /** set true on the step propellant ran out while engines were commanded on */
  flameout = false;

  constructor(readonly spec: EngineSpec, readonly states: EngineState[], ringRadius: number, angleDeg: (k: number) => number) {
    this.n = states.length;
    for (let k = 0; k < this.n; k++) {
      if (k === 0) { this.x.push(0); this.z.push(0); this.radius.push(0); continue; }
      const a = (angleDeg(k) * Math.PI) / 180;
      this.x.push(ringRadius * Math.cos(a));
      this.z.push(ringRadius * Math.sin(a));
      this.radius.push(ringRadius);
    }
    this.cmdOn = new Array(this.n).fill(false);
    this.cmdGX = new Array(this.n).fill(0);
    this.cmdGZ = new Array(this.n).fill(0);
    this.phase = new Array(this.n).fill(0);
    this.thr = new Array(this.n).fill(1);
  }

  /** Start (or keep running) the listed engines at mission time t; others are shut down. */
  command(indices: readonly number[] | 'all' | 'none', t: number): void {
    for (let k = 0; k < this.n; k++) {
      const want = indices === 'all' ? true : indices === 'none' ? false : indices.includes(k);
      if (want && !this.cmdOn[k]) this.states[k].ignitionT = t;
      this.cmdOn[k] = want;
    }
  }

  start(k: number, t: number): void {
    if (!this.cmdOn[k]) this.states[k].ignitionT = t;
    this.cmdOn[k] = true;
  }

  anyOn(): boolean {
    for (let k = 0; k < this.n; k++) if (this.cmdOn[k] || this.states[k].spool > 0.02) return true;
    return false;
  }

  activeCount(): number {
    let c = 0;
    for (let k = 0; k < this.n; k++) if (this.cmdOn[k]) c++;
    return c;
  }

  /** Nominal max thrust (N) of currently commanded engines at ambient pressure p, full throttle. */
  maxThrust(p: number): number {
    let c = 0;
    for (let k = 0; k < this.n; k++) if (this.cmdOn[k]) c++;
    return c * Math.max(0, this.spec.thrustVac - p * this.spec.exitArea);
  }

  setGimbalAll(gx: number, gz: number): void {
    for (let k = 0; k < this.n; k++) { this.cmdGX[k] = gx; this.cmdGZ[k] = gz; }
  }

  step(dt: number, pAmb: number, cg: Vector3, prop: number): void {
    const sp = this.spec;
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.mdot = 0;
    this.totalThrust = 0;
    this.flameout = false;
    if (prop <= 0) {
      for (let k = 0; k < this.n; k++) if (this.cmdOn[k]) { this.cmdOn[k] = false; this.flameout = true; }
    }
    const lim = sp.gimbalLimit, gr = sp.gimbalRate * dt;
    const cmdT = Math.max(sp.minThrottle, Math.min(1, this.cmdThrottle));
    const tr = sp.throttleRate * dt;
    for (let k = 0; k < this.n; k++) {
      const st = this.states[k];
      let s = st.spool;
      if (this.cmdOn[k]) {
        this.phase[k] = Math.min(1, this.phase[k] + dt / sp.startup);
        s = Math.max(s, ss(this.phase[k]));
      } else {
        s = Math.max(0, s * Math.exp(-dt / (sp.shutdown * 0.5)) - dt * 0.3);
        this.phase[k] = Math.min(this.phase[k], s);
      }
      st.spool = s;
      // throttle actuator
      const th = this.thr[k];
      this.thr[k] = th + Math.max(-tr, Math.min(tr, cmdT - th));
      // gimbal actuator (rate limited), recentres when shut down
      const gxT = this.cmdOn[k] ? Math.max(-lim, Math.min(lim, this.cmdGX[k])) : 0;
      const gzT = this.cmdOn[k] ? Math.max(-lim, Math.min(lim, this.cmdGZ[k])) : 0;
      st.gimbalX += Math.max(-gr, Math.min(gr, gxT - st.gimbalX));
      st.gimbalZ += Math.max(-gr, Math.min(gr, gzT - st.gimbalZ));
      st.on = this.cmdOn[k] || s > 0.05;
      st.throttle = st.on ? this.thr[k] : 0;
      if (s <= 1e-4) { st.thrust = 0; continue; }
      const T = Math.max(0, s * (this.thr[k] * sp.thrustVac - pAmb * sp.exitArea));
      st.thrust = T;
      this.mdot += s * this.thr[k] * sp.mdot;
      this.totalThrust += T;
      const cgx = Math.cos(st.gimbalX), sgx = Math.sin(st.gimbalX);
      const cgz = Math.cos(st.gimbalZ), sgz = Math.sin(st.gimbalZ);
      const fx = -sgz * cgx * T, fy = cgz * cgx * T, fz = sgx * T;
      this.force.x += fx; this.force.y += fy; this.force.z += fz;
      const rx = this.x[k] - cg.x, ry = sp.pivotY - cg.y, rz = this.z[k] - cg.z;
      this.torque.x += ry * fz - rz * fy;
      this.torque.y += rz * fx - rx * fz;
      this.torque.z += rx * fy - ry * fx;
    }
  }
}
