// Small post passes: linear depth, bloom chain, exposure metering, screen-space ghosts,
// procedural lens dirt, photo-mode DOF.
import { COMMON } from './common';

/** log / standard depth buffer -> linear view depth (m) into R32F */
export const LINEAR_DEPTH_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform float uLogFar;   // log2(far + 1)
uniform vec2 uNearFar;
uniform float uLogDepth;
void main() {
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
  float z;
  if (uLogDepth > 0.5) {
    z = exp2(d * uLogFar) - 1.0;
  } else {
    float n = uNearFar.x, f = uNearFar.y;
    float zn = d * 2.0 - 1.0;
    z = 2.0 * n * f / (f + n - zn * (f - n));
  }
  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}
`;

/** Jimenez 13-tap downsample (CoD:AW). First pass sanitizes NaN/Inf and soft-clamps fireflies
 * relative to the previous frame's exposure. */
export const BLOOM_DOWN_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform vec4 uSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uKaris;
uniform sampler2D tExp;
varying vec2 vUv;
vec3 S(vec2 uv) { return texture2D(tSrc, min(uv, uSrc.zw)).rgb; }
vec3 clean(vec3 c, float e) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  c = max(c, vec3(0.0));
  float l = luma(c) * e;
  // soft clamp: pixels far above white are compressed so single-pixel glints can't flicker the bloom
  const float K = 800.0;
  return l > K ? c * (K + log2(l / K) * K * 0.25) / l : c;
}
float kw(vec3 c, float e) { return 1.0 / (1.0 + luma(c) * e * 0.25); }
void main() {
  vec2 uv = vUv * uSrc.xy;
  vec2 t = uTexel;
  vec3 a = S(uv + t * vec2(-2.0, 2.0));
  vec3 b = S(uv + t * vec2(0.0, 2.0));
  vec3 c = S(uv + t * vec2(2.0, 2.0));
  vec3 d = S(uv + t * vec2(-2.0, 0.0));
  vec3 e = S(uv);
  vec3 f = S(uv + t * vec2(2.0, 0.0));
  vec3 g = S(uv + t * vec2(-2.0, -2.0));
  vec3 h = S(uv + t * vec2(0.0, -2.0));
  vec3 i = S(uv + t * vec2(2.0, -2.0));
  vec3 j = S(uv + t * vec2(-1.0, 1.0));
  vec3 k = S(uv + t * vec2(1.0, 1.0));
  vec3 l = S(uv + t * vec2(-1.0, -1.0));
  vec3 m = S(uv + t * vec2(1.0, -1.0));
  vec3 o;
  if (uFirst > 0.5) {
    float ex = texelFetch(tExp, ivec2(0), 0).g;
    ex = (ex > 0.0 && ex < 1e6) ? ex : 1.0;
    a = clean(a, ex); b = clean(b, ex); c = clean(c, ex); d = clean(d, ex); e = clean(e, ex);
    f = clean(f, ex); g = clean(g, ex); h = clean(h, ex); i = clean(i, ex); j = clean(j, ex);
    k = clean(k, ex); l = clean(l, ex); m = clean(m, ex);
    vec3 g0 = (j + k + l + m) * 0.25;
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    vec3 plain = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
    float w0 = kw(g0, ex) * 0.5, w1 = kw(g1, ex) * 0.125, w2 = kw(g2, ex) * 0.125;
    float w3 = kw(g3, ex) * 0.125, w4 = kw(g4, ex) * 0.125;
    vec3 karis = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    o = mix(plain, karis, uKaris);
  } else {
    o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(o, 1.0);
}
`;

/** 3x3 tent upsample of the lower mip, lerped with the current mip (energy conserving). */
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform vec4 uLow;
uniform vec2 uLowTexel;
uniform sampler2D tCur;
uniform vec4 uCur;
uniform float uScatter;
uniform float uRadius;
varying vec2 vUv;
vec3 L(vec2 uv) { return texture2D(tLow, min(max(uv, vec2(0.0)), uLow.zw)).rgb; }
void main() {
  vec2 uv = vUv * uLow.xy;
  vec2 t = uLowTexel * uRadius;
  vec3 s = L(uv) * 4.0;
  s += (L(uv + vec2(t.x, 0.0)) + L(uv - vec2(t.x, 0.0)) + L(uv + vec2(0.0, t.y)) + L(uv - vec2(0.0, t.y))) * 2.0;
  s += L(uv + t) + L(uv - t) + L(uv + vec2(t.x, -t.y)) + L(uv + vec2(-t.x, t.y));
  s *= 1.0 / 16.0;
  vec3 cur = texture2D(tCur, min(vUv * uCur.xy, uCur.zw)).rgb;
  gl_FragColor = vec4(mix(cur, s, uScatter), 1.0);
}
`;

/** Luminance histogram: 64 bins (x) x 8 row-stripes (y). Center-weighted. */
export const HIST_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform ivec2 uSize;
uniform float uAspect;
uniform float uMinLog;
uniform float uLogRange;
void main() {
  int bin = int(gl_FragCoord.x);
  int row = int(gl_FragCoord.y);
  float acc = 0.0;
  vec2 inv = 1.0 / vec2(uSize);
  for (int y = row; y < uSize.y; y += 8) {
    for (int x = 0; x < uSize.x; x++) {
      vec3 c = texelFetch(tSrc, ivec2(x, y), 0).rgb;
      float lg = log2(max(luma(c), 1e-9));
      int b = int(clamp((lg - uMinLog) / uLogRange, 0.0, 0.99999) * 64.0);
      if (b == bin) {
        vec2 p = (vec2(float(x), float(y)) + 0.5) * inv - 0.5;
        p.x *= uAspect;
        acc += 0.3 + exp(-dot(p, p) * 9.0);
      }
    }
  }
  gl_FragColor = vec4(acc, 0.0, 0.0, 1.0);
}
`;

/** Exposure adaptation (1x1). out: r = adapted log2 luminance, g = exposure multiplier,
 * b = measured sun luminance (scene-referred, occlusion-aware), a = subject depth (m). */
export const ADAPT_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tHist;
uniform sampler2D tPrev;
uniform float uMinLog;
uniform float uLogRange;
uniform vec4 uP;      // lowP, highP, hiP, hiHeadroom
uniform vec4 uClamp;  // minL, maxL, key, biasEV
uniform vec4 uAdapt;  // dt, speedUp, speedDown, reset
uniform vec4 uPrior;  // priorL, priorW, blackLog, manual(>0.5)
uniform float uManualL;
uniform vec4 uSun;    // uv.xy, radius (uv-y), onScreen
uniform sampler2D tBloom;
uniform vec4 uBloomX;
uniform sampler2D tDepth;
uniform vec4 uDepthX;
uniform float uSkyDepth;
uniform float uAspect;
uniform float uSubjOverride;

float histBin(int i) {
  float v = 0.0;
  for (int r = 0; r < 8; r++) v += texelFetch(tHist, ivec2(i, r), 0).r;
  return v;
}
void main() {
  float h[64];
  float total = 0.0, black = 0.0;
  for (int i = 0; i < 64; i++) {
    float v = histBin(i);
    h[i] = v;
    total += v;
    float lc = uMinLog + (float(i) + 0.5) / 64.0 * uLogRange;
    if (lc < uPrior.z) black += v;
  }
  float L;
  if (total > 0.0) {
    float lowW = uP.x * total, highW = uP.y * total, hiW = uP.z * total;
    float cum = 0.0, sumL = 0.0, sumW = 0.0, hiLog = uMinLog;
    bool found = false;
    for (int i = 0; i < 64; i++) {
      float v = h[i];
      float lc = uMinLog + (float(i) + 0.5) / 64.0 * uLogRange;
      float lo = max(cum, lowW), hi = min(cum + v, highW);
      if (hi > lo) { sumL += (hi - lo) * lc; sumW += hi - lo; }
      if (!found && cum + v >= hiW && v > 0.0) {
        hiLog = uMinLog + (float(i) + clamp((hiW - cum) / v, 0.0, 1.0)) / 64.0 * uLogRange;
        found = true;
      }
      cum += v;
    }
    float avgL = sumW > 0.0 ? sumL / sumW : uClamp.x;
    L = max(avgL, hiLog - uP.w);
    float blackFrac = black / total;
    float pw = uPrior.y * smoothstep(0.35, 0.85, blackFrac);
    L = mix(L, max(L, uPrior.x), pw);
  } else {
    L = uClamp.x;
  }
  L = clamp(L, uClamp.x, uClamp.y);
  if (uPrior.w > 0.5) L = uManualL;

  float prev = texelFetch(tPrev, ivec2(0), 0).r;
  float Ln;
  if (uAdapt.w > 0.5 || isnan(prev) || isinf(prev)) {
    Ln = L;
  } else {
    float rate = L > prev ? uAdapt.y : uAdapt.z;
    Ln = prev + (L - prev) * (1.0 - exp(-uAdapt.x * rate));
  }
  float exposure = uClamp.z / exp2(Ln) * exp2(uClamp.w);

  // sun: luminance at the disc (half-res bloom mip 0) x fraction of unoccluded depth taps
  float sunLum = 0.0;
  if (uSun.w > 0.5) {
    float vis = 0.0;
    for (int k = 0; k < 12; k++) {
      float a = float(k) * 2.39996;
      float rr = uSun.z * (k < 4 ? 0.35 : 0.85);
      vec2 o = vec2(cos(a) / uAspect, sin(a)) * rr;
      float d = texture2D(tDepth, rgn(uSun.xy + o, uDepthX)).r;
      vis += d > uSkyDepth ? 1.0 : 0.0;
    }
    vis /= 12.0;
    vec3 c = texture2D(tBloom, rgn(uSun.xy, uBloomX)).rgb;
    sunLum = luma(c) * vis;
  }
  // subject depth: nearest thing around the frame center
  float subj = 1e30;
  for (int y = 0; y < 5; y++) for (int x = 0; x < 5; x++) {
    vec2 p = vec2(0.4 + 0.05 * float(x), 0.4 + 0.05 * float(y));
    subj = min(subj, texture2D(tDepth, rgn(p, uDepthX)).r);
  }
  if (uSubjOverride > 0.0) subj = min(subj, uSubjOverride);
  gl_FragColor = vec4(Ln, exposure, sunLum, subj);
}
`;

/** Screen-space ghosts of bright (clipped) sources, e.g. a night plume. Quarter/eighth res. */
export const FLARE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform vec4 uSrc;
uniform sampler2D tExp;
uniform float uAspect;
uniform float uThreshold;
uniform vec4 uSunMask;  // sun uv, radius, on
varying vec2 vUv;
vec3 bright(vec2 uv, float ex) {
  vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  if (inb.x * inb.y < 0.5) return vec3(0.0);
  vec3 c = texture2D(tSrc, rgn(uv, uSrc)).rgb * ex;
  if (uSunMask.w > 0.5) {
    vec2 d = (uv - uSunMask.xy) * vec2(uAspect, 1.0);
    c *= smoothstep(uSunMask.z * 3.0, uSunMask.z * 6.0, length(d));
  }
  float l = luma(c);
  // fade toward the frame edge (vignetted rays don't make ghosts)
  vec2 e = min(uv, 1.0 - uv);
  float edge = smoothstep(0.0, 0.12, min(e.x, e.y));
  return c * (max(l - uThreshold, 0.0) / max(l, 1e-4)) * edge;
}
void main() {
  float ex = texelFetch(tExp, ivec2(0), 0).g;
  vec2 p = vUv - 0.5;
  vec3 acc = vec3(0.0);
  // ghost scale factors (negative = mirrored through the optical center), tints = coating colors
  const float SC0 = -0.62, SC1 = -1.35, SC2 = 0.45, SC3 = -2.4, SC4 = 1.7;
  const vec3 T0 = vec3(0.7, 0.82, 1.0), T1 = vec3(1.0, 0.86, 0.72), T2 = vec3(0.75, 1.0, 0.8);
  const vec3 T3 = vec3(0.9, 0.75, 1.0), T4 = vec3(1.0, 0.94, 0.82);
  float sc[5] = float[](SC0, SC1, SC2, SC3, SC4);
  vec3 tint[5] = vec3[](T0, T1, T2, T3, T4);
  // hexagonal ring of taps rounds the blocky low-res source into an aperture-like soft disc
  const vec2 RING[6] = vec2[](vec2(1.0, 0.0), vec2(0.5, 0.866), vec2(-0.5, 0.866),
                              vec2(-1.0, 0.0), vec2(-0.5, -0.866), vec2(0.5, -0.866));
  for (int i = 0; i < 5; i++) {
    float s = sc[i];
    vec3 g;
    g.r = bright(0.5 + p / (s * 1.006), ex).r;
    g.g = bright(0.5 + p / s, ex).g;
    g.b = bright(0.5 + p / (s * 0.994), ex).b;
    vec2 c = 0.5 + p / s;
    vec2 rr = vec2(0.010 / uAspect, 0.010) / abs(s);
    vec3 ring = vec3(0.0);
    for (int k = 0; k < 6; k++) ring += bright(c + RING[k] * rr, ex);
    g = g * 0.35 + ring * (0.65 / 6.0);
    acc += g * tint[i] / (s * s);
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;

/** Procedural lens dirt (dust specks, smudges, wipe streaks). Generated once. */
export const DIRT_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
float spots(vec2 uv, float cells, float seed, float minR, float maxR, float density) {
  vec2 g = uv * cells;
  vec2 id = floor(g);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 cid = id + vec2(float(x), float(y));
    float hh = hash12(cid + seed);
    if (hh > density) continue;
    vec2 c = cid + hash22(cid + seed * 1.7);
    float r = mix(minR, maxR, pow(hash12(cid + seed * 3.1), 2.0));
    float d = length(g - c);
    float disc = smoothstep(r, r * 0.55, d);
    float rim = smoothstep(r * 0.5, r * 0.92, d) * disc;
    acc += (disc * 0.55 + rim * 0.5) * mix(0.25, 1.0, hash12(cid + seed * 5.3));
  }
  return acc;
}
void main() {
  vec2 uv = vUv;
  float base = fbm(uv * 3.0) * 0.6 + fbm(uv * 11.0 + 4.0) * 0.4;
  base = smoothstep(0.42, 0.78, base) * 0.22;
  float s = spots(uv, 7.0, 1.0, 0.10, 0.42, 0.35) * 0.55
          + spots(uv, 19.0, 7.0, 0.08, 0.38, 0.45) * 0.45
          + spots(uv, 47.0, 13.0, 0.06, 0.32, 0.35) * 0.35
          + spots(uv, 110.0, 29.0, 0.1, 0.35, 0.25) * 0.25;
  float streak = fbm(vec2(uv.x * 1.6 + uv.y * 0.9, uv.y * 16.0 - uv.x * 3.0));
  streak = smoothstep(0.6, 0.82, streak) * 0.22;
  float edge = smoothstep(0.15, 0.75, length(uv - 0.5));
  float v = base + s + streak * (0.4 + edge);
  v *= 0.5 + 0.5 * edge;
  vec3 tint = mix(vec3(1.0, 0.96, 0.9), vec3(0.9, 0.96, 1.0), vnoise(uv * 3.0 + 9.0));
  gl_FragColor = vec4(v * tint, 1.0);
}
`;

/** Single-pass scatter-as-gather bokeh DOF (photo mode, after Gustafsson). Thin lens:
 * CoC(px) = A * |1/focus - 1/depth|, A = f^2 * imageHeightPx / (N * sensorHeight). */
export const DOF_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec4 uX;        // region transform (scene + depth share it)
uniform vec2 uTexel;    // 1/texSize
uniform vec4 uCoc;      // A, focus (m, <0 = autofocus on the frame center), maxRadius (px), radScale
varying vec2 vUv;
float gFocus;
float coc(float d) { return min(uCoc.x * abs(1.0 / gFocus - 1.0 / max(d, 0.01)), uCoc.z); }
void main() {
  gFocus = uCoc.y;
  if (gFocus < 0.0) {
    gFocus = 1e9;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
      gFocus = min(gFocus, texture2D(tDepth, rgn(vec2(0.5) + vec2(float(x), float(y)) * 0.02, uX)).r);
  }
  vec2 uv = rgn(vUv, uX);
  vec3 center = texture2D(tSrc, uv).rgb;
  float cd = texture2D(tDepth, uv).r;
  float cs = coc(cd);
  vec3 col = center;
  float tot = 1.0;
  float radius = uCoc.w;
  float ang = 0.0;
  for (int i = 0; i < 400; i++) {
    if (radius >= uCoc.z) break;
    vec2 tc = min(max(uv + vec2(cos(ang), sin(ang)) * uTexel * radius, vec2(0.0)), uX.zw);
    vec3 sc = texture2D(tSrc, tc).rgb;
    float sd = texture2D(tDepth, tc).r;
    float ss = coc(sd);
    if (sd > cd) ss = clamp(ss, 0.0, cs * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, ss);
    col += mix(col / tot, sc, m);
    tot += 1.0;
    radius += uCoc.w / radius;
    ang += 2.39996323;
  }
  gl_FragColor = vec4(col / tot, 1.0);
}
`;
