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
  readonly shape: PlumeShape = { e: 0, ex: 0, mass: 0, L: 0, Rc: 1, tanT: 0.05, retro: 0, standoff: 1e9, lumBright: 0, planeDist: Infinity, bellP: 1, a0: 0 };
  private camInside = false;
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
      uPlaneN: { value: new THREE.Vector4(0, 1, 0, 0) },
      uPlaneP: { value: new THREE.Vector4(0, -1e6, 0, 20) },
      uSunLocal: { value: new THREE.Vector3(0, 1, 0) },
      uSunRad: { value: new THREE.Color() },
      uAmbRad: { value: new THREE.Color() },
      uScat: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSteps: { value: 24 },
      uFlick: { value: 1 },
      uShape: { value: new THREE.Vector4(1, 100, 0, 0) }, // bell exponent, L
      uFlameB: { value: new THREE.Vector4(0, 0, 0, 0) },  // flame sub-proxy x0,x1,R0,R1
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: u,
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
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      refreshSharedForDraw(this.ctx, cam, this.mat, false);
      // own depth-test policy: we clip against the linear scene depth when available; without it,
      // hardware-test front faces from outside, nothing from inside.
      // NOTE: the proxy is mirrored along y in the VS (local y = -a), which flips the winding:
      // THREE.FrontSide draws the physically FAR faces, THREE.BackSide the near ones. Far faces
      // work from inside and outside (the march starts at the camera / entry point).
      const hasD = !!vfxShared.uHasDepth.value;
      this.mat.depthTest = !hasD && !this.camInside;
      this.mat.side = hasD || this.camInside ? THREE.FrontSide : THREE.BackSide;
    };

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
    const scat = (vac ? 45 : 150) * smooth(0.5, 2.4, e) * massFrac;
    const coreLen = vac ? 6 + 10 * ex : 4.2 + 10 * ex + 3 * Math.max(0, e);
    const diaSpacing = 1.05 * (1 + 1.4 * Math.max(0, e));
    const diaAmp = vac ? 0 : 1 - smooth(0.5, 1.6, e);
    const coreBright = vac ? 0.35 : 190 * (1 - 0.35 * smooth(1.5, 4, e));

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
    u.uSteps.value = [16, 24, 36, 52][quality] ?? 36;
    u.uFlick.value = d.flicker;

    // proxy bounds: frustum enclosing the (concave) bell
    const sh = this.shape;
    sh.Rc = Rc; sh.tanT = tanT; sh.L = L; sh.bellP = bellP; sh.a0 = a0;
    const RL = plumeRadiusAt(sh, L);
    let x0 = vac ? -0.5 : -0.4, x1 = L, R1 = RL * 1.12 + 3;
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
    if (retro > 0.02) {
      const shellR = Math.max(Rn * 2.4, Rc + 6);
      x0 = Math.min(x0, -back - 4);
      x1 = Math.max(Math.min(L, standoff + Rn * 0.6 + 12), 10) * (retro > 0.5 ? 1 : 1) ;
      x1 = retro > 0.9 ? Math.min(x1, standoff + Rn * 0.6 + 12) : Math.max(x1, standoff + 12);
      R0 = Math.max(R0, shellR);
      R1 = Math.max(R1 * (1 - retro), shellR);
    }
    if (planeDist < Infinity) {
      x1 = Math.min(x1, planeDist + 1.5);
      if (wall > 0) R1 = Math.max(R1, u.uPlaneP.value.w * 3.2);
      x0 = Math.min(x0, x1 - 1);
    }
    u.uBounds.value.set(x0, x1, R0, R1);
    const fb = u.uFlameB.value as THREE.Vector4;
    if (retro > 0.3) fb.y = 0; else fb.y = Math.min(fb.y, x1);

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
    const col = vac ? _c.setRGB(0.5, 0.45, 1) : _c.setRGB(1, 0.62, 0.3);
    const gsum = d.green.reduce((s, x) => Math.max(s, x), 0);
    if (gsum > 0) col.lerp(_c2.setRGB(0.3, 1, 0.35), Math.min(1, gsum));
    gl.uGlow.value.set(col.r * pw, col.g * pw, col.b * pw, vac ? 1.2 : Rc * 1.4 + 1.5);
  }

  /** Per view: camera in local space, inside/outside handling. */
  prepareView(view: ViewInfo): void {
    if (!this.active) return;
    const u = this.mat.uniforms;
    this.qInv.copy(this.group.quaternion).invert();
    const cl = u.uCamLocal.value as THREE.Vector3;
    cl.copy(view.camWorldPos).sub(this.group.position).applyQuaternion(this.qInv);
    const b = u.uBounds.value as THREE.Vector4;
    const a = -cl.y;
    const near = view.camera.near * 3 + 0.5;
    const R = b.z + ((b.w - b.z) * (a - b.x)) / Math.max(b.y - b.x, 1e-3);
    this.camInside = a > b.x - near && a < b.y + near && Math.hypot(cl.x, cl.z) < R + near;
    // glow fade: hide when the plume is comfortably resolved on screen
    const dist = cl.length();
    const pxPerM = (view.rect.h || 1000) / (2 * Math.tan((view.camera.fov * Math.PI) / 360) * Math.max(dist, 1));
    const sizePx = (b.w + this.shape.L * 0.3) * pxPerM;
    this.glowMat.uniforms.uFade.value = 1 - smooth(6, 40, sizePx);
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
    this.glow.geometry.dispose();
    this.glowMat.dispose();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

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
uniform vec4 uPlaneN; // plane normal (local), wall strength
uniform vec4 uPlaneP; // axis hit point (local), wall radius
uniform vec3 uSunLocal;
uniform vec3 uSunRad;
uniform vec3 uAmbRad;
uniform float uTime;
uniform float uSteps;
uniform float uFlick;
uniform vec4 uShape;
uniform vec4 uFlameB;
varying vec3 vLocal;
varying vec3 vView;

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
float flameR(float a) {
  float exF = smoothstep(0.15, 3.4, uMisc.y);
  return uGeom.z + (0.055 + 0.16 * exF) * max(a, 0.0);
}

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
  float speed = mix(260.0, 900.0, clamp(e * 0.3, 0.0, 1.0));
  // (flame turbulence scales with the flame radius, the expanded plume's with the bell radius)
  float Rf = flameR(a);
  float Rt = mode == 2 ? Rf : mix(R, uRetro.z * 0.35 + uGeom.z, uRetro.x);
  vec3 nc = vec3(q / (Rt * 1.3), (a - uTime * speed) / (Rt * 3.2) + uTime * 0.15);
  float n1 = n3(nc * 0.5);
  float n2 = n3(nc * 1.37 + vec3(0.31, 0.77, 0.13));
  float turb = n1 * 0.65 + n2 * 0.35;           // ~0.5 mean
  float tb = (turb - 0.5) * 2.0;
  float turbF = turb, tbF = tb;
  if (mode == 0 && R > Rf * 1.5 && uFlame.x > 0.01) {
    vec3 nf = vec3(q / (Rf * 1.3), (a - uTime * speed) / (Rf * 3.2) + uTime * 0.15);
    turbF = n3(nf * 0.5) * 0.65 + n3(nf * 1.37 + vec3(0.31, 0.77, 0.13)) * 0.35;
    tbF = (turbF - 0.5) * 2.0;
  }

  // ----- afterburning RP-1 flame + soot (Merlin, sea level -> fades with altitude)
  if (mode != 1 && vac < 0.5 && uFlame.x > 0.01 && a > -0.5) {
    // the luminous core does not follow the (huge) expanded-plume spread at altitude
    float edge = (r / Rf) * (1.0 + 0.38 * tbF * smoothstep(1.0, 8.0, a));
    float prof = exp(-edge * edge * 1.35);
    float grow = smoothstep(-0.3, 1.2, a);
    float flen = uFlame.y;
    // bright incandescent column right from the exit, long turbulent tail
    float along = exp(-a / flen) * 0.75 + 0.25 * exp(-a / (flen * 2.6));
    float fl = uFlame.x * massF * grow * along * prof * (0.55 + 0.9 * turbF) * (1.0 - retro);
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
    sigT += soot * 0.6 + gg * massF;
    sigS += soot * 0.4;
    em += vec3(1.0, 0.35, 0.08) * gg * 3.0 * smoothstep(1.5, 4.0, a) * massF; // entrained GG gas ignites
  }

  // ----- expanded plume: scattering (condensed exhaust / soot) + faint self-luminosity
  if (mode != 2 && uFlame.w > 0.0) {
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
    float start = smoothstep(-0.2, uGeom.z * 2.0, a);
    // bell
    float edgeO = rn * (1.0 + 0.06 * tb);
    vec2 dir = q / max(r, 1e-3);
    float lg = log2(max(a, 1.0) + 8.0);
    float stre = n3(vec3(dir * 1.9, lg * 0.35 - uTime * 0.02)) * 0.6 + n3(vec3(dir * 4.3 + 2.0, lg * 0.7)) * 0.4;
    float streak = 0.35 + 1.3 * smoothstep(0.35, 0.75, stre);
    float shw = 0.11 + 0.06 * stre;
    float shell = exp(-pow((edgeO - 0.9) / shw, 2.0));
    float fill = exp(-edgeO * edgeO * 1.2) * (1.0 - smoothstep(0.85, 1.0, edgeO)) * streak;
    float bellStart = smoothstep(-0.2, uGeom.z * 6.0 + 0.02 * L, a);
    float bell = (shell * 1.1 + fill * 0.3) / (0.5 * R * R + 16.0 * Rc2) * bellStart * shellK;
    // (inner jet: optical depth ~ kIn*K*1.4/Rin -> about 1 a few nozzle radii out, translucent beyond;
    //  the bell carries the full scattering constant so the km-sized membrane stays visible)
    float kIn = vac > 0.5 ? 0.04 : 0.08;
    float s = uFlame.w * start * (kIn * (1.0 - 0.55 * shellK) * inner * mix(0.45 + 1.1 * turb, 0.75 + 0.5 * turb, tsm) + bell);
    s *= (1.0 - retro) * smoothstep(L, L * 0.45, a);
    sigS += s;
    // faint luminous exhaust (hot CO2/H2O/soot) close to the engines
    vec3 gcol = vac > 0.5 ? vec3(0.55, 0.45, 1.0) : vec3(1.0, 0.6, 0.35);
    em += gcol * uFlame.w * start * inner * (vac > 0.5 ? 0.05 : 0.9) * exp(-a / (uGeom.z * 5.0 + 10.0)) * uFlick;
  }

  // ----- supersonic retro-propulsion: jet column to the standoff, bow shell wrapping the base
  if (mode != 2 && retro > 0.001) {
    float xs = uRetro.y, Rn = uRetro.z, back = uRetro.w;
    float colR = uGeom.z * (1.0 + 0.5 * clamp(a / max(xs, 1.0), 0.0, 1.0));
    float jet = exp(-pow(r / colR, 2.0) * 1.5) * smoothstep(xs * 1.05, xs * 0.6, a) * smoothstep(-0.3, 1.0, a);
    float ab = xs - r * r / (2.0 * Rn);
    float ds = a - ab;
    float th = 0.22 * Rn + 0.06 * r + 0.5;
    float wob = 1.0 + 0.5 * tb;
    float tr0 = turb;
    float shell = exp(-ds * ds / (th * th * wob)) * smoothstep(-back, -back * 0.25, a) * (1.0 - smoothstep(Rn * 1.2, Rn * 2.0 + 4.0 * (tr0 - 0.5) * Rn * 0.5, r));
    float fill = smoothstep(th, -th * 2.0, ds) * smoothstep(-back * 0.5, xs * 0.5, a) * 0.35 * (1.0 - smoothstep(Rn * 1.2, Rn * 2.2, r));
    float hot = exp(-r / (Rn * 0.9));
    float lum = (1.0 - smoothstep(0.8, 3.6, e));                 // orange low, translucent high
    float n3r = n3(nc * 2.9 + vec3(0.7, 0.2, 0.5));
    float tr = clamp(turb * 0.75 + n3r * 0.25, 0.0, 1.0);
    float gas = (shell + fill) * (0.06 + 2.4 * tr * tr * tr);
    float bright = 7.0 * massF * (0.4 + 0.6 * lum);
    float T = mix(1600.0, 2350.0, hot) * mix(0.9, 1.0, lum);
    vec3 col = blackbody(T) * flameRadiance(T) * 2.0;
    em += col * gas * bright * (0.25 + 0.75 * hot) * retro;
    em += blackbody(2500.0) * flameRadiance(2500.0) * 2.0 * jet * 30.0 * massF * retro;
    sigT += gas * retro * (0.02 + 0.05 * lum) * massF;
    sigS += gas * retro * 0.8 / (Rn + 5.0) * massF * smoothstep(0.5, 2.5, e);
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
  if (mode == 2) endF *= smoothstep(uFlameB.y, uFlameB.y * 0.6, a);
  em *= clip * endF;
  sigT *= clip * endF;
  sigS *= clip * endF;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  vec2 hit = frustumHit(ro, rd, uBounds);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  vec3 rdv = normalize(vView);
  float tScene = vfxSceneDepth() / max(-rdv.z, 1e-4);
  t1 = min(t1, tScene);
  if (t1 <= t0) discard;

  float vac = uMisc.z;
  float mass = uMisc.x;
  float massF = vac > 0.5 ? mass : mass / 9.0;
  float jit = ign(gl_FragCoord.xy);

  // ---------- analytic per-engine cores (line integral of a gaussian tube)
  vec3 coreL = vec3(0.0);
  float coreT = 1e9;
  float nE = vac > 0.5 ? 1.0 : 9.0;
  float planeA = -uPlaneP.y;
  // retro-propulsion: the jet column is stopped at the Mach disk / stagnation point
  float coreEnd = uRetro.x > 0.01 ? mix(1e6, uRetro.y * 0.95, clamp(uRetro.x * 2.0, 0.0, 1.0)) : 1e6;
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
    if (tc < 0.0 || tc > tScene || sc < -0.4 || sc > planeA || sc > coreEnd) continue;
    vec3 cp = ro + rd * tc;
    float dist = length(cp - vec3(ep.x, -sc, ep.y));
    float a = max(sc, 0.0);
    float lam = uCore.y;
    float ph = a / lam;
    float cs = 0.5 + 0.5 * cos(6.2832 * ph);
    float dia = pow(cs, 8.0) * uCore.z * exp(-a / (lam * 4.0));
    float pinch = 1.0 - 0.35 * uCore.z * cs * cs * exp(-a / (lam * 4.0));
    float rc = uGeom.y * (vac > 0.5 ? (0.85 + a * 0.22) : (0.78 + a * 0.05)) * pinch;
    float along = exp(-a / uCore.x) * smoothstep(-0.4, 0.15, sc) * smoothstep(coreEnd, coreEnd * 0.6, sc);
    float lenInt = min(rc * 1.7725 / sinT, uCore.x * 1.2);
    float g = exp(-dist * dist / (rc * rc)) * lenInt * along;
    float Tk = vac > 0.5 ? 3600.0 : mix(2900.0, 3500.0, dia);
    vec3 col = vac > 0.5 ? vec3(0.45, 0.38, 1.0) : blackbody(Tk) * 1.4;
    col = mix(col, vec3(0.3, 1.0, 0.38) * 1.2, uGreen[k]);
    float br = uCore.w * I * (0.5 + 1.9 * dia) * (1.0 + 0.6 * uGreen[k]);
    coreL += col * br * g;
    if (g > 0.05) coreT = min(coreT, tc);
  }

  // ---------- volumetric march: outer expanded plume + finely sampled flame sub-segment
  vec3 L = vec3(0.0);
  float T = 1.0;
  float Tcore = 1.0;
  float N = uSteps;
  float cosS = dot(rd, uSunLocal);
  float phase = mix(hgPhase(cosS, 0.62), 0.0796, 0.5);
  vec3 sunIn = uSunRad * phase;
  // light from the plume core itself scattered by the expanded gas
  float coreI = vac > 0.5 ? 0.6 * mass : (uCore.w * 0.9 + uFlame.x * 4.0) * massF;
  vec3 coreCol = vac > 0.5 ? vec3(0.6, 0.5, 1.0) : vec3(1.0, 0.6, 0.3);
  // the flame sub-proxy is marched separately (fine steps) when it is much smaller than the plume
  bool split = uFlameB.y > 0.0 && uFlameB.y < uBounds.y * 0.8;
  vec2 fh = split ? frustumHit(ro, rd, uFlameB) : vec2(1.0, -1.0);
  float f0 = clamp(fh.x, t0, t1), f1 = clamp(fh.y, t0, t1);
  bool hasF = split && fh.y > fh.x && f1 > f0;
  float Tb = 1.0; vec3 Lb = vec3(0.0);   // outer march state at the flame entry
  float t = t0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= N || t >= t1 || T < 0.004) break;
    vec3 pp = ro + rd * t;
    float a = -pp.y;
    float Rl = plumeR(a);
    float remaining = t1 - t;
    float left = N - float(i);
    float dt = max(clamp(0.24 * Rl, 0.1, 400.0), remaining / left);
    dt = min(dt, remaining);
    vec3 p = ro + rd * (t + dt * jit);
    vec3 em; float sT; float sS;
    field(p, split ? 1 : 0, em, sT, sS);
    if (t <= coreT) Tcore = T;
    if (t <= f0) { Tb = T; Lb = L; }
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
    float Nf = ceil(N * 0.6);
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
      vec3 em; float sT; float sS;
      field(p, 2, em, sT, sS);
      float ext = sT + sS;
      if (ext > 1e-6 || dot(em, em) > 1e-10) {
        vec3 Li = em + sS * (sunIn + uAmbRad * 0.08);
        float Tr = exp(-ext * dt);
        Lf += Tf * Li * (ext > 1e-5 ? (1.0 - Tr) / ext : dt);
        Tf *= Tr;
      }
      tf += dt;
    }
    L = Lb + Tb * Lf + (L - Lb) * Tf;
    T *= Tf;
  }
  if (coreT > t) Tcore = T;
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
