// VFX orchestrator. OWNER: vfx.
// Plumes (raymarched volumes), particles (pad cloud, trail, RCS, puffs, landing), Max-Q vapor,
// plume point lights (ctx.plumeLights + 3 real PointLights) and heat-haze sources (ctx.hazeSources).
import * as THREE from 'three';
import type { AppContext, FrameModule, PlumeLight, ViewInfo } from '../../core/context';
import { LAYER_VFX } from '../../core/context';
import type { BodyState, EngineState, SimSnapshot } from '../../core/types';
import { IGNITION_TIME, PAD_ELEVATION } from '../../core/constants';
import { F9 } from '../../core/vehicleSpec';
import { ambientAt, airDensity, clamp01, loadNoise3D, smooth, sunRadianceAt, vfxShared, windScale } from './common';
import { ParticleSystem, P_THIN, type ParticleEnv } from './particles';
import { PlumeVolume, makeDrive, plumeRadiusAt, type PlumeDrive } from './plume';
import { Condensation } from './condensation';
import {
  EventPuffs, LandingEmitter, PadEmitter, RcsEmitter, TrailEmitter, TRENCH_EXIT, deckFrame, nominalPadHeight,
  type DeckFrame,
} from './emitters';

const MAX_PARTICLES = [1400, 2400, 3600, 5000];
const EMIT_SCALE = [0.35, 0.6, 0.85, 1];

interface LightCand { pos: THREE.Vector3; color: THREE.Color; intensity: number }

export class VFX implements FrameModule {
  private ready = false;
  private ps!: ParticleSystem;
  private plumeS1!: PlumeVolume;
  private plumeS2!: PlumeVolume;
  private cond!: Condensation;
  private readonly root = new THREE.Group();
  private readonly pad = new PadEmitter();
  private readonly trailS1 = new TrailEmitter();
  private readonly trailS2 = new TrailEmitter();
  private readonly rcs = new RcsEmitter();
  private readonly puffs = new EventPuffs();
  private readonly landing = new LandingEmitter();
  private readonly lights: THREE.PointLight[] = [];
  private readonly driveS1 = makeDrive(9);
  private readonly driveS2 = makeDrive(1);
  private readonly deck: DeckFrame = { pos: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), fwd: new THREE.Vector3(), halfX: 26, halfZ: 45 };
  private readonly penv: ParticleEnv = { t: 0, wind: new THREE.Vector3(), padGroundY: PAD_ELEVATION, deck: null };
  private lastT = NaN;
  private prevS2Status = '';
  private prevFairStatus = '';
  private prevOnS1 = new Array(9).fill(false);
  private prevOnS2 = false;
  private localIgn = new Array(10).fill(-Infinity);
  private firstIgnT = -Infinity;
  private lightCands: LightCand[] = [];
  private readonly exhaustS1 = new THREE.Vector3(0, -1, 0);
  private readonly exhaustS2 = new THREE.Vector3(0, -1, 0);
  private vaporAcc = 0;
  /** debug/test: force-disable the particle pool (e.g. perf checks) */
  particlesEnabled = true;

  constructor(private ctx: AppContext) {
    this.root.name = 'vfx';
    for (let i = 0; i < 3; i++) {
      const L = new THREE.PointLight(0xffa050, 0, 400, 2);
      L.castShadow = false;
      L.layers.enable(LAYER_VFX); // lights must be visible to both the opaque and the vfx pass
      L.name = `vfx-plume-light-${i}`;
      this.lights.push(L);
      this.root.add(L); // layer 0: lights must be visible to the opaque pass
    }
    ctx.worldRoot.add(this.root);
  }

  async load(): Promise<void> {
    const base = (import.meta.env?.BASE_URL ?? '/') + 'textures/vfx/';
    const [noise, puffs] = await Promise.all([
      loadNoise3D(base + 'noise3d_64.bin'),
      new THREE.TextureLoader().loadAsync(base + 'puffs.png').catch(() => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)),
    ]);
    puffs.flipY = false;
    puffs.colorSpace = THREE.NoColorSpace;
    puffs.generateMipmaps = true;
    puffs.minFilter = THREE.LinearMipmapLinearFilter;
    puffs.magFilter = THREE.LinearFilter;
    puffs.anisotropy = 1;
    puffs.needsUpdate = true;
    vfxShared.uNoise3D.value = noise;

    this.ps = new ParticleSystem(this.ctx, MAX_PARTICLES[3], puffs);
    this.plumeS1 = new PlumeVolume(this.ctx, 'merlin');
    this.plumeS2 = new PlumeVolume(this.ctx, 'mvac');
    this.cond = new Condensation(this.ctx);
    this.root.add(this.ps.mesh, this.plumeS1.group, this.plumeS2.group, this.cond.mesh);
    this.ready = true;
  }

  // ------------------------------------------------------------------------------------------
  update(snap: SimSnapshot, dt: number): void {
    const ctx = this.ctx;
    ctx.hazeSources.length = 0;
    ctx.plumeLights.length = 0;
    if (!this.ready) return;
    const q = ctx.quality.level;
    const emitQ = EMIT_SCALE[q] ?? 0.85;
    const t = snap.t;
    let dts = Number.isNaN(this.lastT) ? 0 : t - this.lastT;
    const expected = Math.max(dt, 1 / 240) * Math.max(snap.warp || 1, 1);
    const jumped = Number.isNaN(this.lastT) || dts < -0.05 || dts > expected * 3 + 0.5;
    if (jumped) {
      this.onSeek(snap);
      dts = 0;
    }
    this.lastT = t;
    dts = Math.max(0, dts);
    vfxShared.uVfxTime.value += Math.min(dts, 0.1);

    const b = snap.bodies;
    const S1 = b.S1, S2 = b.S2, SHIP = b.SHIP;
    this.penv.t = t;
    this.penv.wind.copy(snap.wind);
    deckFrame(SHIP, this.deck);
    this.penv.deck = SHIP.status !== 'gone' ? this.deck : null;

    // ---------- plume drives
    const flick = this.flicker(vfxShared.uVfxTime.value);
    const s1Alive = S1.status !== 'gone' && S1.status !== 'destroyed';
    const s2Alive = S2.status !== 'gone' && S2.status !== 'destroyed';
    this.fillDrive(this.driveS1, S1, t, s1Alive, flick, true, snap);
    this.fillDrive(this.driveS2, S2, t, s2Alive && S2.status !== 'stacked', flick, false, snap);
    this.plumeS1.setDrive(this.driveS1, q);
    this.plumeS2.setDrive(this.driveS2, q);
    this.exhaustS1.set(0, -1, 0).applyQuaternion(this.driveS1.quat);
    this.exhaustS2.set(0, -1, 0).applyQuaternion(this.driveS2.quat);

    // ---------- events by state transition
    this.detectEvents(snap, emitQ);

    // ---------- emitters (substep for high warp so fast emitters stay spatially smooth)
    const n = Math.min(8, Math.max(1, Math.ceil(dts / 0.05)));
    const h = dts / n;
    const thrust1 = this.thrustFrac(S1);
    const hN = S1.altitude - PAD_ELEVATION;
    for (let i = 0; i < n && h > 0; i++) {
      if (this.particlesEnabled) {
        if (s1Alive && hN < 400 && Math.hypot(S1.pos.x, S1.pos.z) < 600) {
          this.pad.update(h, this.padInput(t, S1, hN, thrust1), this.ps, emitQ);
        }
        this.trailS1.update(h, S1, S1.pos, this.exhaustS1, this.plumeS1.shape, this.plumeS1.active, this.ps, emitQ, snap.wind);
        this.trailS2.update(h, S2, S2.pos, this.exhaustS2, this.plumeS2.shape, this.plumeS2.active, this.ps, emitQ * 0.7, snap.wind);
        if (s1Alive && S1.status !== 'stacked') this.rcs.update(h, S1, this.ps, emitQ);
        if (s1Alive && this.penv.deck) {
          this.landing.update(h, t, S1, this.exhaustS1, this.deck, S1.engines[0]?.on || thrust1 > 0.01 ? Math.max(thrust1 * 9, 0) : 0, this.ps, emitQ);
        }
        this.vapor(h, S1, emitQ);
      }
      this.ps.update(h, this.penv);
    }

    // ---------- condensation collars (stacked flight only)
    if (S2.status === 'stacked' && s1Alive) {
      const sun = sunRadianceAt(S2.pos.x, S2.pos.y, S2.pos.z, ctx.lighting.sunDir, _c1);
      const amb = ambientAt(S2.altitude, ctx, _c2);
      this.cond.update(S2.pos, S2.quat, S1.mach, S1.altitude, 0.9, sun, amb, q);
    } else this.cond.mesh.visible = false;

    // ---------- lights + haze
    this.updateLights(snap, flick);
    this.updateHaze(snap);
  }

  beforeViewRender(view: ViewInfo, _snap: SimSnapshot): void {
    if (!this.ready) return;
    this.plumeS1.prepareView(view);
    this.plumeS2.prepareView(view);
    this.cond.prepareView(view);
    if (this.particlesEnabled) {
      const split = Math.min(this.plumeS1.distanceToAxis(view.camWorldPos), this.plumeS2.distanceToAxis(view.camWorldPos));
      this.ps.prepareView(view.camera, view.camWorldPos, this.ctx.plumeLights, split);
    }
    this.ps.mesh.visible = this.particlesEnabled;
  }

  // ------------------------------------------------------------------------------------------
  private flicker(time: number): number {
    return 1 + 0.045 * Math.sin(time * 31.7) * Math.sin(time * 17.3 + 1.3) + 0.03 * Math.sin(time * 53.1 + 0.7);
  }

  private thrustFrac(bs: BodyState): number {
    let s = 0;
    for (const e of bs.engines) s += this.engI(e);
    return s / 9;
  }

  private engI(e: EngineState): number {
    const sp = clamp01(e.spool);
    if ((!e.on && sp <= 0.01) || sp <= 0) return 0;
    const th = e.throttle > 0 ? e.throttle : e.on ? 1 : 0;
    return Math.pow(sp, 1.3) * (0.3 + 0.7 * clamp01(th));
  }

  private fillDrive(d: PlumeDrive, bs: BodyState, t: number, alive: boolean, flick: number, isS1: boolean, snap: SimSnapshot): void {
    d.active = false;
    if (!alive) return;
    const n = d.eng.length;
    let any = false, gx = 0, gz = 0, cnt = 0;
    for (let k = 0; k < n; k++) {
      const e = bs.engines[k];
      if (!e) { d.eng[k] = 0; d.green[k] = 0; continue; }
      let I = this.engI(e);
      // TEA-TEB flash: sim ignition time, or our own on-transition fallback
      const li = isS1 ? k : 9;
      const on = e.on || e.spool > 0.02;
      if (on && !(isS1 ? this.prevOnS1[k] : this.prevOnS2) && this.localIgn[li] < t - 2) this.localIgn[li] = t;
      const ig = Number.isFinite(e.ignitionT) && e.ignitionT <= t && t - e.ignitionT < 5 ? e.ignitionT : this.localIgn[li];
      const dIg = t - ig;
      const g = dIg >= 0 && dIg < 1.5 ? smooth(0, 0.04, dIg) * Math.exp(-dIg / 0.24) : 0;
      d.green[k] = g;
      I = Math.max(I, g * 0.55);
      d.eng[k] = I;
      if (I > 0.01) { any = true; gx += e.gimbalX; gz += e.gimbalZ; cnt++; }
    }
    if (!any) return;
    d.active = true;
    if (cnt) { gx /= cnt; gz /= cnt; }
    d.origin.copy(bs.pos);
    _e.set(gx, 0, gz, 'XZY');
    d.quat.copy(bs.quat).multiply(_q.setFromEuler(_e));
    d.ambientPressure = bs.ambientPressure;
    d.ambientDensity = bs.density;
    d.airVel.copy(bs.vel).addScaledVector(snap.wind, -windScale(bs.altitude));
    d.flicker = flick;
    // impingement plane: pad (trench floor -> apron), droneship deck, or open sea
    d.plane = null;
    if (isS1) {
      const hN = bs.altitude - PAD_ELEVATION;
      if (hN < 500 && Math.hypot(bs.pos.x, bs.pos.z) < 800) {
        const depth = 9 * (1 - smooth(12, 30, hN));
        this.padPlane.point.set(0, PAD_ELEVATION - depth, 0);
        this.padPlane.normal.set(0, 1, 0);
        this.padPlane.wall = 0.55 * smooth(14, 32, hN);
        d.plane = this.padPlane;
      } else if (snap.bodies.SHIP.status !== 'gone' && bs.pos.distanceTo(snap.bodies.SHIP.pos) < 400) {
        this.deckPlane.point.copy(this.deck.pos);
        this.deckPlane.normal.copy(this.deck.up);
        this.deckPlane.wall = 1;
        d.plane = this.deckPlane;
      } else if (bs.altitude < 300) {
        const up = _v1.set(bs.pos.x, bs.pos.y + 6_371_000, bs.pos.z).normalize();
        this.seaPlane.point.copy(bs.pos).addScaledVector(up, -bs.altitude);
        this.seaPlane.normal.copy(up);
        this.seaPlane.wall = 0.8;
        d.plane = this.seaPlane;
      }
    }
    // lighting at the plume body
    _v1.set(0, -1, 0).applyQuaternion(d.quat);
    const probe = _v2.copy(bs.pos).addScaledVector(_v1, Math.min(600, 20 + bs.altitude * 0.004));
    sunRadianceAt(probe.x, probe.y, probe.z, this.ctx.lighting.sunDir, d.sunRad);
    ambientAt(bs.altitude, this.ctx, d.ambRad);
  }
  private padPlane = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), wall: 0 };
  private deckPlane = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), wall: 1 };
  private seaPlane = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), wall: 0.8 };

  private padInput(t: number, S1: BodyState, hN: number, thrust: number) {
    // plume axis intersection with the pad plane
    const ex = this.exhaustS1;
    const k = ex.y < -0.2 ? Math.max(0, hN) / -ex.y : 0;
    const sinceIgn = Number.isFinite(this.firstIgnT) ? t - this.firstIgnT : 10;
    return { t, hN, thrust, sinceIgn, gx: S1.pos.x + ex.x * k, gz: S1.pos.z + ex.z * k };
  }

  private detectEvents(snap: SimSnapshot, q: number): void {
    const b = snap.bodies;
    const S1 = b.S1, S2 = b.S2;
    if (this.prevS2Status === 'stacked' && S2.status !== 'stacked' && S2.status !== 'gone') this.puffs.stageSep(S1, S2, this.ps, q);
    this.prevS2Status = S2.status;
    const fa = b.FAIRING_A.status;
    if (this.prevFairStatus === 'stacked' && fa !== 'stacked' && fa !== 'gone') this.puffs.fairingSep(S2, this.ps, q);
    this.prevFairStatus = fa;
    // engine start/stop transients
    const started: number[] = [], stopped: number[] = [];
    for (let k = 0; k < 9; k++) {
      const e = S1.engines[k];
      const on = !!e && (e.on || e.spool > 0.05);
      if (on && !this.prevOnS1[k]) started.push(k);
      if (!on && this.prevOnS1[k]) stopped.push(k);
      this.prevOnS1[k] = on;
    }
    if (started.length && !Number.isFinite(this.firstIgnT)) this.firstIgnT = snap.t;
    if (started.length) this.puffs.engineTransient(S1, started, this.exhaustS1, true, this.ps, q);
    if (stopped.length && S1.status !== 'landed') this.puffs.engineTransient(S1, stopped, this.exhaustS1, false, this.ps, q);
    const e2 = S2.engines[0];
    const on2 = !!e2 && S2.status !== 'stacked' && (e2.on || e2.spool > 0.05);
    if (on2 && !this.prevOnS2) this.puffs.engineTransient(S2, [0], this.exhaustS2, true, this.ps, q * 0.6, true);
    this.prevOnS2 = on2;
  }

  /** transonic vapor shedding off the vehicle (with the condensation collars) */
  private vapor(dt: number, S1: BodyState, q: number): void {
    const str = this.cond.strength;
    if (str < 0.05) return;
    this.vaporAcc += dt * 45 * q * str;
    const s = this.ps.s;
    while (this.vaporAcc >= 1) {
      this.vaporAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const y = F9.s2.mountY + F9.fairing.baseY - 1 - Math.random() * 8;
      _v1.set(Math.cos(a) * (F9.radius + 0.6), y, Math.sin(a) * (F9.radius + 0.6)).applyQuaternion(S1.quat).add(S1.pos); // stacked: S2 frame = S1 frame + mountY
      s.x = _v1.x; s.y = _v1.y; s.z = _v1.z;
      s.vx = S1.vel.x * 0.9; s.vy = S1.vel.y * 0.9; s.vz = S1.vel.z * 0.9;
      s.size0 = 0.8; s.size1 = 3 + 2 * Math.random(); s.sizeTau = 0.4; s.sizeDiff = 0.3;
      s.life = 0.35 + 0.35 * Math.random(); s.tau = 0.7; s.fadeIn = 0.03;
      s.drag = 0.5; s.buoy = 0; s.buoyTau = 1;
      s.r = 0.95; s.g = 0.96; s.b = 0.98; s.temp = 0; s.emis = 0;
      s.variant = 4 + ((Math.random() * 4) | 0); s.turb = 0; s.flags = P_THIN; s.spin = 0; s.prio = 1; s.level = -1;
      this.ps.emit();
    }
  }

  // ------------------------------------------------------------------------------------------
  private updateLights(snap: SimSnapshot, flick: number): void {
    const cands = this.lightCands;
    cands.length = 0;
    const add = (pos: THREE.Vector3, r: number, g: number, bl: number, intensity: number) => {
      if (intensity < 1) return;
      const c = this.candPool[cands.length] ?? (this.candPool[cands.length] = { pos: new THREE.Vector3(), color: new THREE.Color(), intensity: 0 });
      c.pos.copy(pos); c.color.setRGB(r, g, bl); c.intensity = intensity;
      cands.push(c);
    };
    for (const [pl, d, ex] of [[this.plumeS1, this.driveS1, this.exhaustS1], [this.plumeS2, this.driveS2, this.exhaustS2]] as const) {
      if (!pl.active) continue;
      const sh = pl.shape;
      const green = Math.max(...d.green);
      const gcol = (x: number, gx: number) => x * (1 - green) + gx * green;
      if (pl.kind === 'mvac') {
        _v1.copy(d.origin).addScaledVector(ex, 2);
        add(_v1, gcol(0.6, 0.3), gcol(0.5, 1), gcol(1, 0.4), 60 * sh.mass * flick + 400 * green);
        continue;
      }
      const lum = sh.lumBright;
      // main flame light a few meters down the plume (shortened by retro / impingement)
      let dist = Math.min(sh.L * 0.12 + 3, 14) * (1 - 0.7 * sh.retro);
      if (sh.planeDist < Infinity) dist = Math.min(dist, sh.planeDist * 0.6);
      _v1.copy(d.origin).addScaledVector(ex, dist);
      const I = (1300 * sh.mass * lum + 700 * sh.mass * sh.retro) * flick;
      add(_v1, gcol(1, 0.3), gcol(0.6, 1), gcol(0.3, 0.4), I + 3000 * green);
      // ground/deck flash where the flame hits
      if (sh.planeDist < 60 && d.plane) {
        _v2.copy(d.origin).addScaledVector(ex, sh.planeDist - 1.5);
        const hitI = 2600 * sh.mass * lum * (1 - sh.planeDist / 60) * flick;
        add(_v2, 1, 0.55, 0.25, hitI);
      }
    }
    // pad: fire out of the trench mouth
    const S1 = snap.bodies.S1;
    const hN = S1.altitude - PAD_ELEVATION;
    if (hN < 120 && this.plumeS1.active && Math.hypot(S1.pos.x, S1.pos.z) < 600) {
      _v1.copy(TRENCH_EXIT).setY(PAD_ELEVATION + 6);
      add(_v1, 1, 0.5, 0.2, 5000 * this.thrustFrac(S1) * smooth(80, 10, hN) * flick);
    }
    // landed smoulder
    if (this.landing.touchdownT > -Infinity) {
      const age = snap.t - this.landing.touchdownT;
      _v1.copy(S1.pos).addScaledVector(this.deck.up, 1.5);
      add(_v1, 1, 0.5, 0.2, 250 * Math.exp(-age / 10) * flick);
    }
    cands.sort((a, b) => b.intensity - a.intensity);
    const out = this.ctx.plumeLights;
    for (let i = 0; i < Math.min(4, cands.length); i++) {
      const c = cands[i];
      const pl: PlumeLight = this.plPool[i] ?? (this.plPool[i] = { pos: new THREE.Vector3(), color: new THREE.Color(), range: 1 });
      pl.pos.copy(c.pos);
      pl.color.copy(c.color).multiplyScalar(c.intensity);
      pl.range = Math.min(4000, Math.sqrt(c.intensity / 0.004));
      out.push(pl);
    }
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const c = cands[i];
      if (c) {
        L.position.copy(c.pos);
        L.color.copy(c.color);
        L.intensity = c.intensity;
        L.distance = Math.min(4000, Math.sqrt(c.intensity / 0.004));
      } else {
        L.intensity = 0;
      }
    }
  }
  private candPool: LightCand[] = [];
  private plPool: PlumeLight[] = [];

  private updateHaze(snap: SimSnapshot): void {
    const out = this.ctx.hazeSources;
    let k = 0;
    const next = () => this.hzPool[k] ?? (this.hzPool[k] = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius0: 1, radius1: 1, strength: 0 });
    for (const [pl, d, ex] of [[this.plumeS1, this.driveS1, this.exhaustS1], [this.plumeS2, this.driveS2, this.exhaustS2]] as const) {
      if (!pl.active || pl.kind === 'mvac') continue;
      const sh = pl.shape;
      const dens = clamp01(d.ambientDensity / 1.225);
      const str = Math.min(1, Math.sqrt(dens) * Math.min(1, sh.mass / 3) * (1 - 0.6 * sh.retro));
      if (str < 0.02) continue;
      let len = Math.min(sh.L * 0.9, 90);
      if (sh.planeDist < Infinity) len = Math.min(len, sh.planeDist);
      const hz = next();
      hz.start.copy(d.origin);
      hz.end.copy(d.origin).addScaledVector(ex, len);
      hz.radius0 = sh.Rc * 1.3;
      hz.radius1 = plumeRadiusAt(sh, len) + 3;
      hz.strength = str;
      out.push(hz); k++;
    }
    // pad: rising hot air above the trench mouth and the mount during the first seconds
    const S1 = snap.bodies.S1;
    const hN = S1.altitude - PAD_ELEVATION;
    const th = this.thrustFrac(S1);
    if (th > 0.05 && hN < 250 && Math.hypot(S1.pos.x, S1.pos.z) < 600) {
      const hz = next();
      hz.start.copy(TRENCH_EXIT);
      hz.end.copy(TRENCH_EXIT).setY(PAD_ELEVATION + 60);
      hz.radius0 = 12; hz.radius1 = 30;
      hz.strength = th * smooth(250, 40, hN);
      out.push(hz); k++;
    }
    // deck impingement
    if (this.landing.impinge > 0.02) {
      const hz = next();
      hz.start.copy(this.landing.hit);
      hz.end.copy(this.landing.hit).addScaledVector(this.deck.up, 18);
      hz.radius0 = 18; hz.radius1 = 12;
      hz.strength = this.landing.impinge;
      out.push(hz); k++;
    }
  }
  private hzPool: { start: THREE.Vector3; end: THREE.Vector3; radius0: number; radius1: number; strength: number }[] = [];

  // ------------------------------------------------------------------------------------------
  /** Time jumped (?seek, replay start, restart): rebuild a plausible particle state. */
  private onSeek(snap: SimSnapshot): void {
    const t = snap.t;
    const b = snap.bodies;
    this.ps.clear();
    this.trailS1.reset();
    this.trailS2.reset();
    this.landing.touchdownT = -Infinity;
    // prev-state trackers from the current snapshot (don't fire one-shot events on a jump)
    this.prevS2Status = b.S2.status;
    this.prevFairStatus = b.FAIRING_A.status;
    for (let k = 0; k < 9; k++) {
      const e = b.S1.engines[k];
      this.prevOnS1[k] = !!e && (e.on || e.spool > 0.05);
    }
    const e2 = b.S2.engines[0];
    this.prevOnS2 = !!e2 && b.S2.status !== 'stacked' && (e2.on || e2.spool > 0.05);
    const ign0 = b.S1.engines[0]?.ignitionT;
    const tIgn = Number.isFinite(ign0) && (ign0 as number) < 0 ? (ign0 as number) : IGNITION_TIME;
    this.firstIgnT = t > tIgn ? tIgn : -Infinity;
    for (let i = 0; i < this.localIgn.length; i++) this.localIgn[i] = -Infinity;
    if (!this.particlesEnabled) return;
    const q = EMIT_SCALE[this.ctx.quality.level] ?? 0.85;
    this.ps.gridEnabled = false;
    try { this.prewarm(snap, t, tIgn, q); } finally { this.ps.gridEnabled = true; }
    this.ps.refreshGrid();
  }

  private prewarm(snap: SimSnapshot, t: number, tIgn: number, q: number): void {
    const b = snap.bodies;
    // 1) pad cloud: replay the pad emitter along the nominal ascent (older puffs are gone anyway)
    const padStart = Math.max(tIgn, t - 260);
    if (t > tIgn && padStart < 40) {
      const env = this.penv;
      env.wind.copy(snap.wind);
      env.deck = null;
      let tt = padStart;
      const dtp = 0.15;
      while (tt < t) {
        const h = Math.min(dtp, t - tt);
        const hN = nominalPadHeight(tt);
        const sp = clamp01((tt - tIgn) / 0.9);
        const th = hN < 400 ? sp : 0;
        this.pad.update(h, { t: tt, hN, thrust: th, sinceIgn: tt - tIgn, gx: 0, gz: 0 }, this.ps, q);
        this.ps.update(h, env);
        tt += h;
      }
    }
    // 2) ascent trail: synthesize puffs along a curve from the pad to the current S1 position
    const S1 = b.S1;
    if (t > 3 && t < 420 && S1.status !== 'gone') this.synthTrail(snap, t, q);
    // 3) post-landing lingering steam
    const td = snap.timeline.find((m) => m.type === 'TOUCHDOWN' && m.done);
    if (td && (S1.status === 'landed' || S1.phase === 'LANDED') && t - td.t < 120) {
      this.landing.touchdownT = td.t;
      deckFrame(b.SHIP, this.deck);
      this.penv.deck = this.deck;
      let tt = td.t;
      while (tt < t) {
        const h = Math.min(0.2, t - tt);
        this.landing.update(h, tt, S1, this.exhaustS1, this.deck, 0, this.ps, q);
        this.ps.update(h, this.penv);
        tt += h;
      }
    }
  }

  private synthTrail(snap: SimSnapshot, t: number, q: number): void {
    const S1 = snap.bodies.S1;
    // the booster's own ascent path: if staged, use a nominal MECO point on the line to S2
    const end = _v3.copy(S1.status === 'stacked' ? S1.pos : snap.bodies.S2.pos);
    const tEnd = Math.min(t, 150);
    const p0 = _v4.set(0, PAD_ELEVATION + 4, 0);
    // quadratic Bezier with a vertical initial tangent
    const ctrl = _v5.set(0, p0.y + (end.y - p0.y) * 0.55, 0);
    const s = this.ps.s;
    const N = Math.round(260 * q) + 40;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const tSpawn = tEnd * Math.sqrt(u) * 0.97 + 1; // altitude ~ t^2 near the pad
      const age = t - tSpawn;
      if (age < 0) continue;
      const a = (1 - u) * (1 - u), bb = 2 * (1 - u) * u, c = u * u;
      const x = a * p0.x + bb * ctrl.x + c * end.x;
      const y = a * p0.y + bb * ctrl.y + c * end.y;
      const z = a * p0.z + bb * ctrl.z + c * end.z;
      const alt = y; // near-pad approximation for the part of the trail that matters visually
      const low = 1 - smooth(18000, 40000, alt);
      const ws = windScale(alt);
      s.x = x + snap.wind.x * ws * age * low; s.y = y; s.z = z + snap.wind.z * ws * age * low;
      s.vx = snap.wind.x * ws * low; s.vy = 0; s.vz = snap.wind.z * ws * low;
      const R0 = 4 + alt * 0.004 * (1 - low) * 20;
      s.size0 = R0; s.size1 = R0 * 2 + 30 * low + 400 * (1 - low); s.sizeTau = 40; s.sizeDiff = 2.2 * low;
      s.life = 200 + 40 * hashN(i); s.tau = low * 1.6 + (1 - low) * 0.5; s.fadeIn = 0.01;
      s.drag = 2.5; s.buoy = 0; s.buoyTau = 30;
      s.r = 0.8 * low + 0.88 * (1 - low); s.g = 0.79 * low + 0.92 * (1 - low); s.b = 0.78 * low + (1 - low);
      s.temp = 0; s.emis = 0;
      s.variant = 4 + ((hashN(i * 7) * 4) | 0);
      s.turb = low; s.flags = low < 0.5 ? P_THIN : 0; s.spin = 0; s.prio = 2;
      s.level = 15;
      // spacing chosen so the decimation keeps it at its current density
      const sizeNow = s.size0 + (s.size1 - s.size0) * (1 - Math.exp(-age / s.sizeTau)) + s.sizeDiff * Math.sqrt(age);
      const seg = (Math.max(end.distanceTo(p0), 1) / N);
      s.spacing = Math.max(seg, sizeNow / 2.4);
      s.tau *= Math.min(1, seg / (sizeNow * 0.4)) * 2.5;
      const idx = this.ps.emit();
      if (idx >= 0) this.ps.setAge(idx, age);
    }
  }
}

function hashN(n: number): number {
  const s = Math.sin(n * 91.345 + 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
void airDensity;
