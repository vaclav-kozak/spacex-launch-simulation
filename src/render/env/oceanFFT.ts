// High-frequency ocean detail: two Tessendorf FFT cascades (N=256, L≈61 m and ≈7.3 m) on the GPU
// (Stockham radix-2 in fragment shaders, both cascades side by side in one 2N×N float target).
// Low quality uses N=128 (4x fewer texels; cascade 1 loses the < ~13 cm capillaries, whose slope
// variance goes into the surface roughness instead).
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
uniform sampler2D uH0;      // (h0(k).re, h0(k).im, conj h0(-k).re, conj h0(-k).im) per texel, 2N x N
uniform float uTime;
in vec2 vUv;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
uniform float uN;
#define N uN
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
uniform float uN;
#define N uN
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
uniform float uN;
#define N uN
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
  private h0Tex!: THREE.DataTexture;
  private pingA!: THREE.WebGLRenderTarget;
  private pingB!: THREE.WebGLRenderTarget;
  private outRT: THREE.WebGLRenderTarget[] = [];
  private cur = 0;
  private specPass: FullscreenPass;
  private fftPass: FullscreenPass;
  private finalPass: FullscreenPass;
  private key = '';
  private conds: [WaveSet, number, number] | null = null;
  private uN = { value: FFT_N };
  /** grid size (256 at quality >= 2; 128 at low quality: 4x fewer texels, same bands except the
   * shortest capillaries of cascade 1, whose slope variance is returned in `lostSlopeVar`) */
  n = FFT_N;
  /** mean-square slope of the cascade-1 band dropped by a smaller grid (add to the roughness) */
  lostSlopeVar = 0;
  /** displacement (dx,dy,dz,foam) and slope textures per cascade — stable texture objects */
  disp: THREE.Texture[] = [];
  slope: THREE.Texture[] = [];
  /** choppiness */
  chop = 1.0;

  constructor(private maxAniso = 8, n = FFT_N) {
    const N = this.uN;
    this.specPass = new FullscreenPass(passMaterial(SPECTRUM_FRAG, { uH0: { value: null }, uTime: { value: 0 }, uL: { value: new THREE.Vector2(CASCADE_L[0], CASCADE_L[1]) }, uN: N }));
    this.fftPass = new FullscreenPass(passMaterial(FFT_FRAG, { uA: { value: null }, uB: { value: null }, uSub: { value: 2 }, uHorizontal: { value: 1 }, uN: N }));
    this.finalPass = new FullscreenPass(
      passMaterial(FINAL_FRAG, {
        uA: { value: null }, uB: { value: null }, uFoamPrev0: { value: null }, uFoamPrev1: { value: null },
        uChop: { value: 1 }, uFoamDecay: { value: 0.985 }, uFoamThresh: { value: 0.3 }, uN: N,
      }),
    );
    this.alloc(n);
  }

  /** (re)allocate the grid; rebuilds the spectrum for the last conditions */
  setSize(n: number): void {
    if (n === this.n && this.h0Tex) return;
    this.alloc(n);
    if (this.conds) this.setConditions(...this.conds);
  }

  private alloc(n: number): void {
    this.h0Tex?.dispose();
    this.pingA?.dispose();
    this.pingB?.dispose();
    for (const rt of this.outRT) rt.dispose();
    this.n = n;
    this.uN.value = n;
    this.key = '';
    this.h0Tex = new THREE.DataTexture(new Float32Array(n * 2 * n * 4), n * 2, n, THREE.RGBAFormat, THREE.FloatType);
    this.h0Tex.minFilter = this.h0Tex.magFilter = THREE.NearestFilter;
    this.h0Tex.needsUpdate = true;
    this.specPass.material.uniforms.uH0.value = this.h0Tex;
    const ping = () => makeRT(n * 2, n, { type: THREE.FloatType, count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as Partial<THREE.RenderTargetOptions>);
    this.pingA = ping();
    this.pingB = ping();
    const mk = () => {
      const rt = makeRT(n, n, {
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
        t.anisotropy = this.maxAniso;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
      }
      return rt;
    };
    this.outRT = [mk(), mk()];
    this.cur = 0;
    // expose textures of the "current" output; we render into outRT[cur] and point uniforms at it
    this.disp = [this.outRT[0].textures[0], this.outRT[0].textures[2]];
    this.slope = [this.outRT[0].textures[1], this.outRT[0].textures[3]];
  }

  /** (re)build the initial spectrum for the sea state / wind; kmin = cutoff below the Gerstner band */
  setConditions(set: WaveSet, windSpeed: number, windFromDeg: number): void {
    this.conds = [set, windSpeed, windFromDeg];
    const N = this.n;
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
    const kSplit = (2 * Math.PI) / 3.2;
    const kCap = (2 * Math.PI) / 0.06;
    // band limits per cascade so they don't double count: c0 covers k < kSplit, c1 above; a grid
    // smaller than 256 also stops cascade 1 below its Nyquist limit
    const band = (c: number, n: number): [number, number] => [
      c === 0 ? kCut : kSplit,
      c === 0 ? kSplit : n >= FFT_N ? kCap : Math.min(kCap, (0.9 * Math.PI * n) / CASCADE_L[1]),
    ];
    const phil = (kx: number, kz: number, kLo: number, kHi: number) => {
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
    // the random amplitudes are always drawn on the 256 grid (same stream), and a smaller grid keeps
    // the modes it can hold, so a 128 grid shows exactly the same waves minus the shortest ripples
    const F = FFT_N;
    for (let c = 0; c < 2; c++) {
      const L = CASCADE_L[c];
      const [kLo, kHi] = band(c, N);
      const dk = (2 * Math.PI) / L;
      for (let y = 0; y < F; y++) {
        for (let x = 0; x < F; x++) {
          const mx = x < F / 2 ? x : x - F;
          const my = y < F / 2 ? y : y - F;
          const [g1, g2] = gauss(rnd);
          const [g3, g4] = gauss(rnd);
          if (mx < -N / 2 || mx >= N / 2 || my < -N / 2 || my >= N / 2) continue;
          const kx = mx * dk, kz = my * dk;
          const p = Math.sqrt(phil(kx, kz, kLo, kHi) / 2) * dk;
          const pm = Math.sqrt(phil(-kx, -kz, kLo, kHi) / 2) * dk;
          const i = ((my < 0 ? my + N : my) * N * 2 + (mx < 0 ? mx + N : mx) + c * N) * 4;
          data[i] = g1 * p; data[i + 1] = g2 * p;
          // conj(h0(-k))
          data[i + 2] = g3 * pm; data[i + 3] = -g4 * pm;
        }
      }
    }
    // slope variance (x + z) of the cascade-1 band a small grid drops, vs the full 256 grid
    this.lostSlopeVar = 0;
    if (N < FFT_N) {
      const L = CASCADE_L[1], dk = (2 * Math.PI) / L;
      const [lo, hiFull] = band(1, FFT_N);
      const hiN = band(1, N)[1];
      let v = 0;
      for (let y = 0; y < FFT_N; y++)
        for (let x = 0; x < FFT_N; x++) {
          const kx = (x < FFT_N / 2 ? x : x - FFT_N) * dk, kz = (y < FFT_N / 2 ? y : y - FFT_N) * dk;
          const k2 = kx * kx + kz * kz;
          if (k2 < (hiN * 0.8) ** 2) continue;
          const d = phil(kx, kz, lo, hiFull) - phil(kx, kz, lo, hiN) + phil(-kx, -kz, lo, hiFull) - phil(-kx, -kz, lo, hiN);
          v += k2 * d * dk * dk * 0.8; // 0.8: matches the measured x+z slope variance drop of the packed IFFT
        }
      this.lostSlopeVar = v;
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
      for (let sub = 2; sub <= this.n; sub *= 2) {
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
