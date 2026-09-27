// Transonic condensation (Prandtl-Glauert-ish vapor collars) around the fairing boattail and the
// interstage / grid-fin region. Small raymarched annular volume in the S2 body frame: sharp
// expansion front at the shoulder, abrupt evaporation at the (Mach-dependent) shock position,
// streaky flow-aligned structure racing aft, sunlit with forward scattering.
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import { LAYER_VFX } from '../../core/context';
import { F9 } from '../../core/vehicleSpec';
import { AERIAL_GLSL, aerialUniforms } from '../env/aerial';
import { COLOR_GLSL, DEPTH_GLSL, NOISE_GLSL, refreshSharedForDraw, smooth, vfxShared } from './common';

export class Condensation {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private qInv = new THREE.Quaternion();
  strength = 0;
  /** y range (S2 frame) of the proxy */
  private y0 = -8;
  private y1 = 19;
  private R = 6.5;

  constructor(private ctx: AppContext) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...aerialUniforms,
        uSceneDepth: vfxShared.uSceneDepth, uSceneRes: vfxShared.uSceneRes, uHasDepth: vfxShared.uHasDepth,
        uNoise3D: vfxShared.uNoise3D, uTime: vfxShared.uVfxTime,
        uCamLocal: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(this.y0, this.y1, this.R) },
        uC: { value: new THREE.Vector4(0, 0, 0, 0) }, // strength fairing, strength interstage, shock len, speed
        uSunLocal: { value: new THREE.Vector3(0, 1, 0) },
        uSunRad: { value: new THREE.Color() },
        uAmbRad: { value: new THREE.Color() },
        uSteps: { value: 16 },
        uGeomC: { value: new THREE.Vector4(F9.fairing.baseY, F9.fairing.diameter / 2, F9.radius, F9.s2.mountY) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
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
    this.mesh.renderOrder = 15;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      refreshSharedForDraw(this.ctx, cam, this.mat, false);
      this.mat.depthTest = false;
    };
  }

  /**
   * @param s2pos / s2quat pose of S2 (stacked) — the vapor sits around the fairing boattail
   * @param mach Mach number, alt altitude, humidity 0..1
   */
  update(s2pos: THREE.Vector3, s2quat: THREE.Quaternion, mach: number, alt: number, humidity: number, sunRad: THREE.Color, amb: THREE.Color, quality: number): void {
    const s = smooth(0.78, 0.93, mach) * (1 - smooth(1.2, 1.55, mach)) * smooth(15000, 7000, alt) * humidity;
    this.strength = s;
    this.mesh.visible = s > 0.01;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    // shock moves aft with Mach -> longer vapor region; flicker in and out
    const shockLen = 2.0 + 9.0 * smooth(0.85, 1.25, mach);
    const flick = 0.75 + 0.25 * Math.sin(this.ctx.realTime * 0.0 + mach * 90) * Math.sin(mach * 37);
    u.uC.value.set(s * flick, s * 0.6 * smooth(0.9, 1.1, mach), shockLen, 320 * Math.max(mach, 0.5));
    this.mesh.position.copy(s2pos);
    this.mesh.quaternion.copy(s2quat);
    this.qInv.copy(s2quat).invert();
    u.uSunLocal.value.copy(this.ctx.lighting.sunDir).applyQuaternion(this.qInv);
    u.uSunRad.value.copy(sunRad);
    u.uAmbRad.value.copy(amb);
    u.uSteps.value = [12, 16, 24, 32][quality] ?? 24;
    // proxy spans from below the interstage (S1 grid fins, in S2 frame y ~ -2..4) to above the shoulder
    this.y0 = -9; this.y1 = F9.fairing.baseY + 3.5; this.R = F9.fairing.diameter / 2 + 4.5;
    u.uBox.value.set(this.y0, this.y1, this.R);
  }

  prepareView(view: ViewInfo): void {
    if (!this.mesh.visible) return;
    const cl = this.mat.uniforms.uCamLocal.value as THREE.Vector3;
    cl.copy(view.camWorldPos).sub(this.mesh.position).applyQuaternion(this.qInv);
  }
}

const VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uBox;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vec3 lp = vec3(position.x * uBox.z * 1.01, mix(uBox.x, uBox.y, position.y), position.z * uBox.z * 1.01);
  vLocal = lp;
  vec4 mv = modelViewMatrix * vec4(lp, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${DEPTH_GLSL}
${NOISE_GLSL}
${COLOR_GLSL}
${AERIAL_GLSL}
uniform vec3 uCamLocal;
uniform vec3 uBox;
uniform vec4 uC;
uniform vec3 uSunLocal;
uniform vec3 uSunRad;
uniform vec3 uAmbRad;
uniform float uSteps;
uniform float uTime;
uniform vec4 uGeomC; // fairing base y, fairing radius, body radius, s2 mount y (in S1)
varying vec3 vLocal;
varying vec3 vView;

vec2 cylHit(vec3 ro, vec3 rd) {
  float A = dot(rd.xz, rd.xz), B = 2.0 * dot(ro.xz, rd.xz), C = dot(ro.xz, ro.xz) - uBox.z * uBox.z;
  float tc0 = -1e9, tc1 = 1e9;
  if (A > 1e-8) {
    float disc = B * B - 4.0 * A * C;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    tc0 = (-B - s) / (2.0 * A); tc1 = (-B + s) / (2.0 * A);
  } else if (C > 0.0) return vec2(1.0, -1.0);
  float ty0 = -1e9, ty1 = 1e9;
  if (abs(rd.y) > 1e-6) { float a = (uBox.x - ro.y) / rd.y, b = (uBox.y - ro.y) / rd.y; ty0 = min(a, b); ty1 = max(a, b); }
  else if (ro.y < uBox.x || ro.y > uBox.y) return vec2(1.0, -1.0);
  return vec2(max(tc0, ty0), min(tc1, ty1));
}

float density(vec3 p) {
  float r = length(p.xz);
  float y = p.y;
  vec2 dir = p.xz / max(r, 1e-4);
  float yb = uGeomC.x;            // fairing base (boattail end) in S2 frame
  float Rf = uGeomC.y, Rb = uGeomC.z;
  float L = uC.z;
  float flow = y + uTime * uC.w;  // streams aft at flight speed
  // azimuthal streaks (periodic in angle) + ragged large-scale breakup
  float st = n3(vec3(dir * 1.6, flow * 0.045)) * 0.55 + n3(vec3(dir * 4.1 + 3.0, flow * 0.11)) * 0.45;
  float big = n3(vec3(dir * 0.9 + 7.0, uTime * 1.7 + flow * 0.01));
  float d = 0.0;
  // 1) vapor cone behind the fairing shoulder: sharp leading edge where the flow expands around
  //    the boattail, flares outward aft, ends raggedly at the (Mach-dependent) normal shock
  float y0 = yb + 1.4;
  float along = y0 - y;
  float inR = mix(Rf * 0.99, Rb, clamp(along / 1.4, 0.0, 1.0));
  // a thin translucent sheath hugging the body (not a thick ring): thickens slowly aft
  float thick = max(0.3 + along * 0.16 + 0.3 * (st - 0.5), 0.12);
  float outR = inR + thick;
  float shock = L * (0.78 + 0.45 * (big - 0.5) + 0.25 * (st - 0.5));
  float band = smoothstep(inR - 0.05, inR + 0.1, r) * (1.0 - smoothstep(outR - thick * 0.6, outR + 0.15, r));
  float ax = smoothstep(-0.15, 0.25, along) * (1.0 - smoothstep(shock - 2.6, shock + 0.4, along));
  float dens1 = mix(1.0, 0.35, clamp(along / max(L, 1.0), 0.0, 1.0));   // thins as it expands
  d += uC.x * band * ax * dens1 * (0.35 + 0.65 * smoothstep(0.3, 0.62, st)) * 2.0;
  // 2) interstage / grid-fin region: patchy sheath hugging the body
  float yi = -1.0;
  float al2 = yi - y + 3.5;
  float inR2 = Rb + 0.02;
  float out2 = inR2 + max(0.25 + max(al2, 0.0) * 0.1 + 0.25 * (st - 0.5), 0.1);
  float band2 = smoothstep(inR2 - 0.05, inR2 + 0.1, r) * (1.0 - smoothstep(out2 - 0.2, out2 + 0.1, r));
  float ax2 = smoothstep(-0.2, 0.6, al2) * (1.0 - smoothstep(L * 0.55, L * 0.75, al2 + 2.0 * (big - 0.5)));
  d += uC.y * band2 * ax2 * (0.15 + 0.85 * smoothstep(0.35, 0.65, st)) * 2.0;
  return d;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  vec2 h = cylHit(ro, rd);
  float t0 = max(h.x, 0.0), t1 = h.y;
  vec3 rdv = normalize(vView);
  t1 = min(t1, vfxSceneDepth() / max(-rdv.z, 1e-4));
  if (t1 <= t0) discard;
  float N = uSteps;
  float dt = (t1 - t0) / N;
  float jit = ign(gl_FragCoord.xy);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float cosS = dot(rd, uSunLocal);
  float ph = mix(hgPhase(cosS, 0.7), 0.0796, 0.4) * 12.566;
  vec3 light = uSunRad * ph * 0.3183 + uAmbRad * 0.35;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= N) break;
    vec3 p = ro + rd * (t0 + (float(i) + jit) * dt);
    float d = density(p);
    if (d > 1e-4) {
      float Tr = exp(-d * dt);
      L += T * light * (1.0 - Tr);
      T *= Tr;
    }
  }
  float a = 1.0 - T;
  vec3 wdir = transpose(mat3(viewMatrix)) * rdv;
  vec3 relW = wdir * mix(t0, t1, 0.5);
  gl_FragColor = vec4(L * aerialTransmittance(relW) + aerialInscatter(relW) * a, a);
}
`;
