// Raymarched rocket plume volume (Merlin 1D cluster or MVac), valid from pad cams at 20 m to long
// lenses at 100+ km:
//  * analytic line-integrated per-engine cores with Mach diamonds (no aliasing at any distance)
//  * raymarched turbulent afterburning flame, soot fringe / GG exhaust (absorbing), and the
//    pressure-dependent expanded plume that scatters sunlight (the twilight "jellyfish")
//  * supersonic retropropulsion bow shell (entry / landing burn), plane impingement + radial wall jet
//  * far-distance glow sprite so the flame stays a bright point when sub-pixel
// Local plume frame == stage body frame rotated by the mean gimbal: origin at the nozzle-exit plane
// center, exhaust toward local -Y. Proxy = frustum (x0..x1 along the exhaust, radii R0..R1).
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import { LAYER_VFX } from '../../core/context';
import { F9 } from '../../core/vehicleSpec';
import { AERIAL_GLSL, aerialUniforms } from '../env/aerial';
import { COLOR_GLSL, DEPTH_GLSL, NOISE_GLSL, refreshSharedForDraw, smooth, vfxShared } from './common';

export type PlumeKind = 'merlin' | 'mvac';

/** Everything a plume needs each frame (filled by VFX from the snapshot). */
export interface PlumeDrive {
  active: boolean;
  /** W nozzle-exit center of the cluster */
  origin: THREE.Vector3;
  /** local -> W; local -Y is the exhaust direction */
  quat: THREE.Quaternion;
  /** per-engine intensity 0..1 (throttle*spool shaped); merlin: 9, mvac: 1 */
  eng: number[];
  /** per-engine TEA-TEB green flash 0..1 */
  green: number[];
  ambientPressure: number;
  ambientDensity: number;
  /** vehicle velocity relative to the air (W, m/s) */
  airVel: THREE.Vector3;
  /** impingement plane (W point + unit normal pointing toward the vehicle), strength 0..1 */
  plane: { point: THREE.Vector3; normal: THREE.Vector3; wall: number } | null;
  sunRad: THREE.Color;
  ambRad: THREE.Color;
  /** per-frame flicker multiplier */
  flicker: number;
}

export function makeDrive(n: number): PlumeDrive {
  return {
    active: false, origin: new THREE.Vector3(), quat: new THREE.Quaternion(),
    eng: new Array(n).fill(0), green: new Array(n).fill(0),
    ambientPressure: 101325, ambientDensity: 1.225, airVel: new THREE.Vector3(), plane: null,
    sunRad: new THREE.Color(), ambRad: new THREE.Color(), flicker: 1,
  };
}

/** Derived plume shape numbers (also used by VFX for lights / haze / trail hand-off). */
export interface PlumeShape {
  e: number; // expansion level log10(pExit/pAmb)
  ex: number; // 0..1 expansion blend
  mass: number; // engine-equivalents
  L: number; // visible length (m)
  Rc: number; // cluster radius
  tanT: number;
  retro: number; // 0..1
  standoff: number;
  lumBright: number; // how luminous the flame is (0..1) for lights
  planeDist: number; // nozzle -> plane distance along the axis (Infinity if none)
  bellP: number; // boundary exponent (see plumeRadiusAt)
  a0: number; // boundary offset (caps the initial turning angle)
}

/** Expanded-plume radius at axial distance a (matches the shader). */
export function plumeRadiusAt(sh: PlumeShape, a: number): number {
  const L = Math.max(sh.L, 1);
  const x = Math.min(Math.max(a, 0), 4 * L);
  return sh.Rc + sh.tanT * L * (Math.pow((x + sh.a0) / L, sh.bellP) - Math.pow(sh.a0 / L, sh.bellP));
}

const P_EXIT = { merlin: 72_000, mvac: 650 };
const MERLIN_THRUST = 845_000;

export class PlumeVolume {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly glow: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  // half-res path for plumes that cover much of the view (camera inside / close chase): the march
  // runs at 1/4 of the pixels into a private target, the proxy then composites it (depth-aware)
  private lowMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private lowMesh: THREE.Mesh;
  private lowScene = new THREE.Scene();
  private quality = 2;
  /** MVac look constants (shared module object; exposed for live tuning from the console) */
  readonly vacTune = MVAC_TUNE;
  /** per-quality step counts / half-res threshold (shared module object; live-tunable) */
  readonly qTune = PLUME_Q;
  readonly shape: PlumeShape = { e: 0, ex: 0, mass: 0, L: 0, Rc: 1, tanT: 0.05, retro: 0, standoff: 1e9, lumBright: 0, planeDist: Infinity, bellP: 1, a0: 0 };
  private camInside = false;
  /** last view coverage estimate and low-res factor (diagnostics) */
  cov = 0;
  /** on-screen scale at the nozzle (px per m), per view: gates the far fill */
  pxPerM = 0;
  private lowF = 2;
  /** proxy bounds as set for the frame (prepareView widens them per view for the far field) */
  private boundsBase = new THREE.Vector4();
  /** (shared, dev tuning via __app.vfx.plumeRem.farTune) */
  readonly farTune = PLUME_FAR;
  /** march samples for the quality level (per frame); prepareView may lower them per view */
  private baseSteps = 36;
  private qInv = new THREE.Quaternion();
  active = false;

  constructor(private ctx: AppContext, readonly kind: PlumeKind) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
    geo.translate(0, 0.5, 0); // y in [0,1]
    const u = {
      ...aerialUniforms,
      uSceneDepth: vfxShared.uSceneDepth, uSceneRes: vfxShared.uSceneRes, uHasDepth: vfxShared.uHasDepth,
      uNoise3D: vfxShared.uNoise3D, uTime: vfxShared.uVfxTime,
      uCamLocal: { value: new THREE.Vector3() },
      uBounds: { value: new THREE.Vector4(0, 50, 2, 5) },
      uEng: { value: new Array(9).fill(0) },
      uGreen: { value: new Array(9).fill(0) },
      uGeom: { value: new THREE.Vector4(F9.s1.engineRingRadius, F9.s1.nozzleExitRadius, 1.7, 0.06) },
      uCore: { value: new THREE.Vector4(5, 1, 1, 150) },
      uFlame: { value: new THREE.Vector4(30, 25, 0.2, 0) },
      uMisc: { value: new THREE.Vector4(9, 0, kind === 'mvac' ? 1 : 0, 70) },
      uRetro: { value: new THREE.Vector4(0, 1e4, 10, 20) },
      uRetroB: { value: new THREE.Vector4(3, 8, 3, 20) }, // cushion nose, flow length, radius, aft reach
      uPlaneN: { value: new THREE.Vector4(0, 1, 0, 0) },
      uPlaneP: { value: new THREE.Vector4(0, -1e6, 0, 20) },
      uSunLocal: { value: new THREE.Vector3(0, 1, 0) },
      uSunRad: { value: new THREE.Color() },
      uAmbRad: { value: new THREE.Color() },
      uScat: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSteps: { value: 24 },
      uLowF: { value: 2 }, // low-res pass: full-res pixels per low-res texel (2, 3 or 4)
      uFlick: { value: 1 },
      uShape: { value: new THREE.Vector4(1, 100, 0, 0) }, // bell exponent, L
      uFlameB: { value: new THREE.Vector4(0, 0, 0, 0) },  // flame sub-proxy x0,x1,R0,R1
      // MVac vacuum plume (see VAC_GLSL): K, condensation radius R0, boundary angle, shell half-width
      uVacA: { value: new THREE.Vector4(0, 20, 0.87, 0.1) },
      // virtual source (axial a), far fade length, shell build-up radius, core weight
      uVacB: { value: new THREE.Vector4(-2, 1400, 90, 0.3) },
      // far-field condensate gain, its ramp radius (m), interior fill weight, core half-width (rad)
      uVacC: { value: new THREE.Vector4(6, 1200, 0.1, 0.27) },
      // MECO remnant: on (0/1), density multiplier, detach distance (m), -
      uRem: { value: new THREE.Vector4(0, 1, 0, 1) },
      // far field (per view, 0..1): metres per pixel at the plume >> its fine structure (see PLUME_FAR)
      uFar: { value: 0 },
    };
    const kindDefs: Record<string, number> = kind === 'mvac' ? { PLUME_MVAC: 1 } : {};
    this.mat = new THREE.ShaderMaterial({
      uniforms: u,
      defines: { ...kindDefs },
      vertexShader: PLUME_VS,
      fragmentShader: PLUME_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.renderOrder = 20;
    this.mesh.onBeforeRender = (r, _s, cam, _g, material) => {
      const m = material as THREE.ShaderMaterial;
      refreshSharedForDraw(this.ctx, cam, m, false);
      // own depth-test policy: we clip against the linear scene depth when available; without it,
      // hardware-test front faces from outside, nothing from inside.
      // NOTE: the proxy is mirrored along y in the VS (local y = -a), which flips the winding:
      // THREE.FrontSide draws the physically FAR faces, THREE.BackSide the near ones. Far faces
      // work from inside and outside (the march starts at the camera / entry point).
      const hasD = !!vfxShared.uHasDepth.value;
      const side = hasD || this.camInside ? THREE.FrontSide : THREE.BackSide;
      m.depthTest = !hasD && !this.camInside;
      m.side = side;
      if (m === this.compMat) this.renderLow(r, cam, side);
    };
    this.lowMat = new THREE.ShaderMaterial({
      uniforms: u,
      defines: { VFX_LOWRES: 1, ...kindDefs },
      vertexShader: PLUME_VS,
      fragmentShader: PLUME_FS,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
      blending: THREE.NoBlending,
    });
    this.lowMesh = new THREE.Mesh(geo, this.lowMat);
    this.lowMesh.frustumCulled = false;
    this.lowMesh.matrixAutoUpdate = false;
    this.lowMesh.layers.set(LAYER_VFX);
    this.lowScene.add(this.lowMesh);
    this.lowScene.matrixWorldAutoUpdate = false;
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        uSceneDepth: vfxShared.uSceneDepth, uHasDepth: vfxShared.uHasDepth,
        uLow: { value: null }, uLowSize: { value: new THREE.Vector2(1, 1) }, uLowTexel: { value: new THREE.Vector2(1, 1) },
        uCamLocal: u.uCamLocal, uBounds: u.uBounds, uLowF: u.uLowF,
      },
      vertexShader: PLUME_VS,
      fragmentShader: PLUME_COMP_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });

    // far-distance glow sprite
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: {
        ...aerialUniforms,
        uViewH: vfxShared.uViewH,
        uSceneDepth: vfxShared.uSceneDepth, uSceneRes: vfxShared.uSceneRes, uHasDepth: vfxShared.uHasDepth,
        uGlow: { value: new THREE.Vector4(1, 1, 1, 0) }, // rgb radiance*area, physical radius
        uFade: { value: 1 },
      },
      vertexShader: GLOW_VS,
      fragmentShader: GLOW_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.layers.set(LAYER_VFX);
    this.glow.renderOrder = 21;
    this.glow.onBeforeRender = (_r, _s, cam) => refreshSharedForDraw(this.ctx, cam, this.glowMat);
    this.group.add(this.mesh);
    this.group.add(this.glow);
    this.group.visible = false;
  }

  /** Map the physical state to shader parameters. */
  setDrive(d: PlumeDrive, quality: number): void {
    this.active = d.active;
    this.group.visible = d.active;
    if (!d.active) return;
    const u = this.mat.uniforms;
    const vac = this.kind === 'mvac';
    const nEng = d.eng.length;
    let mass = 0;
    let rc = 0;
    for (let k = 0; k < nEng; k++) {
      mass += d.eng[k];
      if (d.eng[k] > 0.02) {
        const rr = vac ? 0 : k === 0 ? 0 : F9.s1.engineRingRadius;
        rc = Math.max(rc, rr + (vac ? F9.s2.mvac.exitRadius : F9.s1.nozzleExitRadius));
      }
    }
    if (mass < 1e-3) { this.group.visible = false; this.active = false; return; }
    const Rc = Math.max(rc, 0.4);
    const pA = Math.max(d.ambientPressure, 1e-4);
    const e = Math.min(6.5, Math.max(-0.3, Math.log10(P_EXIT[this.kind] / pA)));
    const ex = smooth(0.15, vac ? 2.6 : 3.4, e);
    const massFrac = vac ? mass : mass / 9;
    // spreading half-angle: ~3.5 deg at sea level -> ~60 deg near vacuum
    const tanT = vac ? 0.35 + 1.3 * ex : 0.055 + 1.75 * Math.pow(ex, 1.35);
    // visible length
    const sizeK = vac ? 1 : 0.45 + 0.55 * Math.sqrt(Math.max(mass, 0.05) / 9);
    let L = (vac ? 60 + 900 * ex : 70 + 2400 * Math.pow(ex, 1.6)) * sizeK;

    // ---- supersonic retro-propulsion: jet penetration vs ram pressure
    const exhaustW = _v1.set(0, -1, 0).applyQuaternion(d.quat);
    const vAlong = d.airVel.dot(exhaustW); // >0: vehicle moves along the exhaust (engine-first)
    const q = 0.5 * d.ambientDensity * Math.max(0, vAlong) * Math.max(0, vAlong);
    const J = MERLIN_THRUST * (vac ? 1.1 : mass);
    const standoff = 0.75 * Math.sqrt(J / Math.max(q, 1e-3));
    const retro = smooth(L * 0.7, L * 0.12, standoff) * smooth(40, 120, vAlong);
    const Rn = Math.min(standoff * 0.62 + Rc * 1.5, 400);
    const back = Math.min(Math.max(standoff * 1.2, 8), 60);

    // ---- impingement plane
    let planeDist = Infinity;
    let wall = 0;
    if (d.plane) {
      this.qInv.copy(d.quat).invert();
      const nL = _v2.copy(d.plane.normal).applyQuaternion(this.qInv);
      const pL = _v3.copy(d.plane.point).sub(d.origin).applyQuaternion(this.qInv);
      // axis (0,-a,0) hits plane where dot((0,-a,0) - pL, nL) = 0
      const denom = -nL.y;
      if (denom < -0.2) {
        const aHit = pL.dot(nL) / denom; // axis point (0,-a,0) on the plane: a = -(pL.n)/n.y
        if (aHit > 0) {
          planeDist = aHit;
          wall = d.plane.wall * smooth(L * 1.1, L * 0.35, aHit);
          u.uPlaneN.value.set(nL.x, nL.y, nL.z, wall);
          u.uPlaneP.value.set(0, -aHit, 0, 8 + 22 * Math.sqrt(Math.min(massFrac, 1)));
        }
      }
    }
    if (planeDist === Infinity) {
      u.uPlaneN.value.set(0, 1, 0, 0);
      u.uPlaneP.value.set(0, -1e7, 0, 20);
    }

    // ---- shading parameters
    const flameBright = vac ? 0 : 26 * (1 - 0.8 * smooth(0.2, 2.6, e));
    const flameLen = (vac ? 5 : 22 + 18 * ex) * (0.55 + 0.45 * sizeK) * (1 - 0.6 * retro);
    const soot = vac ? 0 : 0.16 * (1 - smooth(0.4, 2.2, e));
    // scattering column: optical depth through the plume center ~ scat / R  (mass flux / area)
    // (MVac: the vacuum plume is nearly transparent; only a faint sunlit haze survives)
    const scat = (vac ? 1.5 : 150) * smooth(0.5, 2.4, e) * massFrac;
    const coreLen = vac ? MVAC_TUNE.coreLen * (1 + 0.4 * ex) : 4.2 + 10 * ex + 3 * Math.max(0, e);
    const diaSpacing = 1.05 * (1 + 1.4 * Math.max(0, e));
    const diaAmp = vac ? 0 : 1 - smooth(0.5, 1.6, e);
    const coreBright = vac ? MVAC_TUNE.emis : 190 * (1 - 0.35 * smooth(1.5, 4, e));

    u.uEng.value = d.eng.length === 9 ? d.eng : [d.eng[0], 0, 0, 0, 0, 0, 0, 0, 0];
    u.uGreen.value = d.green.length === 9 ? d.green : [d.green[0], 0, 0, 0, 0, 0, 0, 0, 0];
    u.uGeom.value.set(vac ? 0 : F9.s1.engineRingRadius, vac ? F9.s2.mvac.exitRadius : F9.s1.nozzleExitRadius, Rc, tanT);
    // strongly under-expanded: the boundary turns out steeply (initial half-angle capped ~70 deg)
    // then is swept back into a paraboloid (bell / "jellyfish"):
    //   R = Rc + tanT * L * (((a + a0)/L)^p - (a0/L)^p)
    const bellP = 1 - 0.38 * smooth(1.0, 3.2, e);
    const a0 = bellP < 0.999 ? Math.min(L, L * Math.pow(2.75 / (bellP * tanT), 1 / (bellP - 1))) : 0;
    u.uShape.value.set(bellP, L, a0, 0);
    u.uCore.value.set(coreLen, diaSpacing, diaAmp, coreBright * d.flicker);
    u.uFlame.value.set(flameBright * d.flicker, flameLen, soot, scat);
    u.uMisc.value.set(vac ? mass : mass, e, vac ? 1 : 0, L);
    u.uRetro.value.set(retro, standoff, Rn, back);
    u.uSunRad.value.copy(d.sunRad);
    u.uAmbRad.value.copy(d.ambRad);
    this.qInv.copy(d.quat).invert();
    u.uSunLocal.value.copy(this.ctx.lighting.sunDir).applyQuaternion(this.qInv);
    this.baseSteps = (vac ? PLUME_Q.vac : PLUME_Q.march)[quality] ?? (vac ? 20 : 36);
    u.uSteps.value = this.baseSteps;
    this.quality = quality;
    u.uFlick.value = d.flicker;

    // proxy bounds: frustum enclosing the (concave) bell
    const sh = this.shape;
    sh.Rc = Rc; sh.tanT = tanT; sh.L = L; sh.bellP = bellP; sh.a0 = a0;
    const RL = plumeRadiusAt(sh, L);
    // (MVac: nothing upstream of the exit plane -- the long nozzle extension hides it, and haze
    //  there would draw over the bell's outside in the engine cam)
    let x0 = vac ? 0.02 : -0.4, x1 = L, R1 = RL * 1.12 + 3;
    let R0 = Rc + 0.9 + (vac ? 1.2 * ex : 0);
    for (let i = 1; i < 24; i++) {
      const sN = i / 24;
      R0 = Math.max(R0, (plumeRadiusAt(sh, sN * L) * 1.04 + 1 - R1 * sN) / (1 - sN));
    }
    // flame sub-proxy: finely marched separately so a thin bright flame inside a km-sized expanded
    // plume is not undersampled
    const exF = smooth(0.15, 3.4, e);
    const fx1 = Math.min(5.5 * flameLen, L);
    const fSl = 0.055 + 0.16 * exF;
    u.uFlameB.value.set(-0.5, vac ? 0 : fx1, 2.6 * Rc + 1.5, vac ? 0 : 2.6 * (Rc + fSl * fx1) + 1.5);
    // retro flame cushion: the jets are stopped a short way ahead of the engines and the hot,
    // re-compressed exhaust splays back around the engine section and streams aft along the body.
    // (aN nose, Lc flow decay length, Rw radius at the nozzle plane, xb how far aft it reaches)
    const aN = Math.min(Math.max(0.2 * standoff, 2.2), 13);
    const Lc = Math.min(Math.max(0.3 * standoff, 3.5), 22) * (0.6 + 0.4 * Math.sqrt(Math.min(massFrac * 3, 1)));
    const Rw = Math.min(Math.max(0.1 * standoff + Rc * 0.6 + 0.8, Rc + 0.8), 8.5);
    // (aft reach capped well short of the body length: tongues streaming past an onboard camera
    //  converge in perspective into a frame-filling starburst)
    const xb = Math.min(Lc * 2.2, 30);
    u.uRetroB.value.set(aN, Lc, Rw, xb);
    if (retro > 0.02) {
      const shellR = Math.max(Rn * 2.4, Rc + 6);
      if (retro > 0.9) {
        // fully retro: the proxy only has to hold the bow envelope
        x0 = -back - 4;
        x1 = standoff + Rn * 0.6 + 12;
        R0 = Math.max(Rn * 2.2 + 4, Rc + 6);
        R1 = Math.max(Rn * 1.1 + 6, Rc + 6);
      } else {
        x0 = Math.min(x0, -back - 4);
        x1 = Math.max(Math.min(L, standoff + Rn * 0.6 + 12), 10);
        x1 = Math.max(x1, standoff + 12);
        R0 = Math.max(R0, shellR);
        R1 = Math.max(R1 * (1 - retro), shellR);
      }
    }
    if (planeDist < Infinity) {
      x1 = Math.min(x1, planeDist + 1.5);
      if (wall > 0) R1 = Math.max(R1, u.uPlaneP.value.w * 3.2);
      x0 = Math.min(x0, x1 - 1);
    }
    u.uRem.value.set(0, 1, 0, 1);
    if (vac) {
      // Vacuum plume (Simons-type source flow): gas leaves a virtual source just inside the bell,
      // density ~ K f(theta) / (R^2 + R0^2) out to kilometres. f = faint core + fill + a brighter
      // boundary shell at ~50 deg that builds up downstream; R0 = where the exhaust has cooled
      // enough to condense (nothing scatters right at the exit, so the bell stays clear).
      const aS = -1.2 * F9.s2.mvac.exitRadius;
      const V = MVAC_TUNE;
      const thB = V.thB, w = V.w;
      u.uVacA.value.set(V.K * massFrac, V.R0, thB, w);
      u.uVacB.value.set(aS, V.fade, V.shellR, V.core);
      u.uVacC.value.set(V.G, V.condR, V.fill, V.coreW);
      const tMax = Math.tan(thB + 3 * w);
      x0 = 0.02; x1 = MVAC_REACH;
      R0 = Math.max(Rc + 0.5, (x0 - aS) * tMax);
      R1 = (x1 - aS) * tMax;
    }
    u.uBounds.value.set(x0, x1, R0, R1);
    this.boundsBase.copy(u.uBounds.value);
    const fb = u.uFlameB.value as THREE.Vector4;
    if (retro > 0.3) {
      // fine sub-march holds the flame cushion: frustum from xb aft of the nozzles to the nose,
      // enclosing rs(a) = 0.75 Rc + Rw sqrt((aN - a)/aN) (+ turbulent overshoot)
      const cx0 = -xb, cx1 = aN + 1.5;
      const rsA = (a: number) => (0.75 * Rc + Rw * Math.sqrt(Math.max(aN - a, 0) / Math.max(aN, 0.5))) * 1.45 + 1;
      const cR0 = rsA(cx0);
      let cR1 = Rc + 1.5;
      for (let i = 0; i < 16; i++) {
        const sN = (i + 0.5) / 16;
        const a = cx0 + (cx1 - cx0) * sN;
        cR1 = Math.max(cR1, (rsA(a) - cR0 * (1 - sN)) / sN);
      }
      fb.set(cx0, cx1, cR0, cR1);
    } else fb.y = Math.min(fb.y, x1);

    sh.e = e; sh.ex = ex; sh.mass = mass; sh.L = L; sh.Rc = Rc; sh.tanT = tanT; sh.retro = retro;
    sh.standoff = standoff; sh.planeDist = planeDist;
    sh.lumBright = vac ? 0.02 : (1 - 0.7 * smooth(0.3, 3, e));

    this.group.position.copy(d.origin);
    this.group.quaternion.copy(d.quat);

    // glow sprite: total radiant power of core + flame, placed a bit downstream
    const gl = this.glowMat.uniforms;
    const glowPos = vac ? 3 : Math.min(8 + 6 * ex, L * 0.3) * (1 - 0.7 * retro);
    this.glow.position.set(0, -glowPos, 0);
    const pw = vac ? 2 * mass : (coreBright * 0.9 * mass * 0.2 + flameBright * 8) * d.flicker; // ~ radiance*area
    // (MVac: the violet exhaust core plus the ~1300 K radiatively cooled nozzle extension -- from far
    //  away the two merge into one warm point at the head of the plume)
    const col = vac ? _c.setRGB(0.85, 0.52, 0.45) : _c.setRGB(1, 0.62, 0.3);
    const gsum = d.green.reduce((s, x) => Math.max(s, x), 0);
    if (gsum > 0) col.lerp(_c2.setRGB(0.3, 1, 0.35), Math.min(1, gsum));
    gl.uGlow.value.set(col.r * pw, col.g * pw, col.b * pw, vac ? 1.2 : Rc * 1.4 + 1.5);
  }

  // ---- MECO remnant: this volume as a ghost of another plume's expanded shell
  private remBase = { L: 0, a0: 0, Rc: 0, bounds: new THREE.Vector4() };

  /** Take a live plume's current shape, shading and transform as the remnant's starting state. */
  captureFrom(src: PlumeVolume): void {
    const a = this.mat.uniforms, b = src.mat.uniforms;
    for (const k of ['uGeom', 'uCore', 'uFlame', 'uMisc', 'uRetro', 'uRetroB', 'uPlaneN', 'uPlaneP', 'uShape', 'uFlameB', 'uBounds']) {
      (a[k].value as THREE.Vector4).copy(b[k].value as THREE.Vector4);
    }
    Object.assign(this.shape, src.shape);
    const rb = this.remBase;
    rb.L = src.shape.L; rb.a0 = src.shape.a0; rb.Rc = src.shape.Rc;
    rb.bounds.copy(b.uBounds.value as THREE.Vector4);
    this.group.quaternion.copy(src.group.quaternion);
  }

  /**
   * Drive the remnant: the captured shell (no cores, flame or inner jet) grows self-similarly by
   * `grow`, its optical depth is scaled by `dens`, and it lets go of the nozzle up to `detach` m.
   */
  setRemnant(origin: THREE.Vector3, grow: number, dens: number, detach: number, sunRad: THREE.Color, ambRad: THREE.Color, quality: number, fill = 1): void {
    this.active = dens > 1e-3;
    this.group.visible = this.active;
    if (!this.active) return;
    const u = this.mat.uniforms;
    const rb = this.remBase;
    (u.uCore.value as THREE.Vector4).w = 0;
    (u.uFlame.value as THREE.Vector4).x = 0;
    (u.uFlame.value as THREE.Vector4).z = 0;
    (u.uFlameB.value as THREE.Vector4).set(0, 0, 0, 0);
    (u.uShape.value as THREE.Vector4).y = rb.L * grow;
    (u.uShape.value as THREE.Vector4).z = rb.a0 * grow;
    (u.uMisc.value as THREE.Vector4).w = rb.L * grow;
    (u.uGeom.value as THREE.Vector4).z = rb.Rc * grow;
    (u.uBounds.value as THREE.Vector4).copy(rb.bounds).multiplyScalar(grow);
    this.boundsBase.copy(u.uBounds.value);
    (u.uRem.value as THREE.Vector4).set(1, dens, detach, fill);
    u.uSunRad.value.copy(sunRad);
    u.uAmbRad.value.copy(ambRad);
    this.qInv.copy(this.group.quaternion).invert();
    u.uSunLocal.value.copy(this.ctx.lighting.sunDir).applyQuaternion(this.qInv);
    this.baseSteps = PLUME_Q.march[quality] ?? 36;
    u.uSteps.value = this.baseSteps;
    this.quality = quality;
    this.group.position.copy(origin);
    const sh = this.shape;
    sh.L = rb.L * grow; sh.Rc = rb.Rc * grow; sh.a0 = rb.a0 * grow; sh.lumBright = 0; sh.mass = 0;
    this.glow.visible = false;
  }

  /** Per view: camera in local space, inside/outside handling. */
  prepareView(view: ViewInfo): void {
    if (!this.active) return;
    const u = this.mat.uniforms;
    this.qInv.copy(this.group.quaternion).invert();
    const cl = u.uCamLocal.value as THREE.Vector3;
    cl.copy(view.camWorldPos).sub(this.group.position).applyQuaternion(this.qInv);
    // far field: soft, translucent shells (see PLUME_FAR); the proxy widens to hold the softened edge
    const dist = cl.length();
    const pxPerM = (view.rect.h || 1000) / (2 * Math.tan((view.camera.fov * Math.PI) / 360) * Math.max(dist, 1));
    const rem = (u.uRem.value as THREE.Vector4).x > 0.5;
    const farK = this.kind === 'mvac' || rem ? smooth(rem ? PLUME_FAR.remMpp0 : PLUME_FAR.mpp0, rem ? PLUME_FAR.remMpp1 : PLUME_FAR.mpp1, 1 / Math.max(pxPerM, 1e-9)) : 0;
    u.uFar.value = farK;
    const b = (u.uBounds.value as THREE.Vector4).copy(this.boundsBase);
    const wR = 1 + farK * (rem ? PLUME_FAR.remR : this.kind === 'mvac' ? PLUME_FAR.vacR : 0);
    b.z *= wR; b.w *= wR;
    if (rem) { b.y *= 1 + farK * PLUME_FAR.remX; b.w *= 1 + farK * PLUME_FAR.remX * 0.6; }
    const a = -cl.y;
    const near = view.camera.near * 3 + 0.5;
    const R = b.z + ((b.w - b.z) * (a - b.x)) / Math.max(b.y - b.x, 1e-3);
    this.camInside = a > b.x - near && a < b.y + near && Math.hypot(cl.x, cl.z) < R + near;
    // glow fade: hide when the plume is comfortably resolved on screen
    const sizePx = (b.w + this.shape.L * 0.3) * pxPerM;
    // (far field: the MVac's warm point stays -- a faint orange core at the head of the soft shell)
    this.glowMat.uniforms.uFade.value = Math.max(1 - smooth(6, 40, sizePx), this.kind === 'mvac' ? 0.7 * farK : 0);
    // big on screen -> march at half resolution (the plume is soft; cost ~ covered pixels x steps)
    const cov = this.camInside ? 1 : this.coverage(view, cl, b);
    this.cov = cov;
    this.mesh.material = cov > (PLUME_Q.lowres[this.quality] ?? 0.15) ? this.compMat : this.mat;
    // (third-res once it fills much of the view: soft, and the cost is ~ covered pixels x steps)
    // (far fill: a frame-filling far plume -- the long lens end-on up the plume -- is smooth at that
    //  scale. Only from outside the proxy (inside it the flame and nozzles are close by) and while the
    //  nozzle region is small on screen (< fillPxPerM px/m): the pad engine, pad wide and max-Q chase
    //  views also fill the frame from outside, but show the flame up close)
    this.pxPerM = pxPerM;
    // (flame-free volumes gate looser: the MECO remnant never, the MVac (clear near field) at 4x)
    const pxMax = rem ? Infinity : PLUME_Q.fillPxPerM * (this.kind === 'mvac' ? 4 : 1);
    const fill = !this.camInside && pxPerM < pxMax && cov > (PLUME_Q.fill[this.quality] ?? 9);
    this.lowF = cov > (PLUME_Q.third[this.quality] ?? 9) ? (fill ? PLUME_Q.fillF : 3) : 2;
    // (and fewer samples along the ray: the dither is blurred over 3x3 / 4x4 px; the march cost there
    //  is sample-bound -- scattered noise taps -- more than pixel-bound)
    u.uSteps.value = fill ? Math.max(8, Math.round(this.baseSteps * PLUME_Q.fillSteps)) : this.baseSteps;
  }

  /** rough fraction of the view covered by the proxy (capsule around the axis segment) */
  private coverage(view: ViewInfo, cl: THREE.Vector3, b: THREE.Vector4): number {
    const d0 = _v1.set(-cl.x, -b.x - cl.y, -cl.z);
    const d1 = _v2.set(-cl.x, -b.y - cl.y, -cl.z);
    const l0 = Math.max(d0.length(), 1), l1 = Math.max(d1.length(), 1);
    const th = Math.acos(Math.min(1, Math.max(-1, d0.dot(d1) / (l0 * l1))));
    const r0 = Math.atan(b.z / l0), r1 = Math.atan(b.w / l1);
    const h = Math.max(view.rect.h, 1), w = Math.max(view.rect.w, 1);
    const k = (h * 0.5) / Math.tan((view.camera.fov * Math.PI) / 360); // px per radian
    const rm = Math.max(r0, r1) * k;
    const area = th * k * (r0 + r1) * k + Math.PI * rm * rm;
    return Math.min(1, area / (w * h));
  }

  /** half-res march into the shared low target (nested render, called from the proxy's onBeforeRender) */
  private renderLow(r: THREE.WebGLRenderer, cam: THREE.Camera, side: THREE.Side): void {
    r.getCurrentViewport(_vp4);
    const f = this.lowF;
    const lw = Math.max(1, Math.ceil(_vp4.z / f)), lh = Math.max(1, Math.ceil(_vp4.w / f));
    const rt = lowTarget(lw, lh);
    rt.viewport.set(0, 0, lw, lh);
    rt.scissor.set(0, 0, lw, lh);
    rt.scissorTest = false;
    this.lowMesh.matrixWorld.copy(this.mesh.matrixWorld);
    this.lowMat.side = side;
    const prevRT = r.getRenderTarget();
    const prevAC = r.autoClear;
    r.getClearColor(_cc);
    const prevCA = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    // glClear honours the colour write mask, which the last outer draw may have left off
    // (env.cloudsDepth is colorWrite: false): without this the target keeps stale frames
    r.state.buffers.color.setMask(true);
    r.clear(true, false, false);
    r.autoClear = false;
    const viewH = vfxShared.uViewH.value;
    try {
      r.render(this.lowScene, cam);
    } finally {
      vfxShared.uViewH.value = viewH; // (refreshSharedForDraw saw the low viewport)
      r.autoClear = prevAC;
      r.setClearColor(_cc, prevCA);
      r.setRenderTarget(prevRT);
    }
    const cu = this.compMat.uniforms;
    cu.uLow.value = rt.texture;
    (cu.uLowSize.value as THREE.Vector2).set(lw, lh);
    (cu.uLowTexel.value as THREE.Vector2).set(1 / rt.width, 1 / rt.height);
    this.mat.uniforms.uLowF.value = f;
  }

  /** distance from a W point to the visible plume axis segment (for particle/plume ordering) */
  distanceToAxis(p: THREE.Vector3): number {
    if (!this.active) return Infinity;
    const b = this.mat.uniforms.uBounds.value as THREE.Vector4;
    const len = Math.max(0, Math.min(this.shape.planeDist, b.y));
    const ax = _v1.set(0, -1, 0).applyQuaternion(this.group.quaternion);
    const rel = _v2.copy(p).sub(this.group.position);
    const a = Math.max(0, Math.min(len, rel.dot(ax)));
    return rel.addScaledVector(ax, -a).length();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.lowMat.dispose();
    this.compMat.dispose();
    this.glow.geometry.dispose();
    this.glowMat.dispose();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _cc = new THREE.Color();
const _vp4 = new THREE.Vector4();
/** MVac scattering constant (optical depth ~ K / impact distance) and proxy reach (m) */
/** MVac vacuum-plume look (see vacF): K optical-depth scale, R0 clear radius at the exit (m),
 *  boundary angle / shell half-width (rad), far fade (m), shell build-up radius (m), core weight,
 *  far-field condensate gain G and its ramp radius (m), interior fill weight, core half-width (rad);
 *  emissive exit core: brightness, e-folding length (m) */
export const MVAC_TUNE = {
  K: 1.5, R0: 8, thB: 0.4, w: 0.06, fade: 2500, shellR: 25, core: 0.35, G: 20, condR: 1500, fill: 0.05, coreW: 0.3,
  emis: 0.01, coreLen: 1.6,
};
const MVAC_REACH = 4000;
/** per quality level (0 low .. 3 ultra): Merlin outer-march samples, MVac samples (importance-sampled:
 *  far fewer), the view fraction above which a plume is marched at half resolution, above which at
 *  third res, and above which it is a "far fill" (camera outside the proxy: fewer samples, fillF) */
const PLUME_Q = {
  march: [16, 24, 36, 52],
  vac: [10, 14, 20, 28],
  lowres: [0.03, 0.1, 0.18, 0.4],
  third: [0.15, 0.3, 0.45, 9],
  fill: [0.6, 0.8, 0.95, 9],
  /** "far fill" (proxy fills the view, camera outside it): low-res factor and march-sample factor */
  fillF: 4,
  fillSteps: 0.67,
  /** far fill only below this on-screen scale at the nozzle (px/m; MVac 4x, remnant: any) */
  fillPxPerM: 2,
};

/** Far field of the flame-free shells (MVac, MECO remnant) seen from a distant site (the twilight coast
 *  shot at ~200 km, ~100 m per pixel): the membranes are tens of metres thick, so they drew as hard,
 *  opaque cut-outs. Blend in (uFar: metres per pixel mpp0 -> mpp1; remnant remMpp0 -> remMpp1) a wider, softer, more translucent
 *  shell with a tapered far end; the proxy radius grows by remR / vacR (the remnant's length by remX) to hold it. */
const PLUME_FAR = { mpp0: 25, mpp1: 100, remMpp0: 10, remMpp1: 60, remR: 0.45, remX: 0.5, vacR: 0.8 };

const FRUSTUM_GLSL = /* glsl */ `
// ray vs the proxy frustum (x0..x1 along the exhaust, radii R0..R1) -> (tEnter, tExit)
vec2 frustumHit(vec3 ro, vec3 rd, vec4 bb) {
  float x0 = bb.x, x1 = bb.y, R0 = bb.z, R1 = bb.w;
  float oa = -ro.y, da = -rd.y;
  float tA0 = -1e9, tA1 = 1e9;
  if (abs(da) < 1e-6) { if (oa < x0 || oa > x1) return vec2(1.0, -1.0); }
  else { float ta = (x0 - oa) / da, tb = (x1 - oa) / da; tA0 = min(ta, tb); tA1 = max(ta, tb); }
  float k = (R1 - R0) / max(x1 - x0, 1e-3);
  float m = R0 + k * (oa - x0);
  float n = k * da;
  float A = rd.x * rd.x + rd.z * rd.z - n * n;
  float B = 2.0 * (ro.x * rd.x + ro.z * rd.z) - 2.0 * m * n;
  float C = ro.x * ro.x + ro.z * ro.z - m * m;
  float tc0 = -1e9, tc1 = 1e9;
  if (abs(A) > 1e-7) {
    float disc = B * B - 4.0 * A * C;
    if (A > 0.0) {
      if (disc < 0.0) return vec2(1.0, -1.0);
      float sq = sqrt(disc);
      tc0 = (-B - sq) / (2.0 * A); tc1 = (-B + sq) / (2.0 * A);
    }
  } else if (abs(B) > 1e-7) {
    float tl = -C / B;
    if (B > 0.0) tc1 = tl; else tc0 = tl;
  }
  return vec2(max(tA0, tc0), min(tA1, tc1));
}
`;

const PLUME_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec4 uBounds;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  float t = position.y;
  float a = mix(uBounds.x, uBounds.y, t);
  float R = mix(uBounds.z, uBounds.w, t) * 1.0049; // circumscribe the 32-gon
  vec3 lp = vec3(position.x * R, -a, position.z * R);
  vLocal = lp;
  vec4 mv = modelViewMatrix * vec4(lp, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const PLUME_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${DEPTH_GLSL}
${NOISE_GLSL}
${COLOR_GLSL}
${AERIAL_GLSL}
uniform vec3 uCamLocal;
uniform vec4 uBounds;
uniform float uEng[9];
uniform float uGreen[9];
uniform vec4 uGeom;   // ringR, nozR, clusterR, tanTheta
uniform vec4 uCore;   // coreLen, diamond spacing, diamond amp, core brightness
uniform vec4 uFlame;  // flame brightness, flame length, soot, scatter
uniform vec4 uMisc;   // mass, e, vac, L
uniform vec4 uRetro;  // strength, standoff, nose radius, back length
uniform vec4 uRetroB; // cushion: nose a, flow decay length, radius at the nozzle plane, aft reach
uniform vec4 uPlaneN; // plane normal (local), wall strength
uniform vec4 uPlaneP; // axis hit point (local), wall radius
uniform vec3 uSunLocal;
uniform vec3 uSunRad;
uniform vec3 uAmbRad;
uniform float uTime;
uniform float uSteps;
uniform float uLowF;
uniform float uFlick;
uniform vec4 uShape;
uniform vec4 uFlameB;
uniform vec4 uVacA;
uniform vec4 uVacB;
uniform vec4 uVacC;
uniform vec4 uRem;
uniform float uFar;
varying vec3 vLocal;
varying vec3 vView;

${FRUSTUM_GLSL}
// engine index k (0 = center, 1..8 ring at (k-1)*45 deg) -> nozzle center (local xz)
vec2 enginePos(int k) {
  if (k == 0) return vec2(0.0);
  float a = float(k - 1) * 0.785398;
  return vec2(cos(a), sin(a)) * uGeom.x;
}

// radius of the merged plume at axial distance a
float plumeR(float a) {
  float L = uShape.y;
  float x = clamp(a, 0.0, 4.0 * L);
  return uGeom.z + uGeom.w * L * (pow((x + uShape.z) / L, uShape.x) - pow(uShape.z / L, uShape.x));
}
float flameSlope() { return 0.055 + 0.16 * smoothstep(0.15, 3.4, uMisc.y); }
float flameR(float a) {
  return uGeom.z + flameSlope() * max(a, 0.0);
}
// Ray parameter of march fraction x over [f0, f1] for a cone of radius R0 + slope * max(a, 0):
// blends a uniform spacing with one uniform in s(a) = integral da / R(a) (spacing ~ local cone
// radius; constant R0 upstream of the exit plane), so along oblique rays the narrow root of the
// cone gets as many samples as its wide end. (A0 = a at f0, kA = da/dt, s0/s1 = s at the ends,
// w = blend weight toward the warped spacing)
float coneS(float a, float R0, float slope) { return a < 0.0 ? a / R0 : log(1.0 + slope * a / R0) / slope; }
float coneMarchT(float x, float f0, float f1, float A0, float kA, float s0, float s1, float R0, float slope, float w) {
  float tu = mix(f0, f1, x);
  if (w <= 0.0) return tu;
  float s = mix(s0, s1, x);
  float ag = s < 0.0 ? s * R0 : R0 * (exp(slope * s) - 1.0) / slope;
  float tg = clamp(f0 + (ag - A0) / kA, min(f0, f1), max(f0, f1));
  return mix(tu, tg, w);
}

const mat3 NOISE_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Emission (rgb radiance per meter), extinction, scattering coefficient at local point p.
// mode 0: everything, 1: everything but the luminous flame, 2: flame only
void field(vec3 p, int mode, out vec3 em, out float sigT, out float sigS) {
  em = vec3(0.0); sigT = 0.0; sigS = 0.0;
  float a = -p.y;
  vec2 q = p.xz;
  float r = length(q);
  float vac = uMisc.z;
  float mass = uMisc.x;
  float massF = vac > 0.5 ? mass : mass / 9.0;
  float e = uMisc.y;
  float L = uMisc.w;
  // impingement plane clip (height above plane along its normal)
  float hp = dot(p - uPlaneP.xyz, uPlaneN.xyz);
  float clip = smoothstep(-0.3, 0.6, hp);
  if (clip <= 0.0) return;
  float R = plumeR(a);
  float rn = r / R;
  float retro = uRetro.x;

  // turbulence: self-similar, scales with the local plume radius, streams downstream
  // (skipped when the plume is fully in retro-propulsion: nothing below uses it then)
  float turb = 0.5, tb = 0.0, turbF = 0.5, tbF = 0.0;
  float Rf = flameR(a);
  if (retro < 0.999) {
    float speed = mix(260.0, 900.0, clamp(e * 0.3, 0.0, 1.0));
    // (flame turbulence scales with the flame radius, the expanded plume's with the bell radius)
    // (the flame's eddies are stretched far along the flow: at 260+ m/s any exposure smears them
    //  into streaks; the lookup is rotated off the noise texture's lattice)
    float Rt = mode == 2 ? Rf : R;
    vec3 nc = NOISE_ROT * vec3(q / (Rt * 1.3), (a - uTime * speed) / (Rt * (mode == 2 ? 7.5 : 3.2)) + uTime * 0.15);
    float n1 = n3(nc * 0.5);
    float n2 = n3(nc * 1.37 + vec3(0.31, 0.77, 0.13));
    turb = n1 * 0.65 + n2 * 0.35;           // ~0.5 mean
    tb = (turb - 0.5) * 2.0;
    turbF = turb; tbF = tb;
    if (mode == 0 && R > Rf * 1.5 && uFlame.x > 0.01) {
      vec3 nf = NOISE_ROT * vec3(q / (Rf * 1.3), (a - uTime * speed) / (Rf * 7.5) + uTime * 0.15);
      turbF = n3(nf * 0.5) * 0.65 + n3(nf * 1.37 + vec3(0.31, 0.77, 0.13)) * 0.35;
      tbF = (turbF - 0.5) * 2.0;
    }
  }

  // ----- afterburning RP-1 flame + soot (Merlin, sea level -> fades with altitude)
  if (mode != 1 && vac < 0.5 && uFlame.x > 0.01 && a > -0.5 && retro < 0.999) {
    // the luminous core does not follow the (huge) expanded-plume spread at altitude
    // (only a small edge wobble: a larger one turned the column seen side-on from the tower into
    //  regularly spaced horizontal bands; the flame's real turbulence shows downstream, in the smoke)
    float edge = (r / Rf) * (1.0 + 0.14 * tbF * smoothstep(1.0, 8.0, a));
    float prof = exp(-edge * edge * 1.35);
    float grow = smoothstep(-0.3, 1.2, a);
    float flen = uFlame.y;
    // bright incandescent column right from the exit, long turbulent tail
    float along = exp(-a / flen) * 0.75 + 0.25 * exp(-a / (flen * 2.6));
    float fl = uFlame.x * massF * grow * along * prof * (0.55 + 0.9 * turbF) * (1.0 - retro);
    // near field: nine separate afterburning jets (shear layers around each core) that merge into
    // one flame a few meters out
    float nearK = 1.0 - smoothstep(1.0, 7.0, a);
    if (nearK > 0.01 && vac < 0.5) {
      float re = uGeom.y * (1.05 + 0.2 * max(a, 0.0));
      float m = 0.0;
      for (int k = 0; k < 9; k++) {
        if (uEng[k] < 0.01) continue;
        vec2 dd = q - enginePos(k);
        float d2 = dot(dd, dd) / (re * re);
        // hollow-ish: brightest in the shear layer around each core
        m = max(m, uEng[k] * exp(-d2 * 0.9) * (0.55 + 0.45 * smoothstep(0.05, 0.6, d2)));
      }
      fl *= mix(1.0, m * 1.5 / max(prof, 0.25), nearK);
    }
    float T = mix(2550.0, 1750.0, clamp(a / (flen * 2.4), 0.0, 1.0)) - 300.0 * clamp(edge - 0.45, 0.0, 1.0);
    float gr = 0.0;
    for (int k = 0; k < 9; k++) gr = max(gr, uGreen[k]);
    vec3 fcol = blackbody(T) * flameRadiance(T) * 2.2;
    fcol = mix(fcol, vec3(0.25, 1.0, 0.35) * 0.8, gr);
    em += fcol * fl;
    sigT += fl * 0.012;
    // soot: dark turbulent fringe + gas-generator exhaust streaks near the nozzles
    float fringe = smoothstep(0.55, 1.05, edge) * exp(-pow(max(edge - 1.05, 0.0) * 2.5, 2.0));
    float soot = uFlame.z * massF * fringe * smoothstep(2.0, 12.0, a) * exp(-a / (flen * 1.5)) * (0.4 + 1.2 * turbF);
    // GG exhaust: 8 thin dark streams just outside the ring, dissolving within a few meters
    float ang = atan(q.y, q.x) - 0.3927;
    float kk = floor(ang / 0.785398 + 0.5);
    vec2 gp = vec2(cos(kk * 0.785398 + 0.3927), sin(kk * 0.785398 + 0.3927)) * (uGeom.x + uGeom.y + 0.35);
    float gd = length(q - gp);
    float ggR = 0.18 + a * 0.07;
    float gg = exp(-gd * gd / (ggR * ggR)) * smoothstep(-0.2, 0.5, a) * exp(-a / 7.0) * uFlame.z * 4.0 * (0.6 + 0.8 * turbF);
    sigT += (soot * 0.6 + gg * massF) * (1.0 - retro);
    sigS += soot * 0.4 * (1.0 - retro);
    em += vec3(1.0, 0.35, 0.08) * gg * 3.0 * smoothstep(1.5, 4.0, a) * massF * (1.0 - retro); // entrained GG gas ignites
  }

  // ----- expanded plume: scattering (condensed exhaust / soot) + faint self-luminosity
  if (mode != 2 && uFlame.w > 0.0 && retro < 0.999) {
    // column density ~ mass per length / area. Two parts: the inner jet (most of the mass, moderate
    // spread) and, at high expansion, the bell: exhaust piled up in a thin shell behind the plume
    // boundary (limb-brightened "jellyfish" membrane) with a faint fill and radial streamers.
    // (the shell is the plume/atmosphere interaction layer: gone in near-vacuum)
    float shellK = smoothstep(1.2, 3.5, e) * (1.0 - smoothstep(4.6, 6.2, e));
    float Rc2 = uGeom.z * uGeom.z;
    float tanIn = 0.055 + 0.32 * smoothstep(0.5, 3.4, e);
    float Rin = min(uGeom.z + tanIn * max(a, 0.0), R * 0.8);
    float tsm = smoothstep(1.5, 3.5, e);   // the expanded plume is smooth / laminar
    float edgeI = (r / Rin) * (1.0 + 0.3 * tb * (1.0 - 0.5 * tsm));
    float inner = exp(-edgeI * edgeI * 1.6) / (Rin * Rin + 4.0 * Rc2);
    float start = smoothstep(vac > 0.5 ? 0.0 : -0.2, uGeom.z * 2.0, a);
    // bell
    float edgeO = rn * (1.0 + 0.06 * tb);
    vec2 dir = q / max(r, 1e-3);
    float lg = log2(max(a, 1.0) + 8.0);
    float stre = n3(vec3(dir * 1.9, lg * 0.35 - uTime * 0.02)) * 0.6 + n3(vec3(dir * 4.3 + 2.0, lg * 0.7)) * 0.4;
    float streak = 0.35 + 1.3 * smoothstep(0.35, 0.75, stre);
    // (far field: a wider, fainter membrane -- soft-edged and translucent at ~100 m per pixel)
    float shw = (0.11 + 0.06 * stre) * (1.0 + 1.3 * uFar);
    float shell = exp(-pow((edgeO - 0.9) / shw, 2.0)) / (1.0 + 0.9 * uFar);
    // (MECO remnant: fine radial striations in the condensed shell. A long lens from the ground sees
    //  a ~km patch of the km-sized shell, which the plume-scale streamers alone left flat grey)
    // (far field: faded out -- a few px apart they only alias into hair; at half contrast the twilight
    //  coast shot still drew the remnant as a hairy white leaf instead of a soft sunlit dome)
    if (uRem.x > 0.5) shell *= mix(0.25 + 1.6 * smoothstep(0.3, 0.72, n3(vec3(dir * 6.5 + 3.1, lg * 1.4 + 0.6))), 1.0, uFar);
    // (the faint interior fill only builds up well downstream: near the vehicle the bell is still
    //  narrow, so a 1/R^2 fill there turned a camera sitting inside it (chase at 60 km) into fog;
    //  the membrane stays clear through the middle, tau ~0.05-0.2 end-on)
    float fill = exp(-edgeO * edgeO * 1.2) * (1.0 - smoothstep(0.85, 1.0, edgeO)) * streak
               * smoothstep(0.04 * L, 0.35 * L, a);
    float bellStart = smoothstep(-0.2, uGeom.z * 6.0 + 0.02 * L, a);
    // (the membrane builds up downstream: near the nozzle the boundary is a nearly flat, thin front
    //  that would otherwise read as an opaque veil around the vehicle)
    float memStart = smoothstep(0.0, uGeom.z * 6.0 + 0.12 * L, a);
    // (MECO remnant: uRem.w empties the interior fill into the shell)
    //  From far away a faint translucent interior stays (the dispersing inner jet), lit through the shell)
    //  and the column falls off slower than 1/R^2 (as at R = 0.6 L): the outer bell -- most of its
    //  size -- glows faintly instead of the bright inner half reading as a small, hard lens)
    float den = 0.5 * R * R + 16.0 * Rc2;
    float fR = uFar * uRem.x;
    if (fR > 0.0) den = mix(den, pow(den, 0.6) * pow(0.18 * L * L + 16.0 * Rc2, 0.4), fR);
    float bell = (shell * 1.1 * memStart + fill * 0.08 * max(uRem.w, 3.0 * fR)) / den * bellStart * shellK;
    // (inner jet: optical depth ~ kIn*K*1.4/Rin -> about 1 a few nozzle radii out, translucent beyond;
    //  the bell carries the full scattering constant so the km-sized membrane stays visible)
    float kIn = (vac > 0.5 ? 0.04 : 0.08) * (1.0 - uRem.x);
    float s = uFlame.w * start * (kIn * (1.0 - 0.55 * shellK) * inner * mix(0.45 + 1.1 * turb, 0.75 + 0.5 * turb, tsm) + bell);
    // (far-field remnant: the bell fades out over a longer reach -- past L, see PLUME_FAR.remX -- so
    //  its outer half, most of its size, glows faintly and the rim has no hard edge)
    s *= (1.0 - retro) * smoothstep(L * (1.0 + 0.5 * fR), L * mix(0.45, 0.5, fR), a);
    // (MECO remnant: the shell left behind thins out and lets go of the (departed) nozzle first)
    s *= mix(1.0, uRem.y * smoothstep(uRem.z, uRem.z * 1.4 + 1.0, a), uRem.x);
    sigS += s;
    // faint luminous exhaust (hot CO2/H2O/soot) close to the engines
    vec3 gcol = vac > 0.5 ? vec3(0.55, 0.45, 1.0) : vec3(1.0, 0.6, 0.35);
    // (MVac: a faint bluish-violet translucent cone, independent of the (tiny) scattering)
    em += vac > 0.5
      ? gcol * 0.3 * mass * start * inner * exp(-a / (uGeom.z * 2.0 + 4.0)) * uFlick
      : gcol * uFlame.w * start * inner * 0.9 * exp(-a / (uGeom.z * 5.0 + 10.0)) * uFlick * (1.0 - retro) * (1.0 - uRem.x);
  }

  // ----- supersonic retro-propulsion (entry burn, start of the landing burn)
  if (retro > 0.001) {
    float xs = uRetro.y, Rn = uRetro.z, back = uRetro.w;
    vec2 dir = q / max(r, 1e-3);
    float thinK = smoothstep(0.8, 3.6, e);        // 0 dense air .. 1 near vacuum
    if (mode != 1) {
      // (a) flame cushion: the jets are stopped just ahead of the engines; the re-compressed hot
      //     exhaust splays out around the engine section and streams aft along the body in
      //     turbulent tongues that cool, thin out and break up with flow distance.
      float aN = uRetroB.x, Lc = uRetroB.y, Rw = uRetroB.z, xb = uRetroB.w;
      float s = aN - a;                           // flow distance from the cushion nose
      if (s > -1.0 && s < xb + aN + 2.0) {
        float sp = max(s, 0.0);
        float rs = uGeom.z * 0.75 + Rw * sqrt(sp / max(aN, 0.5));
        float fl = sp - uTime * 140.0;            // streams aft
        float nA = n3(vec3(dir * 0.3, fl / 60.0 + uTime * 0.21));
        float nB = n3(vec3(dir * 1.25 + 1.7, fl / 34.0 + r / 30.0)); // flow-aligned streaks
        // (billow scale ~2 m: the sub-march steps ~1 m through the cushion, and the old 0.6 m cells
        //  aliased into a regular IGN dot mesh over the whole bright fan at 4K)
        float nC = n3(vec3(q / 7.2 + 0.3, fl / 16.0 + uTime * 0.9));
        // (flow-aligned streaks kept secondary: billowy breakup reads less like a radial starburst)
        float tt = nA * 0.5 + nB * 0.2 + nC * 0.3;
        float u = sp / Lc;
        float edge = r / (rs * (0.7 + 0.65 * tt));
        float prof = smoothstep(1.0, 0.4, edge);
        float thr = mix(0.26, 0.62, clamp(u / 3.2, 0.0, 1.0));
        float tongue = smoothstep(thr, thr + 0.12, tt);
        float dens = prof * tongue * exp(-u * 1.0) * smoothstep(-1.0, 0.8, s) * smoothstep(xb + aN, (xb + aN) * 0.55, sp);
        float T = mix(2450.0, 1450.0, clamp(u / 2.6, 0.0, 1.0)) * (0.93 + 0.14 * nC);
        vec3 col = blackbody(T) * flameRadiance(T) * 2.0;
        em += col * dens * 13.0 * massF * mix(1.0, 0.75, thinK) * retro;
        // soot + condensed exhaust: slightly smoky tongues aft, sunlit
        float smoke = prof * tongue * exp(-u * 0.45) * smoothstep(-1.0, 0.8, s) * smoothstep(xb + aN, (xb + aN) * 0.55, sp);
        sigT += (dens * 0.03 + smoke * 0.012) * massF * retro;
        sigS += smoke * 0.02 * massF * retro;
      }
    }
    if (mode != 2) {
      // (b) bow envelope: the plume/free-stream interface at the standoff distance, wrapping back
      //     past the booster. Large, smooth and faint: mostly scattered sunlight + a dull glow
      //     from the hot stagnation region at its nose.
      float ab = xs - r * r / (2.0 * Rn);
      float ds = a - ab;
      float th = 0.2 * Rn + 0.05 * r + 0.5;
      float nE = n3(vec3(dir * 0.45, (a - uTime * 45.0) / (Rn * 1.6) + uTime * 0.04));
      float nF = n3(vec3(dir * 1.3 + 3.0, (r + uTime * 30.0) / (Rn * 0.7)));
      float wob = 0.7 + 0.8 * nE;
      float shell = exp(-ds * ds / (th * th * wob)) * smoothstep(-back, -back * 0.25, a)
                  * (1.0 - smoothstep(Rn * 1.2, Rn * 2.0, r));
      float streak = 0.4 + 1.2 * smoothstep(0.3, 0.72, nF);
      float fill = smoothstep(th, -th * 2.0, ds) * smoothstep(-back * 0.5, xs * 0.5, a) * (1.0 - smoothstep(Rn * 1.2, Rn * 2.2, r));
      float env = shell * streak;
      float hot = exp(-r / (Rn * 0.6));
      float T = mix(1300.0, 1850.0, hot);
      vec3 col = blackbody(T) * flameRadiance(T) * 2.0;
      em += col * env * (0.25 + 0.75 * hot) * 0.5 * massF * mix(1.0, 0.6, thinK) * retro;
      sigS += (env * 0.3 + fill * 0.06) / (Rn + 5.0) * massF * smoothstep(0.5, 2.5, e) * retro;
      sigT += env * 0.002 * massF * retro;
    }
  }

  // ----- impingement wall jet (flame sheet racing across the deck)
  if (mode != 2 && uPlaneN.w > 0.001) {
    vec3 rel = p - uPlaneP.xyz;
    float h = dot(rel, uPlaneN.xyz);
    vec3 inPl = rel - uPlaneN.xyz * h;
    float rho = length(inPl);
    float Rw = uPlaneP.w;
    float hw = 0.6 + 0.09 * rho;
    float ang = atan(inPl.z, inPl.x);
    float streak = n3(vec3(ang * 1.2, rho / 9.0 - uTime * 7.0, h * 0.1 + uTime * 0.3));
    float st = n3(vec3(ang * 3.1 + 5.0, rho / 4.0 - uTime * 11.0, 0.5));
    float wj = exp(-pow(max(h, 0.0) / hw, 2.0)) * exp(-rho / Rw) * (0.25 + 1.6 * streak * st) * smoothstep(-0.2, 0.5, h);
    wj *= uPlaneN.w;
    float T = mix(2300.0, 1400.0, clamp(rho / (Rw * 1.5), 0.0, 1.0));
    em += blackbody(T) * flameRadiance(T) * 2.0 * wj * 22.0 * massF;
    sigT += wj * 0.08;
    // stagnation fireball right at the impact point
    float stag = exp(-dot(rel, rel) / (4.0 + uGeom.z * uGeom.z * 4.0)) * uPlaneN.w;
    em += blackbody(2600.0) * flameRadiance(2600.0) * 2.0 * stag * 40.0 * massF;
  }
  float endF = smoothstep(uBounds.y, uBounds.y * 0.72, a);
  if (mode == 2 && retro < 0.3) endF *= smoothstep(uFlameB.y, uFlameB.y * 0.6, a);
  em *= clip * endF;
  sigT *= clip * endF;
  sigS *= clip * endF;
}

#ifdef PLUME_MVAC
// ----- MVac vacuum plume. Optical-depth density K F(theta, R) / (R^2 + R0^2) around a virtual source on
// the axis (R: distance from it, theta: angle off the exhaust axis). Equi-angular sampling about the
// source with the softened impact distance B = sqrt(b^2 + R0^2) importance-samples the radial falloff
// exactly (sigma dt = K F dphi / B), so a handful of samples resolves the near field and a km-long
// plume alike. F: faint core + fill, a brighter boundary shell that builds up downstream (the
// limb-brightened "jellyfish" membrane), faint wings outside; radial streamers; nothing within ~R0 of
// the exit (the exhaust has not condensed yet), so the bell stays clear.
float vacF(vec3 d, float R) {
  float th = acos(clamp(-d.y / R, -1.0, 1.0));
  vec2 dir = d.xz / max(length(d.xz), 1e-4);
  float lg = log2(R + 8.0);
  float n1 = n3(vec3(dir * 1.9, lg * 0.35 - uTime * 0.02));
  float n2 = uSteps > 12.0 ? n3(vec3(dir * 4.3 + 2.0, lg * 0.7 + 0.37)) : 0.5;
  float stre = n1 * 0.6 + n2 * 0.4;
  // (streamers keep most of their contrast far downstream: end-on from the ground the far field
  //  fills the frame and read as flat grey fog with the old 50 % fade)
  float streak = mix(1.0, 0.4 + 1.2 * smoothstep(0.32, 0.74, stre), smoothstep(0.03, 0.3, th) * (1.0 - 0.2 * smoothstep(200.0, 2000.0, R)));
  // (boundary rippled by the streamers, swept slightly back far downstream)
  float thB = uVacA.z * (1.0 + 0.08 * (stre - 0.5)) * (1.0 - 0.1 * smoothstep(400.0, 2500.0, R));
  // (far field: wider, fainter boundary shell)
  float x = (th - thB) / (uVacA.w * (0.75 + 0.6 * n2) * (1.0 + 1.6 * uFar));
  float inside = 1.0 - smoothstep(-1.0, 0.6, x);
  float shell = exp(-x * x) * smoothstep(0.1 * uVacB.z, uVacB.z, R) / (1.0 + 0.8 * uFar);
  float tc = th / uVacC.w;
  float core = exp(-tc * tc);
  float fill = uVacC.z * smoothstep(0.05, thB, th) * inside;
  float wing = 0.25 * uVacC.z * exp(-max(x, 0.0) * 0.7) * (1.0 - inside);
  float F = uVacB.w * core + (fill + wing + shell) * streak;
  // condensate builds up as the flow cools: clear at the exit, x(1 + G) by ~a km
  float cond = smoothstep(0.2 * uVacA.y, 1.3 * uVacA.y, R) * (1.0 + uVacC.x * smoothstep(0.0, uVacC.y, R));
  // (far field: taper toward the proxy's far end instead of the cut at MVAC_REACH)
  return F * cond * exp(-R / uVacB.y) * mix(1.0, smoothstep(uBounds.y, uBounds.y * 0.35, R), uFar);
}
void vacMarch(vec3 ro, vec3 rd, float t0, float t1, float jit, vec3 sunIn, inout vec3 L, inout float T) {
  vec3 oc = ro - vec3(0.0, -uVacB.x, 0.0);
  float tc = -dot(oc, rd);
  vec3 pc = oc + rd * tc;
  float B = sqrt(dot(pc, pc) + uVacA.y * uVacA.y);
  float ph0 = atan((t0 - tc) / B), ph1 = atan((t1 - tc) / B);
  float N = uSteps;
  float dph = (ph1 - ph0) / N;
  float kB = uVacA.x * dph / B * (1.0 - 0.3 * uFar);
  // brightness from scattered sunlight only (uSunRad carries the Earth shadow): sub-micron
  // condensate, slightly blue-white; a trace of sky / Earthshine
  vec3 Li = (sunIn + uAmbRad * 0.08) * vec3(0.8, 0.92, 1.14);
  // a close camera (chase / onboard) sits in or right next to the plume: thin out the gas within
  // ~half its distance to the source, so the frame shows the plume's shape instead of a uniform fog
  float Dn = min(length(oc), 120.0);
  for (int i = 0; i < 32; i++) {
    if (float(i) >= N || T < 0.01) break;
    float ph = ph0 + (float(i) + jit) * dph;
    float t = tc + B * tan(ph);
    vec3 d = oc + rd * t;
    float R = max(length(d), 1e-3);
    float Tr = exp(-kB * vacF(d, R) * smoothstep(0.12 * Dn, 0.5 * Dn, t));
    L += T * Li * (1.0 - Tr);
    T *= Tr;
  }
}
#endif

void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  vec2 hit = frustumHit(ro, rd, uBounds);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  vec3 rdv = normalize(vView);
#ifdef VFX_LOWRES
  // low-res pass: this texel stands for full-res texel F*xy + (F-1)/2 (the composite matches depths to it)
  int lf = int(uLowF + 0.5);
  float dS = uHasDepth > 0.5 ? texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy) * lf + (lf - 1) / 2, 0).r : 1e20;
#else
  float dS = vfxSceneDepth();
#endif
  float tScene = dS / max(-rdv.z, 1e-4);
  t1 = min(t1, tScene);
  if (t1 <= t0) discard;

  float vac = uMisc.z;
  float mass = uMisc.x;
  float massF = vac > 0.5 ? mass : mass / 9.0;
  float jit = ign(gl_FragCoord.xy);
#ifdef VFX_LOWRES
  // (quarter-res far fill, few samples: a checkerboard dither. Its only non-DC term is (pi, pi), which
  //  the composite's cubic B-spline passes at <= 1/9; IGN's slow aliases survived it as a diagonal
  //  mesh on thin, smooth gas, a 2x2 Bayer's (0, pi) term (<= 1/3) as an 8 px grid)
  if (lf >= 4) jit = ((int(gl_FragCoord.x) ^ int(gl_FragCoord.y)) & 1) == 1 ? 0.75 : 0.25;
#endif

  // ---------- analytic per-engine cores (line integral of a gaussian tube)
  vec3 coreL = vec3(0.0);
  float coreT = 1e9;
  float nE = vac > 0.5 ? 1.0 : 9.0;
  float planeA = -uPlaneP.y;
  // retro-propulsion: the jet column is stopped at the Mach disk / stagnation point
  // (the luminous jets end inside the flame cushion, just ahead of the engines)
  float coreEnd = uRetro.x > 0.01 ? mix(1e6, min(uRetro.y * 0.95, uRetroB.x * 1.5 + 3.0), clamp(uRetro.x * 2.0, 0.0, 1.0)) : 1e6;
  for (int k = 0; k < 9; k++) {
    if (float(k) >= nE) break;
    float I = uEng[k];
    if (I < 0.01) continue;
    vec2 ep = enginePos(k);
    vec3 w0 = ro - vec3(ep.x, 0.0, ep.y);
    // axis direction u = (0,-1,0): b = rd.u, d = rd.w0, e = u.w0
    float b = -rd.y;
    float d = dot(rd, w0);
    float ee = -w0.y;
    float den = max(1.0 - b * b, 1e-4);
    float tc = (b * ee - d) / den;
    float sc = (ee - b * d) / den;          // axial distance of closest approach
    float sinT = sqrt(den);
    if (sinT < 0.08) {                       // looking along the core: integrate from the exit plane
      sc = max(sc, 0.0);
    }
    float sc0 = vac > 0.5 ? 0.0 : -0.4;     // (MVac core starts at the exit plane)
    if (tc < 0.0 || tc > tScene || sc < sc0 || sc > planeA || sc > coreEnd) continue;
    vec3 cp = ro + rd * tc;
    float dist = length(cp - vec3(ep.x, -sc, ep.y));
    float a = max(sc, 0.0);
    float lam = uCore.y;
    float ph = a / lam;
    float cs = 0.5 + 0.5 * cos(6.2832 * ph);
    float dia = pow(cs, 8.0) * uCore.z * exp(-a / (lam * 4.0));
    float pinch = 1.0 - 0.35 * uCore.z * cs * cs * exp(-a / (lam * 4.0));
    float rc = uGeom.y * (vac > 0.5 ? (0.8 + a * 0.12) : (0.78 + a * 0.05)) * pinch;
    float along = exp(-a / uCore.x) * smoothstep(sc0, sc0 + 0.55, sc) * smoothstep(coreEnd, coreEnd * 0.6, sc);
    float lenInt = min(rc * 1.7725 / sinT, uCore.x * 1.2);
    float g = exp(-dist * dist / (rc * rc)) * lenInt * along;
    float Tk = vac > 0.5 ? 3600.0 : mix(2900.0, 3500.0, dia);
    vec3 col = vac > 0.5 ? vec3(0.42, 0.5, 1.0) : blackbody(Tk) * 1.4;
    col = mix(col, vec3(0.3, 1.0, 0.38) * 1.2, uGreen[k]);
    float br = uCore.w * I * (0.5 + 1.9 * dia) * (1.0 + 0.6 * uGreen[k]);
    coreL += col * br * g;
    if (g > 0.05) coreT = min(coreT, tc);
  }

  // ---------- volumetric march: outer expanded plume + finely sampled flame sub-segment
  vec3 L = vec3(0.0);
  float T = 1.0;
  float Tcore = 1.0;
  float cosS = dot(rd, uSunLocal);
#ifdef PLUME_MVAC
  // sub-micron condensate: weakly forward-scattering (near Rayleigh), so the plume shows from any side
  float phase = mix(hgPhase(cosS, 0.35), 0.0796, 0.5);
#else
  float phase = mix(hgPhase(cosS, 0.62), 0.0796, 0.5);
#endif
  vec3 sunIn = uSunRad * phase;
#ifdef PLUME_MVAC
  vacMarch(ro, rd, t0, t1, jit, sunIn, L, T);
#else
  // (in full retro the outer volume only holds the smooth, faint bow envelope: few steps suffice)
  float N = uRetro.x > 0.5 && uFlameB.y > 0.0 && uFlameB.y < uBounds.y * 0.8 ? max(8.0, floor(uSteps * 0.4)) : uSteps;
  // light from the plume core itself scattered by the expanded gas
  float coreI = vac > 0.5 ? 0.15 * mass : (uCore.w * 0.9 + uFlame.x * 4.0) * massF;
  vec3 coreCol = vac > 0.5 ? vec3(0.6, 0.5, 1.0) : vec3(1.0, 0.6, 0.3);
  // the flame sub-proxy is marched separately (fine steps) when it is much smaller than the plume
  bool split = uFlameB.y > 0.0 && uFlameB.y < uBounds.y * 0.8;
  vec2 fh = split ? frustumHit(ro, rd, uFlameB) : vec2(1.0, -1.0);
  float f0 = clamp(fh.x, t0, t1), f1 = clamp(fh.y, t0, t1);
  bool hasF = split && fh.y > fh.x && f1 > f0;
  float Tb = 1.0; vec3 Lb = vec3(0.0);   // outer march state at the flame entry
  // sample spacing ~ the inner-jet radius (geometric along oblique rays; see coneMarchT): the
  // dense, narrow jet near the nozzle aliased the march dither into a mesh with uniform steps
  // (not in retro-propulsion: the cushion / bow envelope live upstream of the exit plane)
  float kA = -rd.y;
  float A0 = -(ro.y + rd.y * t0), A1 = -(ro.y + rd.y * t1);
  float tanIn = 0.055 + 0.32 * smoothstep(0.5, 3.4, uMisc.y);
  float lqa = coneS(A0, uGeom.z, tanIn), lqb = coneS(A1, uGeom.z, tanIn);
  float geoO = abs(kA) > 1e-3 && uRetro.x < 0.001 ? smoothstep(0.1, 0.5, tanIn * abs(lqb - lqa)) : 0.0;
  // (warped samples land in the fine, texture-cache-unfriendly root: fewer of them do the same job)
  N = floor(N * (1.0 - 0.28 * geoO));
  float t = coneMarchT(0.0, t0, t1, A0, kA, lqa, lqb, uGeom.z, tanIn, geoO);
  for (int i = 0; i < 64; i++) {
    if (float(i) >= N || T < 0.004) break;
    float tNext = coneMarchT((float(i) + 1.0) / N, t0, t1, A0, kA, lqa, lqb, uGeom.z, tanIn, geoO);
    float dt = tNext - t;
    vec3 p = ro + rd * (t + dt * jit);
    if (t <= coreT) Tcore = T;
    if (t <= f0) { Tb = T; Lb = L; }
    if (dt <= 0.0) { t = tNext; continue; }
    vec3 em; float sT; float sS;
    field(p, split ? 1 : 0, em, sT, sS);
    float ext = sT + sS;
    if (ext > 1e-6 || dot(em, em) > 1e-10) {
      float dc2 = dot(p, p) + uGeom.z * uGeom.z * 4.0;
      vec3 Li = em + sS * (sunIn + uAmbRad * 0.08 + coreCol * coreI * 0.08 / dc2);
      float Tr = exp(-ext * dt);
      L += T * Li * (ext > 1e-5 ? (1.0 - Tr) / ext : dt);
      T *= Tr;
    }
    t += dt;
  }
  if (hasF) {
    // flame: composited at its entry point into the outer volume (the outer gas behind it is
    // dimmed by the flame's own opacity)
    vec3 Lf = vec3(0.0);
    float Tf = 1.0;
    float Nf = ceil(uSteps * 0.6);
    float tf = f0;
    for (int i = 0; i < 48; i++) {
      if (float(i) >= Nf || tf >= f1 || Tf < 0.004) break;
      vec3 pp = ro + rd * tf;
      float a = -pp.y;
      float remaining = f1 - tf;
      float left = Nf - float(i);
      float dt = max(clamp(0.24 * flameR(a), 0.1, 400.0), remaining / left);
      dt = min(dt, remaining);
      vec3 p = ro + rd * (tf + dt * jit);
      tf += dt;
      vec3 em; float sT; float sS;
      field(p, 2, em, sT, sS);
      float ext = sT + sS;
      if (ext > 1e-6 || dot(em, em) > 1e-10) {
        vec3 Li = em + sS * (sunIn + uAmbRad * 0.08);
        float Tr = exp(-ext * dt);
        Lf += Tf * Li * (ext > 1e-5 ? (1.0 - Tr) / ext : dt);
        Tf *= Tr;
      }
    }
    L = Lb + Tb * Lf + (L - Lb) * Tf;
    T *= Tf;
  }
  if (coreT > t) Tcore = T;
#endif
  L += coreL * Tcore;
  float alpha = 1.0 - T;
  vec3 relW = (transpose(mat3(viewMatrix)) * rdv) * mix(t0, t1, 0.3); // world pos rel. camera
  vec3 col = L * aerialTransmittance(relW) + aerialInscatter(relW) * alpha;
  gl_FragColor = vec4(col, alpha);
}
`;

const GLOW_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${AERIAL_GLSL}
uniform vec4 uGlow;
uniform float uViewH;
uniform float uFade;
varying vec2 vUv;
varying vec3 vCol;
varying float vViewZ;
void main() {
  vec4 mvC = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = max(length(mvC.xyz), 1.0);
  float pxPerM = uViewH * projectionMatrix[1][1] * 0.5 / dist;
  float rPhys = uGlow.w;
  float rPx = max(rPhys * pxPerM, 2.2);
  float r = rPx / pxPerM;
  // conserve radiant flux when enlarged; keep a floor so a far rocket stays a visible star
  float k = (rPhys * rPhys) / (r * r);
  k = max(k, 0.02);
  vec4 mv = mvC + vec4(position.xy * r * 3.0, 0.0, 0.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = position.xy * 3.0;
  vec3 wp = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vCol = uGlow.rgb / max(rPhys * rPhys * 3.14, 1.0) * k * uFade * aerialTransmittance(wp);
  vViewZ = -mvC.z;
}
`;

const GLOW_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${DEPTH_GLSL}
varying vec2 vUv;
varying vec3 vCol;
varying float vViewZ;
void main() {
  #include <logdepthbuf_fragment>
  if (vfxSceneDepth() < vViewZ) discard;
  float d2 = dot(vUv, vUv);
  float g = exp(-d2 * 1.6) + 0.04 * exp(-d2 * 0.25);
  gl_FragColor = vec4(vCol * g, 0.0);
}
`;

// Composite of the half-res plume pass: joint-bilateral upsample (the half-res texel k was marched
// against the scene depth of full-res texel 2k, so the neighbour whose depth matches this pixel's
// wins at silhouettes), drawn with the proxy geometry so only covered pixels pay.
const PLUME_COMP_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uSceneDepth;
uniform float uHasDepth;
uniform sampler2D uLow;
uniform vec2 uLowSize;
uniform vec2 uLowTexel; // 1 / full texture size of the (shared, grow-only) low target
uniform float uLowF;    // full-res pixels per low-res texel
uniform vec3 uCamLocal;
uniform vec4 uBounds;
varying vec3 vLocal;
varying vec3 vView;
${FRUSTUM_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec2 fc = gl_FragCoord.xy;
  int lf = int(uLowF + 0.5);
  ivec2 lo0 = ivec2((lf - 1) / 2);
  vec2 lc = fc / uLowF - 0.5;
  vec2 i0f = floor(lc);
  vec2 f = lc - i0f;
  ivec2 i0 = ivec2(i0f);
  ivec2 mx = ivec2(uLowSize) - 1;
  bool hasD = uHasDepth > 0.5;
  float dHi = hasD ? texelFetch(uSceneDepth, ivec2(fc), 0).r : 1e20;
  if (hasD) {
    // occluder in front of the whole proxy (thin structure the half-res pass may have missed)
    vec3 rd = normalize(vLocal - uCamLocal);
    vec2 hit = frustumHit(uCamLocal, rd, uBounds);
    float tHi = dHi / max(-normalize(vView).z, 1e-4);
    if (tHi <= max(hit.x, 0.0)) discard;
  }
  vec4 wd = vec4(1.0);
  if (hasD) {
    for (int k = 0; k < 4; k++) {
      ivec2 ii = clamp(i0 + ivec2(k & 1, k >> 1), ivec2(0), mx);
      float dLo = texelFetch(uSceneDepth, ii * lf + lo0, 0).r;
      float rel = abs(dLo - dHi) / max(min(dLo, dHi), 0.1);
      wd[k] = exp(-rel * 25.0) + 1e-6;
    }
  }
  if (min(min(wd.x, wd.y), min(wd.z, wd.w)) > 0.6) {
    vec2 p = fc / uLowF;
    vec2 lo = vec2(1.0), hi = uLowSize - 1.0;
    if (lf >= 4) {
      // quarter res: cubic B-spline from 4 bilinear taps (a tent over 4x4 px blocks leaves small
      // bright features -- the flame seen end-on -- visibly square)
      vec2 tc = p - 0.5;
      vec2 ic = floor(tc);
      vec2 fr = tc - ic;
      vec2 f2 = fr * fr, f3 = f2 * fr;
      vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * fr + 1.0) / 6.0;
      vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
      vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * fr + 1.0) / 6.0;
      vec2 w3 = f3 / 6.0;
      vec2 g0 = w0 + w1, g1 = w2 + w3;
      vec2 h0 = clamp(ic + 0.5 - 1.0 + w1 / g0, lo, hi) * uLowTexel;
      vec2 h1 = clamp(ic + 0.5 + 1.0 + w3 / g1, lo, hi) * uLowTexel;
      gl_FragColor = g0.y * (g0.x * texture2D(uLow, h0) + g1.x * texture2D(uLow, vec2(h1.x, h0.y)))
                   + g1.y * (g0.x * texture2D(uLow, vec2(h0.x, h1.y)) + g1.x * texture2D(uLow, h1));
      return;
    }
    // interior: wide (~4x4 tent) filter from 4 bilinear taps, also dissolves the march dither
    vec4 c = texture2D(uLow, clamp(p + vec2(-0.75, -0.75), lo, hi) * uLowTexel)
           + texture2D(uLow, clamp(p + vec2( 0.75, -0.75), lo, hi) * uLowTexel)
           + texture2D(uLow, clamp(p + vec2(-0.75,  0.75), lo, hi) * uLowTexel)
           + texture2D(uLow, clamp(p + vec2( 0.75,  0.75), lo, hi) * uLowTexel);
    gl_FragColor = c * 0.25;
    return;
  }
  // silhouette: joint-bilateral over the 4x4 neighbourhood (tent x depth-match weights)
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      ivec2 ii = clamp(i0 + ivec2(x, y), ivec2(0), mx);
      vec2 dd = abs(vec2(float(x), float(y)) - f);
      vec2 tw = max(1.6 - dd, 0.0);
      float dLo = texelFetch(uSceneDepth, ii * lf + lo0, 0).r;
      float rel = abs(dLo - dHi) / max(min(dLo, dHi), 0.1);
      float w = tw.x * tw.y * (exp(-rel * 25.0) + 1e-6);
      acc += texelFetch(uLow, ii, 0) * w;
      ws += w;
    }
  }
  gl_FragColor = acc / max(ws, 1e-12);
}
`;

/** Shared half-res target (grow-only; each view uses its top-left sub-rect). */
let lowRT: THREE.WebGLRenderTarget | null = null;
function lowTarget(w: number, h: number): THREE.WebGLRenderTarget {
  if (!lowRT) {
    lowRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
  } else if (lowRT.width < w || lowRT.height < h) {
    lowRT.setSize(Math.max(lowRT.width, w), Math.max(lowRT.height, h));
  }
  return lowRT;
}
