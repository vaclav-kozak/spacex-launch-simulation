// HDR post pipeline, one instance per viewport. OWNER: post.
//
//   opaque (LAYER_DEFAULT) -> HDR (+MSAA at q3/photo) + depth
//   log depth -> linear view depth (R32F)  == ctx.sceneDepth while LAYER_VFX renders
//   VFX (LAYER_VFX) into the same HDR target, depth-tested against the opaque depth
//   [photo DOF] -> bloom mip chain -> histogram auto-exposure (per view, temporal)
//   -> lens-ghost source stats -> composite (haze/shimmer, motion blur, bloom+dirt, flares, AgX)
//   -> SMAA -> final (lens distortion, CA, sharpen/soften, vignette, grain, alpha) into view.rect
//
// All transient targets are pooled (PostShared) and shared by every viewport; each view renders
// into a (0,0,w,h) sub-region so animated tiling rects never reallocate anything.
import * as THREE from 'three';
import { LAYER_DEFAULT, LAYER_VFX, type AppContext, type ViewInfo } from '../../core/context';
import { PostShared, BLOOM_LEVELS, GHOST_COLS } from './PostShared';
import { MAX_HAZE } from './shaders/composite';
import { envLook } from '../env/look';
import { ATMO } from '../env/atmosphere';
import { postSettings, type PostSettings, type ToneMapper, type DofSettings } from './PostSettings';

interface QualityParams {
  msaa: number;
  bloomLevels: number;
  smaaHi: boolean;
  smaaThreshold: number;
  mbSamples: number;
  flares: boolean;
  maxHaze: number;
  /** false: no SMAA (3 full-res passes) */
  smaa: boolean;
  /** false: single-tap final pass (no lateral CA) */
  lensCA: boolean;
}
// q0 is the "GTX 1650 / laptop" tier: no SMAA, no CA, no flares / motion blur, 5 bloom levels.
const QUALITY: QualityParams[] = [
  { msaa: 0, bloomLevels: 5, smaaHi: false, smaaThreshold: 0.12, mbSamples: 0, flares: false, maxHaze: 2, smaa: false, lensCA: false },
  { msaa: 0, bloomLevels: 6, smaaHi: false, smaaThreshold: 0.1, mbSamples: 0, flares: true, maxHaze: 3, smaa: true, lensCA: true },
  { msaa: 0, bloomLevels: 6, smaaHi: true, smaaThreshold: 0.1, mbSamples: 6, flares: true, maxHaze: 4, smaa: true, lensCA: true },
  { msaa: 4, bloomLevels: 6, smaaHi: true, smaaThreshold: 0.08, mbSamples: 10, flares: true, maxHaze: 4, smaa: true, lensCA: true },
];

/** Per camera-type "lens + sensor" character. */
interface Lens {
  vignette: number;
  ca: number; // lateral CA in px at the frame corner (1080p)
  barrel: number;
  sharpen: number; // >0 sharpen, <0 soften
  grain: number;
  chroma: number;
  flare: number;
  dirt: number;
  bloom: number;
  sat: number;
  contrast: number;
  lift: number;
  starRot: number;
  star: number; // diffraction spike strength (small apertures = stronger)
}
const CINE: Lens = {
  vignette: 0.2, ca: 1.1, barrel: 0, sharpen: 0.1, grain: 0.011, chroma: 0.12, flare: 1, dirt: 0.55, bloom: 1,
  sat: 1, contrast: 1, lift: 0, starRot: 0.26, star: 0.25,
};
const LENSES: Partial<Record<string, Lens>> = {
  long_lens: { ...CINE, vignette: 0.08, ca: 0.7, sharpen: 0.28, grain: 0.013, chroma: 0.08, flare: 0.75, dirt: 0.25, bloom: 0.9, sat: 0.96, contrast: 0.98, lift: 0.008, starRot: 0.1, star: 0.08 },
  pad: { ...CINE, vignette: 0.14, ca: 0.9, sharpen: 0.2, grain: 0.013, flare: 0.9, dirt: 0.5, starRot: 0.5 },
  onboard_down: { ...CINE, vignette: 0.42, ca: 2.2, barrel: 0.12, sharpen: -0.3, grain: 0.026, chroma: 0.35, flare: 1.3, dirt: 1.2, bloom: 1.35, sat: 0.9, contrast: 1.04, lift: 0.012, starRot: 0.7, star: 0.6 },
  onboard_engine: { ...CINE, vignette: 0.45, ca: 2.4, barrel: 0.14, sharpen: -0.3, grain: 0.028, chroma: 0.35, flare: 1.3, dirt: 1.1, bloom: 1.4, sat: 0.9, contrast: 1.04, lift: 0.012, starRot: 0.9, star: 0.6 },
  deck: { ...CINE, vignette: 0.3, ca: 1.8, barrel: 0.22, sharpen: -0.08, grain: 0.02, chroma: 0.25, flare: 1.2, dirt: 1.6, bloom: 1.2, sat: 1.04, contrast: 1.03, lift: 0.006, starRot: 1.1, star: 0.7 },
};
function lensFor(view: ViewInfo): Lens {
  const l = LENSES[view.mode];
  if (l) return l;
  if (view.onboard) return LENSES.onboard_down!;
  return CINE;
}

/** Per camera-type metering: sensitivity range (EV clamp relative to the default camera, in stops)
 * and histogram weights. Broadcast / tracking cameras are big sensors with a lot of gain and a
 * subject-weighted meter; onboard cameras are small, noisy sensors that give up earlier at night
 * and meter the whole frame. */
interface Meter {
  minEV: number; // stops added to the dark clamp (positive = less sensitive)
  maxEV: number;
  skyW: number; // histogram weight of open sky (depth ~ far)
  subjW: number; // weight of geometry near the subject depth
  center: number; // centre-weight sharpness (exp(-k r^2))
  subjHead: number; // extra stops (on top of settings.meter.subjectHeadroom) the subject may run hot
  /** fixed-ish exposure camera: [offset from the daylight gray card, stops it may open up, stops it may
   *  stop down]. Replaces the EV clamp. A webcast engine cam is set up for the sunlit Earth; it does
   *  not lift an unlit bell or empty space to grey. */
  anchor?: [number, number, number];
  /** fixed remote camera in daylight: stop down at most this many stops below the exposure the
   *  incident light (sun + sky gray card at the focus) calls for, so plume-lit smoke filling the frame
   *  clips instead of dragging a blue sky to navy. Fades out as the sun leaves the focus. */
  dayCap?: number;
  /** highlight-preserving meter: [histogram percentile, max exposed stops (log2 over display white 1.0)
   *  at that percentile, gate, instant]. A floor on the metered level, solved through the key curve.
   *  Gate 'dark': fades in as the sun leaves the focus (sunVisibility 0.8..0.2), so daylight keeps its
   *  deliberate plume/smoke clipping. Gate 'space': fades in with the camera altitude (75..110 km), where a
   *  dark frame holds a small sunlit or glowing subject and nothing else to expose for. instant: stop down
   *  in the same frame (ignition at a dark pad) instead of slewing while the frame clips. Optional 5th:
   *  max exposed stops once the sun has left the focus (sunVisibility 0.8..0.2 blend from the 2nd). */
  hiCap?: [number, number, 'dark' | 'space', boolean, number?];
}
// cine cams (chase, orbit, ...) in space: the top 1% (sunlit white paint, the MVac glow) stays ~1 stop over
// display white. Morning chases sit at <= 0.85 there already (the sunlit fairing at T+196 ~1.0); at
// twilight/night the dark frame had opened up 2-2.5 stops and the glowing bell read as a white bulb. With
// the vehicle in Earth's shadow the bell is all there is: keep it well down the shoulder (dull orange).
const METER_DEFAULT: Meter = { minEV: 0, maxEV: 0, skyW: 0.75, subjW: 2.5, center: 9, subjHead: 0, hiCap: [0.99, 1.1, 'space', false, -0.4] };
const METERS: Partial<Record<string, Meter>> = {
  // long lens: small (often plume-dominated) subject on a big sky, let it run hotter so the sky keeps colour
  long_lens: { minEV: 0, maxEV: 0, skyW: 0.85, subjW: 3, center: 12, subjHead: 1.5 },
  // pad cams: a flood-lit vehicle on a dark pad is allowed to run brighter (the sky stays visible). At
  // twilight / night the top 3% (flame-lit steel next to the plume) may run at most 1.3 stops over white,
  // applied at once: ignition turns a dark pad (metered ~2^-11.5) into a flame-lit one within a frame.
  pad: { minEV: 0, maxEV: 0, skyW: 0.7, subjW: 2, center: 7, subjHead: 1, dayCap: 2, hiCap: [0.97, 1.3, 'dark', true] },
  deck: { minEV: 2, maxEV: 0, skyW: 0.8, subjW: 1.5, center: 6, subjHead: 0.5, dayCap: 2 },
  onboard_down: { minEV: 3.5, maxEV: 0, skyW: 1, subjW: 1, center: 4, subjHead: 0, anchor: [-1.8, 8, 2] },
  onboard_engine: { minEV: 3.5, maxEV: 0, skyW: 1, subjW: 1, center: 4, subjHead: 0, anchor: [-1.8, 0.5, 1.5] },
};
/** log2 luminance of an 18% card under the unshadowed sun, 45° (the daylight exposure reference) */
const DAY_CARD_LOG = Math.log2((0.18 / Math.PI) * ATMO.sunE * 0.75);
function meterFor(view: ViewInfo): Meter {
  return METERS[view.mode] ?? (view.onboard ? METERS.onboard_down! : METER_DEFAULT);
}

const TONEMAP_ID: Record<ToneMapper, number> = { agx: 0, aces: 1, neutral: 2 };
const DEBUG_ID: Record<PostSettings['debug'], number> = { none: 0, depth: 1, bloom: 2, exposure: 3, haze: 4, dirt: 5, flare: 6 };
const SUN_ANG_RADIUS = 0.00465;
/** Lens ghosts of compact highlights (see lensGhosts in composite.ts). threshold: exposed luminance
 * (averaged over ~16 px) where a highlight starts to make ghosts; gain: reflected share of the flux per
 * ghost (~1e-3, a coated double reflection); spread0/1: rms source radius (frame heights) where ghosts
 * start to fade / are gone (big plumes make none); cap: max exposed luminance of a ghost (faint). */
const GHOST = { threshold: 4, gain: 1.2e-3, spread0: 0.03, spread1: 0.075, cap: 0.035 };

// scratch
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _m4a = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _size = new THREE.Vector2();
const _clear = new THREE.Color();
const _res = new THREE.Vector2();
const _scl = new THREE.Vector2();
const _maxUv = new THREE.Vector2();
const _key = new THREE.Vector4();

interface HazeCand { ax: number; ay: number; bx: number; by: number; ra: number; rb: number; za: number; zb: number; sa: number; sb: number; rwa: number; rwb: number; score: number }

export class PostPipeline {
  /** shared settings for every viewport (photo mode UI writes here) */
  static readonly settings: PostSettings = postSettings;
  /** optional GPU profiler (see GpuTimer): phases 'scene' and 'post', summed over viewports */
  static profiler: { begin(label: string): void; end(): void } | null = null;
  /** split 'post' into bloom / meter / comp / smaa / final (debug) */
  static profileDetail = false;

  private S: PostShared;
  private exp: THREE.WebGLRenderTarget[];
  private expRead = 0;
  private needReset = true;
  private fastAdapt = 0;
  private lastT = -1;
  private frame = 0;
  private fxTime = 0;
  // previous camera state for reprojection motion blur
  private prevRotInv = new THREE.Matrix4();
  private prevProj = new THREE.Matrix4();
  private prevPos = new THREE.Vector3();
  private prevFwd = new THREE.Vector3();
  private hasPrev = false;
  private prevMode = '';
  private prevFocus: string | null = null;
  private hazeCands: HazeCand[] = [];
  private hzA = new THREE.Vector3(); private hzB = new THREE.Vector3(); private hzT = new THREE.Vector3();
  private hzPA = new THREE.Vector4(); private hzPB = new THREE.Vector4();
  private x = { scene: new THREE.Vector4(), a: new THREE.Vector4(), b: new THREE.Vector4() };

  constructor(private ctx: AppContext) {
    this.S = PostShared.acquire(ctx.renderer);
    const o = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.exp = [new THREE.WebGLRenderTarget(1, 1, o), new THREE.WebGLRenderTarget(1, 1, o)];
  }

  // ---------------------------------------------------------------- photo-mode hooks
  setExposureBias(ev: number): void { postSettings.exposureBias = ev; }
  setToneMapper(t: ToneMapper): void { postSettings.toneMapper = t; }
  setGrain(on: boolean | number): void { postSettings.grain = typeof on === 'number' ? on : on ? 1 : 0; }
  setVignette(on: boolean | number): void { postSettings.vignette = typeof on === 'number' ? on : on ? 1 : 0; }
  setFlares(on: boolean): void { postSettings.flares = on; }
  setMotionBlur(on: boolean): void { postSettings.motionBlur = on; }
  setDOF(d: Partial<DofSettings>): void { Object.assign(postSettings.dof, d); }
  /** force the exposure to re-meter instantly on the next frame (e.g. after a hard cut) */
  resetExposure(): void { this.needReset = true; }
  /** DEBUG (sync GPU readback, slow): [adapted log2 lum, exposure, sun lum, subject depth] */
  readExposure(): number[] {
    const buf = new Float32Array(4);
    this.ctx.renderer.readRenderTargetPixels(this.exp[this.expRead], 0, 0, 1, 1, buf);
    return Array.from(buf);
  }

  // ---------------------------------------------------------------- frame
  render(view: ViewInfo): void {
    const ctx = this.ctx, r = ctx.renderer, S = this.S, set = postSettings;
    const photo = ctx.photoMode;
    const Q = QUALITY[photo ? 3 : Math.max(0, Math.min(3, ctx.quality.level))];
    const scale = photo ? 1 : THREE.MathUtils.clamp(ctx.quality.renderScale || 1, 0.35, 1);
    const pr = r.getPixelRatio();
    r.getDrawingBufferSize(_size);
    S.ensure(_size.x * scale, _size.y * scale, Q.msaa, photo && set.dof.enabled);
    const rect = view.rect;
    const w = THREE.MathUtils.clamp(Math.round(rect.w * pr * scale), 1, S.W);
    const h = THREE.MathUtils.clamp(Math.round(rect.h * pr * scale), 1, S.H);
    const aspect = rect.w / Math.max(1e-3, rect.h);

    // timing
    const now = ctx.realTime;
    const dt = this.lastT < 0 ? 0 : THREE.MathUtils.clamp(now - this.lastT, 0, 0.25);
    this.lastT = now;
    if (!photo) this.fxTime += dt * (ctx.replay ? 0.25 : 1);
    this.frame++;

    const cam = view.camera;
    if (Math.abs(cam.aspect - aspect) > 1e-6) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    // camera cut detection (mode / focus change or a large jump)
    const fwd = _v3a.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const delta = _v3b.copy(view.camWorldPos).sub(this.prevPos);
    let cut = !this.hasPrev || view.mode !== this.prevMode || view.focus !== this.prevFocus;
    if (this.hasPrev && (fwd.dot(this.prevFwd) < 0.9 || delta.length() > 20_000)) cut = true;
    if (cut && this.hasPrev) this.fastAdapt = 0.7;
    this.fastAdapt = Math.max(0, this.fastAdapt - dt);

    // ---------------------------------------------------------------- scene passes
    const savedMask = cam.layers.mask;
    const bg = ctx.scene.background;
    const shadowAuto = r.shadowMap.autoUpdate;
    const mwAuto = ctx.scene.matrixWorldAutoUpdate;
    r.getClearColor(_clear);
    const clearAlpha = r.getClearAlpha();

    const msaa = S.msaa > 0 && S.msaaRT !== null;
    const sceneRT = msaa ? S.msaaRT! : S.scene;
    sceneRT.viewport.set(0, 0, w, h);
    sceneRT.scissor.set(0, 0, w, h);
    sceneRT.scissorTest = false;

    const prof = PostPipeline.profiler;
    prof?.begin('scene');
    // (a) opaque
    r.setRenderTarget(sceneRT);
    if (bg && (bg as THREE.Color).isColor) r.setClearColor(bg as THREE.Color, 1);
    else r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    cam.layers.set(LAYER_DEFAULT);
    r.render(ctx.scene, cam);
    if (msaa) S.resolve(w, h, false, true);

    // (b) linear depth
    const dm = S.m.depth.uniforms;
    dm.tDepth.value = S.scene.depthTexture;
    dm.uLogFar.value = Math.log2(cam.far + 1);
    (dm.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    dm.uLogDepth.value = r.capabilities.logarithmicDepthBuffer ? 1 : 0;
    S.pass(S.m.depth, S.linDepth, w, h);

    // (c) VFX, depth-tested against the opaque depth, reading ctx.sceneDepth
    ctx.sceneDepth.texture = S.linDepth.texture;
    ctx.sceneDepth.resolution.set(S.W, S.H);
    cam.layers.set(LAYER_VFX);
    ctx.scene.background = null;
    r.shadowMap.autoUpdate = false;
    ctx.scene.matrixWorldAutoUpdate = false;
    try {
      r.setRenderTarget(sceneRT);
      r.render(ctx.scene, cam);
    } finally {
      cam.layers.mask = savedMask;
      ctx.scene.background = bg;
      r.shadowMap.autoUpdate = shadowAuto;
      ctx.scene.matrixWorldAutoUpdate = mwAuto;
      ctx.sceneDepth.texture = null;
    }
    if (msaa) S.resolve(w, h, true, false);
    prof?.end();
    prof?.begin('post');

    // ---------------------------------------------------------------- post
    let hdrRT = S.scene;
    const sceneX = PostShared.xf(S.scene, w, h, this.x.scene);

    // photo-mode depth of field
    if (photo && set.dof.enabled && S.dof) {
      const u = S.m.dof.uniforms;
      u.tSrc.value = S.scene.texture;
      u.tDepth.value = S.linDepth.texture;
      (u.uX.value as THREE.Vector4).copy(sceneX);
      (u.uTexel.value as THREE.Vector2).set(1 / S.W, 1 / S.H);
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      const A = (0.024 * h) / (4 * tanHalf * tanHalf * Math.max(0.7, set.dof.fStop));
      const maxR = Math.min(28, h * 0.025);
      (u.uCoc.value as THREE.Vector4).set(A, set.dof.autoFocus ? -1 : Math.max(0.1, set.dof.focusDistance), maxR, 0.6);
      S.pass(S.m.dof, S.dof, w, h);
      hdrRT = S.dof;
    }

    if (PostPipeline.profileDetail) { prof?.end(); prof?.begin('bloom'); }
    // bloom: 13-tap down chain (always all levels: the exposure meter reads a small mip)
    const dims: [number, number][] = [];
    {
      const u = S.m.down.uniforms;
      let src = hdrRT, sw = w, sh = h;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const dw = Math.max(1, Math.ceil(sw / 2)), dh = Math.max(1, Math.ceil(sh / 2));
        u.tSrc.value = src.texture;
        PostShared.xf(src, sw, sh, u.uSrc.value as THREE.Vector4);
        (u.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        u.uFirst.value = i === 0 ? 1 : 0;
        u.uKnee.value = set.bloomKnee;
        u.tExp.value = this.exp[this.expRead].texture;
        S.pass(S.m.down, S.down[i], dw, dh);
        dims.push([dw, dh]);
        src = S.down[i];
        sw = dw;
        sh = dh;
      }
    }
    const levels = Math.max(2, Math.min(BLOOM_LEVELS, Q.bloomLevels));
    {
      const u = S.m.up.uniforms;
      let low = S.down[levels - 1];
      let [lw, lh] = dims[levels - 1];
      for (let i = levels - 2; i >= 0; i--) {
        u.tLow.value = low.texture;
        PostShared.xf(low, lw, lh, u.uLow.value as THREE.Vector4);
        (u.uLowTexel.value as THREE.Vector2).set(1 / low.width, 1 / low.height);
        u.tCur.value = S.down[i].texture;
        PostShared.xf(S.down[i], dims[i][0], dims[i][1], u.uCur.value as THREE.Vector4);
        u.uScatter.value = 0.62;
        u.uRadius.value = 1.0;
        S.pass(S.m.up, S.up[i], dims[i][0], dims[i][1]);
        low = S.up[i];
        [lw, lh] = dims[i];
      }
    }

    if (PostPipeline.profileDetail) { prof?.end(); prof?.begin('meter'); }
    // sun projection
    const sun = this.projectSun(view, cam);

    // auto-exposure: histogram of a ~64px-wide mip, then 1x1 temporal adaptation
    const mt = set.meter;
    const meter = meterFor(view);
    const keyU = _key.set(Math.log2(mt.keyDark), Math.log2(mt.key), mt.darkLog, mt.brightLog);
    {
      let mi = BLOOM_LEVELS - 1;
      for (let i = 0; i < BLOOM_LEVELS; i++) if (dims[i][0] <= 80) { mi = i; break; }
      const hu = S.m.hist.uniforms;
      hu.tSrc.value = S.down[mi].texture;
      (hu.uSize.value as THREE.Vector2).set(dims[mi][0], dims[mi][1]);
      hu.uAspect.value = aspect;
      hu.tDepth.value = S.linDepth.texture;
      (hu.uDepthX.value as THREE.Vector4).copy(sceneX);
      hu.tExp.value = this.exp[this.expRead].texture;
      (hu.uW.value as THREE.Vector4).set(Math.min(cam.far * 0.5, 3e5), meter.skyW, view.onboard ? 1 : meter.subjW, meter.center);
      S.pass(S.m.hist, S.hist, 65, 8);

      const au = S.m.adapt.uniforms;
      au.tHist.value = S.hist.texture;
      au.tPrev.value = this.exp[this.expRead].texture;
      (au.uP.value as THREE.Vector4).set(mt.lowPercent, mt.highPercent, mt.highlightPercent, mt.highlightHeadroom);
      const bias = (ctx.lighting.exposureBias || 0) + set.exposureBias;
      // incident-light prior: sun-lit gray card (only used when the frame is mostly black, e.g. space)
      const L = ctx.lighting;
      const sunLum = (0.2126 * L.sunColor.r + 0.7152 * L.sunColor.g + 0.0722 * L.sunColor.b) * L.sunVisibility;
      const skyLum = 0.2126 * L.skyColor.r + 0.7152 * L.skyColor.g + 0.0722 * L.skyColor.b;
      const gray = (0.18 / Math.PI) * (sunLum * 0.75 + skyLum);
      const priorL = Math.log2(Math.max(1e-9, gray));
      let minL = Math.log2(mt.minLum) + meter.minEV, maxL = Math.log2(mt.maxLum) + meter.maxEV;
      if (meter.anchor) {
        const a = DAY_CARD_LOG + meter.anchor[0];
        minL = a - meter.anchor[1];
        maxL = a + meter.anchor[2];
      }
      if (meter.dayCap !== undefined) {
        const w = THREE.MathUtils.smoothstep(L.sunVisibility, 0.2, 0.8);
        if (w > 0) maxL = Math.max(minL, THREE.MathUtils.lerp(maxL, Math.min(maxL, priorL + meter.dayCap), w));
      }
      (au.uClamp.value as THREE.Vector4).set(minL, maxL, 0, bias);
      const hc = meter.hiCap;
      let hw = 0;
      if (hc) {
        if (hc[2] === 'dark') hw = 1 - THREE.MathUtils.smoothstep(L.sunVisibility, 0.2, 0.8);
        else {
          const c = view.camWorldPos;
          const alt = Math.hypot(c.x, c.y + ATMO.R, c.z) - ATMO.R;
          hw = THREE.MathUtils.smoothstep(alt, 75_000, 110_000);
        }
      }
      let capStops = hc ? hc[1] : 99;
      if (hc && hc[4] !== undefined) capStops = THREE.MathUtils.lerp(hc[4], hc[1], THREE.MathUtils.smoothstep(L.sunVisibility, 0.2, 0.8));
      (au.uHiCap.value as THREE.Vector4).set(hc ? hc[0] : 0.99, capStops, hw, hc && hc[3] ? 1 : 0);
      (au.uKey.value as THREE.Vector4).copy(keyU);
      (au.uKeyDeep.value as THREE.Vector3).set(mt.nightKeyStops * envLook.night, mt.darkLog + 4, mt.darkLog - 2);
      const fast = this.fastAdapt > 0 ? 4 : 1;
      (au.uAdapt.value as THREE.Vector4).set(dt, mt.speedUp * fast, mt.speedDown * fast, this.needReset ? 1 : 0);
      (au.uMaxRate.value as THREE.Vector2).set(mt.maxRateUp * fast, mt.maxRateDown * fast);
      (au.uSubj.value as THREE.Vector4).set(mt.subjectHeadroom + meter.subjHead, 0.015, 0.06, view.onboard || meter.subjW <= 1 ? 0 : 1);
      // "black" = below anything a sky can be (moonless night sky ~2^-16), i.e. space / unlit void
      (au.uPrior.value as THREE.Vector4).set(priorL, mt.priorWeight * Math.min(1, L.sunVisibility * 1.5), -17.5, set.autoExposure ? 0 : 1);
      au.uManualL.value = set.manualEV;
      (au.uSun.value as THREE.Vector4).set(sun.uvx, sun.uvy, sun.radius, sun.on ? 1 : 0);
      au.tBloom.value = S.down[0].texture;
      PostShared.xf(S.down[0], dims[0][0], dims[0][1], au.uBloomX.value as THREE.Vector4);
      au.tDepth.value = S.linDepth.texture;
      (au.uDepthX.value as THREE.Vector4).copy(sceneX);
      au.uSkyDepth.value = Math.min(cam.far * 0.5, 3e5);
      au.uAspect.value = aspect;
      au.uSubjOverride.value = view.onboard ? 60 : 0;
      au.uSubjHint.value = view.onboard || view.mode === 'deck' ? 0 : (envLook.focusDist.get(view.id) ?? 0);
      this.expRead = 1 - this.expRead;
      S.pass(S.m.adapt, this.exp[this.expRead], 1, 1);
      this.needReset = false;
    }
    const expTex = this.exp[this.expRead].texture;
    const lens = lensFor(view);

    // lens ghosts: flux / centroid / spread of the clipped highlights in a small mip (2 tiny passes);
    // the composite draws the ghost discs analytically from that
    const flaresOn = set.flares && Q.flares;
    if (flaresOn) {
      let gi = BLOOM_LEVELS - 1;
      for (let i = 1; i < BLOOM_LEVELS; i++) if (dims[i][0] <= GHOST_COLS) { gi = i; break; }
      const u = S.m.ghostCols.uniforms;
      u.tSrc.value = S.down[gi].texture;
      (u.uSize.value as THREE.Vector2).set(dims[gi][0], dims[gi][1]);
      u.tExp.value = expTex;
      u.uAspect.value = aspect;
      u.uThreshold.value = GHOST.threshold;
      (u.uSunMask.value as THREE.Vector4).set(sun.uvx, sun.uvy, sun.radius, sun.on ? 1 : 0);
      S.pass(S.m.ghostCols, S.ghostCols, dims[gi][0], 2);
      const ru = S.m.ghostReduce.uniforms;
      ru.tCols.value = S.ghostCols.texture;
      ru.uCols.value = dims[gi][0];
      S.pass(S.m.ghostReduce, S.ghost, 2, 1);
    }

    if (PostPipeline.profileDetail) { prof?.end(); prof?.begin('comp'); }
    // ---------------------------------------------------------------- composite
    {
      const u = S.m.composite.uniforms;
      u.tScene.value = hdrRT.texture;
      u.tDepth.value = S.linDepth.texture;
      (u.uSceneX.value as THREE.Vector4).copy(sceneX);
      (u.uScenePx.value as THREE.Vector2).set(w, h);
      u.tBloom.value = S.up[0].texture;
      PostShared.xf(S.up[0], dims[0][0], dims[0][1], u.uBloomX.value as THREE.Vector4);
      u.tGhost.value = S.ghost.texture;
      (u.uGhost.value as THREE.Vector4).set(flaresOn ? GHOST.gain * set.flareStrength * lens.flare : 0, GHOST.spread0, GHOST.spread1, GHOST.cap);
      u.tDirt.value = S.dirt.texture;
      this.dirtXf(view, aspect, u.uDirtX.value as THREE.Vector4);
      u.tExp.value = expTex;
      u.uAspect.value = aspect;
      u.uTime.value = this.fxTime;
      u.uFrame.value = photo ? 0 : this.frame;
      const bloomK = 0.04 * set.bloom * lens.bloom;
      (u.uBloom.value as THREE.Vector4).set(bloomK, bloomK * 5.0 * set.dirt * lens.dirt, 0, 0);
      // heat haze
      u.uHazeCount.value = set.heatHaze ? this.projectHaze(view, cam, Q.maxHaze, u) : 0;
      // long-lens shimmer
      const sh = set.shimmer ? THREE.MathUtils.clamp(view.shimmer || 0, 0, 1) : 0;
      (u.uShimmer.value as THREE.Vector4).set(sh, 120, 6000, 0);
      // motion blur (camera reprojection)
      const mbOn = set.motionBlur && Q.mbSamples > 0 && !photo && !cut && dt > 1e-4;
      const mb = u.uMB.value as THREE.Vector4;
      if (mbOn) {
        _q.setFromRotationMatrix(_m4a.extractRotation(cam.matrixWorld));
        const curRot = _m4a.makeRotationFromQuaternion(_q);
        const T = _m4b.makeTranslation(delta.x, delta.y, delta.z);
        const M = u.uReproj.value as THREE.Matrix4;
        M.copy(this.prevProj).multiply(this.prevRotInv).multiply(T).multiply(curRot);
        const shutter = Math.min(dt * 0.5, 1 / 96);
        mb.set(1, Q.mbSamples, 0.03, shutter / dt);
      } else mb.set(0, 0, 0, 0);
      const P = cam.projectionMatrix.elements;
      (u.uProj.value as THREE.Vector4).set(P[0], P[5], P[8], P[9]);
      u.uSubjOverride.value = view.onboard ? 60 : 0;
      // sun lens fx
      (u.uSun.value as THREE.Vector4).set((sun.uvx - 0.5) * aspect, sun.uvy - 0.5, sun.on && set.flares ? 1 : 0,
        set.flareStrength * lens.flare * THREE.MathUtils.clamp(ctx.lighting.sunVisibility, 0, 1));
      (u.uSunRot.value as THREE.Vector4).set(lens.starRot, sun.radius, lens.star, 0);
      // local highlight compression, adaptation level = wide blur from the bloom up-chain
      const li = Math.min(2, levels - 2);
      u.tLocal.value = S.up[li].texture;
      PostShared.xf(S.up[li], dims[li][0], dims[li][1], u.uLocalX.value as THREE.Vector4);
      (u.uLocal.value as THREE.Vector4).set(set.highlightCompress, set.compressStart, set.compressRangeDark, set.compressRangeBright);
      (u.uKey.value as THREE.Vector4).copy(keyU);
      (u.uNight.value as THREE.Vector4).set(set.nightLook * envLook.night, -10, -4.5, 0.5);
      u.uTonemap.value = TONEMAP_ID[set.toneMapper] ?? 0;
      (u.uLook.value as THREE.Vector3).set(set.agxLook.slope, set.agxLook.power, set.agxLook.saturation);
      u.uDebug.value = DEBUG_ID[set.debug] ?? 0;
      S.pass(S.m.composite, S.ldr, w, h);
    }

    if (PostPipeline.profileDetail) { prof?.end(); prof?.begin('smaa'); }
    // ---------------------------------------------------------------- SMAA
    let finalSrc = S.ldr;
    if (Q.smaa && S.smaaReady >= 2) {
      const res = _res.set(1 / S.W, 1 / S.H);
      const scl = _scl.set(w / S.W, h / S.H);
      const maxUv = _maxUv.set((w - 0.5) / S.W, (h - 0.5) / S.H);
      S.edges.scissorTest = false;
      r.setRenderTarget(S.edges);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      const eu = S.m.edges.uniforms;
      eu.tDiffuse.value = S.ldr.texture;
      (eu.resolution.value as THREE.Vector2).copy(res);
      (eu.uScale.value as THREE.Vector2).copy(scl);
      (eu.uMaxUv.value as THREE.Vector2).copy(maxUv);
      eu.uThreshold.value = Q.smaaThreshold;
      S.pass(S.m.edges, S.edges, w, h);
      const wm = Q.smaaHi ? S.m.weightsHi : S.m.weightsLo;
      const wu = wm.uniforms;
      wu.tDiffuse.value = S.edges.texture;
      (wu.resolution.value as THREE.Vector2).copy(res);
      (wu.uScale.value as THREE.Vector2).copy(scl);
      S.pass(wm, S.weights, w, h);
      const bu = S.m.blend.uniforms;
      bu.tDiffuse.value = S.weights.texture;
      bu.tColor.value = S.ldr.texture;
      (bu.resolution.value as THREE.Vector2).copy(res);
      (bu.uScale.value as THREE.Vector2).copy(scl);
      (bu.uMaxUv.value as THREE.Vector2).copy(maxUv);
      S.pass(S.m.blend, S.aa, w, h);
      finalSrc = S.aa;
    }

    if (PostPipeline.profileDetail) { prof?.end(); prof?.begin('final'); }
    // ---------------------------------------------------------------- final -> canvas
    {
      const u = S.m.final.uniforms;
      u.tColor.value = finalSrc.texture;
      PostShared.xf(finalSrc, w, h, u.uSrc.value as THREE.Vector4);
      (u.uTexel.value as THREE.Vector2).set(1 / finalSrc.width, 1 / finalSrc.height);
      u.tExp.value = expTex;
      const outH = rect.h * pr;
      (u.uOut.value as THREE.Vector2).set(rect.w * pr, outH);
      u.uAspect.value = aspect;
      const alpha = set.viewAlpha ? THREE.MathUtils.clamp(view.alpha, 0, 1) : 1;
      u.uAlpha.value = alpha;
      u.uFrame.value = photo ? 0 : this.frame;
      const up = w / Math.max(1, rect.w * pr); // <1 when upscaling
      const sharpen = lens.sharpen + (lens.sharpen > -0.05 ? (1 - up) * 0.6 : 0);
      (u.uLens.value as THREE.Vector4).set(
        lens.vignette * set.vignette,
        Q.lensCA ? lens.ca * set.chromaticAberration * (outH / 1080) : 0,
        set.lensDistortion ? lens.barrel : 0,
        sharpen,
      );
      (u.uGrain.value as THREE.Vector4).set(lens.grain * set.grain, lens.chroma, -1.0, 0.3);
      (u.uLook.value as THREE.Vector4).set(lens.sat, lens.contrast, lens.lift, 0);
      const fm = S.m.final;
      fm.blending = alpha < 0.999 ? THREE.CustomBlending : THREE.NoBlending;
      const H = ctx.height;
      r.setRenderTarget(null);
      r.setViewport(rect.x, H - rect.y - rect.h, rect.w, rect.h);
      r.setScissor(rect.x, H - rect.y - rect.h, rect.w, rect.h);
      r.setScissorTest(true);
      S.quad.material = fm;
      r.render(S.quad, S.cam);
      r.setScissorTest(false);
      r.setViewport(0, 0, ctx.width, ctx.height);
    }
    r.setClearColor(_clear, clearAlpha);
    prof?.end();

    // remember camera for next frame's reprojection
    this.prevRotInv.makeRotationFromQuaternion(_q.setFromRotationMatrix(_m4a.extractRotation(cam.matrixWorld))).invert();
    this.prevProj.copy(cam.projectionMatrix);
    this.prevPos.copy(view.camWorldPos);
    this.prevFwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this.prevMode = view.mode;
    this.prevFocus = view.focus;
    this.hasPrev = true;
  }

  dispose(): void {
    for (const e of this.exp) e.dispose();
    this.S.release();
  }

  // ---------------------------------------------------------------- helpers
  private sunOut = { uvx: 0.5, uvy: 0.5, radius: 0.01, on: false };
  private projectSun(view: ViewInfo, cam: THREE.PerspectiveCamera) {
    const o = this.sunOut;
    const d = _v4.set(this.ctx.lighting.sunDir.x, this.ctx.lighting.sunDir.y, this.ctx.lighting.sunDir.z, 0);
    d.applyMatrix4(cam.matrixWorldInverse);
    o.on = false;
    if (d.z < -1e-3 && this.ctx.lighting.sunVisibility > 0.01) {
      d.w = 0;
      d.applyMatrix4(cam.projectionMatrix);
      if (d.w > 1e-6) {
        o.uvx = (d.x / d.w) * 0.5 + 0.5;
        o.uvy = (d.y / d.w) * 0.5 + 0.5;
        o.on = o.uvx > -0.02 && o.uvx < 1.02 && o.uvy > -0.02 && o.uvy < 1.02;
      }
    }
    o.radius = SUN_ANG_RADIUS * cam.projectionMatrix.elements[5] * 0.5;
    void view;
    return o;
  }

  private dirtXf(view: ViewInfo, aspect: number, out: THREE.Vector4): void {
    // "cover" mapping of the square dirt texture; each camera type gets a different flip
    let sx: number, sy: number;
    if (aspect >= 1) { sx = 1; sy = 1 / aspect; } else { sx = aspect; sy = 1; }
    let hsh = 0;
    for (let i = 0; i < view.mode.length; i++) hsh = (hsh * 31 + view.mode.charCodeAt(i)) | 0;
    const fx = hsh & 1 ? -1 : 1, fy = hsh & 2 ? -1 : 1;
    out.set(sx * fx, sy * fy, 0.5 - 0.5 * sx * fx, 0.5 - 0.5 * sy * fy);
  }

  /**
   * Project ctx.hazeSources to screen capsules, keep the most significant. Returns count.
   * Near clip: a capsule is kept only where its axis lies at least one local radius (and 1.5x the camera near
   * plane) in front of the camera, so a plume that reaches past the camera plane is cut where it starts to wrap
   * around the lens instead of projecting to a screen-filling capsule with a huge, flat noise scale. Strength
   * fades along the capsule (1 -> 0.45); the clipped ends carry their own strength (uHazeC.x / .w).
   */
  private projectHaze(view: ViewInfo, cam: THREE.PerspectiveCamera, max: number, u: Record<string, THREE.IUniform>): number {
    const src = this.ctx.hazeSources;
    if (!src || src.length === 0) return 0;
    const Vi = cam.matrixWorldInverse;
    const P = cam.projectionMatrix;
    const p11 = P.elements[5];
    const near = Math.max(cam.near, 0.05) * 1.5;
    const cands = this.hazeCands;
    cands.length = 0;
    const a = this.hzA, b = this.hzB, pa = this.hzPA, pb = this.hzPB;
    const k = 1.25; // distortion region slightly wider than the hot core
    for (const hs of src) {
      if (!(hs.strength > 0.001)) continue;
      a.copy(hs.start).sub(view.camWorldPos).applyMatrix4(Vi);
      b.copy(hs.end).sub(view.camWorldPos).applyMatrix4(Vi);
      const da0 = -a.z, db0 = -b.z, ra0 = hs.radius0, rb0 = hs.radius1;
      // keep t in [t0, t1] where depth(t) >= near and depth(t) >= radius(t) (both linear in t)
      let t0 = 0, t1 = 1;
      for (let c = 0; c < 2; c++) {
        const g0 = c === 0 ? da0 - near : da0 - ra0, g1 = c === 0 ? db0 - near : db0 - rb0;
        if (g0 < 0 && g1 < 0) { t1 = -1; break; }
        if (g0 < 0) t0 = Math.max(t0, g0 / (g0 - g1));
        else if (g1 < 0) t1 = Math.min(t1, g0 / (g0 - g1));
      }
      if (t1 - t0 < 1e-3) continue;
      const ra = ra0 + (rb0 - ra0) * t0, rb = ra0 + (rb0 - ra0) * t1;
      b.lerpVectors(a, b, t1);
      a.lerp(this.hzT.copy(hs.end).sub(view.camWorldPos).applyMatrix4(Vi), t0);
      const da = -a.z, db = -b.z;
      pa.set(a.x, a.y, a.z, 1).applyMatrix4(P);
      pb.set(b.x, b.y, b.z, 1).applyMatrix4(P);
      const ax = (pa.x / pa.w) * 0.5 + 0.5, ay = (pa.y / pa.w) * 0.5 + 0.5;
      const bx = (pb.x / pb.w) * 0.5 + 0.5, by = (pb.y / pb.w) * 0.5 + 0.5;
      const rA = ((ra * k) * p11 * 0.5) / da, rB = ((rb * k) * p11 * 0.5) / db;
      const rmax = Math.max(rA, rB);
      if (rmax < 0.0015) continue;
      if (Math.max(ax, bx) + rmax < 0 || Math.min(ax, bx) - rmax > 1 || Math.max(ay, by) + rmax < 0 || Math.min(ay, by) - rmax > 1) continue;
      const s0 = THREE.MathUtils.clamp(hs.strength, 0, 1);
      cands.push({
        ax, ay, bx, by, ra: rA, rb: rB, za: da, zb: db, sa: s0 * (1 - 0.55 * t0), sb: s0 * (1 - 0.55 * t1),
        rwa: ra * k, rwb: rb * k, score: s0 * Math.min(rmax, 0.3),
      });
    }
    cands.sort((x, y) => y.score - x.score);
    const n = Math.min(cands.length, max, MAX_HAZE);
    const A = u.uHazeA.value as THREE.Vector4[], B = u.uHazeB.value as THREE.Vector4[], C = u.uHazeC.value as THREE.Vector4[];
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      A[i].set(c.ax, c.ay, c.bx, c.by);
      B[i].set(c.ra, c.rb, c.za, c.zb);
      C[i].set(c.sa, c.rwa, c.rwb, c.sb);
    }
    return n;
  }
}
