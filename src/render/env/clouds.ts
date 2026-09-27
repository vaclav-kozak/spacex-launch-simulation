// Volumetric clouds: coastal marine stratocumulus deck (~0.6-1.5 km) that burns off over the hills
// and breaks up offshore, plus scattered cumulus far offshore (weather model: cloudWeather.ts).
//
// Rendering: during the post pipeline's LAYER_VFX pass (the only time ctx.sceneDepth is valid) the
// composite mesh's onBeforeRender ray-marches the cloud shell at 1/2 (1/4 at quality 0) resolution
// into a per-view MRT target, stopping at the opaque scene depth, then resolves it temporally
// (reprojected history, neighbourhood clamp, depth rejection). The composite depth-aware upsamples
// and blends premultiplied into the HDR target; a second draw writes the cloud's median depth
// (where transmittance crosses 0.5) so VFX drawn later (plumes/smoke) behind thick cloud are
// depth-rejected, while plumes in front still draw over it.
//
// Lighting: atmosphere light (sun or moon, transmittance LUT + Earth shadow) through a short
// exponential light march with a 3-octave multiple-scattering approximation (Wrenninge/Hillaire),
// dual-lobe HG phase, sky irradiance from above, surface bounce from below, night glow and the
// plume point lights (ctx.plumeLights) so a night launch lights the deck from inside. Aerial
// perspective is applied at the opacity-weighted mean cloud distance.
//
// Per view (before the opaque pass) a cloud shadow map is traced along the key light over a box
// around the camera; it drives aerialCloudShadow() (earth, terrain and every patched lit material)
// and a tiny async-read probe gives the cloud transmittance toward the key light at the focus and
// at the camera (→ ctx.lighting.sunColor / sunVisibility).
//
// A rocket crossing the deck punches a hole that widens and drifts with the wind.
import * as THREE from 'three';
import { LAYER_VFX, type AppContext, type ViewInfo } from '../../core/context';
import type { SimSnapshot } from '../../core/types';
import { aerialUniforms } from './aerial';
import { AERIAL_LOOKUP_GLSL, ATMO_COMMON, IRR_LOOKUP_GLSL } from './atmosphere';
import { CLOUD_SHELL, CLOUD_TILE, CLOUD_WEATHER_GLSL, cloudWeatherUniforms } from './cloudWeather';
import { FullscreenPass, makeRT, passMaterial } from './gpu';

export { CLOUD_SHELL };

const MAX_PL = 4;
const NHOLES = 2;
const SHAPE_TILE = 3200;
const DETAIL_TILE = 480;
const EVO_WRAP = SHAPE_TILE * 3; // multiple of both noise tiles

/** density model shared by the view march, the shadow map and the light probe */
const CLOUD_DENSITY_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform vec3 uEvo;
uniform vec4 uHoles[${NHOLES}];
uniform float uSigma;
#define CL_BOT ${CLOUD_SHELL.bottom.toFixed(1)}
#define CL_TOP ${CLOUD_SHELL.top.toFixed(1)}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// ray (altitude h0, cos zenith mu) vs sphere of altitude H; x = near, y = far, y < x on a miss
vec2 shellHit(float h0, float mu, float H) {
  float r0 = ATM_R + h0;
  float b = r0 * mu;
  float c = (h0 - H) * (2.0 * ATM_R + h0 + H);
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  float s = sqrt(d);
  float q = -(b + (b >= 0.0 ? s : -s));
  float t1 = q, t2 = abs(q) > 1e-6 ? c / q : 0.0;
  return vec2(min(t1, t2), max(t1, t2));
}

// noise-space position: advected + domain-warped by the weather texel (breaks the 3.2 km tiling)
vec3 cldQ(vec2 xz, float h, vec4 w) {
  return vec3(xz.x + (w.b - 0.5) * 3000.0, h, xz.y + (w.r - 0.5) * 3000.0) + uEvo;
}

// cloud density 0..1 before detail erosion; hf = height fraction in the layer that won
float cldBase(vec3 q, float h, vec2 reg, vec4 w, out float hf) {
  hf = 0.0;
  // stratocumulus deck: flat base, lumpy top
  float scB = 620.0 + 180.0 * w.b;
  float scT = scB + 280.0 + 460.0 * w.a;
  float hs = (h - scB) / (scT - scB);
  float covS = clamp(reg.x * (0.55 + 0.9 * w.r), 0.0, 1.0);
  // cumulus: cells, towers taller where the cell is strong
  float covC = clamp(reg.y * (0.6 + 0.8 * w.r), 0.0, 1.0);
  float cell = smoothstep(1.0 - covC, 1.0 - covC + 0.3, w.g);
  float cuB = 800.0 + 160.0 * w.b;
  float cuT = cuB + cell * (450.0 + 2000.0 * w.a * w.a);
  float hc = (h - cuB) / max(cuT - cuB, 1.0);
  bool inS = hs > 0.0 && hs < 1.0 && covS > 0.02;
  bool inC = hc > 0.0 && hc < 1.0 && cell > 0.02;
  if (!inS && !inC) return 0.0;
  float s = texture(uShape, q * ${(1 / SHAPE_TILE).toExponential(8)}).r;
  float d = 0.0;
  if (inS) {
    // closed-cell organisation: cloud fills the ~2.5 km cells, rifts along the cell walls
    float ss = mix(s, w.g, 0.45);
    // lumpy tops via the coverage profile; flat (condensation-level) base via a density ramp only
    float cov = covS * (1.0 - smoothstep(0.3, 1.0, hs));
    d = clamp((ss - (1.0 - cov)) / max(cov, 1e-3), 0.0, 1.0) * sqrt(cov) * smoothstep(0.0, 0.1, hs);
    hf = hs;
  }
  if (inC) {
    float cov = cell * (1.0 - smoothstep(0.15, 1.0, hc));
    float dc = clamp((s - (1.0 - cov)) / max(cov, 1e-3), 0.0, 1.0) * sqrt(cov) * smoothstep(0.0, 0.05, hc);
    if (dc > d) { d = dc; hf = hc; }
  }
  return d;
}
float cldErode(float d, vec3 q, float hf) {
  float n = texture(uDetail, q * ${(1 / DETAIL_TILE).toExponential(8)}).r;
  float e = mix(n, 1.0 - n, clamp(hf * 2.5, 0.0, 1.0)) * 0.45;
  return clamp((d - e) / (1.0 - e), 0.0, 1.0);
}
float holeMask(vec2 xz) {
  float m = 1.0;
  for (int k = 0; k < ${NHOLES}; k++) {
    vec4 H = uHoles[k];
    if (H.w > 0.0) m *= 1.0 - H.w * (1.0 - smoothstep(H.z * 0.45, H.z, length(xz - H.xy)));
  }
  return m;
}
// coarse density at W horizontal xz (absolute) and altitude h
float cldCoarse(vec2 xz, float h) {
  if (h < CL_BOT || h > CL_TOP) return 0.0;
  vec2 reg = cldRegime(xz);
  if (reg.x + reg.y < 0.01) return 0.0;
  vec4 w = cldWeather(xz);
  float hf;
  return cldBase(cldQ(xz, h, w), h, reg, w, hf) * holeMask(xz);
}
`;

const MARCH_FRAG = /* glsl */ `
${ATMO_COMMON}
${IRR_LOOKUP_GLSL}
${AERIAL_LOOKUP_GLSL}
${CLOUD_WEATHER_GLSL}
${CLOUD_DENSITY_GLSL}
uniform float uCamAlt;
uniform vec3 uCamUp;
uniform vec3 uLightDir;
uniform vec3 uLightE;
uniform vec3 uNightGlow;
uniform sampler2D uDepthTex;
uniform vec2 uViewPx;
uniform float uScale;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform vec3 uOrigin;
uniform float uSteps;
uniform float uLSteps;
uniform float uMaxDist;
uniform float uDetailDist;
uniform float uOn;
uniform vec3 uPlPos[${MAX_PL}];
uniform vec3 uPlCol[${MAX_PL}];
uniform float uPlRange[${MAX_PL}];
uniform int uPlCount;
uniform float uFrame;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
// aux distances are stored log-encoded (half-float targets: raw metres overflow at 65504)
float auxE(float v) { return log2(1.0 + max(v, 0.0)); }
float auxD(float e) { return exp2(e) - 1.0; }

#define PI 3.14159265

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float phaseC(float c, float k) { return mix(hg(c, 0.8 * k), hg(c, -0.3 * k), 0.3); }

void main() {
  outColor = vec4(0.0);
  vec2 hpx = gl_FragCoord.xy;
  // min opaque depth over the full-res block this texel covers (conservative near edges)
  int sc = int(uScale);
  ivec2 b0 = ivec2(floor(hpx)) * sc;
  ivec2 vmax = ivec2(uViewPx) - 1;
  float D = 1e30;
  for (int j = 0; j < 4; j++) {
    if (j >= sc) break;
    for (int i = 0; i < 4; i++) {
      if (i >= sc) break;
      D = min(D, texelFetch(uDepthTex, min(b0 + ivec2(i, j), vmax), 0).r);
    }
  }
  outAux = vec4(auxE(D), 0.0, 0.0, 1.0);
  if (uOn < 0.5) return;

  vec2 ndc = (hpx * uScale) / uViewPx * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dv = normalize(v.xyz / v.w);
  vec3 dir = normalize(uCamRot * dv);
  float cosF = max(-dv.z, 1e-4);
  float sceneT = D > 1e7 ? 1e12 : D / cosF;

  float h0 = uCamAlt;
  float mu = dot(dir, uCamUp);
  vec2 top = shellHit(h0, mu, CL_TOP);
  vec2 bot = shellHit(h0, mu, CL_BOT);
  float t0, t1;
  if (h0 > CL_TOP) {
    if (top.y < top.x || top.y <= 0.0) return;
    t0 = max(top.x, 0.0);
    t1 = (bot.y >= bot.x && bot.x > 0.0) ? bot.x : top.y;
  } else if (h0 >= CL_BOT) {
    t0 = 0.0;
    t1 = (bot.y >= bot.x && bot.x > 0.0) ? bot.x : top.y;
  } else {
    t0 = bot.y;
    t1 = top.y;
  }
  float tEnd = min(min(t1, sceneT), uMaxDist);
  if (h0 >= CL_BOT && h0 <= CL_TOP) tEnd = min(tEnd, 60000.0);
  if (tEnd <= t0) return;

  float seg = tEnd - t0;
  outAux.z = auxE(t0 + 0.25 * seg);
  float pw = mix(1.0, 2.0, smoothstep(3000.0, 30000.0, seg));
  float N = uSteps;
  float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float r0 = ATM_R + h0;
  float nu = dot(dir, uLightDir);
  float ph0 = phaseC(nu, 1.0), ph1 = phaseC(nu, 0.5), ph2 = phaseC(nu, 0.25);
  vec3 L = vec3(0.0);
  float T = 1.0, tw = 0.0, tHalf = 0.0;
  float farFade = uMaxDist * 0.75;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= N) break;
    float fi = float(i);
    float u0 = pow(fi / N, pw), u1 = pow((fi + 1.0) / N, pw);
    float t = t0 + seg * pow((fi + jit) / N, pw);
    float dt = seg * (u1 - u0);
    vec3 rel = dir * t;
    float h = atmAltAt(h0, mu, t);
    if (h < CL_BOT || h > CL_TOP) continue;
    vec2 xz = uOrigin.xz + rel.xz;
    vec2 reg = cldRegime(xz);
    if (reg.x + reg.y < 0.01) continue;
    vec4 w = cldWeather(xz);
    vec3 q = cldQ(xz, h, w);
    float hf;
    float d = cldBase(q, h, reg, w, hf);
    if (d <= 0.0) continue;
    d *= holeMask(xz);
    if (t < uDetailDist) d = cldErode(d, q, hf);
    d *= 1.0 - smoothstep(farFade, uMaxDist, t);
    if (d <= 0.001) continue;
    float sig = d * uSigma;

    vec3 up = normalize(uCamUp * r0 + rel);
    float mus = dot(uLightDir, up);
    vec3 Es = uLightE * atmLightTrans(h, mus);
    float tau = 0.0;
    if (Es.r + Es.g + Es.b > 1e-12) {
      float lt = 0.0, dl = 18.0;
      for (int j = 0; j < 8; j++) {
        if (float(j) >= uLSteps) break;
        float s = lt + dl * 0.5;
        float hl = h + mus * s;
        vec2 xzl = xz + uLightDir.xz * s;
        float hf2;
        tau += cldBase(cldQ(xzl, hl, w), hl, reg, w, hf2) * uSigma * dl;
        lt += dl;
        dl *= 2.0;
      }
    }
    vec3 Ls = Es * (ph0 * exp(-tau) + 0.5 * ph1 * exp(-0.5 * tau) + 0.25 * ph2 * exp(-0.25 * tau));
    // ambient: sky from above (darker deeper down), surface bounce from below
    vec3 Esky = uLightE * atmSkyIrradiance(h, mus);
    vec3 amb = (Esky * (1.0 / PI) + uNightGlow) * (0.25 + 0.75 * hf);
    vec3 Eg = uLightE * (atmLightTrans(0.0, mus) * max(mus, 0.0) + atmSkyIrradiance(0.0, mus));
    amb += Eg * (0.08 / PI) * (1.0 - hf);
    // plume lights (isotropic, crude in-cloud attenuation)
    vec3 Lp = vec3(0.0);
    for (int k = 0; k < ${MAX_PL}; k++) {
      if (k >= uPlCount) break;
      vec3 lv = uPlPos[k] - rel;
      float d2 = dot(lv, lv);
      float dd = sqrt(d2);
      float win = pow(clamp(1.0 - pow(dd / uPlRange[k], 4.0), 0.0, 1.0), 2.0);
      Lp += uPlCol[k] * (win * exp(-sig * min(dd, 500.0) * 0.5) / max(d2, 400.0));
    }
    vec3 S = sig * (Ls + amb + Lp * (1.0 / (4.0 * PI)));
    float ex = exp(-sig * dt);
    L += T * (S - S * ex) / sig;
    float Tn = T * ex;
    tw += (T - Tn) * t;
    if (T >= 0.5 && Tn < 0.5) tHalf = t;
    T = Tn;
    if (T < 0.005) { T = 0.0; break; }
  }
  float a = 1.0 - T;
  if (a < 1e-4) return;
  vec3 ai, at;
  aerialLookup(dir * (tw / a), ai, at);
  outColor = vec4(L * at + ai * a, a);
  outAux.y = tHalf > 0.0 ? auxE(tHalf * cosF) : 0.0;
  outAux.z = auxE(tw / a);
}
`;

// cloud shadow map: per texel = ground point in a box around the camera; trace toward the key light
const SHADOW_FRAG = /* glsl */ `
${ATMO_COMMON}
${CLOUD_WEATHER_GLSL}
${CLOUD_DENSITY_GLSL}
uniform float uCamAlt;
uniform vec3 uCamUp;
uniform vec3 uOrigin;
uniform vec4 uBox;   // xy = box min (x,z) rel camera, z = size
uniform vec3 uKeyDir;
uniform float uShSteps;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 xzRel = uBox.xy + vUv * uBox.z;
  vec3 C = uCamUp * (ATM_R + uCamAlt);
  vec2 cxz = C.xz + xzRel;
  vec3 G = vec3(xzRel.x, sqrt(max(ATM_R * ATM_R - dot(cxz, cxz), 0.0)) - C.y, xzRel.y);
  vec3 up = normalize(C + G);
  float mu = dot(uKeyDir, up);
  outColor = vec4(1.0, 9000.0, 0.0, 1.0);
  if (mu < 0.02) return;
  float t0 = shellHit(0.0, mu, CL_BOT).y;
  float t1 = min(shellHit(0.0, mu, CL_TOP).y, t0 + 60000.0);
  // no per-texel jitter: it turns into a stipple pattern under bilinear filtering
  float N = uShSteps;
  float dt = (t1 - t0) / N;
  float tau = 0.0, hB = 9000.0, hT = 0.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= N) break;
    float t = t0 + (float(i) + 0.5) * dt;
    float h = atmAltAt(0.0, mu, t);
    vec2 xz = uOrigin.xz + G.xz + uKeyDir.xz * t;
    float d = cldCoarse(xz, h);
    if (d > 0.0) {
      tau += d * uSigma * dt;
      hB = min(hB, h);
      hT = max(hT, h);
    }
  }
  // transmittance (not optical depth) so bilinear filtering gives soft penumbrae instead of stair-steps
  outColor = vec4(exp(-tau), hB, hT, 1.0);
}
`;

// cloud transmittance toward the key light at the focus (x = 0) and at the camera (x = 1)
const PROBE_FRAG = /* glsl */ `
${ATMO_COMMON}
${CLOUD_WEATHER_GLSL}
${CLOUD_DENSITY_GLSL}
uniform float uCamAlt;
uniform vec3 uCamUp;
uniform vec3 uOrigin;
uniform vec3 uKeyDir;
uniform vec3 uFocusRel;
uniform float uFocusAlt;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  bool focus = gl_FragCoord.x < 1.0;
  vec3 P = focus ? uFocusRel : vec3(0.0);
  float h0 = focus ? uFocusAlt : uCamAlt;
  vec3 up = normalize(uCamUp * (ATM_R + uCamAlt) + P);
  float mu = dot(uKeyDir, up);
  outColor = vec4(1.0);
  if (h0 > CL_TOP) return;
  float t0 = h0 < CL_BOT ? max(shellHit(h0, mu, CL_BOT).y, 0.0) : 0.0;
  float t1 = shellHit(h0, mu, CL_TOP).y;
  if (!(t1 > t0)) return;
  t1 = min(t1, t0 + 60000.0);
  const float N = 32.0;
  float dt = (t1 - t0) / N;
  float tau = 0.0;
  for (int i = 0; i < 32; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    float h = atmAltAt(h0, mu, t);
    vec2 xz = uOrigin.xz + P.xz + uKeyDir.xz * t;
    tau += cldCoarse(xz, h) * uSigma * dt;
  }
  outColor = vec4(vec3(exp(-tau)), 1.0);
}
`;

// temporal resolve (low res): reproject the history by the cloud's mean distance, clamp it to the
// current 3x3 neighbourhood, reject it where the opaque depth changed (moving vehicles)
const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D uRaw;
uniform sampler2D uRawAux;
uniform sampler2D uHist;
uniform sampler2D uHistAux;
uniform vec2 uLowSize;
uniform vec2 uViewPx;
uniform float uScale;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform mat4 uPrevViewProj;
uniform vec3 uCamDelta;
uniform float uHistOn;
uniform float uBlend;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
// aux distances are stored log-encoded (half-float targets: raw metres overflow at 65504)
float auxE(float v) { return log2(1.0 + max(v, 0.0)); }
float auxD(float e) { return exp2(e) - 1.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 imax = ivec2(uLowSize) - 1;
  vec4 c = texelFetch(uRaw, p, 0);
  vec4 x = texelFetch(uRawAux, p, 0);
  outColor = c;
  outAux = x;
  if (uHistOn < 0.5 || x.z <= 0.0) return;
  // neighbourhood bounds from texels at the same opaque depth (silhouette texels that stopped at a
  // nearer surface would otherwise let the history fade toward them)
  float Dc = min(auxD(x.x), 1e7);
  vec4 mn = c, mx = c;
  for (int k = 0; k < 9; k++) {
    if (k == 4) continue;
    ivec2 q = clamp(p + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), imax);
    float Dn = min(auxD(texelFetch(uRawAux, q, 0).x), 1e7);
    if (abs(Dn - Dc) > 0.1 * max(min(Dn, Dc), 1.0)) continue;
    vec4 n = texelFetch(uRaw, q, 0);
    mn = min(mn, n);
    mx = max(mx, n);
  }
  vec2 ndc = (gl_FragCoord.xy * uScale) / uViewPx * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dir = normalize(uCamRot * normalize(v.xyz / v.w));
  vec4 cp = uPrevViewProj * vec4(dir * auxD(x.z) + uCamDelta, 1.0);
  if (cp.w <= 0.0) return;
  vec2 uv = cp.xy / cp.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return;
  // depth-aware bilinear history fetch: only texels that saw the same opaque depth
  vec2 hp = uv * uViewPx / uScale - 0.5;
  vec2 hf = fract(hp);
  ivec2 h0 = ivec2(floor(hp));
  vec4 hacc = vec4(0.0);
  float hw = 0.0, hy = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 q = clamp(h0 + o, ivec2(0), imax);
    vec4 hx = texelFetch(uHistAux, q, 0);
    float Dh = min(auxD(hx.x), 1e7);
    if (abs(Dh - Dc) > 0.1 * max(min(Dh, Dc), 1.0)) continue;
    float w = (o.x == 0 ? 1.0 - hf.x : hf.x) * (o.y == 0 ? 1.0 - hf.y : hf.y) + 1e-4;
    hacc += texelFetch(uHist, q, 0) * w;
    hy += hx.y * w;
    hw += w;
  }
  if (hw <= 0.0) return;
  vec4 h = clamp(hacc / hw, mn, mx);
  outColor = mix(h, c, uBlend);
  hy /= hw;
  outAux.y = x.y > 0.0 && hy > 0.0 ? mix(hy, x.y, 0.3) : x.y;
}
`;

const COMP_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMP_FRAG = /* glsl */ `
uniform sampler2D uCloud;
uniform sampler2D uAux;
uniform sampler2D uDepthTex;
uniform vec2 uLowSize;
uniform float uScale;
uniform float uMsaaEdge;
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
uniform float logDepthBufFC;
#endif
// aux distances are stored log-encoded (half-float targets: raw metres overflow at 65504)
float auxE(float v) { return log2(1.0 + max(v, 0.0)); }
float auxD(float e) { return exp2(e) - 1.0; }
void main() {
  vec2 fc = gl_FragCoord.xy;
  ivec2 pc = ivec2(fc);
  float D0 = min(texelFetch(uDepthTex, pc, 0).r, 1e7);
  float D = D0;
  float edgeK = 1.0;
#ifndef DEPTH_PASS
  // MSAA (quality 3): a silhouette pixel's resolved colour is part background while its depth is the
  // nearer surface; composite the background's cloud at ~half coverage so no un-clouded sky rim shows
  if (uMsaaEdge > 0.5) {
    ivec2 pm = textureSize(uDepthTex, 0) - 1;
    float Df = max(
      max(texelFetch(uDepthTex, min(pc + ivec2(1, 0), pm), 0).r, texelFetch(uDepthTex, max(pc - ivec2(1, 0), ivec2(0)), 0).r),
      max(texelFetch(uDepthTex, min(pc + ivec2(0, 1), pm), 0).r, texelFetch(uDepthTex, max(pc - ivec2(0, 1), ivec2(0)), 0).r));
    Df = min(Df, 1e7);
    if (Df > D0 * 1.5) { D = Df; edgeK = 0.5; }
  }
#endif
  vec2 hp = fc / uScale - 0.5;
  vec2 fl = floor(hp);
  vec2 f = hp - fl;
  ivec2 i0 = ivec2(fl);
  ivec2 imax = ivec2(uLowSize) - 1;
  vec4 acc = vec4(0.0);
  float ws = 0.0, best = -1.0, cd = 0.0, rdMin = 1e9;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 ij = clamp(i0 + o, ivec2(0), imax);
    vec4 c = texelFetch(uCloud, ij, 0);
    vec2 x = texelFetch(uAux, ij, 0).xy;
    float bw = (o.x == 0 ? 1.0 - f.x : f.x) * (o.y == 0 ? 1.0 - f.y : f.y);
    float dh = min(auxD(x.x), 1e7);
    float rd = abs(dh - D) / max(min(dh, D), 0.5);
    rdMin = min(rdMin, rd);
    float w = bw / (1e-3 + rd * rd * 8.0) + 1e-6;
    acc += c * w;
    ws += w;
    if (w > best) { best = w; cd = auxD(x.y); }
  }
  // no tap at this pixel's depth (silhouettes: the low-res texels took the nearer surface's depth):
  // widen the search to 4x4 and take the depth-matching texels
  if (rdMin > 0.1) {
    vec4 acc2 = vec4(0.0);
    float ws2 = 0.0, best2 = -1.0, cd2 = 0.0;
    for (int k = 0; k < 16; k++) {
      ivec2 o = ivec2(k & 3, k >> 2) - 1;
      ivec2 ij = clamp(i0 + o, ivec2(0), imax);
      vec2 x = texelFetch(uAux, ij, 0).xy;
      float dh = min(auxD(x.x), 1e7);
      float rd = abs(dh - D) / max(min(dh, D), 0.5);
      if (rd > 0.1) continue;
      vec2 dp = vec2(o) - f;
      float w = 1.0 / (1.0 + dot(dp, dp));
      acc2 += texelFetch(uCloud, ij, 0) * w;
      ws2 += w;
      if (w > best2) { best2 = w; cd2 = auxD(x.y); }
    }
    if (ws2 > 0.0) { acc = acc2; ws = ws2; cd = cd2; }
  }
  vec4 c = acc / ws;
#ifdef DEPTH_PASS
  if (c.a < 0.6 || cd <= 0.0 || cd >= D0) discard;
  gl_FragColor = vec4(0.0);
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    gl_FragDepth = log2(1.0 + cd) * logDepthBufFC * 0.5;
  #else
    gl_FragDepth = gl_FragCoord.z;
  #endif
#else
  c *= edgeK;
  if (c.a < 1e-4) discard;
  gl_FragColor = c;
#endif
}
`;

interface ViewRT {
  raw: THREE.WebGLRenderTarget;
  hist: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  cur: number;
  w: number;
  h: number;
  valid: boolean;
  prevViewProj: THREE.Matrix4;
  prevCamW: THREE.Vector3;
  prevFwd: THREE.Vector3;
  lastFrame: number;
}
interface ViewShadow {
  rt: THREE.WebGLRenderTarget | null;
  size: number;
  probe: THREE.WebGLRenderTarget;
  buf: Uint8Array;
  pending: boolean;
  focusT: number;
  camT: number;
  targetFocusT: number;
  targetCamT: number;
}
interface Hole { x: number; z: number; t0: number }

function tex3D(data: Uint8Array, n: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const _vp = new THREE.Vector4();
const _fwd = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Clouds {
  readonly marchMat: THREE.ShaderMaterial;
  readonly composite: THREE.Mesh;
  readonly depthMesh: THREE.Mesh;
  /** 0..1: volumetric clouds active for the current view (fades out at high altitude) */
  volumetricOn = 1;
  /** max ray distance (m) for the current view — beyond it the globe's 2D layer takes over */
  maxDist = 120_000;
  private march: FullscreenPass;
  private resolve: FullscreenPass;
  private resolveMat: THREE.ShaderMaterial;
  private shadowPass: FullscreenPass;
  private shadowMat: THREE.ShaderMaterial;
  private probePass: FullscreenPass;
  private probeMat: THREE.ShaderMaterial;
  private frameNo = 0;
  private renderFrame = 0;
  private compMat: THREE.ShaderMaterial;
  private depthMat: THREE.ShaderMaterial;
  private rts = new Map<string, ViewRT>();
  private shadows = new Map<string, ViewShadow>();
  private viewId = '';
  private scale = 2;
  private q = 2;
  private ready = false;
  private windVel = new THREE.Vector2(); // cloud-level wind (x east, z south) m/s
  private holes: (Hole | null)[] = [null, null];
  private prevS1Alt = NaN;
  private prevT = 0;
  private shadowOff = false;

  constructor(private ctx: AppContext, shared: Record<string, THREE.IUniform>) {
    try {
      const p = new URLSearchParams(window.location.search).get('clouds');
      const v = p !== null && p !== '' ? Number(p) : NaN;
      if (Number.isFinite(v)) cloudWeatherUniforms.uCldCover.value = Math.max(0, Math.min(1.5, v));
      this.shadowOff = new URLSearchParams(window.location.search).get('cshadow') === '0';
    } catch {
      /* no window */
    }
    const density = {
      uShape: { value: null as THREE.Texture | null },
      uDetail: { value: null as THREE.Texture | null },
      uEvo: { value: new THREE.Vector3() },
      uHoles: { value: Array.from({ length: NHOLES }, () => new THREE.Vector4()) },
      uSigma: { value: 0.06 },
    };
    const wu = cloudWeatherUniforms as unknown as Record<string, THREE.IUniform>;
    const origin = { value: new THREE.Vector3() };
    this.marchMat = passMaterial(MARCH_FRAG, {
      ...shared,
      ...wu,
      ...density,
      uNightGlow: { value: new THREE.Vector3() },
      uDepthTex: { value: null },
      uViewPx: { value: new THREE.Vector2(1, 1) },
      uScale: { value: 2 },
      uInvProj: { value: new THREE.Matrix4() },
      uCamRot: { value: new THREE.Matrix3() },
      uOrigin: origin,
      uSteps: { value: 48 },
      uLSteps: { value: 5 },
      uMaxDist: { value: 120_000 },
      uDetailDist: { value: 20_000 },
      uOn: { value: 1 },
      uPlPos: { value: Array.from({ length: MAX_PL }, () => new THREE.Vector3()) },
      uPlCol: { value: Array.from({ length: MAX_PL }, () => new THREE.Vector3()) },
      uPlRange: { value: new Array(MAX_PL).fill(1) },
      uPlCount: { value: 0 },
      uFrame: { value: 0 },
    });
    this.march = new FullscreenPass(this.marchMat);
    this.resolveMat = passMaterial(RESOLVE_FRAG, {
      uRaw: { value: null },
      uRawAux: { value: null },
      uHist: { value: null },
      uHistAux: { value: null },
      uLowSize: { value: new THREE.Vector2(1, 1) },
      uViewPx: { value: new THREE.Vector2(1, 1) },
      uScale: { value: 2 },
      uInvProj: { value: new THREE.Matrix4() },
      uCamRot: { value: new THREE.Matrix3() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamDelta: { value: new THREE.Vector3() },
      uHistOn: { value: 0 },
      uBlend: { value: 0.07 },
    });
    this.resolve = new FullscreenPass(this.resolveMat);
    const keyDir = { value: new THREE.Vector3(0, 1, 0) };
    const camU = { uCamAlt: shared.uCamAlt, uCamUp: shared.uCamUp, uTransLUT: shared.uTransLUT, uMsLUT: shared.uMsLUT };
    this.shadowMat = passMaterial(SHADOW_FRAG, { ...camU, ...wu, ...density, uOrigin: origin, uBox: { value: new THREE.Vector4() }, uKeyDir: keyDir, uShSteps: { value: 16 } });
    this.shadowPass = new FullscreenPass(this.shadowMat);
    this.probeMat = passMaterial(PROBE_FRAG, {
      ...camU, ...wu, ...density, uOrigin: origin, uKeyDir: keyDir,
      uFocusRel: { value: new THREE.Vector3() }, uFocusAlt: { value: 0 },
    });
    this.probePass = new FullscreenPass(this.probeMat);

    const cu = {
      uCloud: { value: null as THREE.Texture | null },
      uAux: { value: null as THREE.Texture | null },
      uDepthTex: { value: null as THREE.Texture | null },
      uLowSize: { value: new THREE.Vector2(1, 1) },
      uScale: { value: 2 },
      uMsaaEdge: { value: 0 },
    };
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: COMP_VERT,
      fragmentShader: COMP_FRAG,
      uniforms: cu,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: COMP_VERT,
      fragmentShader: COMP_FRAG,
      uniforms: cu,
      defines: { DEPTH_PASS: 1 },
      transparent: true,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessEqualDepth,
      colorWrite: false,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.composite = new THREE.Mesh(tri, this.compMat);
    this.depthMesh = new THREE.Mesh(tri, this.depthMat);
    for (const m of [this.composite, this.depthMesh]) {
      m.frustumCulled = false;
      m.layers.set(LAYER_VFX);
      m.userData.noAerial = true;
      m.visible = false;
      m.matrixAutoUpdate = false;
    }
    this.composite.name = 'env.clouds';
    this.depthMesh.name = 'env.cloudsDepth';
    this.composite.renderOrder = -100;
    this.depthMesh.renderOrder = -99;
    this.composite.onBeforeRender = (r, _s, cam) => this.runMarch(r, cam as THREE.PerspectiveCamera);
    ctx.scene.add(this.composite, this.depthMesh);
  }

  async load(): Promise<void> {
    const get = async (name: string) => new Uint8Array(await (await fetch(`/data/env/${name}`)).arrayBuffer());
    const [shape, detail, weather] = await Promise.all([get('cloud_shape.bin'), get('cloud_detail.bin'), get('cloud_weather.bin')]);
    if (shape.length !== 128 ** 3 || detail.length !== 32 ** 3 || weather.length !== 512 * 512 * 4) throw new Error('cloud noise size');
    this.marchMat.uniforms.uShape.value = tex3D(shape, 128);
    this.marchMat.uniforms.uDetail.value = tex3D(detail, 32);
    const w = new THREE.DataTexture(weather, 512, 512, THREE.RGBAFormat, THREE.UnsignedByteType);
    w.wrapS = w.wrapT = THREE.RepeatWrapping;
    w.minFilter = THREE.LinearMipmapLinearFilter;
    w.magFilter = THREE.LinearFilter;
    w.generateMipmaps = true;
    w.colorSpace = THREE.NoColorSpace;
    w.needsUpdate = true;
    cloudWeatherUniforms.uCldWeather.value = w;
    this.ready = true;
  }

  /** regional land mask (drives the coastal regime); the global cloud texture is used by the globe */
  setGlobalCoverage(_clouds: THREE.Texture, maskReg?: THREE.Texture): void {
    if (maskReg) cloudWeatherUniforms.uCldMask.value = maskReg;
  }

  setWind(speed: number, fromDeg: number): void {
    // wind at cloud level ~1.3x the 10 m wind, blowing toward fromDeg + 180
    const a = (fromDeg * Math.PI) / 180;
    const s = Math.max(1.5, speed * 1.3);
    this.windVel.set(-Math.sin(a) * s, Math.cos(a) * s);
  }

  update(snap: SimSnapshot, _dt: number): void {
    const t = snap.envT ?? snap.t;
    this.renderFrame++;
    if (Math.abs(t - this.prevT) > 5) this.resetHistory(); // seek / replay jump
    this.prevT = t;
    const wv = this.windVel;
    const wx = -wv.x * t, wz = -wv.y * t;
    cloudWeatherUniforms.uCldWind.value.set(wx - Math.floor(wx / CLOUD_TILE) * CLOUD_TILE, wz - Math.floor(wz / CLOUD_TILE) * CLOUD_TILE);
    const wrap = (v: number) => v - Math.floor(v / EVO_WRAP) * EVO_WRAP;
    this.marchMat.uniforms.uEvo.value.set(wrap(-wv.x * t * 1.1), wrap(-0.6 * t), wrap(-wv.y * t * 1.1));

    // rocket punch-through: remember where S1 crossed the deck (ascent / descent)
    const s1 = snap.bodies?.S1;
    if (s1 && s1.status !== 'gone') {
      const alt = s1.altitude;
      if (Number.isFinite(this.prevS1Alt)) {
        if (this.prevS1Alt < 1000 && alt >= 1000 && !this.holes[0]) this.holes[0] = { x: s1.pos.x, z: s1.pos.z, t0: snap.t };
        if (this.prevS1Alt > CLOUD_SHELL.top && alt <= CLOUD_SHELL.top && snap.t > 60 && !this.holes[1]) this.holes[1] = { x: s1.pos.x, z: s1.pos.z, t0: snap.t };
      }
      this.prevS1Alt = alt;
    }
    const hu = this.marchMat.uniforms.uHoles.value as THREE.Vector4[];
    for (let i = 0; i < NHOLES; i++) {
      const h = this.holes[i];
      if (h && snap.t < h.t0 - 0.5) this.holes[i] = null; // seeked back
      const hh = this.holes[i];
      if (!hh) { hu[i].set(0, 0, 1, 0); continue; }
      const age = Math.max(0, snap.t - hh.t0);
      const r = Math.min(600, 45 + 28 * Math.sqrt(age));
      const s = (i === 0 ? 0.97 : 0.8) * Math.min(1, age * 2 + 0.3) * (1 - THREE.MathUtils.smoothstep(age, 400, 1200));
      hu[i].set(hh.x + wv.x * age, hh.z + wv.y * age, r, s);
    }
  }

  /** true when the volumetric pass will draw for the current view */
  get active(): boolean {
    return this.composite.visible;
  }

  /** per-view setup of the view march (runs later, inside the LAYER_VFX pass) */
  beforeViewRender(view: ViewInfo, camAlt: number, _lightDir: THREE.Vector3, _lightE: THREE.Color, q: number, glow?: THREE.Vector3): void {
    const ctx = this.ctx;
    this.viewId = view.id;
    this.q = q;
    const mu = this.marchMat.uniforms;
    if (glow) mu.uNightGlow.value.copy(glow);
    // volumetric up to ~60 km camera altitude; the globe's 2D layer takes over above / beyond maxDist
    this.volumetricOn = 1 - THREE.MathUtils.smoothstep(camAlt, 40_000, 70_000);
    const on = this.ready && this.volumetricOn > 0.001 && cloudWeatherUniforms.uCldCover.value > 0.001;
    this.composite.visible = on;
    this.depthMesh.visible = on;
    this.scale = q <= 0 ? 4 : 2;
    mu.uSteps.value = [24, 32, 44, 60][q] ?? 44;
    mu.uLSteps.value = [3, 4, 5, 6][q] ?? 5;
    this.maxDist = Math.min(400_000, ([70_000, 100_000, 130_000, 160_000][q] ?? 130_000) + 3 * camAlt);
    mu.uMaxDist.value = this.maxDist;
    mu.uDetailDist.value = [8_000, 15_000, 25_000, 35_000][q] ?? 25_000;
    mu.uOrigin.value.copy(ctx.renderOrigin);
    mu.uOn.value = on ? 1 : 0;
    const pls = ctx.plumeLights;
    let n = 0;
    for (let i = 0; i < pls.length && n < MAX_PL; i++) {
      const p = pls[i];
      (mu.uPlPos.value[n] as THREE.Vector3).copy(p.pos).sub(ctx.renderOrigin);
      (mu.uPlCol.value[n] as THREE.Vector3).set(p.color.r, p.color.g, p.color.b);
      mu.uPlRange.value[n] = p.range;
      n++;
    }
    mu.uPlCount.value = n;
  }

  /**
   * Cloud shadow map + light probe for the current view (call after beforeViewRender, before the
   * opaque pass). keyDir = the shadow-casting DirectionalLight direction (toward the light).
   * Returns nothing; read focusTransmittance() / cameraTransmittance() (async, ~2 frames late).
   */
  updateShadow(renderer: THREE.WebGLRenderer, keyDir: THREE.Vector3, focusPos: THREE.Vector3, focusAlt: number, camAlt: number): void {
    const au = aerialUniforms;
    let vs = this.shadows.get(this.viewId);
    if (!vs) {
      const probe = new THREE.WebGLRenderTarget(2, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
      probe.texture.generateMipmaps = false;
      vs = { rt: null, size: 0, probe, buf: new Uint8Array(8), pending: false, focusT: 1, camT: 1, targetFocusT: 1, targetCamT: 1 };
      this.shadows.set(this.viewId, vs);
    }
    if (!this.active || this.shadowOff) {
      au.uCloudShadowBox.value.w = 0;
      vs.targetFocusT = vs.targetCamT = 1;
      vs.focusT += (1 - vs.focusT) * 0.2;
      vs.camT += (1 - vs.camT) * 0.2;
      return;
    }
    const origin = this.ctx.renderOrigin;
    const n = [256, 384, 512, 1024][this.q] ?? 512;
    if (!vs.rt || vs.size !== n) {
      vs.rt?.dispose();
      vs.rt = makeRT(n, n);
      vs.size = n;
    }
    const half = THREE.MathUtils.clamp(12_000 + 2.5 * camAlt, 12_000, 150_000);
    const texel = (2 * half) / n;
    const x0 = Math.floor((origin.x - half) / texel) * texel;
    const z0 = Math.floor((origin.z - half) / texel) * texel;
    const su = this.shadowMat.uniforms;
    su.uBox.value.set(x0 - origin.x, z0 - origin.z, 2 * half, 0);
    su.uKeyDir.value.copy(keyDir);
    su.uShSteps.value = [12, 16, 24, 24][this.q] ?? 16;
    this.shadowPass.render(renderer, vs.rt);
    au.uCloudShadow.value = vs.rt.texture;
    au.uCloudShadowBox.value.set(x0 - origin.x, z0 - origin.z, 1 / (2 * half), 1);
    au.uCloudShadowDir.value.copy(keyDir);

    // probe (every 3rd frame, async readback)
    if (!vs.pending && this.renderFrame % 3 === 0) {
      const pu = this.probeMat.uniforms;
      pu.uFocusRel.value.copy(focusPos).sub(origin);
      pu.uFocusAlt.value = focusAlt;
      this.probePass.render(renderer, vs.probe);
      vs.pending = true;
      const v = vs;
      renderer
        .readRenderTargetPixelsAsync(vs.probe, 0, 0, 2, 1, vs.buf)
        .then(() => {
          v.targetFocusT = v.buf[0] / 255;
          v.targetCamT = v.buf[4] / 255;
        })
        .catch(() => {
          v.targetFocusT = v.targetCamT = 1;
        })
        .finally(() => {
          v.pending = false;
        });
    }
    vs.focusT += (vs.targetFocusT - vs.focusT) * 0.25;
    vs.camT += (vs.targetCamT - vs.camT) * 0.25;
  }

  /** cloud transmittance toward the key light at the current view's focus (0..1) */
  focusTransmittance(): number {
    return this.shadows.get(this.viewId)?.focusT ?? 1;
  }

  /** cloud transmittance toward the key light at the current view's camera (0..1) */
  cameraTransmittance(): number {
    return this.shadows.get(this.viewId)?.camT ?? 1;
  }

  private runMarch(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const depth = this.ctx.sceneDepth.texture;
    const cu = this.compMat.uniforms;
    if (!depth || !this.ready) {
      cu.uCloud.value = null;
      return;
    }
    renderer.getCurrentViewport(_vp);
    const w = Math.max(1, Math.round(_vp.z)), h = Math.max(1, Math.round(_vp.w));
    const s = this.scale;
    const lw = Math.ceil(w / s), lh = Math.ceil(h / s);
    let vr = this.rts.get(this.viewId);
    if (!vr || vr.w !== lw || vr.h !== lh) {
      if (vr) { vr.raw.dispose(); vr.hist[0].dispose(); vr.hist[1].dispose(); }
      const mk = (filter: THREE.MagnificationTextureFilter) =>
        makeRT(lw, lh, { count: 2, minFilter: filter, magFilter: filter } as Partial<THREE.RenderTargetOptions>);
      vr = {
        raw: mk(THREE.NearestFilter),
        hist: [mk(THREE.LinearFilter), mk(THREE.LinearFilter)],
        cur: 0, w: lw, h: lh, valid: false,
        prevViewProj: new THREE.Matrix4(), prevCamW: new THREE.Vector3(), prevFwd: new THREE.Vector3(),
        lastFrame: -10,
      };
      this.rts.set(this.viewId, vr);
    }
    const origin = this.ctx.renderOrigin;
    _fwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    _d.copy(origin).sub(vr.prevCamW);
    const histOk = vr.valid && vr.lastFrame >= this.renderFrame - 2 && _d.length() < 3000 && _fwd.dot(vr.prevFwd) > 0.8;

    const mu = this.marchMat.uniforms;
    mu.uDepthTex.value = depth;
    mu.uViewPx.value.set(w, h);
    mu.uScale.value = s;
    mu.uInvProj.value.copy(camera.projectionMatrixInverse);
    mu.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    mu.uFrame.value = this.frameNo++ % 1024;
    this.march.render(renderer, vr.raw);

    const ru = this.resolveMat.uniforms;
    const prev = vr.hist[vr.cur];
    const next = vr.hist[1 - vr.cur];
    ru.uRaw.value = vr.raw.textures[0];
    ru.uRawAux.value = vr.raw.textures[1];
    ru.uHist.value = prev.textures[0];
    ru.uHistAux.value = prev.textures[1];
    ru.uLowSize.value.set(lw, lh);
    ru.uViewPx.value.set(w, h);
    ru.uScale.value = s;
    ru.uInvProj.value.copy(camera.projectionMatrixInverse);
    ru.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    ru.uPrevViewProj.value.copy(vr.prevViewProj);
    ru.uCamDelta.value.copy(_d);
    ru.uHistOn.value = histOk ? 1 : 0;
    this.resolve.render(renderer, next);
    vr.cur = 1 - vr.cur;
    vr.valid = true;
    vr.lastFrame = this.renderFrame;
    vr.prevCamW.copy(origin);
    vr.prevFwd.copy(_fwd);
    vr.prevViewProj.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);

    cu.uCloud.value = next.textures[0];
    cu.uAux.value = next.textures[1];
    cu.uDepthTex.value = depth;
    cu.uLowSize.value.set(lw, lh);
    cu.uScale.value = s;
    // PostPipeline renders quality 3 with 4x MSAA
    cu.uMsaaEdge.value = this.q >= 3 ? 1 : 0;
  }

  /** invalidate temporal history (time-of-day change, seek) */
  resetHistory(): void {
    for (const v of this.rts.values()) v.valid = false;
  }

  dispose(): void {
    for (const v of this.rts.values()) { v.raw.dispose(); v.hist[0].dispose(); v.hist[1].dispose(); }
    for (const v of this.shadows.values()) { v.rt?.dispose(); v.probe.dispose(); }
    this.rts.clear();
    this.shadows.clear();
  }
}
