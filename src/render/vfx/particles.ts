// Unified smoke / steam / gas / fire particle system.
//  * CPU simulation in W doubles (drag toward the local wind with a density-dependent time
//    constant, buoyancy, ground / deck / ocean collision, smooth pseudo-turbulence).
//  * One sorted instanced draw per view with premultiplied-alpha blending (ONE, ONE_MINUS_SRC_ALPHA)
//    so lit smoke (over) and emissive fire (add) composite correctly in one pass.
//  * Instances are uploaded camera-relative per view -> full float precision anywhere in the 0..700 km scene.
//  * Lighting: sun radiance per particle (Earth shadow + reddening, cached), volumetric self-shadow
//    from a coarse density grid (pad cloud), sky ambient, plume point lights (per vertex), blackbody emission.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { LAYER_VFX } from '../../core/context';
import { EARTH_RADIUS } from '../../core/constants';
import { AERIAL_GLSL, aerialUniforms } from '../env/aerial';
import { COLOR_GLSL, DEPTH_GLSL, NOISE_GLSL, airDensity, refreshSharedForDraw, sunRadianceAt, vfxShared, windScale } from './common';

export const P_GROUND = 1; // collide with the pad-area ground plane
export const P_DECK = 2; // collide with the droneship deck
export const P_OCEAN = 4; // collide with sea level
export const P_PADGRID = 8; // participates in the pad-cloud self-shadow grid
export const P_THIN = 16; // thin gas (phase-function lit, wispy sprite)
export const P_NOWIND = 32; // ignore wind (vacuum puffs)

/** Reusable spawn descriptor (fill + call emit()). All values SI. */
export class Spawn {
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  size0 = 1; size1 = 4; sizeTau = 2; sizeDiff = 0;
  life = 5; tau = 1; fadeIn = 0.1;
  /** velocity relaxation time toward the air at sea-level density (s); scaled by sqrt(rho0/rho) */
  drag = 1;
  buoy = 0; buoyTau = 5;
  r = 0.9; g = 0.9; b = 0.9;
  /** emission temperature (K) at spawn, 0 = not emissive; cools with tempTau */
  temp = 0; tempTau = 0.5; emis = 0;
  variant = 0; // 0..3 billowy, 4..7 wispy (+random)
  turb = 0;
  flags = 0;
  spin = 0;
  /** priority (higher survives when the pool is full) */
  prio = 1;
  /** trail decimation: level (trailing zeros of the sequence number), -1 = off; spawn spacing (m) */
  level = -1;
  spacing = 0;
  /** elongation along a W axis (fast jets / expanding sheets): aspect 1 = round sprite */
  axX = 0; axY = 1; axZ = 0; aspect = 1;
}

const STRIDE = 24;

export interface ParticleEnv {
  t: number;
  wind: THREE.Vector3;
  padGroundY: number;
  deck: { pos: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3; fwd: THREE.Vector3; halfX: number; halfZ: number } | null;
}

export class ParticleSystem {
  readonly max: number;
  count = 0;
  readonly s = new Spawn();
  // state (SoA)
  private px: Float64Array; private py: Float64Array; private pz: Float64Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private ux: Float32Array; private uy: Float32Array; private uz: Float32Array;
  private age: Float32Array; private life: Float32Array;
  private size0: Float32Array; private size1: Float32Array; private sizeTau: Float32Array; private sizeDiff: Float32Array;
  private tau: Float32Array; private fadeIn: Float32Array;
  private drag: Float32Array; private buoy: Float32Array; private buoyTau: Float32Array;
  private cr: Float32Array; private cg: Float32Array; private cb: Float32Array;
  private temp: Float32Array; private tempTau: Float32Array; private emis: Float32Array;
  private variant: Float32Array; private turb: Float32Array; private flags: Uint8Array; private spin: Float32Array;
  private seed: Float32Array; private prio: Float32Array; private lvl: Int8Array; private spc: Float32Array;
  private sunR: Float32Array; private sunG: Float32Array; private sunB: Float32Array;
  private shadow: Float32Array; private ambOcc: Float32Array; private plOcc: Float32Array;
  private axX: Float32Array; private axY: Float32Array; private axZ: Float32Array; private asp: Float32Array;
  // render
  /** particles behind the plume (drawn before it) */
  readonly mesh: THREE.Mesh;
  /** particles between the camera and the plume (drawn after it) */
  readonly meshNear: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private inst: THREE.InstancedInterleavedBuffer;
  private data: Float32Array;
  private geoN: THREE.InstancedBufferGeometry;
  private instN: THREE.InstancedInterleavedBuffer;
  private dataN: Float32Array;
  private mat: THREE.ShaderMaterial;
  private keys: Uint16Array; private order: Uint32Array; private tmpIdx: Uint32Array; private counts = new Uint32Array(4096);
  private relX: Float32Array; private relY: Float32Array; private relZ: Float32Array; private curSize: Float32Array; private curTau: Float32Array; private curT: Float32Array;
  private rr = 0; // round-robin cursor for lighting refresh
  private seedCounter = 1;
  private _c = new THREE.Color();
  // pad self-shadow grid
  readonly grid = new DensityGrid(24, 12, 24, 1400, 480);
  /** skip the (CPU) self-shadow grid, e.g. during seek pre-warm; call refreshGrid() after */
  gridEnabled = true;
  plLights: { pos: THREE.Vector3; color: THREE.Color; range: number }[] = [];

  constructor(private ctx: AppContext, max: number, puffTex: THREE.Texture) {
    this.max = max;
    const f64 = () => new Float64Array(max), f32 = () => new Float32Array(max);
    this.px = f64(); this.py = f64(); this.pz = f64();
    this.vx = f32(); this.vy = f32(); this.vz = f32();
    this.ux = f32(); this.uy = f32(); this.uz = f32();
    this.age = f32(); this.life = f32();
    this.size0 = f32(); this.size1 = f32(); this.sizeTau = f32(); this.sizeDiff = f32();
    this.tau = f32(); this.fadeIn = f32(); this.drag = f32(); this.buoy = f32(); this.buoyTau = f32();
    this.cr = f32(); this.cg = f32(); this.cb = f32();
    this.temp = f32(); this.tempTau = f32(); this.emis = f32();
    this.variant = f32(); this.turb = f32(); this.flags = new Uint8Array(max); this.spin = f32();
    this.seed = f32(); this.prio = f32(); this.lvl = new Int8Array(max); this.spc = f32();
    this.sunR = f32(); this.sunG = f32(); this.sunB = f32(); this.shadow = f32(); this.ambOcc = f32(); this.plOcc = f32();
    this.axX = f32(); this.axY = f32(); this.axZ = f32(); this.asp = f32();
    this.keys = new Uint16Array(max); this.order = new Uint32Array(max); this.tmpIdx = new Uint32Array(max);
    this.relX = f32(); this.relY = f32(); this.relZ = f32(); this.curSize = f32(); this.curTau = f32(); this.curT = f32();
    this.curSortD = f32();

    const mk = () => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const data = new Float32Array(max * STRIDE);
      const inst = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
      inst.setUsage(THREE.DynamicDrawUsage);
      const A = (off: number) => new THREE.InterleavedBufferAttribute(inst, 4, off);
      geo.setAttribute('iPosSize', A(0));
      geo.setAttribute('iRotTauVarT', A(4));
      geo.setAttribute('iAlbEmis', A(8));
      geo.setAttribute('iSunAmb', A(12));
      geo.setAttribute('iMisc', A(16));
      geo.setAttribute('iAxis', A(20));
      geo.instanceCount = 0;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      return { geo, data, inst };
    };
    const far = mk(), nearB = mk();
    this.geo = far.geo; this.data = far.data; this.inst = far.inst;
    this.geoN = nearB.geo; this.dataN = nearB.data; this.instN = nearB.inst;

    const plPos = [0, 1, 2, 3].map(() => new THREE.Vector3());
    const plCol = [0, 1, 2, 3].map(() => new THREE.Vector3());
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...aerialUniforms,
        uSceneDepth: vfxShared.uSceneDepth, uSceneRes: vfxShared.uSceneRes, uHasDepth: vfxShared.uHasDepth,
        uSunView: vfxShared.uSunView, uUpView: vfxShared.uUpView,
        uPuffs: { value: puffTex },
        uAmbCol: { value: new THREE.Color(1, 1, 1) },
        uGndCol: { value: new THREE.Color(0.1, 0.1, 0.1) },
        uNoise3D: vfxShared.uNoise3D,
        uPLPos: { value: plPos }, uPLCol: { value: plCol }, uPLRange: { value: [1, 1, 1, 1] },
        uTime: vfxShared.uVfxTime,
      },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 10;
    this.mesh.name = 'vfx-particles';
    this.mesh.onBeforeRender = (_r, _s, cam) => refreshSharedForDraw(this.ctx, cam, this.mat);
    this.meshNear = new THREE.Mesh(this.geoN, this.mat);
    this.meshNear.frustumCulled = false;
    this.meshNear.layers.set(LAYER_VFX);
    this.meshNear.renderOrder = 30;
    this.meshNear.name = 'vfx-particles-near';
    this.meshNear.onBeforeRender = this.mesh.onBeforeRender;
    this.mesh.add(this.meshNear);
  }

  clear(): void {
    this.count = 0;
  }

  /** Emit the particle described by this.s. Returns its slot index, or -1 if dropped. */
  emit(): number {
    const s = this.s;
    let i = this.count;
    if (i >= this.max) {
      // replace a random lower-priority, older particle
      let best = -1, bestScore = Infinity;
      for (let k = 0; k < 6; k++) {
        const j = (Math.random() * this.count) | 0;
        const score = this.prio[j] - this.age[j] / Math.max(this.life[j], 1e-3);
        if (score < bestScore) { bestScore = score; best = j; }
      }
      if (best < 0 || this.prio[best] > s.prio) { s.aspect = 1; return -1; }
      i = best;
    } else this.count++;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    const cy = s.y + EARTH_RADIUS;
    const il = 1 / Math.sqrt(s.x * s.x + cy * cy + s.z * s.z);
    this.ux[i] = s.x * il; this.uy[i] = cy * il; this.uz[i] = s.z * il;
    this.age[i] = 0; this.life[i] = s.life;
    this.size0[i] = s.size0; this.size1[i] = s.size1; this.sizeTau[i] = Math.max(s.sizeTau, 1e-3); this.sizeDiff[i] = s.sizeDiff;
    this.tau[i] = s.tau; this.fadeIn[i] = Math.max(s.fadeIn, 1e-3);
    this.drag[i] = s.drag; this.buoy[i] = s.buoy; this.buoyTau[i] = Math.max(s.buoyTau, 1e-3);
    this.cr[i] = s.r; this.cg[i] = s.g; this.cb[i] = s.b;
    this.temp[i] = s.temp; this.tempTau[i] = Math.max(s.tempTau, 1e-3); this.emis[i] = s.emis;
    this.variant[i] = s.variant; this.turb[i] = s.turb; this.flags[i] = s.flags; this.spin[i] = s.spin;
    this.seed[i] = (this.seedCounter++ * 0.6180339887) % 1;
    this.prio[i] = s.prio;
    this.lvl[i] = s.level; this.spc[i] = s.spacing;
    this.curSize[i] = s.size0; this.curTau[i] = 0; this.curT[i] = s.temp;
    sunRadianceAt(s.x, s.y, s.z, this.ctx.lighting.sunDir, this._c);
    this.sunR[i] = this._c.r; this.sunG[i] = this._c.g; this.sunB[i] = this._c.b;
    this.shadow[i] = 1; this.ambOcc[i] = 1; this.plOcc[i] = 1;
    this.axX[i] = s.axX; this.axY[i] = s.axY; this.axZ[i] = s.axZ; this.asp[i] = s.aspect;
    s.aspect = 1;
    return i;
  }

  /** Start a freshly emitted particle at a given age (pre-warm); position is left as given. */
  setAge(i: number, age: number): void {
    this.age[i] = Math.min(age, this.life[i] * 0.999);
  }

  /** Advance the simulation by dt seconds of mission time. */
  update(dt: number, env: ParticleEnv): void {
    if (dt <= 0) return;
    const n0 = this.count;
    const wx = env.wind.x, wy = env.wind.y, wz = env.wind.z;
    const deck = env.deck;
    let i = 0;
    while (i < this.count) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) {
        this.kill(i);
        continue;
      }
      this.age[i] = a;
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      const fl = this.flags[i];
      const cy = y + EARTH_RADIUS;
      const alt = Math.sqrt(x * x + cy * cy + z * z) - EARTH_RADIUS;
      const rho = airDensity(alt);
      const ux = this.ux[i], uy = this.uy[i], uz = this.uz[i];
      // drag toward the air (wind) velocity
      const tauD = Math.min(1e5, this.drag[i] * Math.sqrt(1.225 / Math.max(rho, 1e-12)));
      const k = 1 - Math.exp(-dt / tauD);
      const ws = fl & P_NOWIND ? 0 : windScale(alt);
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      vx += (wx * ws - vx) * k; vy += (wy * ws - vy) * k; vz += (wz * ws - vz) * k;
      // buoyancy (hot gas rises, decays as it mixes/cools); only meaningful in air
      const b = this.buoy[i] * Math.exp(-a / this.buoyTau[i]) * Math.min(1, rho / 0.3) * dt;
      vx += ux * b; vy += uy * b; vz += uz * b;
      // pseudo turbulence (smooth, deterministic per particle)
      const tb = this.turb[i];
      let tx = 0, ty = 0, tz = 0;
      if (tb > 0) {
        const sd = this.seed[i] * 50;
        tx = tb * Math.sin(a * 0.9 + sd);
        ty = tb * 0.6 * Math.sin(a * 0.7 + sd * 1.7);
        tz = tb * Math.sin(a * 1.1 + sd * 2.3);
      }
      let nx = x + (vx + tx) * dt, ny = y + (vy + ty) * dt, nz = z + (vz + tz) * dt;
      // collisions
      const sz = this.curSize[i] || this.size0[i];
      if (fl & P_GROUND) {
        const h = ny - env.padGroundY; // pad area ~flat, +Y is up near the pad
        const minH = sz * 0.35;
        if (h < minH && Math.abs(nx) < 5000 && Math.abs(nz) < 5000) {
          ny = env.padGroundY + minH;
          if (vy < 0) {
            // turn downward momentum into radial outflow along the ground
            const hs = Math.hypot(vx, vz) + 1e-3;
            const add = -vy * 0.55;
            vx += (vx / hs) * add; vz += (vz / hs) * add;
            vy = -vy * 0.1;
          }
        }
      }
      if (fl & P_OCEAN) {
        const na = Math.sqrt(nx * nx + (ny + EARTH_RADIUS) ** 2 + nz * nz) - EARTH_RADIUS;
        const minH = sz * 0.3;
        if (na < minH) {
          const d = minH - na;
          nx += ux * d; ny += uy * d; nz += uz * d;
          const vn = vx * ux + vy * uy + vz * uz;
          if (vn < 0) { vx -= ux * vn * 1.1; vy -= uy * vn * 1.1; vz -= uz * vn * 1.1; }
        }
      }
      if (deck && fl & P_DECK) {
        const rx = nx - deck.pos.x, ry = ny - deck.pos.y, rz = nz - deck.pos.z;
        const h = rx * deck.up.x + ry * deck.up.y + rz * deck.up.z;
        const lx = rx * deck.right.x + ry * deck.right.y + rz * deck.right.z;
        const lz = rx * deck.fwd.x + ry * deck.fwd.y + rz * deck.fwd.z;
        const minH = Math.min(sz * 0.3, 3);
        if (h < minH && h > -4 && Math.abs(lx) < deck.halfX && Math.abs(lz) < deck.halfZ) {
          const d = minH - h;
          nx += deck.up.x * d; ny += deck.up.y * d; nz += deck.up.z * d;
          const vn = vx * deck.up.x + vy * deck.up.y + vz * deck.up.z;
          if (vn < 0) {
            vx -= deck.up.x * vn; vy -= deck.up.y * vn; vz -= deck.up.z * vn;
            // radial spreading
            const hl = Math.hypot(lx, lz) + 1e-3;
            const add = -vn * 0.7;
            vx += (deck.right.x * lx + deck.fwd.x * lz) / hl * add;
            vy += (deck.right.y * lx + deck.fwd.y * lz) / hl * add;
            vz += (deck.right.z * lx + deck.fwd.z * lz) / hl * add;
          }
        }
      }
      this.px[i] = nx; this.py[i] = ny; this.pz[i] = nz;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      i++;
    }
    // derived per-particle values
    for (let j = 0; j < this.count; j++) {
      const a = this.age[j];
      const s = this.size0[j] + (this.size1[j] - this.size0[j]) * (1 - Math.exp(-a / this.sizeTau[j])) + this.sizeDiff[j] * Math.sqrt(a);
      this.curSize[j] = s;
      const r = this.size0[j] / s;
      const fin = Math.min(1, a / this.fadeIn[j]);
      const lf = a / this.life[j];
      const fout = lf < 0.55 ? 1 : 1 - smooth01((lf - 0.55) / 0.45);
      let tm = 1;
      const lv = this.lvl[j];
      if (lv >= 0) {
        // hierarchical decimation of overlapping trail puffs: keep ~2 puffs per diameter
        const need = Math.max(0, Math.floor(Math.log2(Math.max(1, s / (this.spc[j] * 2.5)))));
        if (need > lv) { this.age[j] = this.life[j]; }
        tm = 1 << Math.min(need, 15);
      }
      this.curTau[j] = this.tau[j] * r * r * fin * fout * tm;
      this.curT[j] = this.temp[j] > 0 ? this.temp[j] * Math.exp(-a / this.tempTau[j]) : 0;
    }
    // refresh cached sun radiance round-robin (particles drift in altitude, sun moves slowly)
    const nRefresh = Math.min(this.count, 256);
    const sun = this.ctx.lighting.sunDir;
    for (let k = 0; k < nRefresh; k++) {
      this.rr = (this.rr + 1) % Math.max(1, this.count);
      const j = this.rr;
      sunRadianceAt(this.px[j], this.py[j], this.pz[j], sun, this._c);
      this.sunR[j] = this._c.r; this.sunG[j] = this._c.g; this.sunB[j] = this._c.b;
    }
    this.updateGrid(env);
    void n0;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
    this.ux[i] = this.ux[last]; this.uy[i] = this.uy[last]; this.uz[i] = this.uz[last];
    this.age[i] = this.age[last]; this.life[i] = this.life[last];
    this.size0[i] = this.size0[last]; this.size1[i] = this.size1[last]; this.sizeTau[i] = this.sizeTau[last]; this.sizeDiff[i] = this.sizeDiff[last];
    this.tau[i] = this.tau[last]; this.fadeIn[i] = this.fadeIn[last];
    this.drag[i] = this.drag[last]; this.buoy[i] = this.buoy[last]; this.buoyTau[i] = this.buoyTau[last];
    this.cr[i] = this.cr[last]; this.cg[i] = this.cg[last]; this.cb[i] = this.cb[last];
    this.temp[i] = this.temp[last]; this.tempTau[i] = this.tempTau[last]; this.emis[i] = this.emis[last];
    this.variant[i] = this.variant[last]; this.turb[i] = this.turb[last]; this.flags[i] = this.flags[last]; this.spin[i] = this.spin[last];
    this.seed[i] = this.seed[last]; this.prio[i] = this.prio[last]; this.lvl[i] = this.lvl[last]; this.spc[i] = this.spc[last];
    this.sunR[i] = this.sunR[last]; this.sunG[i] = this.sunG[last]; this.sunB[i] = this.sunB[last];
    this.shadow[i] = this.shadow[last]; this.ambOcc[i] = this.ambOcc[last]; this.plOcc[i] = this.plOcc[last];
    this.curSize[i] = this.curSize[last]; this.curTau[i] = this.curTau[last]; this.curT[i] = this.curT[last];
    this.axX[i] = this.axX[last]; this.axY[i] = this.axY[last]; this.axZ[i] = this.axZ[last]; this.asp[i] = this.asp[last];
  }

  private gridFrame = 0;
  private lastEnv: ParticleEnv | null = null;
  /** Force a grid rebuild now (after pre-warm). */
  refreshGrid(): void {
    if (this.lastEnv) { this.gridFrame = 0; this.updateGrid(this.lastEnv); }
  }
  /** Splat pad-cloud particles into the coarse grid and derive sun / sky / flame occlusion per particle. */
  private updateGrid(env: ParticleEnv): void {
    this.lastEnv = env;
    if (!this.gridEnabled) return;
    const g = this.grid;
    if (this.gridFrame++ % 6 !== 0) return;
    g.clear();
    let any = false;
    for (let j = 0; j < this.count; j++) {
      if (!(this.flags[j] & P_PADGRID)) continue;
      const s = this.curSize[j];
      // mean extinction contributed by this puff: optical depth * area / cell area
      g.splat(this.px[j], this.py[j] - env.padGroundY, this.pz[j], this.curTau[j] * s * s * 1.6, s);
      any = true;
    }
    if (!any) return;
    g.integrate(this.ctx.lighting.sunDir);
    const L0 = this.ctx.plumeLights[0];
    const hasL = !!L0 && L0.pos.distanceToSquared(_origin.set(0, env.padGroundY, 0)) < 1500 * 1500;
    for (let j = 0; j < this.count; j++) {
      if (!(this.flags[j] & P_PADGRID)) { this.plOcc[j] = 1; continue; }
      const h = this.py[j] - env.padGroundY;
      const odS = g.sampleSun(this.px[j], h, this.pz[j]);
      const odU = g.sampleUp(this.px[j], h, this.pz[j]);
      // own contribution is roughly half of the local cell: remove bias with a soft offset
      this.shadow[j] = 0.1 + 0.9 * Math.exp(-Math.max(0, odS - 0.3) * 0.6);
      this.ambOcc[j] = 0.35 + 0.65 * Math.exp(-Math.max(0, odU - 0.3) * 0.35);
      this.plOcc[j] = hasL ? 0.08 + 0.92 * Math.exp(-Math.max(0, g.odTo(this.px[j], h, this.pz[j], L0.pos.x, L0.pos.y - env.padGroundY, L0.pos.z) - 0.4) * 0.5) : 1;
    }
  }

  /** Per-view: cull, sort back-to-front, upload camera-relative instance data. */
  prepareView(camera: THREE.PerspectiveCamera, origin: THREE.Vector3, plumeLights: { pos: THREE.Vector3; color: THREE.Color; range: number }[], splitDist = Infinity): void {
    this.mesh.position.copy(origin); // world position = 0 after the floating-origin shift
    const e = camera.matrixWorld.elements; // camera sits at the origin during render
    // camera forward (-Z) in world
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    const tanX = tanY * camera.aspect;
    const n = this.count;
    let m = 0;
    let maxD = 1;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    for (let i = 0; i < n; i++) {
      const tau = this.curTau[i];
      const T = this.curT[i];
      if (tau < 0.002 && T < 700) continue;
      const rx = this.px[i] - ox, ry = this.py[i] - oy, rz = this.pz[i] - oz;
      const s = this.curSize[i];
      const d = rx * fx + ry * fy + rz * fz;
      if (d < -s) continue;
      const dist2 = rx * rx + ry * ry + rz * rz;
      // coarse frustum test (sphere vs cone)
      const lat2 = dist2 - d * d;
      const lim = Math.max(d, 0) * Math.max(tanX, tanY) * 1.45 + s * 1.5;
      if (lat2 > lim * lim) continue;
      this.relX[i] = rx; this.relY[i] = ry; this.relZ[i] = rz;
      const dist = Math.sqrt(dist2);
      if (dist > maxD) maxD = dist;
      this.tmpIdx[m++] = i;
      this.keys[i] = 0; // filled below
      this.curSortD[i] = dist;
    }
    // counting sort by log distance, far -> near
    const lmax = Math.log(maxD + 1);
    const counts = this.counts;
    counts.fill(0);
    for (let k = 0; k < m; k++) {
      const i = this.tmpIdx[k];
      const key = 4095 - Math.min(4095, Math.floor((Math.log(this.curSortD[i] + 1) / lmax) * 4095));
      this.keys[i] = key;
      counts[key]++;
    }
    let acc = 0;
    for (let b = 0; b < 4096; b++) { const c = counts[b]; counts[b] = acc; acc += c; }
    for (let k = 0; k < m; k++) {
      const i = this.tmpIdx[k];
      this.order[counts[this.keys[i]]++] = i;
    }
    // split: puffs clearly in front of the plume go to the near mesh (drawn after the plume)
    let kSplit = m;
    if (splitDist < Infinity) {
      while (kSplit > 0) {
        const i = this.order[kSplit - 1];
        if (this.curSortD[i] + this.curSize[i] * 0.35 < splitDist) kSplit--;
        else break;
      }
    }
    for (let k = 0; k < m; k++) {
      const i = this.order[k];
      const nearP = k >= kSplit;
      const D = nearP ? this.dataN : this.data;
      const o = (nearP ? k - kSplit : k) * STRIDE;
      D[o] = this.relX[i]; D[o + 1] = this.relY[i]; D[o + 2] = this.relZ[i]; D[o + 3] = this.curSize[i];
      D[o + 4] = this.spin[i] * this.age[i] + this.seed[i] * 6.283;
      D[o + 5] = this.curTau[i];
      D[o + 6] = this.variant[i] + this.seed[i] * 0.99;
      D[o + 7] = this.curT[i];
      D[o + 8] = this.cr[i]; D[o + 9] = this.cg[i]; D[o + 10] = this.cb[i]; D[o + 11] = this.emis[i];
      const sh = this.shadow[i];
      // (some sunlight always diffuses through the cloud: multiple scattering keeps shadowed steam grey, not black)
      const shl = 0.18 + 0.82 * sh;
      D[o + 12] = this.sunR[i] * shl; D[o + 13] = this.sunG[i] * shl; D[o + 14] = this.sunB[i] * shl;
      D[o + 15] = this.ambOcc[i];
      D[o + 16] = this.flags[i] & P_THIN ? 1 : 0;
      D[o + 17] = this.age[i] / this.life[i];
      D[o + 18] = this.plOcc[i]; D[o + 19] = this.age[i];
      D[o + 20] = this.axX[i]; D[o + 21] = this.axY[i]; D[o + 22] = this.axZ[i]; D[o + 23] = this.asp[i];
    }
    const mN = m - kSplit;
    this.geo.instanceCount = kSplit;
    this.inst.clearUpdateRanges();
    this.inst.addUpdateRange(0, Math.max(1, kSplit) * STRIDE);
    this.inst.needsUpdate = true;
    this.geoN.instanceCount = mN;
    this.meshNear.visible = mN > 0;
    if (mN > 0) {
      this.instN.clearUpdateRanges();
      this.instN.addUpdateRange(0, mN * STRIDE);
      this.instN.needsUpdate = true;
    }
    // plume lights (camera-relative)
    const u = this.mat.uniforms;
    const pp = u.uPLPos.value as THREE.Vector3[], pc = u.uPLCol.value as THREE.Vector3[], pr = u.uPLRange.value as number[];
    for (let k = 0; k < 4; k++) {
      const L = plumeLights[k];
      if (L) {
        pp[k].copy(L.pos).sub(origin);
        pc[k].set(L.color.r, L.color.g, L.color.b);
        pr[k] = L.range;
      } else { pc[k].set(0, 0, 0); pr[k] = 1; }
    }
    (u.uAmbCol.value as THREE.Color).copy(this.ctx.lighting.skyColor);
    (u.uGndCol.value as THREE.Color).copy(this.ctx.lighting.groundColor);
  }
  private curSortD: Float32Array;

  dispose(): void {
    this.geo.dispose();
    this.geoN.dispose();
    this.mat.dispose();
  }
}

const _origin = new THREE.Vector3();

function smooth01(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Coarse density grid around the pad for volumetric self-shadowing of the launch cloud. */
export class DensityGrid {
  readonly d: Float32Array;
  readonly sunOD: Float32Array;
  readonly upOD: Float32Array;
  readonly cx: number; readonly cy: number;
  constructor(readonly nx: number, readonly ny: number, readonly nz: number, readonly sizeXZ: number, readonly sizeY: number) {
    this.d = new Float32Array(nx * ny * nz);
    this.sunOD = new Float32Array(nx * ny * nz);
    this.upOD = new Float32Array(nx * ny * nz);
    this.cx = sizeXZ / nx;
    this.cy = sizeY / ny;
  }
  clear(): void { this.d.fill(0); }
  private idx(x: number, y: number, z: number): number { return (y * this.nz + z) * this.nx + x; }
  private cell(x: number, h: number, z: number): [number, number, number] {
    return [Math.floor(x / this.cx + this.nx / 2), Math.floor(h / this.cy), Math.floor(z / this.cx + this.nz / 2)];
  }
  splat(x: number, h: number, z: number, mass: number, radius: number): void {
    const [ix, iy, iz] = this.cell(x, h, z);
    // extinction per meter in the cell: mass / cell volume * cell size ~ od per cell crossing
    const rx = Math.max(0, Math.min(2, Math.floor(radius / this.cx)));
    const ry = Math.max(0, Math.min(2, Math.floor(radius / this.cy)));
    const cnt = (2 * rx + 1) * (2 * ry + 1) * (2 * rx + 1);
    const v = mass / (this.cx * this.cx * this.cy) / cnt;
    for (let dy = -ry; dy <= ry; dy++) {
      const y = iy + dy;
      if (y < 0 || y >= this.ny) continue;
      for (let dz = -rx; dz <= rx; dz++) {
        const z = iz + dz;
        if (z < 0 || z >= this.nz) continue;
        for (let dx = -rx; dx <= rx; dx++) {
          const xx = ix + dx;
          if (xx < 0 || xx >= this.nx) continue;
          this.d[this.idx(xx, y, z)] += v;
        }
      }
    }
  }
  /** optical depth (per cell, extinction * path) toward the sun and straight up */
  integrate(sun: THREE.Vector3): void {
    const { nx, ny, nz, cx, cy } = this;
    // up: cumulative from top
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let y = ny - 1; y >= 0; y--) {
        const i = this.idx(x, y, z);
        this.upOD[i] = acc + this.d[i] * cy * 0.5;
        acc += this.d[i] * cy;
      }
    }
    // sun: march each cell toward the sun (sun below horizon -> treat as grazing)
    const sy = Math.max(0.05, sun.y);
    const step = Math.min(cx, cy);
    const dx = (sun.x / cx) * step, dy = (sy / cy) * step, dz = (sun.z / cx) * step;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let fx = x + 0.5, fy = y + 0.5, fz = z + 0.5, od = 0;
      for (let s = 0; s < 40; s++) {
        fx += dx; fy += dy; fz += dz;
        const ix = fx | 0, iy = fy | 0, iz = fz | 0;
        if (fx < 0 || fy < 0 || fz < 0 || ix >= nx || iy >= ny || iz >= nz) break;
        od += this.d[this.idx(ix, iy, iz)] * step;
      }
      this.sunOD[this.idx(x, y, z)] = od;
    }
  }
  private sample(arr: Float32Array, x: number, h: number, z: number): number {
    const [ix, iy, iz] = this.cell(x, h, z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return 0;
    return arr[this.idx(ix, iy, iz)];
  }
  sampleSun(x: number, h: number, z: number): number { return this.sample(this.sunOD, x, h, z); }
  /** optical depth from (x,h,z) toward a target point (skipping the particle's own cell) */
  odTo(x: number, h: number, z: number, tx: number, th: number, tz: number): number {
    const dx = tx - x, dy = th - h, dz = tz - z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1) return 0;
    const n = 7;
    const t0 = Math.min(0.9, (this.cx * 0.6) / len);
    let od = 0;
    const seg = (len * (1 - t0)) / n;
    for (let k = 0; k < n; k++) {
      const t = t0 + ((1 - t0) * (k + 0.5)) / n;
      od += this.sample(this.d, x + dx * t, h + dy * t, z + dz * t) * seg;
    }
    return od;
  }
  sampleUp(x: number, h: number, z: number): number { return this.sample(this.upOD, x, h, z); }
}

const PARTICLE_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${AERIAL_GLSL}
attribute vec4 iPosSize;
attribute vec4 iRotTauVarT;
attribute vec4 iAlbEmis;
attribute vec4 iSunAmb;
attribute vec4 iMisc;
attribute vec4 iAxis;   // W elongation axis, aspect (1 = round)
uniform vec3 uPLPos[4];
uniform vec3 uPLCol[4];
uniform float uPLRange[4];
varying vec2 vUv;
varying vec4 vCell;     // atlas offset xy, rot cos/sin
varying vec3 vViewPos;
varying vec4 vTauTSize; // tau, temperature, size, thin
varying vec4 vAlbEmis;
varying vec3 vSun;
varying vec3 vPL;
varying vec3 vPLDir;
varying float vAmb;
varying vec3 vAT;
varying vec3 vAI;
varying float vNear;
varying vec3 vNoise;    // per-particle noise coordinate offset + evolution
void main() {
  vec3 wp = iPosSize.xyz;          // camera-relative (world after floating-origin shift)
  float size = iPosSize.w;
  float rot = iRotTauVarT.x;
  vec4 mvC = modelViewMatrix * vec4(wp, 1.0);
  float c = cos(rot), s = sin(rot);
  vec2 corner = position.xy;
  vec2 cs = corner;
  if (iAxis.w > 1.01) {
    // elongated (jet / sheet): sprite x along the projected axis, same area
    vec3 av = (modelViewMatrix * vec4(iAxis.xyz, 0.0)).xyz;
    vec2 ap = av.xy;
    float pl = length(ap);
    float asp = 1.0 + (iAxis.w - 1.0) * clamp(pl, 0.0, 1.0);
    if (pl > 1e-3) { c = ap.x / pl; s = ap.y / pl; }
    float sa = sqrt(asp);
    cs = vec2(corner.x * sa, corner.y / sa);
  }
  vec2 off = vec2(c * cs.x - s * cs.y, s * cs.x + c * cs.y) * size;
  vec4 mv = mvC + vec4(off, 0.0, 0.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = corner * 0.5 + 0.5;
  float variant = floor(iRotTauVarT.z);
  float seed = fract(iRotTauVarT.z);
  vCell = vec4(mod(variant, 4.0) * 0.25, variant >= 4.0 ? 0.5 : 0.0, c, s);
  vViewPos = mv.xyz;
  vTauTSize = vec4(iRotTauVarT.y, iRotTauVarT.w, size, iMisc.x);
  vAlbEmis = iAlbEmis;
  vSun = iSunAmb.xyz;
  vAmb = iSunAmb.w;
  // plume lights: irradiance at the puff (softened by its size) + dominant direction (view space)
  vec3 pl = vec3(0.0);
  vec3 pd = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 d = uPLPos[k] - wp;
    float d2 = dot(d, d);
    float win = clamp(1.0 - pow(sqrt(d2) / uPLRange[k], 4.0), 0.0, 1.0);
    // (softened by the puff size and by the extent of the source itself: the flame / fire are
    //  metres long, so a puff next to them is not lit like one next to a point)
    vec3 e = uPLCol[k] * win * win / (d2 + size * size * 0.35 + 30.0);
    pl += e;
    pd += normalize(d + 1e-4) * dot(e, vec3(0.3, 0.5, 0.2));
  }
  // (x0.04: look-dev measured plume-lit pad smoke at 2^2..2^4.5 scene units; night-launch photo
  //  exposures put it at ~2^-3..2^-1.5 while the plume core (60-150) stays the brightest element.
  //  Saturated toward deep orange so the tone mapper does not wash it to cream.)
  float plL = dot(pl, vec3(0.3, 0.5, 0.2));
  vPL = max(mix(vec3(plL), pl, 1.35), 0.0) * iMisc.z * 0.028;
  vPLDir = normalize((modelViewMatrix * vec4(pd + vec3(0.0, 1e-6, 0.0), 0.0)).xyz);
  vAT = aerialTransmittance(wp);
  vAI = aerialInscatter(wp);
  // fade puffs that engulf the camera (avoids full-screen blobs + near-plane popping)
  float dc = length(mvC.xyz);
  vNear = smoothstep(size * 0.35, size * 1.1, dc) * smoothstep(2.0, 6.0, dc);
  vNoise = vec3(seed * 7.13, seed * 3.71, iMisc.w * 0.035 + seed * 11.0);
}
`;

const PARTICLE_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${DEPTH_GLSL}
${COLOR_GLSL}
${NOISE_GLSL}
uniform sampler2D uPuffs;
uniform vec3 uSunView;
uniform vec3 uUpView;
uniform vec3 uAmbCol;
uniform vec3 uGndCol;
varying vec2 vUv;
varying vec4 vCell;
varying vec3 vViewPos;
varying vec4 vTauTSize;
varying vec4 vAlbEmis;
varying vec3 vSun;
varying vec3 vPL;
varying vec3 vPLDir;
varying float vAmb;
varying vec3 vAT;
varying vec3 vAI;
varying float vNear;
varying vec3 vNoise;
void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);            // atlas rows are stored top-down (flipY = false)
  vec4 tex = texture2D(uPuffs, vCell.xy + uv * vec2(0.25, 0.5));
  float dens = tex.a;
  // invisible texels: skip the noise (threshold on the resulting opacity, tiny so that faint,
  // heavily exposed high-altitude gas shows no cut-off edge)
  if (dens < 0.004 || (vTauTSize.x * dens < 2e-4 && vTauTSize.y < 700.0)) discard;
  float billowy = vCell.y < 0.25 ? 1.0 : 0.0;
  // evolving erosion: eats into the rim and thin parts so puffs never read as flat cut-outs
  float en = n3(vec3(vUv * 0.55, 0.0) + vNoise);
  float en2 = n3(vec3(vUv * 1.3, 0.5) + vNoise * 1.7);
  float ero = (en * 0.65 + en2 * 0.35 - 0.5) * 2.0 * mix(1.0, 0.35, vTauTSize.w);
  dens = clamp(dens * (1.0 + 0.45 * ero) - 0.18 * (1.0 - dens) * max(ero, 0.0) * 2.0, 0.0, 1.0);
  if (dens < 0.004) discard;
  float viewZ = -vViewPos.z;
  float sceneZ = vfxSceneDepth();
  float size = vTauTSize.z;
  float soft = clamp((sceneZ - viewZ) / (size * 0.45 + 0.3), 0.0, 1.0);
  if (soft <= 0.0) discard;
  // an optically thin puff (fresh wisp or a fading, expanded one) has no surface to shade: blend it
  // toward the thin-gas phase lighting, otherwise its sprite normals rim-light a hard arc
  float thin = max(vTauTSize.w, exp(-1.5 * vTauTSize.x));
  // sprite-space normal -> view space (rotate with the sprite)
  vec2 nxy = tex.rg * 2.0 - 1.0;
  nxy = nxy * 0.85 + vec2(en - 0.5, en2 - 0.5) * 0.3;
  vec3 n = vec3(vCell.z * nxy.x - vCell.w * nxy.y, vCell.w * nxy.x + vCell.z * nxy.y, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  n = normalize(mix(n, vec3(0.0, 0.0, 1.0), thin * 0.7 + (1.0 - billowy) * 0.3));
  float ao = billowy > 0.5 ? tex.b : 1.0;
  vec3 V = normalize(vViewPos);
  float cosT = dot(V, uSunView);
  float ndl = dot(n, uSunView);
  // dense steam: lambert with a soft terminator + multiple-scattering floor + silver lining;
  // thin gas: phase function (strong forward scattering toward the sun)
  float lamb = clamp((ndl + 0.15) / 1.15, 0.0, 1.0);
  // diffuse transmission through the puff (multiple scattering, g ~ 0.85: 1 / (1 + 0.75 (1 - g) tau)):
  // a backlit steam puff glows through instead of going near-black against the light
  float odV = vTauTSize.x * dens;
  float transD = 0.8 / (1.0 + 0.11 * odV);
  lamb = max(lamb, transD * clamp(-ndl, 0.0, 1.0));
  // silver lining keyed on the optical depth through this texel (not on the raw sprite density):
  // an optically thin puff forward-scatters evenly instead of drawing a bright ring at its rim
  float silver = hgPhase(cosT, 0.8) * 12.566 * exp(-1.3 * vTauTSize.x * dens) * 0.3;
  float denseTerm = lamb * mix(0.65, 1.0, ao) + 0.26 * mix(0.6, 1.0, ao) + silver;
  float thinTerm = mix(1.0, hgPhase(cosT, 0.55) * 12.566, 0.65);
  // Daylight steam / smoke reads white-grey in real footage (the camera white-balances the ~17 deg
  // morning sun, and multiple scattering in the cloud mixes in the blue skylight). A cloud built
  // from overlapping, individually thin puffs would otherwise take the full direct-sun tint (beige).
  // Keep the warm / red sun near and below the horizon (sunset smoke, twilight plumes).
  float sunY = dot(vSun, vec3(0.2126, 0.7152, 0.0722));
  float wb = 0.7 * smoothstep(0.05, 0.3, dot(uSunView, uUpView));
  vec3 sunW = mix(vSun, vec3(sunY), wb);
  vec3 sunDense = mix(sunW, vec3(sunY), 0.3 * (1.0 - thin));
  float nu = dot(n, uUpView);
  vec3 amb = uAmbCol * (0.62 + 0.38 * nu) * vAmb + uGndCol * (0.5 - 0.5 * nu) * 0.6;
  float plW = clamp((dot(n, vPLDir) + 0.6) / 1.6, 0.0, 1.0);
  plW = max(plW, transD * clamp(-dot(n, vPLDir), 0.0, 1.0));
  vec3 E = mix(sunDense * denseTerm, sunW * thinTerm, thin) + amb * mix(1.0, ao, billowy * 0.6) + vPL * mix(plW * mix(0.6, 1.0, ao), 0.8, thin);
  vec3 lit = vAlbEmis.rgb * E * 0.3183;
  float alpha = (1.0 - exp(-vTauTSize.x * dens)) * soft * vNear;
  // blackbody emission (fire / glowing exhaust), independent of opacity
  vec3 emis = vec3(0.0);
  float T = vTauTSize.y;
  if (T > 700.0) {
    float fe = clamp(dens * 1.4 * (0.7 + 0.6 * en), 0.0, 1.0);
    float Tl = T * (0.9 + 0.18 * en2);
    emis = blackbody(Tl) * flameRadiance(Tl) * vAlbEmis.a * fe * soft * vNear;
  }
  vec3 col = (lit * alpha + emis) * vAT + vAI * alpha;
  gl_FragColor = vec4(col, alpha);
}
`;
