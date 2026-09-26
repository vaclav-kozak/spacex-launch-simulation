// High-frequency ocean detail: two Tessendorf FFT cascades (N=256, L≈61 m and ≈7.3 m) on the GPU
// (Stockham radix-2 in fragment shaders, both cascades side by side in one 512×256 float target).
// The spectrum is high-pass filtered below the shortest core/waves.ts Gerstner wavelength so the
// low-frequency surface stays exactly the shared Gerstner sum the ship rides on.
// Outputs per cascade: displacement (dx, dy, dz, jacobian) and slope moments (sx, sz, sx², sz²)
// textures with mipmaps (LEAN-style filtering -> distance roughness), plus persistent foam.
import * as THREE from 'three';
import { FullscreenPass, makeRT, passMaterial } from './gpu';
import type { WaveSet } from '../../core/waves';

export const FFT_N = 256;
export const CASCADE_L = [61.3, 7.3];
const G = 9.81;

function gauss(rnd: () => number): [number, number] {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  v = rnd();
  const m = Math.sqrt(-2 * Math.log(u));
  return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)];
}
function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECTRUM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uH0;      // (h0(k).re, h0(k).im, conj h0(-k).re, conj h0(-k).im) per texel, 512x256
uniform float uTime;
in vec2 vUv;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
const float N = ${FFT_N}.0;
uniform vec2 uL; // cascade sizes
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  vec2 px = floor(vUv * vec2(2.0 * N, N));
  float cascade = px.x >= N ? 1.0 : 0.0;
  vec2 n = vec2(px.x - cascade * N, px.y);
  vec2 m = vec2(n.x < N * 0.5 ? n.x : n.x - N, n.y < N * 0.5 ? n.y : n.y - N);
  float L = cascade > 0.5 ? uL.y : uL.x;
  vec2 k = 6.283185307 * m / L;
  float kl = length(k);
  vec4 h0 = texture(uH0, (px + 0.5) / vec2(2.0 * N, N));
  float w = sqrt(9.81 * kl);
  float ph = w * uTime;
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x); // i*h
  float ik = kl > 1e-6 ? 1.0 / kl : 0.0;
  // FT of the real fields
  vec2 fDy = h;
  vec2 fDx = -ih * k.x * ik;     // -i kx/k h
  vec2 fDz = -ih * k.y * ik;
  vec2 fSx = ih * k.x;           // d(Dy)/dx
  vec2 fSz = ih * k.y;
  vec2 fDxx = h * k.x * k.x * ik; // d(Dx)/dx = kx^2/k h
  vec2 fDzz = h * k.y * k.y * ik;
  vec2 fDxz = h * k.x * k.y * ik;
  // pack pairs: c = F1 + i F2  -> IFFT gives f1 + i f2
  vec2 c1 = fDy + vec2(-fDx.y, fDx.x);
  vec2 c2 = fDz + vec2(-fSx.y, fSx.x);
  vec2 c3 = fSz + vec2(-fDxx.y, fDxx.x);
  vec2 c4 = fDzz + vec2(-fDxz.y, fDxz.x);
  outA = vec4(c1, c2);
  outB = vec4(c3, c4);
}
`;

const FFT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uSub;       // subtransform size 2..N
uniform float uHorizontal;
in vec2 vUv;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
const float N = ${FFT_N}.0;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  vec2 px = floor(vUv * vec2(2.0 * N, N));
  float base = px.x >= N ? N : 0.0;
  float index = uHorizontal > 0.5 ? px.x - base : px.y;
  float evenIndex = floor(index / uSub) * (uSub * 0.5) + mod(index, uSub * 0.5);
  vec2 pe, po;
  if (uHorizontal > 0.5) { pe = vec2(base + evenIndex, px.y); po = vec2(base + evenIndex + N * 0.5, px.y); }
  else { pe = vec2(px.x, evenIndex); po = vec2(px.x, evenIndex + N * 0.5); }
  vec2 sz = vec2(2.0 * N, N);
  vec4 ea = texture(uA, (pe + 0.5) / sz), oa = texture(uA, (po + 0.5) / sz);
  vec4 eb = texture(uB, (pe + 0.5) / sz), ob = texture(uB, (po + 0.5) / sz);
  float arg = 6.283185307 * index / uSub;
  vec2 tw = vec2(cos(arg), sin(arg));
  outA = vec4(ea.xy + cmul(tw, oa.xy), ea.zw + cmul(tw, oa.zw));
  outB = vec4(eb.xy + cmul(tw, ob.xy), eb.zw + cmul(tw, ob.zw));
}
`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFoamPrev0;
uniform sampler2D uFoamPrev1;
uniform float uChop;
uniform float uFoamDecay;
uniform float uFoamThresh;
in vec2 vUv;
layout(location = 0) out vec4 outD0;
layout(location = 1) out vec4 outS0;
layout(location = 2) out vec4 outD1;
layout(location = 3) out vec4 outS1;
const float N = ${FFT_N}.0;
vec4 disp(vec2 uv, out vec4 slopes) {
  vec4 a = texture(uA, uv), b = texture(uB, uv);
  // a = (Dy, Dx, Dz, Sx), b = (Sz, Dxx, Dzz, Dxz)
  float dy = a.x, dx = a.y, dz = a.z, sx = a.w, szz = b.x;
  float dxx = b.y, dzz = b.z, dxz = b.w;
  float jxx = 1.0 + uChop * dxx, jzz = 1.0 + uChop * dzz, jxz = uChop * dxz;
  float J = jxx * jzz - jxz * jxz;
  // slope of the displaced surface
  float gx = sx / max(jxx, 0.2), gz = szz / max(jzz, 0.2);
  slopes = vec4(gx, gz, gx * gx, gz * gz);
  return vec4(uChop * dx, dy, uChop * dz, J);
}
void main() {
  vec2 uv0 = vec2(vUv.x * 0.5, vUv.y);
  vec2 uv1 = vec2(0.5 + vUv.x * 0.5, vUv.y);
  vec4 s0, s1;
  vec4 d0 = disp(uv0, s0);
  vec4 d1 = disp(uv1, s1);
  // persistent foam (in .w of the displacement: 1-J based coverage accumulated with decay)
  float f0 = max(texture(uFoamPrev0, vUv).w * uFoamDecay, clamp((uFoamThresh - d0.w) * 2.5, 0.0, 1.0));
  float f1 = max(texture(uFoamPrev1, vUv).w * uFoamDecay, clamp((uFoamThresh - d1.w) * 2.5, 0.0, 1.0));
  outD0 = vec4(d0.xyz, f0);
  outS0 = s0;
  outD1 = vec4(d1.xyz, f1);
  outS1 = s1;
}
`;

export class OceanFFT {
  private h0Tex: THREE.DataTexture;
  private pingA = makeRT(FFT_N * 2, FFT_N, { type: THREE.FloatType, count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as Partial<THREE.RenderTargetOptions>);
  private pingB = makeRT(FFT_N * 2, FFT_N, { type: THREE.FloatType, count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as Partial<THREE.RenderTargetOptions>);
  private outRT: THREE.WebGLRenderTarget[];
  private cur = 0;
  private specPass: FullscreenPass;
  private fftPass: FullscreenPass;
  private finalPass: FullscreenPass;
  private key = '';
  /** displacement (dx,dy,dz,foam) and slope textures per cascade — stable texture objects */
  disp: THREE.Texture[] = [];
  slope: THREE.Texture[] = [];
  /** choppiness */
  chop = 1.0;

  constructor(maxAniso = 8) {
    this.h0Tex = new THREE.DataTexture(new Float32Array(FFT_N * 2 * FFT_N * 4), FFT_N * 2, FFT_N, THREE.RGBAFormat, THREE.FloatType);
    this.h0Tex.minFilter = this.h0Tex.magFilter = THREE.NearestFilter;
    this.h0Tex.needsUpdate = true;
    const mk = () => {
      const rt = makeRT(FFT_N, FFT_N, {
        count: 4,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
      } as Partial<THREE.RenderTargetOptions>);
      for (const t of rt.textures) {
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.anisotropy = maxAniso;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
      }
      return rt;
    };
    this.outRT = [mk(), mk()];
    this.specPass = new FullscreenPass(passMaterial(SPECTRUM_FRAG, { uH0: { value: this.h0Tex }, uTime: { value: 0 }, uL: { value: new THREE.Vector2(CASCADE_L[0], CASCADE_L[1]) } }));
    this.fftPass = new FullscreenPass(passMaterial(FFT_FRAG, { uA: { value: null }, uB: { value: null }, uSub: { value: 2 }, uHorizontal: { value: 1 } }));
    this.finalPass = new FullscreenPass(
      passMaterial(FINAL_FRAG, {
        uA: { value: null }, uB: { value: null }, uFoamPrev0: { value: null }, uFoamPrev1: { value: null },
        uChop: { value: 1 }, uFoamDecay: { value: 0.985 }, uFoamThresh: { value: 0.3 },
      }),
    );
    // expose textures of the "current" output; we render into outRT[cur] and point uniforms at it
    this.disp = [this.outRT[0].textures[0], this.outRT[0].textures[2]];
    this.slope = [this.outRT[0].textures[1], this.outRT[0].textures[3]];
  }

  /** (re)build the initial spectrum for the sea state / wind; kmin = cutoff below the Gerstner band */
  setConditions(set: WaveSet, windSpeed: number, windFromDeg: number): void {
    const minGerstner = Math.min(...set.waves.map((w) => w.wavelength));
    const key = `${set.seaState.toFixed(2)}|${windSpeed.toFixed(1)}|${windFromDeg.toFixed(0)}`;
    if (key === this.key) return;
    this.key = key;
    const data = this.h0Tex.image.data as Float32Array;
    const travel = ((windFromDeg + 180) * Math.PI) / 180;
    const wdx = Math.sin(travel), wdz = -Math.cos(travel);
    // effective wind for the spectrum: sea state dominates (a Douglas 5 sea implies strong wind)
    const U = Math.max(windSpeed, 2.5 + 2.6 * set.seaState);
    const Lw = (U * U) / G;
    const kCut = (2 * Math.PI) / (minGerstner * 0.9);
    const A = 3.2e-3; // Phillips constant (tuned)
    const rnd = mulberry(4242);
    for (let c = 0; c < 2; c++) {
      const L = CASCADE_L[c];
      // band limits per cascade so they don't double count: c0 covers k < kSplit, c1 above
      const kSplit = (2 * Math.PI) / 3.2;
      const kLo = c === 0 ? kCut : kSplit;
      const kHi = c === 0 ? kSplit : (2 * Math.PI) / 0.06;
      const phil = (kx: number, kz: number) => {
        const k = Math.hypot(kx, kz);
        if (k < 1e-6) return 0;
        const lo = smooth(kLo * 0.8, kLo * 1.1, k);
        const hi = 1 - smooth(kHi * 0.9, kHi * 1.1, k);
        if (lo * hi <= 0) return 0;
        const cosw = (kx * wdx + kz * wdz) / k;
        // directional spreading: cos^2 with a small upwind part
        const dirf = cosw > 0 ? cosw * cosw : 0.07 * cosw * cosw;
        const l = 0.0012 * Lw;
        return (A * Math.exp(-1 / (k * Lw) ** 2) / k ** 4) * dirf * Math.exp(-(k * k) * l * l) * lo * hi;
      };
      const dk = (2 * Math.PI) / L;
      for (let y = 0; y < FFT_N; y++) {
        for (let x = 0; x < FFT_N; x++) {
          const mx = x < FFT_N / 2 ? x : x - FFT_N;
          const my = y < FFT_N / 2 ? y : y - FFT_N;
          const kx = mx * dk, kz = my * dk;
          const p = Math.sqrt(phil(kx, kz) / 2) * dk;
          const pm = Math.sqrt(phil(-kx, -kz) / 2) * dk;
          const [g1, g2] = gauss(rnd);
          const [g3, g4] = gauss(rnd);
          const i = (y * FFT_N * 2 + x + c * FFT_N) * 4;
          data[i] = g1 * p; data[i + 1] = g2 * p;
          // conj(h0(-k))
          data[i + 2] = g3 * pm; data[i + 3] = -g4 * pm;
        }
      }
    }
    this.h0Tex.needsUpdate = true;
    this.chop = 0.9;
  }

  update(renderer: THREE.WebGLRenderer, time: number): void {
    const sp = this.specPass.material.uniforms;
    sp.uTime.value = time;
    this.specPass.render(renderer, this.pingA);
    let src = this.pingA, dst = this.pingB;
    const fu = this.fftPass.material.uniforms;
    for (const horiz of [1, 0]) {
      for (let sub = 2; sub <= FFT_N; sub *= 2) {
        fu.uA.value = src.textures[0];
        fu.uB.value = src.textures[1];
        fu.uSub.value = sub;
        fu.uHorizontal.value = horiz;
        this.fftPass.render(renderer, dst);
        const t = src; src = dst; dst = t;
      }
    }
    const prev = this.outRT[this.cur];
    this.cur ^= 1;
    const out = this.outRT[this.cur];
    const fin = this.finalPass.material.uniforms;
    fin.uA.value = src.textures[0];
    fin.uB.value = src.textures[1];
    fin.uFoamPrev0.value = prev.textures[0];
    fin.uFoamPrev1.value = prev.textures[2];
    fin.uChop.value = this.chop;
    this.finalPass.render(renderer, out);
    this.disp[0] = out.textures[0];
    this.slope[0] = out.textures[1];
    this.disp[1] = out.textures[2];
    this.slope[1] = out.textures[3];
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
