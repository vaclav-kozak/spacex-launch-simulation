// Particle emitters driven by the snapshot. All positions W (doubles).
import * as THREE from 'three';
import { PAD_ELEVATION } from '../../core/constants';
import type { BodyState } from '../../core/types';
import { F9, OCISLY } from '../../core/vehicleSpec';
import { altitudeW, clamp01, makeRng, smooth } from './common';
import { P_DECK, P_GROUND, P_NOWIND, P_OCEAN, P_PADGRID, P_THIN, type ParticleSystem } from './particles';
import { plumeRadiusAt, type PlumeShape } from './plume';

/**
 * SLC-4E flame trench: exhaust is deflected sideways and leaves the trench mouth this far from the
 * launch mount, heading along PAD_TRENCH_AZIMUTH (deg from north, clockwise). Keep in sync with the
 * pad model (see docs/notes/vfx.md).
 */
export const PAD_TRENCH_AZIMUTH_DEG = 200;
export const PAD_TRENCH_EXIT_DIST = 42;
export const PAD_TRENCH_DEPTH = 9;

const az = (PAD_TRENCH_AZIMUTH_DEG * Math.PI) / 180;
export const TRENCH_DIR = new THREE.Vector3(Math.sin(az), 0, -Math.cos(az));
export const TRENCH_EXIT = new THREE.Vector3().copy(TRENCH_DIR).multiplyScalar(PAD_TRENCH_EXIT_DIST).setY(PAD_ELEVATION - 3);

const rng = makeRng(12345);
const R = () => rng();
const RS = () => rng() * 2 - 1;

/** Nominal nozzle height above the pad vs mission time (for pre-warm after ?seek). */
export function nominalPadHeight(t: number): number {
  const tf = Math.max(0, t);
  return 4 + 2.2 * tf * tf;
}

export interface PadInput {
  t: number;
  /** nozzle-exit height above the pad surface */
  hN: number;
  /** 0..1 total thrust fraction (9 engines at full = 1) */
  thrust: number;
  /** seconds since first ignition */
  sinceIgn: number;
  /** W horizontal position of the plume axis at ground */
  gx: number;
  gz: number;
}

export class PadEmitter {
  private acc = { trench: 0, fire: 0, mount: 0, radial: 0, dark: 0 };

  update(dt: number, inp: PadInput, ps: ParticleSystem, q: number): void {
    const th = inp.thrust;
    if (th <= 0.01 || inp.hN > 400) return;
    const hN = inp.hN;
    const s = ps.s;
    const inTrench = smooth(95, 12, hN);
    const early = 1 - smooth(1.0, 3.0, inp.sinceIgn); // TEA-TEB + fuel-rich start: brownish
    const g0 = PAD_ELEVATION;
    // --- flame-trench mouth: violent sideways jet of steam + exhaust
    this.acc.trench += dt * 120 * q * th * inTrench;
    while (this.acc.trench >= 1) {
      this.acc.trench -= 1;
      const lat = RS() * 7;
      const px = TRENCH_EXIT.x - TRENCH_DIR.z * lat, pz = TRENCH_EXIT.z + TRENCH_DIR.x * lat;
      const sp = (40 + 40 * R()) * (0.55 + 0.45 * th);
      const spread = RS() * 0.35;
      const dx = TRENCH_DIR.x - TRENCH_DIR.z * spread, dz = TRENCH_DIR.z + TRENCH_DIR.x * spread;
      s.x = px; s.y = g0 - 1 + R() * 5; s.z = pz;
      s.vx = dx * sp; s.vy = 4 + 12 * R(); s.vz = dz * sp;
      s.size0 = 4 + 3 * R(); s.size1 = 26 + 22 * R(); s.sizeTau = 9 + 6 * R(); s.sizeDiff = 1.2;
      s.life = 140 + 90 * R(); s.tau = 42; s.fadeIn = 0.25;
      s.drag = 2.2 + R(); s.buoy = 2.2 + 1.5 * R(); s.buoyTau = 30;
      const w = 0.92 - 0.05 * R();
      // (the fuel-rich start only greys the very first puffs a little; the cloud is deluge steam)
      s.r = w - early * 0.14; s.g = w - early * 0.16; s.b = w + 0.02 - early * 0.2;
      // (emission kept low: glowing steam puffs out-shone the smoke's plume light at night)
      s.temp = early > 0.3 || R() < 0.25 ? 1500 + 500 * R() : 0; s.tempTau = 0.35; s.emis = 2.5;
      s.variant = (R() * 4) | 0; s.turb = 2.5; s.flags = P_GROUND | P_PADGRID; s.spin = RS() * 0.05; s.prio = 3;
      s.level = -1;
      ps.emit();
    }
    // --- fire licking out of the trench (bright, short-lived, turns to dark smoke)
    this.acc.fire += dt * 70 * q * th * smooth(60, 8, hN);
    while (this.acc.fire >= 1) {
      this.acc.fire -= 1;
      const lat = RS() * 4;
      s.x = TRENCH_EXIT.x - TRENCH_DIR.z * lat - TRENCH_DIR.x * 8; s.y = g0 - 1 + R() * 3; s.z = TRENCH_EXIT.z + TRENCH_DIR.x * lat - TRENCH_DIR.z * 8;
      const sp = 60 + 40 * R();
      s.vx = TRENCH_DIR.x * sp + RS() * 8; s.vy = 3 + 8 * R(); s.vz = TRENCH_DIR.z * sp + RS() * 8;
      s.size0 = 2.5 + 2 * R(); s.size1 = 10 + 6 * R(); s.sizeTau = 0.8; s.sizeDiff = 0;
      s.life = 1.2 + R() * 0.8; s.tau = 1.5; s.fadeIn = 0.03;
      s.drag = 0.8; s.buoy = 4; s.buoyTau = 2;
      s.r = 0.25; s.g = 0.2; s.b = 0.17;
      s.temp = 2150 + 250 * R(); s.tempTau = 0.45; s.emis = 14;
      s.variant = (R() * 4) | 0; s.turb = 3; s.flags = P_GROUND; s.spin = RS() * 0.8; s.prio = 1;
      s.level = -1;
      ps.emit();
    }
    // --- deluge steam boiling up around the launch mount
    this.acc.mount += dt * 18 * q * th * smooth(70, 4, hN);
    while (this.acc.mount >= 1) {
      this.acc.mount -= 1;
      const a = R() * Math.PI * 2, rr = 5 + 9 * R();
      s.x = inp.gx + Math.cos(a) * rr; s.y = g0 + R() * 3; s.z = inp.gz + Math.sin(a) * rr;
      // (rises as a veil around the mount rather than rolling out over the close pad cameras)
      const out = 2 + 4 * R();
      s.vx = Math.cos(a) * out; s.vy = 7 + 12 * R(); s.vz = Math.sin(a) * out;
      s.size0 = 2.5 + 2 * R(); s.size1 = 10 + 8 * R(); s.sizeTau = 7; s.sizeDiff = 0.8;
      s.life = 45 + 40 * R(); s.tau = 14; s.fadeIn = 0.3;
      s.drag = 1.5; s.buoy = 1.8; s.buoyTau = 20;
      s.r = 0.93; s.g = 0.93; s.b = 0.95;
      s.temp = 0; s.emis = 0;
      s.variant = (R() * 4) | 0; s.turb = 1.5; s.flags = P_GROUND | P_PADGRID; s.spin = RS() * 0.04; s.prio = 2;
      s.level = -1;
      ps.emit();
    }
    // --- once the plume clears the trench it hammers the pad apron and spreads radially
    this.acc.radial += dt * 85 * q * th * smooth(10, 26, hN) * smooth(230, 70, hN);
    while (this.acc.radial >= 1) {
      this.acc.radial -= 1;
      const a = R() * Math.PI * 2;
      const r0 = 3 + hN * 0.08;
      s.x = inp.gx + Math.cos(a) * r0; s.y = g0 + 1 + R() * 2; s.z = inp.gz + Math.sin(a) * r0;
      const sp = (35 + 35 * R()) * smooth(240, 40, hN);
      s.vx = Math.cos(a) * sp; s.vy = 2 + 5 * R(); s.vz = Math.sin(a) * sp;
      s.size0 = 4 + 3 * R(); s.size1 = 24 + 16 * R(); s.sizeTau = 8; s.sizeDiff = 1.1;
      s.life = 120 + 80 * R(); s.tau = 34; s.fadeIn = 0.3;
      s.drag = 2.4; s.buoy = 1.8; s.buoyTau = 30;
      s.r = 0.88; s.g = 0.87; s.b = 0.86;
      s.temp = hN < 60 && R() < 0.3 ? 1700 : 0; s.tempTau = 0.3; s.emis = 3;
      s.variant = (R() * 4) | 0; s.turb = 2; s.flags = P_GROUND | P_PADGRID; s.spin = RS() * 0.05; s.prio = 3;
      s.level = -1;
      ps.emit();
    }
  }
}

/**
 * Exhaust trail: puffs laid down where the visible plume ends, spaced by the local plume radius
 * with hierarchical decimation as they grow. Low altitude: grey-white smoke drifting in the wind.
 * High altitude: huge, thin, sunlit expanding exhaust ("jellyfish" when lit at twilight).
 */
export class TrailEmitter {
  private last = new THREE.Vector3();
  private has = false;
  private seq = 0;
  private dist = 0;

  reset(): void { this.has = false; this.dist = 0; }

  update(dt: number, b: BodyState, origin: THREE.Vector3, exhaustDir: THREE.Vector3, sh: PlumeShape, active: boolean, ps: ParticleSystem, q: number, wind: THREE.Vector3): void {
    if (!active || sh.mass < 0.05) { this.has = false; return; }
    const alt = b.altitude;
    const retro = sh.retro;
    // spawn point: tail of the luminous plume (or the retro shell)
    const dSpawn = retro > 0.3 ? -Math.min(sh.standoff * 0.3, 20) : Math.min(sh.L * 0.55, 36 + sh.L * 0.25);
    const Rt = retro > 0.3 ? sh.standoff * 0.7 + sh.Rc * 2 : plumeRadiusAt(sh, dSpawn);
    const px = origin.x + exhaustDir.x * dSpawn, py = origin.y + exhaustDir.y * dSpawn, pz = origin.z + exhaustDir.z * dSpawn;
    if (!this.has) { this.last.set(px, py, pz); this.has = true; return; }
    const dx = px - this.last.x, dy = py - this.last.y, dz = pz - this.last.z;
    const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // near the ground at liftoff the vehicle barely moves: keep a minimum emission rate by time
    this.dist += step + dt * 6;
    const spacing = Math.max(1.6, 0.75 * Rt) / Math.max(q, 0.3);
    const nMax = 40;
    let n = 0;
    const ex = sh.ex;
    const low = 1 - smooth(16000, 34000, alt);
    const contrail = smooth(6000, 9000, alt) * (1 - smooth(14000, 20000, alt));
    const s = ps.s;
    while (this.dist >= spacing && n < nMax) {
      this.dist -= spacing;
      n++;
      const f = step > 1e-6 ? 1 - this.dist / Math.max(step + dt * 6, 1e-6) : 1;
      const k = clamp01(f);
      this.seq++;
      let lvl = 0;
      let sq = this.seq;
      while ((sq & 1) === 0 && lvl < 12) { lvl++; sq >>= 1; }
      s.x = this.last.x + dx * k + RS() * Rt * 0.2;
      s.y = this.last.y + dy * k + RS() * Rt * 0.2;
      s.z = this.last.z + dz * k + RS() * Rt * 0.2;
      // gas velocity: at altitude the exhaust keeps (vehicle + exhaust) velocity; low it's stopped by the air
      const vEx = 2600 * ex * (1 - retro);
      s.vx = b.vel.x * (1 - low * 0.9) + exhaustDir.x * vEx + RS() * 5;
      s.vy = b.vel.y * (1 - low * 0.9) + exhaustDir.y * vEx + RS() * 5;
      s.vz = b.vel.z * (1 - low * 0.9) + exhaustDir.z * vEx + RS() * 5;
      if (low > 0.5) { s.vx = wind.x + exhaustDir.x * 25; s.vy = wind.y + exhaustDir.y * 25; s.vz = wind.z + exhaustDir.z * 25; }
      s.size0 = Rt * (0.9 + 0.3 * R());
      s.size1 = s.size0 * (1.6 + 5 * ex) + 30 * low;
      s.sizeTau = low > 0.5 ? 40 : 12 + 20 * R();
      s.sizeDiff = 2.2 * low + 30 * ex;
      s.life = low > 0.5 ? 170 + 60 * R() : 110 + 50 * R();
      const thin = 1 - low;
      // (above ~30 km the km-wide trail is tenuous: faint in daylight, a glowing veil only at
      //  twilight; long lenses look along it through dozens of overlapping puffs)
      s.tau = (low * (1.5 + 1.8 * contrail) + thin * 0.25 * (1 - 0.985 * smooth(26000, 62000, alt))) * Math.min(1, Math.sqrt(sh.mass / 9) + 0.25) * (retro > 0.3 ? 0.6 : 1);
      s.fadeIn = low > 0.5 ? 0.8 : 1.5;
      s.drag = retro > 0.3 ? 0.03 : low > 0.5 ? 2.5 : 1.5;
      s.buoy = 0.4 * low; s.buoyTau = 30;
      const w = 0.8 + 0.12 * contrail;
      s.r = w * low + 0.88 * thin; s.g = w * low * 0.98 + 0.92 * thin; s.b = w * low * 0.96 + 1.0 * thin;
      // entry/landing burn exhaust leaves glowing hot gas behind
      s.temp = retro > 0.3 ? 1500 + 300 * R() : 0; s.tempTau = 1.2; s.emis = 3;
      s.variant = 4 + ((R() * 4) | 0);
      s.turb = low * 1.5;
      s.flags = (thin > 0.5 ? P_THIN | P_NOWIND : 0);
      s.spin = RS() * 0.02;
      s.prio = low > 0.5 ? 2 : 1;
      s.level = lvl;
      s.spacing = spacing;
      ps.emit();
    }
    this.last.set(px, py, pz);
  }
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Cold-gas N2 RCS puffs (S1 pods near the interstage top). */
export class RcsEmitter {
  private acc = new Float32Array(8);

  update(dt: number, b: BodyState, ps: ParticleSystem, q: number): void {
    const noz = F9.s1.rcs.nozzles;
    const rho = b.density;
    const vac = 1 - smooth(0.02, 0.4, rho);
    for (let i = 0; i < noz.length; i++) {
      const f = b.rcs[i] ?? 0;
      if (f < 0.02) { this.acc[i] = Math.min(this.acc[i], 0.99); continue; }
      const nz = noz[i];
      const podA = (F9.s1.rcs.podAngleDeg[nz.pod] * Math.PI) / 180;
      _v.set(Math.cos(podA) * (F9.radius + 0.15), F9.s1.rcs.podY, Math.sin(podA) * (F9.radius + 0.15));
      // nozzle dir in body frame: tangential entries are given in the pod's local sense
      _d.set(nz.dir[0], nz.dir[1], nz.dir[2]);
      if (nz.dir[1] === 0 && Math.abs(nz.dir[0]) === 1) {
        // tangential: rotate +X into the pod's tangent (-sin a, 0, cos a)
        const sgn = nz.dir[0];
        _d.set(-Math.sin(podA) * sgn, 0, Math.cos(podA) * sgn);
      }
      _v.applyQuaternion(b.quat).add(b.pos);
      _d.applyQuaternion(b.quat).normalize();
      this.acc[i] += dt * 55 * q * f;
      if (this.acc[i] < 1 && f > 0.02 && this.acc[i] > 0) this.acc[i] = Math.max(this.acc[i], 1); // first puff immediately
      const s = ps.s;
      while (this.acc[i] >= 1) {
        this.acc[i] -= 1;
        // cold N2 leaves at ~700 m/s: in thin air each burst is a fast, thin, quickly expanding
        // jet that is gone within half a second (optical depth falls as 1/size^2)
        const sp = (60 + 60 * R()) * (1 + 2.2 * vac);
        const spread = 0.3 + 0.45 * vac;
        s.x = _v.x + _d.x * 0.3; s.y = _v.y + _d.y * 0.3; s.z = _v.z + _d.z * 0.3;
        s.vx = b.vel.x + (_d.x + RS() * spread) * sp;
        s.vy = b.vel.y + (_d.y + RS() * spread) * sp;
        s.vz = b.vel.z + (_d.z + RS() * spread) * sp;
        // (in vacuum: a wide, fast-fading fan rather than a chain of discrete puffs)
        s.size0 = 0.35; s.size1 = 3 + 40 * vac + 3 * R(); s.sizeTau = 0.45 - 0.15 * vac + 0.3 * R(); s.sizeDiff = 0.5 * (1 - vac);
        s.life = (1.2 + 1.2 * R()) * (1 - 0.6 * vac); s.tau = 1.8 + 4.7 * (1 - vac); s.fadeIn = 0.02;
        s.axX = _d.x; s.axY = _d.y; s.axZ = _d.z; s.aspect = 1 + 1.3 * vac;
        s.drag = 0.25; s.buoy = 0; s.buoyTau = 1;
        s.r = 0.96; s.g = 0.97; s.b = 1.0;
        s.temp = 0; s.emis = 0;
        s.variant = 4 + ((R() * 4) | 0); s.turb = 0; s.flags = P_THIN | (vac > 0.5 ? P_NOWIND : 0); s.spin = RS() * 0.5; s.prio = 2;
        s.level = -1;
        ps.emit();
      }
    }
  }
}

/** One-shot puffs: stage separation, fairing separation, MECO / shutdown, engine start soot. */
export class EventPuffs {
  stageSep(s1: BodyState, s2: BodyState, ps: ParticleSystem, q: number): void {
    // pneumatic pushers + residual gas at the interstage top
    _v.set(0, F9.s1.interstageTopY - 0.5, 0).applyQuaternion(s1.quat).add(s1.pos);
    const n = Math.round(46 * q) + 6;
    const vac = 1 - smooth(0.01, 0.3, s1.density);
    const s = ps.s;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + RS() * 0.1;
      _d.set(Math.cos(a), RS() * 0.3, Math.sin(a)).applyQuaternion(s1.quat);
      // residual pusher gas / interstage vent: a thin sunlit sheet racing outward, gone in ~1 s
      const sp = (30 + 50 * R()) * (1 + vac);
      s.x = _v.x + _d.x * 1.9; s.y = _v.y + _d.y * 1.9; s.z = _v.z + _d.z * 1.9;
      s.vx = (s1.vel.x + s2.vel.x) * 0.5 + _d.x * sp; s.vy = (s1.vel.y + s2.vel.y) * 0.5 + _d.y * sp; s.vz = (s1.vel.z + s2.vel.z) * 0.5 + _d.z * sp;
      s.size0 = 0.6; s.size1 = 8 + (22 + 14 * R()) * vac; s.sizeTau = 0.7; s.sizeDiff = 1 - vac;
      s.life = (2 + 2 * R()) * (1 - 0.6 * vac); s.tau = 2.2; s.fadeIn = 0.02;
      _t.set(-Math.sin(a), 0, Math.cos(a)).applyQuaternion(s1.quat); // tangential: an expanding ring sheet
      s.axX = _t.x; s.axY = _t.y; s.axZ = _t.z; s.aspect = 1 + 2 * vac;
      s.drag = 0.3; s.buoy = 0; s.buoyTau = 1;
      s.r = 0.95; s.g = 0.96; s.b = 0.98; s.temp = 0; s.emis = 0;
      s.variant = 4 + ((R() * 4) | 0); s.turb = 0; s.flags = P_THIN | P_NOWIND; s.spin = RS() * 0.4; s.prio = 3;
      s.level = -1;
      ps.emit();
    }
  }

  fairingSep(s2: BodyState, ps: ParticleSystem, q: number): void {
    const s = ps.s;
    const n = Math.round(36 * q) + 6;
    const Rf = F9.fairing.diameter / 2;
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const y = F9.fairing.baseY + R() * F9.fairing.length * 0.85;
      const taper = y > F9.fairing.baseY + F9.fairing.length * 0.55 ? 1 - (y - F9.fairing.baseY - F9.fairing.length * 0.55) / (F9.fairing.length * 0.5) : 1;
      _v.set(0, y, side * Rf * Math.max(taper, 0.2)).applyQuaternion(s2.quat).add(s2.pos);
      _d.set(RS() * 0.3, RS() * 0.2, side).applyQuaternion(s2.quat).normalize();
      const sp = 8 + 20 * R();
      s.x = _v.x; s.y = _v.y; s.z = _v.z;
      s.vx = s2.vel.x + _d.x * sp; s.vy = s2.vel.y + _d.y * sp; s.vz = s2.vel.z + _d.z * sp;
      s.size0 = 0.4; s.size1 = 4 + 5 * R(); s.sizeTau = 0.8; s.sizeDiff = 0.6;
      s.life = 1.5 + 1.5 * R(); s.tau = 2.2; s.fadeIn = 0.02;
      s.drag = 0.3; s.buoy = 0; s.buoyTau = 1;
      s.r = 0.95; s.g = 0.96; s.b = 0.98; s.temp = 0; s.emis = 0;
      s.variant = 4 + ((R() * 4) | 0); s.turb = 0; s.flags = P_THIN | P_NOWIND; s.spin = RS() * 0.4; s.prio = 3;
      s.level = -1;
      ps.emit();
    }
  }

  /** Transient soot/gas when engines start or shut down (fuel-rich), at the nozzle exits. */
  engineTransient(b: BodyState, engines: number[], exhaustDir: THREE.Vector3, start: boolean, ps: ParticleSystem, q: number, vacuumEngine = false): void {
    const s = ps.s;
    const thinAir = 1 - smooth(0.02, 0.5, b.density);
    for (const k of engines) {
      let ex = 0, ez = 0;
      if (!vacuumEngine && k > 0) {
        const a = F9.s1.engineAngleDeg(k) * (Math.PI / 180);
        ex = Math.cos(a) * F9.s1.engineRingRadius; ez = Math.sin(a) * F9.s1.engineRingRadius;
      }
      _v.set(ex, -0.3, ez).applyQuaternion(b.quat).add(b.pos);
      const n = Math.max(1, Math.round((start ? 4 : 5) * q));
      for (let i = 0; i < n; i++) {
        // in thin air the fuel-rich transient gas is not stopped by anything: it streams away at
        // hundreds of m/s and thins out into a faint wisp within a second
        const sp = ((start ? 40 : 25) + 40 * R()) * (1 + 5 * thinAir);
        const jit = 10 + 60 * thinAir;
        s.x = _v.x; s.y = _v.y; s.z = _v.z;
        s.vx = b.vel.x * (thinAir) + exhaustDir.x * sp + RS() * jit;
        s.vy = b.vel.y * (thinAir) + exhaustDir.y * sp + RS() * jit;
        s.vz = b.vel.z * (thinAir) + exhaustDir.z * sp + RS() * jit;
        s.size0 = 0.8; s.size1 = 5 + 55 * thinAir + 4 * R(); s.sizeTau = 1.2 - 0.6 * thinAir; s.sizeDiff = 0.8 * (1 - thinAir);
        s.life = (2.5 + 2 * R()) * (1 - 0.6 * thinAir); s.tau = (start ? 4 : 2.5) * (1 - 0.4 * thinAir); s.fadeIn = 0.03;
        s.drag = 0.6 * (1 - thinAir); s.buoy = 1 - thinAir; s.buoyTau = 3;
        s.axX = exhaustDir.x; s.axY = exhaustDir.y; s.axZ = exhaustDir.z; s.aspect = 1 + 3 * thinAir;
        const g = 0.3 + 0.5 * thinAir;
        s.r = g; s.g = g * 0.85; s.b = g * 0.72;
        s.temp = start ? 1300 : 1600; s.tempTau = 0.4 - 0.2 * thinAir; s.emis = 5;
        s.variant = thinAir > 0.5 ? 4 + ((R() * 4) | 0) : (R() * 4) | 0; s.turb = 1 - thinAir;
        s.flags = thinAir > 0.5 ? P_NOWIND | P_THIN : P_GROUND; s.spin = RS() * 0.5; s.prio = 2;
        s.level = -1;
        ps.emit();
      }
    }
  }
}

export interface DeckFrame {
  pos: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3; fwd: THREE.Vector3; halfX: number; halfZ: number;
}

/** Landing-burn impingement on the droneship deck, sea spray, post-landing steam and smoulder. */
export class LandingEmitter {
  private acc = { fire: 0, steam: 0, spray: 0, mist: 0, linger: 0, smoulder: 0 };
  touchdownT = -Infinity;
  impinge = 0;
  /** impact point on the deck (W) */
  readonly hit = new THREE.Vector3();

  update(dt: number, t: number, s1: BodyState, nozzleDir: THREE.Vector3, deck: DeckFrame, thrustFrac: number, ps: ParticleSystem, q: number): void {
    // nozzle height above the deck plane along the deck normal
    const rx = s1.pos.x - deck.pos.x, ry = s1.pos.y - deck.pos.y, rz = s1.pos.z - deck.pos.z;
    const h = rx * deck.up.x + ry * deck.up.y + rz * deck.up.z;
    const lx = rx * deck.right.x + ry * deck.right.y + rz * deck.right.z;
    const lz = rx * deck.fwd.x + ry * deck.fwd.y + rz * deck.fwd.z;
    const overDeck = Math.abs(lx) < deck.halfX + 10 && Math.abs(lz) < deck.halfZ + 10;
    const I = overDeck ? thrustFrac * smooth(48, 10, h) : 0;
    this.impinge = I;
    // impact point: along the plume axis to the deck plane
    const cosA = -(nozzleDir.x * deck.up.x + nozzleDir.y * deck.up.y + nozzleDir.z * deck.up.z);
    const along = cosA > 0.3 ? h / cosA : h;
    this.hit.copy(s1.pos).addScaledVector(nozzleDir, Math.max(0, along));
    const s = ps.s;
    const hx = this.hit.x, hy = this.hit.y, hz = this.hit.z;
    const U = deck.up;
    if (I > 0.01) {
      // flame sheet racing across the deck
      this.acc.fire += dt * 180 * q * I;
      while (this.acc.fire >= 1) {
        this.acc.fire -= 1;
        const a = R() * Math.PI * 2;
        const cx = Math.cos(a), cz = Math.sin(a);
        const dx = deck.right.x * cx + deck.fwd.x * cz, dy = deck.right.y * cx + deck.fwd.y * cz, dz = deck.right.z * cx + deck.fwd.z * cz;
        const sp = 60 + 90 * R();
        s.x = hx + dx * 2 + U.x * 0.8; s.y = hy + dy * 2 + U.y * 0.8; s.z = hz + dz * 2 + U.z * 0.8;
        s.vx = dx * sp + U.x * 4 * R(); s.vy = dy * sp + U.y * 4 * R(); s.vz = dz * sp + U.z * 4 * R();
        s.size0 = 1.2 + R(); s.size1 = 5 + 4 * R(); s.sizeTau = 0.35; s.sizeDiff = 0;
        s.life = 0.45 + 0.4 * R(); s.tau = 0.6; s.fadeIn = 0.02;
        s.drag = 0.5; s.buoy = 3; s.buoyTau = 1;
        // (once the flame sheet cools it is mostly water vapour with a little soot: grey, not brown)
        s.r = 0.46; s.g = 0.45; s.b = 0.44;
        s.temp = 2300 + 200 * R(); s.tempTau = 0.35; s.emis = 26;
        s.variant = R() < 0.5 ? (R() * 4) | 0 : 4 + ((R() * 4) | 0); s.turb = 0; s.flags = P_DECK | P_OCEAN; s.spin = RS(); s.prio = 2;
        s.axX = dx; s.axY = dy; s.axZ = dz; s.aspect = 3.2; // radial flame sheet: streaks racing outward
        s.level = -1;
        ps.emit();
      }
      // steam / smoke boiling off the wet deck
      // (dense and continuous: the wall jet piles a boiling cloud onto the deck that engulfs the
      //  legs and octaweb, then rolls off the edges)
      this.acc.steam += dt * 75 * q * I;
      while (this.acc.steam >= 1) {
        this.acc.steam -= 1;
        const a = R() * Math.PI * 2;
        const cx = Math.cos(a), cz = Math.sin(a);
        const dx = deck.right.x * cx + deck.fwd.x * cz, dy = deck.right.y * cx + deck.fwd.y * cz, dz = deck.right.z * cx + deck.fwd.z * cz;
        const sp = 10 + 32 * R() * R();
        const r0 = 2 + 5 * R();
        s.x = hx + dx * r0 + U.x * 0.8; s.y = hy + dy * r0 + U.y * 0.8; s.z = hz + dz * r0 + U.z * 0.8;
        s.vx = dx * sp + U.x * 2 * R(); s.vy = dy * sp + U.y * 2 * R(); s.vz = dz * sp + U.z * 2 * R();
        // (translucent and short-lived: the sea wind strips it off the deck within ~5-8 s, so the
        //  booster stays partly visible through it and reads clearly soon after touchdown)
        s.size0 = 1.5 + 1.5 * R(); s.size1 = 10 + 10 * R(); s.sizeTau = 1.4; s.sizeDiff = 1.6;
        s.life = 4 + 4 * R(); s.tau = 4.5; s.fadeIn = 0.08;
        s.drag = 0.7; s.buoy = 1.4; s.buoyTau = 6;
        s.r = 0.93; s.g = 0.93; s.b = 0.93;
        s.temp = R() < 0.15 ? 1600 : 0; s.tempTau = 0.25; s.emis = 4;
        s.variant = (R() * 4) | 0; s.turb = 1.5; s.flags = P_DECK | P_OCEAN; s.spin = RS() * 0.1; s.prio = 3;
        s.level = -1;
        ps.emit();
      }
      // sea spray thrown off the deck edges once the flow reaches them
      this.acc.spray += dt * 110 * q * smooth(0.25, 0.8, I);
      while (this.acc.spray >= 1) {
        this.acc.spray -= 1;
        const edgeX = R() < 0.5;
        const ins = 1 - 0.12 * R();
        const sx = edgeX ? (R() < 0.5 ? -1 : 1) * deck.halfX * ins : RS() * deck.halfX;
        const sz = edgeX ? RS() * deck.halfZ : (R() < 0.5 ? -1 : 1) * deck.halfZ * ins;
        const ox = deck.pos.x + deck.right.x * sx + deck.fwd.x * sz;
        const oy = deck.pos.y + deck.right.y * sx + deck.fwd.y * sz;
        const oz = deck.pos.z + deck.right.z * sx + deck.fwd.z * sz;
        const ddx = ox - hx, ddy = oy - hy, ddz = oz - hz;
        const dl = Math.hypot(ddx, ddy, ddz) + 1e-3;
        // curtain of spray + steam rolling off the deck edges (continuous: many overlapping puffs)
        const sp = 7 + 14 * R();
        s.x = ox + U.x * 1.5; s.y = oy + U.y * 1.5; s.z = oz + U.z * 1.5;
        s.vx = (ddx / dl) * sp + U.x * (5 * R() - 1.5); s.vy = (ddy / dl) * sp + U.y * (5 * R() - 1.5); s.vz = (ddz / dl) * sp + U.z * (5 * R() - 1.5);
        s.size0 = 4 + 2 * R(); s.size1 = 13 + 9 * R(); s.sizeTau = 1.8; s.sizeDiff = 0.8;
        s.life = 5 + 4 * R(); s.tau = 2.2; s.fadeIn = 0.12;
        s.drag = 0.9; s.buoy = 0.8; s.buoyTau = 4;
        s.r = 0.92; s.g = 0.94; s.b = 0.96;
        s.temp = 0; s.emis = 0;
        s.variant = ((R() * 8) | 0); s.turb = 1; s.flags = P_OCEAN; s.spin = RS() * 0.2; s.prio = 2;
        s.axX = ddx / dl; s.axY = ddy / dl; s.axZ = ddz / dl; s.aspect = 1.8;
        s.level = -1;
        ps.emit();
      }
    }
    // downwash mist over the water before the plume reaches the deck (booster low over the ship)
    const mistI = thrustFrac * smooth(120, 50, h) * (overDeck ? 1 : 0);
    // (many large, very thin wisps that overlap into a low haze sheet rather than discrete puffs)
    this.acc.mist += dt * 0 * q * mistI; // disabled: read as floating bubbles over open water
    while (this.acc.mist >= 1) {
      this.acc.mist -= 1;
      const a = R() * Math.PI * 2;
      const rr = 18 + 30 * Math.sqrt(R());
      const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr * 1.4;
      s.x = deck.pos.x + deck.right.x * cx + deck.fwd.x * cz - U.x * 3;
      s.y = deck.pos.y + deck.right.y * cx + deck.fwd.y * cz - U.y * 3;
      s.z = deck.pos.z + deck.right.z * cx + deck.fwd.z * cz - U.z * 3;
      s.vx = Math.cos(a) * 8 + U.x * 2; s.vy = U.y * 2; s.vz = Math.sin(a) * 8 + U.z * 2;
      s.size0 = 14 + 6 * R(); s.size1 = 34 + 14 * R(); s.sizeTau = 4; s.sizeDiff = 0.5;
      s.life = 8 + 6 * R(); s.tau = 0.13; s.fadeIn = 2.0;
      s.drag = 2; s.buoy = 0.3; s.buoyTau = 5;
      s.r = 0.9; s.g = 0.92; s.b = 0.95;
      s.temp = 0; s.emis = 0;
      s.variant = 4 + ((R() * 4) | 0); s.turb = 1; s.flags = P_OCEAN; s.spin = RS() * 0.05; s.prio = 1;
      s.level = -1;
      ps.emit();
    }
    // post-touchdown: lingering steam/smoke rising off the deck + smouldering octaweb
    const landed = s1.status === 'landed' || s1.status === 'tipped' || s1.phase === 'LANDED';
    if (landed && this.touchdownT === -Infinity) this.touchdownT = t;
    if (!landed && t < this.touchdownT) this.touchdownT = -Infinity; // time jumped back
    if (this.touchdownT > -Infinity && thrustFrac < 0.05) {
      const age = t - this.touchdownT;
      // (stops after ~10 s: a lone late puff read as a cotton ball on the clear deck)
      const k = age < 10 ? Math.exp(-age / 3.5) : 0;
      this.acc.linger += dt * 6 * q * k;
      while (this.acc.linger >= 1) {
        this.acc.linger -= 1;
        const a = R() * Math.PI * 2, rr = 1 + 9 * R();
        s.x = s1.pos.x + Math.cos(a) * rr * 1 + U.x; s.y = s1.pos.y + U.y * (0.5 + R() * 2); s.z = s1.pos.z + Math.sin(a) * rr;
        s.vx = Math.cos(a) * 2 + U.x * (2 + 2 * R()); s.vy = U.y * (2 + 2 * R()); s.vz = Math.sin(a) * 2 + U.z * (2 + 2 * R());
        s.size0 = 2 + 2 * R(); s.size1 = 12 + 8 * R(); s.sizeTau = 3; s.sizeDiff = 1.2;
        s.life = 5 + 4 * R(); s.tau = 1.4 * (0.3 + 0.7 * k); s.fadeIn = 0.5;
        s.drag = 0.6; s.buoy = 0.7; s.buoyTau = 8;
        const w = 0.88 + 0.07 * R();
        s.r = w; s.g = w * 0.98; s.b = w * 0.96;
        s.temp = 0; s.emis = 0;
        s.variant = (R() * 4) | 0; s.turb = 1; s.flags = P_DECK | P_OCEAN; s.spin = RS() * 0.05; s.prio = 2;
        s.level = -1;
        ps.emit();
      }
      const ks = Math.exp(-age / 12);
      this.acc.smoulder += dt * 22 * q * ks;
      while (this.acc.smoulder >= 1) {
        this.acc.smoulder -= 1;
        const a = R() * Math.PI * 2, rr = 0.5 + 1.4 * R();
        s.x = s1.pos.x + Math.cos(a) * rr; s.y = s1.pos.y + 0.8 + R(); s.z = s1.pos.z + Math.sin(a) * rr;
        s.vx = U.x * 3; s.vy = U.y * 3; s.vz = U.z * 3;
        s.size0 = 0.4 + 0.3 * R(); s.size1 = 1.6; s.sizeTau = 0.5; s.sizeDiff = 0;
        s.life = 0.6 + 0.5 * R(); s.tau = 0.5; s.fadeIn = 0.05;
        s.drag = 0.5; s.buoy = 6; s.buoyTau = 1;
        s.r = 0.2; s.g = 0.18; s.b = 0.16;
        s.temp = 1500 + 300 * R(); s.tempTau = 0.6; s.emis = 18;
        s.variant = (R() * 4) | 0; s.turb = 0.5; s.flags = 0; s.spin = RS(); s.prio = 1;
        s.level = -1;
        ps.emit();
      }
    }
  }
}

export function deckFrame(ship: BodyState, out: DeckFrame): DeckFrame {
  out.pos.copy(ship.pos);
  out.up.set(0, 1, 0).applyQuaternion(ship.quat);
  out.right.set(1, 0, 0).applyQuaternion(ship.quat);
  out.fwd.set(0, 0, 1).applyQuaternion(ship.quat);
  out.halfX = OCISLY.deckWidth / 2;
  out.halfZ = OCISLY.deckLength / 2;
  return out;
}

export function altOf(p: THREE.Vector3): number {
  return altitudeW(p.x, p.y, p.z);
}
