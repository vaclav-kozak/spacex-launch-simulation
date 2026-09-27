// Physically based atmosphere (Hillaire 2020 style): transmittance LUT, multiple-scattering LUT,
// per-view sky-view LUT and a direction×distance aerial-perspective LUT. Spherical Earth
// (R = EARTH_RADIUS), all math in terms of altitude to stay float32-stable from 0 m to 700 km.
import * as THREE from 'three';
import { EARTH_RADIUS } from '../../core/constants';
import { altitudeOf, upAt } from '../../core/frames';
import { FullscreenPass, makeRT, passMaterial } from './gpu';

export const ATMO = {
  R: EARTH_RADIUS,
  H: 100_000,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6] as const,
  rayleighH: 8000,
  // background continental/stratospheric aerosol
  mieScat: 3.996e-6,
  mieExt: 4.44e-6,
  mieH: 1200,
  // coastal marine boundary-layer haze (extra aerosol, low scale height)
  blScat: 7.0e-6,
  blExt: 7.7e-6,
  blH: 500,
  mieG: 0.78,
  // Ozone (Chappuis band) absorption integrated over the sRGB channel responses instead of the usual
  // single-wavelength values (680/550/440 nm: 0.65/1.881/0.085e-6). The band peaks at ~600 nm, i.e. inside
  // the red channel, so red is absorbed about as strongly as green. The single-wavelength set turns
  // every long ozone path magenta (purple twilight zenith, pink grazing sunlight at 30–80 km).
  ozone: [1.75e-6, 1.7e-6, 0.11e-6] as const,
  ozoneCenter: 25_000,
  ozoneHalfWidth: 15_000,
  groundAlbedo: 0.1,
  sunAngularRadius: 0.004675,
  /** top-of-atmosphere solar irradiance (linear, white) — gives ≈ SUN_INTENSITY at sea level zenith */
  sunE: 6.6,
};

const f = (x: number) => x.toExponential(6);
const v3 = (a: readonly number[]) => `vec3(${a.map(f).join(',')})`;

/** Shared atmosphere GLSL (constants, medium, geometry, LUT parameterizations). Needs uniforms
 * uTransLUT + uMsLUT (declared here). */
export const ATMO_COMMON = /* glsl */ `
#ifndef ATMO_COMMON_INCLUDED
#define ATMO_COMMON_INCLUDED
#define ATM_PI 3.141592653589793
#define ATM_R ${ATMO.R.toFixed(1)}
#define ATM_H ${ATMO.H.toFixed(1)}
#define ATM_SUN_R ${ATMO.sunAngularRadius}
#define TLUT_W 256.0
#define TLUT_H 64.0
#define MSLUT_N 32.0
const vec3 ATM_RAY = ${v3(ATMO.rayleigh)};
const vec3 ATM_OZONE = ${v3(ATMO.ozone)};
uniform sampler2D uTransLUT;
uniform sampler2D uMsLUT;

struct AtmMedium { vec3 scatR; float scatM; vec3 ext; };
AtmMedium atmMedium(float h) {
  h = max(h, 0.0);
  float dR = exp(-h / ${ATMO.rayleighH.toFixed(1)});
  float dM = exp(-h / ${ATMO.mieH.toFixed(1)});
  float dB = exp(-h / ${ATMO.blH.toFixed(1)});
  float dO = max(0.0, 1.0 - abs(h - ${ATMO.ozoneCenter.toFixed(1)}) / ${ATMO.ozoneHalfWidth.toFixed(1)});
  AtmMedium m;
  m.scatR = ATM_RAY * dR;
  m.scatM = ${f(ATMO.mieScat)} * dM + ${f(ATMO.blScat)} * dB;
  m.ext = m.scatR + vec3(${f(ATMO.mieExt)} * dM + ${f(ATMO.blExt)} * dB) + ATM_OZONE * dO;
  return m;
}
float atmPhaseR(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }
float atmPhaseM(float c) {
  const float g = ${ATMO.mieG};
  const float g2 = g * g;
  float k = 3.0 / (8.0 * ATM_PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
// r^2 - R^2 for altitude h (stable)
float atmRho2(float h) { return h * (2.0 * ATM_R + h); }
// altitude at distance t along a ray from altitude h with cos-zenith mu
float atmAltAt(float h, float mu, float t) {
  float a = atmRho2(h) + t * t + 2.0 * (ATM_R + h) * t * mu;
  return a / (sqrt(ATM_R * ATM_R + a) + ATM_R);
}
// distance to the top of the atmosphere (h <= H) along mu
float atmDistToTop(float h, float mu) {
  float r = ATM_R + h;
  float disc = r * r * mu * mu + (ATM_H - h) * (2.0 * ATM_R + ATM_H + h);
  return max(0.0, -r * mu + sqrt(max(disc, 0.0)));
}
// distance to the ground or -1
float atmDistToGround(float h, float mu) {
  if (mu >= 0.0) return -1.0;
  float r = ATM_R + h;
  float disc = r * r * mu * mu - atmRho2(h);
  if (disc < 0.0) return -1.0;
  return atmRho2(max(h, 0.0)) / (-r * mu + sqrt(disc));
}
// cos-zenith of the geometric horizon at altitude h
float atmHorizonMu(float h) { return -sqrt(max(atmRho2(h), 0.0)) / (ATM_R + h); }
// ray segment inside the atmosphere: returns false if the ray misses it. t1 stops at the ground.
bool atmSegment(float h, float mu, out float t0, out float t1, out bool hitsGround) {
  float r = ATM_R + h;
  float cTop = (h - ATM_H) * (2.0 * ATM_R + h + ATM_H);
  float disc = r * r * mu * mu - cTop;
  hitsGround = false;
  t0 = 0.0; t1 = 0.0;
  if (disc < 0.0) return false;
  float sq = sqrt(disc);
  if (h > ATM_H) {
    if (mu >= 0.0) return false;
    t0 = cTop / (-r * mu + sq);
    t1 = -r * mu + sq;
  } else {
    t1 = -r * mu + sq;
  }
  float tg = atmDistToGround(h, mu);
  if (tg >= 0.0) { t1 = min(t1, tg); hitsGround = true; }
  return true;
}
vec2 atmTransUV(float h, float mu) {
  h = clamp(h, 0.0, ATM_H);
  float Hh = sqrt(atmRho2(ATM_H));
  float rho = sqrt(max(atmRho2(h), 0.0));
  float d = atmDistToTop(h, mu);
  float dMin = ATM_H - h, dMax = rho + Hh;
  float xmu = clamp((d - dMin) / max(dMax - dMin, 1e-3), 0.0, 1.0);
  float xr = rho / Hh;
  return vec2(0.5 / TLUT_W + xmu * (1.0 - 1.0 / TLUT_W), 0.5 / TLUT_H + xr * (1.0 - 1.0 / TLUT_H));
}
// transmittance from altitude h along mu to the top of the atmosphere (ignores the ground)
vec3 atmTransToTop(float h, float mu) {
  return texture(uTransLUT, atmTransUV(h, mu)).rgb;
}
// sun/moon transmittance incl. soft Earth shadow at altitude h, light cos-zenith mus
vec3 atmLightTrans(float h, float mus) {
  float muh = atmHorizonMu(max(h, 0.0));
  float vis = smoothstep(-ATM_SUN_R, ATM_SUN_R, mus - muh);
  return vis <= 0.0 ? vec3(0.0) : atmTransToTop(h, max(mus, muh + 0.002)) * vis;
}
vec3 atmMS(float h, float mus) {
  vec2 uv = vec2(mus * 0.5 + 0.5, clamp(h / ATM_H, 0.0, 1.0));
  uv = 0.5 / MSLUT_N + uv * (1.0 - 1.0 / MSLUT_N);
  return texture(uMsLUT, uv).rgb;
}
// Hillaire sky-view style mapping: (h, mu=cos view zenith, cosAz rel. light) -> uv
vec2 atmViewUV(float h, float mu, float cosAz) {
  float r = ATM_R + max(h, 1.0);
  float cosBeta = sqrt(max(atmRho2(max(h, 1.0)), 0.0)) / r;
  float beta = acos(clamp(cosBeta, 0.0, 1.0));
  float zha = ATM_PI - beta;
  float vza = acos(clamp(mu, -1.0, 1.0));
  float v;
  if (vza < zha) { float c = clamp(vza / zha, 0.0, 1.0); v = (1.0 - sqrt(1.0 - c)) * 0.5; }
  else { float c = clamp((vza - zha) / beta, 0.0, 1.0); v = sqrt(c) * 0.5 + 0.5; }
  float u = sqrt(clamp(-cosAz * 0.5 + 0.5, 0.0, 1.0));
  return vec2(u, v);
}
void atmViewParams(float h, vec2 uv, out float mu, out float cosAz) {
  float r = ATM_R + max(h, 1.0);
  float cosBeta = sqrt(max(atmRho2(max(h, 1.0)), 0.0)) / r;
  float beta = acos(clamp(cosBeta, 0.0, 1.0));
  float zha = ATM_PI - beta;
  float vza;
  if (uv.y < 0.5) { float c = 1.0 - 2.0 * uv.y; vza = zha * (1.0 - c * c); }
  else { float c = 2.0 * uv.y - 1.0; vza = zha + beta * c * c; }
  mu = cos(vza);
  cosAz = -(uv.x * uv.x * 2.0 - 1.0);
}
// energy-conserving in-scatter integration along [t0,t1]. E = light irradiance.
// dist: 0 = uniform, 1 = dense near t0 (camera inside), 2 = dense near t1
void atmIntegrate(float h, float mu, float mus, float nu, float t0, float t1, int N, int distMode, vec3 E, out vec3 L, out vec3 T) {
  L = vec3(0.0); T = vec3(1.0);
  if (t1 <= t0) return;
  float pR = atmPhaseR(nu), pM = atmPhaseM(nu);
  float r = ATM_R + h;
  float span = t1 - t0;
  for (int i = 0; i < 64; i++) {
    if (i >= N) break;
    float a = float(i) / float(N), b = float(i + 1) / float(N);
    if (distMode == 1) { a *= a; b *= b; }
    else if (distMode == 2) { a = 1.0 - (1.0 - a) * (1.0 - a); b = 1.0 - (1.0 - b) * (1.0 - b); }
    float ta = t0 + span * a, tb = t0 + span * b;
    float t = 0.5 * (ta + tb), dt = tb - ta;
    float hs = atmAltAt(h, mu, t);
    float rs = ATM_R + hs;
    float musT = (r * mus + t * nu) / rs;
    AtmMedium m = atmMedium(hs);
    vec3 Ts = atmLightTrans(hs, musT);
    vec3 ms = atmMS(hs, musT);
    vec3 S = E * ((m.scatR * pR + m.scatM * pM) * Ts + (m.scatR + m.scatM) * ms);
    vec3 segT = exp(-m.ext * dt);
    L += T * (S - S * segT) / max(m.ext, vec3(1e-12));
    T *= segT;
  }
}
#endif
`;

// ---------------------------------------------------------------- LUT shaders
const TRANS_FRAG = /* glsl */ `
precision highp float;
${ATMO_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  float xmu = (vUv.x - 0.5 / TLUT_W) / (1.0 - 1.0 / TLUT_W);
  float xr = (vUv.y - 0.5 / TLUT_H) / (1.0 - 1.0 / TLUT_H);
  float Hh = sqrt(atmRho2(ATM_H));
  float rho = Hh * clamp(xr, 0.0, 1.0);
  float h = rho * rho / (sqrt(rho * rho + ATM_R * ATM_R) + ATM_R);
  float r = ATM_R + h;
  float dMin = ATM_H - h, dMax = rho + Hh;
  float d = dMin + clamp(xmu, 0.0, 1.0) * (dMax - dMin);
  float mu = d <= 0.0 ? 1.0 : clamp((Hh * Hh - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float tMax = atmDistToTop(h, mu);
  vec3 od = vec3(0.0);
  const int N = 64;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) / float(N) * tMax;
    od += atmMedium(atmAltAt(h, mu, t)).ext;
  }
  od *= tMax / float(N);
  outColor = vec4(exp(-od), 1.0);
}
`;

const MS_FRAG = /* glsl */ `
precision highp float;
${ATMO_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = (vUv - 0.5 / MSLUT_N) / (1.0 - 1.0 / MSLUT_N);
  float mus = uv.x * 2.0 - 1.0;
  float h = max(uv.y * ATM_H, 1.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - mus * mus)), mus, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  const int ND = 64;
  const int NS = 24;
  for (int k = 0; k < ND; k++) {
    // fibonacci sphere
    float z = 1.0 - 2.0 * (float(k) + 0.5) / float(ND);
    float phi = float(k) * 2.39996323;
    float s = sqrt(max(0.0, 1.0 - z * z));
    vec3 dir = vec3(s * cos(phi), z, s * sin(phi));
    float mu = dir.y;
    float nu = dot(dir, sunDir);
    float t0, t1; bool hg;
    if (!atmSegment(h, mu, t0, t1, hg)) continue;
    float r = ATM_R + h;
    vec3 L = vec3(0.0), F = vec3(0.0), T = vec3(1.0);
    for (int i = 0; i < NS; i++) {
      float a = float(i) / float(NS), b = float(i + 1) / float(NS);
      float ta = t0 + (t1 - t0) * a, tb = t0 + (t1 - t0) * b;
      float t = 0.5 * (ta + tb), dt = tb - ta;
      float hs = atmAltAt(h, mu, t);
      float musT = (r * mus + t * nu) / (ATM_R + hs);
      AtmMedium m = atmMedium(hs);
      vec3 sc = m.scatR + vec3(m.scatM);
      vec3 segT = exp(-m.ext * dt);
      vec3 Sint = (sc - sc * segT) / max(m.ext, vec3(1e-12));
      vec3 Ts = atmLightTrans(hs, musT);
      L += T * Sint * Ts / (4.0 * ATM_PI);
      F += T * Sint;
      T *= segT;
    }
    if (hg) {
      float hs = 0.0;
      float musG = (r * mus + t1 * nu) / ATM_R;
      L += T * atmLightTrans(0.0, musG) * max(musG, 0.0) * ${ATMO.groundAlbedo} / ATM_PI;
    }
    L2 += L; fms += F;
  }
  L2 /= float(ND);
  fms /= float(ND); // f_ms = mean transfer (Hillaire eq. 7)
  outColor = vec4(L2 / max(vec3(1.0) - fms, vec3(1e-3)), 1.0);
}
`;

// sky irradiance on a horizontal surface (unit light), u = light cos-zenith (-1..1), v = sqrt(h/H)
export const IRR_W = 64, IRR_H = 16;
const IRR_FRAG = /* glsl */ `
precision highp float;
${ATMO_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = (vUv - vec2(0.5 / ${64}.0, 0.5 / ${16}.0)) / vec2(1.0 - 1.0 / ${64}.0, 1.0 - 1.0 / ${16}.0);
  float mus = uv.x * 2.0 - 1.0;
  float h = uv.y * uv.y * ATM_H;
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - mus * mus)), mus, 0.0);
  vec3 E = vec3(0.0);
  const int NA = 12, NB = 8;
  for (int a = 0; a < NA; a++) {
    for (int b = 0; b < NB; b++) {
      // cosine-weighted hemisphere
      float u1 = (float(b) + 0.5) / float(NB);
      float phi = (float(a) + 0.5) / float(NA) * 2.0 * ATM_PI;
      float ct = sqrt(u1);
      float st = sqrt(1.0 - u1);
      vec3 dir = vec3(st * cos(phi), ct, st * sin(phi));
      float t0, t1; bool hg;
      if (!atmSegment(h, ct, t0, t1, hg)) continue;
      vec3 L, T;
      atmIntegrate(h, ct, mus, dot(dir, sunDir), t0, t1, 12, 1, vec3(1.0), L, T);
      E += L;
    }
  }
  // cos-weighted estimator: E = pi * mean(L)
  E *= ATM_PI / float(NA * NB);
  outColor = vec4(E, 1.0);
}
`;
/** GLSL: sky irradiance (unit light) at altitude h for light cos-zenith mus. Needs uIrrLUT. */
export const IRR_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uIrrLUT;
vec3 atmSkyIrradiance(float h, float mus) {
  vec2 uv = vec2(clamp(mus * 0.5 + 0.5, 0.0, 1.0), sqrt(clamp(h / ${ATMO.H.toFixed(1)}, 0.0, 1.0)));
  uv = vec2(0.5 / ${64}.0, 0.5 / ${16}.0) + uv * vec2(1.0 - 1.0 / ${64}.0, 1.0 - 1.0 / ${16}.0);
  return texture(uIrrLUT, uv).rgb;
}
`;

const SKYVIEW_FRAG = /* glsl */ `
precision highp float;
${ATMO_COMMON}
uniform float uH;
uniform float uMus;   // light cos-zenith at the camera
uniform vec3 uE;
uniform float uSteps;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  float mu, cosAz;
  atmViewParams(uH, vUv, mu, cosAz);
  float sinV = sqrt(max(0.0, 1.0 - mu * mu));
  float sinS = sqrt(max(0.0, 1.0 - uMus * uMus));
  float nu = mu * uMus + sinV * sinS * cosAz;
  float t0, t1; bool hg;
  vec3 L = vec3(0.0), T = vec3(1.0);
  if (atmSegment(uH, mu, t0, t1, hg)) {
    atmIntegrate(uH, mu, uMus, nu, t0, t1, int(uSteps), uH > ATM_H ? 0 : 1, uE, L, T);
  }
  outColor = vec4(L, 1.0);
}
`;

// aerial atlas: AZ x EL cells per slice, SLICES = TX*TY tiles
export const AERIAL_AZ = 32;
export const AERIAL_EL = 64;
export const AERIAL_TX = 8;
export const AERIAL_TY = 4;
export const AERIAL_SLICES = AERIAL_TX * AERIAL_TY;

const AERIAL_FRAG = /* glsl */ `
precision highp float;
${ATMO_COMMON}
uniform float uH;
uniform float uMus;
uniform vec3 uE;
uniform float uSteps;
in vec2 vUv;
layout(location = 0) out vec4 outIn;
layout(location = 1) out vec4 outTr;
void main() {
  vec2 px = vUv * vec2(${AERIAL_AZ * AERIAL_TX}.0, ${AERIAL_EL * AERIAL_TY}.0);
  vec2 tile = floor(px / vec2(${AERIAL_AZ}.0, ${AERIAL_EL}.0));
  vec2 cell = px - tile * vec2(${AERIAL_AZ}.0, ${AERIAL_EL}.0);
  float slice = tile.y * ${AERIAL_TX}.0 + tile.x;
  // cell centers map exactly to the parameter range ends (lookups use texel centers, no edge bias)
  vec2 uv = floor(cell) / vec2(${AERIAL_AZ - 1}.0, ${AERIAL_EL - 1}.0);
  // keep rows strictly on their side of the horizon (v=0.5)
  float row = floor(cell.y);
  uv.y = row < ${AERIAL_EL / 2}.0 ? (row / ${AERIAL_EL / 2 - 1}.0) * 0.4995 : 0.5005 + (row - ${AERIAL_EL / 2}.0) / ${AERIAL_EL / 2 - 1}.0 * 0.4995;
  float mu, cosAz;
  atmViewParams(uH, uv, mu, cosAz);
  float sinV = sqrt(max(0.0, 1.0 - mu * mu));
  float sinS = sqrt(max(0.0, 1.0 - uMus * uMus));
  float nu = mu * uMus + sinV * sinS * cosAz;
  float t0, t1; bool hg;
  vec3 L = vec3(0.0), T = vec3(1.0);
  if (slice > 0.0 && atmSegment(uH, mu, t0, t1, hg)) {
    float s = slice / ${AERIAL_SLICES - 1}.0;
    float d = t0 + (t1 - t0) * s * s;
    atmIntegrate(uH, mu, uMus, nu, t0, d, int(uSteps), uH > ATM_H ? 2 : 1, uE, L, T);
  }
  outIn = vec4(L, 1.0);
  outTr = vec4(T, 1.0);
}
`;

/** GLSL for sampling the aerial LUT (needs uniforms from Atmosphere.uniforms / aerialUniforms). */
export const AERIAL_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uAerialIn;
uniform sampler2D uAerialTr;
uniform vec3 uAerialCamUp;
uniform vec3 uAerialSunTan;
uniform float uAerialCamAlt;
uniform float uAerialOn;
void aerialLookup(vec3 rel, out vec3 inscat, out vec3 trans) {
  inscat = vec3(0.0); trans = vec3(1.0);
  float dist = length(rel);
  if (uAerialOn < 0.5 || dist < 1e-3) return;
  vec3 dir = rel / dist;
  float h = uAerialCamAlt;
  float mu = dot(dir, uAerialCamUp);
  vec3 dh = dir - uAerialCamUp * mu;
  float lh = length(dh);
  float cosAz = lh > 1e-5 ? dot(dh / lh, uAerialSunTan) : 1.0;
  // segment in the atmosphere for this direction
  const float R = ${ATMO.R.toFixed(1)};
  const float HT = ${ATMO.H.toFixed(1)};
  float r = R + h;
  float cTop = (h - HT) * (2.0 * R + h + HT);
  float disc = r * r * mu * mu - cTop;
  if (disc < 0.0) return;
  float sq = sqrt(disc);
  float t0 = 0.0, t1 = -r * mu + sq;
  if (h > HT) { if (mu >= 0.0) return; t0 = cTop / (-r * mu + sq); }
  bool ground = false;
  if (mu < 0.0) {
    float dg = r * r * mu * mu - h * (2.0 * R + h);
    if (dg >= 0.0) { t1 = min(t1, h * (2.0 * R + h) / (-r * mu + sqrt(dg))); ground = true; }
  }
  if (dist <= t0) return;
  // view mapping (same as atmViewUV) with rows clamped to their side of the horizon
  float hh = max(h, 1.0);
  float rr = R + hh;
  float cosBeta = sqrt(hh * (2.0 * R + hh)) / rr;
  float beta = acos(clamp(cosBeta, 0.0, 1.0));
  float zha = ${Math.PI} - beta;
  float vza = acos(clamp(mu, -1.0, 1.0));
  float v;
  if (!ground) { float c = clamp(vza / zha, 0.0, 1.0); v = (1.0 - sqrt(1.0 - c)) * 0.5; v = min(v, 0.4995); v = v / 0.4995 * 0.5; }
  else { float c = clamp((vza - zha) / beta, 0.0, 1.0); v = sqrt(c) * 0.5 + 0.5; v = max(v, 0.5005); v = 0.5 + (v - 0.5005) / 0.4995 * 0.5; }
  float u = sqrt(clamp(-cosAz * 0.5 + 0.5, 0.0, 1.0));
  // cell coordinates (rows: 0..EL/2-1 sky, EL/2..EL-1 ground)
  float cu = u * ${AERIAL_AZ - 1}.0;
  float cv = !ground ? v * 2.0 * ${AERIAL_EL / 2 - 1}.0 : ${AERIAL_EL / 2}.0 + (v - 0.5) * 2.0 * ${AERIAL_EL / 2 - 1}.0;
  // distance -> slice, linear in distance between slices
  float span = max(t1 - t0, 1e-3);
  float x = clamp((dist - t0) / span, 0.0, 1.0);
  float sf = sqrt(x) * ${AERIAL_SLICES - 1}.0;
  float s0 = min(floor(sf), ${AERIAL_SLICES - 2}.0);
  float d0 = (s0 / ${AERIAL_SLICES - 1}.0) * (s0 / ${AERIAL_SLICES - 1}.0);
  float d1 = ((s0 + 1.0) / ${AERIAL_SLICES - 1}.0) * ((s0 + 1.0) / ${AERIAL_SLICES - 1}.0);
  float fr = clamp((x - d0) / (d1 - d0), 0.0, 1.0);
  vec2 texSize = vec2(${AERIAL_AZ * AERIAL_TX}.0, ${AERIAL_EL * AERIAL_TY}.0);
  vec2 inCell = vec2(cu, cv) + 0.5;
  float s1 = s0 + 1.0;
  vec2 o0 = vec2(mod(s0, ${AERIAL_TX}.0), floor(s0 / ${AERIAL_TX}.0)) * vec2(${AERIAL_AZ}.0, ${AERIAL_EL}.0);
  vec2 o1 = vec2(mod(s1, ${AERIAL_TX}.0), floor(s1 / ${AERIAL_TX}.0)) * vec2(${AERIAL_AZ}.0, ${AERIAL_EL}.0);
  vec2 uv0 = (o0 + inCell) / texSize;
  vec2 uv1 = (o1 + inCell) / texSize;
  inscat = mix(texture(uAerialIn, uv0).rgb, texture(uAerialIn, uv1).rgb, fr);
  trans = mix(texture(uAerialTr, uv0).rgb, texture(uAerialTr, uv1).rgb, fr);
}
`;

// ---------------------------------------------------------------- CPU side
const R = ATMO.R;

function mediumExt(h: number, out: number[]): void {
  h = Math.max(h, 0);
  const dR = Math.exp(-h / ATMO.rayleighH), dM = Math.exp(-h / ATMO.mieH), dB = Math.exp(-h / ATMO.blH);
  const dO = Math.max(0, 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneHalfWidth);
  const m = ATMO.mieExt * dM + ATMO.blExt * dB;
  for (let i = 0; i < 3; i++) out[i] = ATMO.rayleigh[i] * dR + m + ATMO.ozone[i] * dO;
}

/** CPU transmittance from altitude h toward direction with cos-zenith mu (to space), incl. soft Earth shadow. */
export function transmittanceCPU(h: number, mu: number, out = new THREE.Color()): THREE.Color {
  if (h > ATMO.H) {
    // outside: ray may still graze the atmosphere
    const r = R + h;
    const cTop = (h - ATMO.H) * (2 * R + h + ATMO.H);
    const disc = r * r * mu * mu - cTop;
    if (disc < 0 || mu >= 0) return horizonShadow(h, mu, out.setRGB(1, 1, 1));
    const t0 = cTop / (-r * mu + Math.sqrt(disc));
    const rEntry = Math.sqrt(r * r + t0 * t0 + 2 * r * t0 * mu);
    const muEntry = (r * mu + t0) / rEntry;
    transmittanceCPU(ATMO.H - 1, muEntry, out);
    return horizonShadow(h, mu, out);
  }
  const r = R + h;
  const disc = r * r * mu * mu + (ATMO.H - h) * (2 * R + ATMO.H + h);
  const tMax = -r * mu + Math.sqrt(Math.max(disc, 0));
  const N = 48;
  const od = [0, 0, 0], e = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = ((i + 0.5) / N) * tMax;
    const a = h * (2 * R + h) + t * t + 2 * r * t * mu;
    const hs = a / (Math.sqrt(R * R + a) + R);
    mediumExt(hs, e);
    od[0] += e[0]; od[1] += e[1]; od[2] += e[2];
  }
  const k = tMax / N;
  out.setRGB(Math.exp(-od[0] * k), Math.exp(-od[1] * k), Math.exp(-od[2] * k));
  return horizonShadow(h, mu, out);
}

function horizonShadow(h: number, mu: number, out: THREE.Color): THREE.Color {
  const hh = Math.max(h, 0);
  const muh = -Math.sqrt(hh * (2 * R + hh)) / (R + hh);
  const x = (mu - muh + ATMO.sunAngularRadius) / (2 * ATMO.sunAngularRadius);
  const vis = Math.max(0, Math.min(1, x));
  return out.multiplyScalar(vis * vis * (3 - 2 * vis));
}

export interface AtmoView {
  /** camera W position (doubles) */
  camPos: THREE.Vector3;
  lightDir: THREE.Vector3;
  lightE: THREE.Color;
}

/** Owns the LUTs. The `uniforms` object is shared with sky/ocean/terrain/aerial shaders. */
export class Atmosphere {
  readonly transRT = makeRT(256, 64);
  readonly msRT = makeRT(32, 32);
  readonly irrRT = makeRT(IRR_W, IRR_H);
  readonly skyViewRT = makeRT(192, 108);
  readonly seaSkyRT = makeRT(96, 64);
  readonly aerialRT = makeRT(AERIAL_AZ * AERIAL_TX, AERIAL_EL * AERIAL_TY, { count: 2 } as Partial<THREE.RenderTargetOptions>);
  private transPass: FullscreenPass;
  private msPass: FullscreenPass;
  private irrPass: FullscreenPass;
  private skyPass: FullscreenPass;
  private aerialPass: FullscreenPass;
  private ready = false;

  readonly uniforms = {
    uTransLUT: { value: this.transRT.texture as THREE.Texture },
    uMsLUT: { value: this.msRT.texture as THREE.Texture },
    uIrrLUT: { value: this.irrRT.texture as THREE.Texture },
    uSkyViewLUT: { value: this.skyViewRT.texture as THREE.Texture },
    uSeaSkyLUT: { value: this.seaSkyRT.texture as THREE.Texture },
    uAerialIn: { value: this.aerialRT.textures[0] as THREE.Texture },
    uAerialTr: { value: this.aerialRT.textures[1] as THREE.Texture },
    uAerialCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uAerialSunTan: { value: new THREE.Vector3(1, 0, 0) },
    uAerialCamAlt: { value: 0 },
    uAerialOn: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightE: { value: new THREE.Vector3(6, 6, 6) },
  };

  constructor() {
    this.transPass = new FullscreenPass(passMaterial(TRANS_FRAG, {}));
    const common = { uTransLUT: this.uniforms.uTransLUT, uMsLUT: this.uniforms.uMsLUT };
    this.msPass = new FullscreenPass(passMaterial(MS_FRAG, { ...common }));
    this.irrPass = new FullscreenPass(passMaterial(IRR_FRAG, { ...common }));
    this.skyPass = new FullscreenPass(
      passMaterial(SKYVIEW_FRAG, { ...common, uH: { value: 0 }, uMus: { value: 0 }, uE: { value: new THREE.Vector3() }, uSteps: { value: 30 } }),
    );
    this.aerialPass = new FullscreenPass(
      passMaterial(AERIAL_FRAG, { ...common, uH: { value: 0 }, uMus: { value: 0 }, uE: { value: new THREE.Vector3() }, uSteps: { value: 20 } }),
    );
    this.aerialRT.textures[0].name = 'aerialIn';
    this.aerialRT.textures[1].name = 'aerialTr';
  }

  init(renderer: THREE.WebGLRenderer): void {
    if (this.ready) return;
    this.transPass.render(renderer, this.transRT);
    this.msPass.render(renderer, this.msRT);
    this.irrPass.render(renderer, this.irrRT);
    this.ready = true;
    this.readIrradiance(renderer);
  }

  private _up = new THREE.Vector3();
  private _t = new THREE.Vector3();
  /** CPU copy of the irradiance LUT (RGBA float) for ambient light colors */
  irrCPU: Float32Array | null = null;

  private readIrradiance(renderer: THREE.WebGLRenderer): void {
    // read back via a float target copy (HalfFloat RT -> read as Float32 is supported by readRenderTargetPixels only
    // for matching types; render the LUT again into a float RT)
    const rt = makeRT(IRR_W, IRR_H, { type: THREE.FloatType });
    this.irrPass.render(renderer, rt);
    const buf = new Float32Array(IRR_W * IRR_H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, IRR_W, IRR_H, buf);
    rt.dispose();
    this.irrCPU = buf;
  }

  /** sky irradiance on a horizontal surface at altitude h (unit light), CPU bilinear lookup */
  skyIrradianceCPU(h: number, mus: number, out = new THREE.Color()): THREE.Color {
    const b = this.irrCPU;
    if (!b) return out.setRGB(0.15, 0.2, 0.3).multiplyScalar(Math.max(0, mus + 0.1));
    const u = Math.max(0, Math.min(1, mus * 0.5 + 0.5)) * (IRR_W - 1);
    const v = Math.sqrt(Math.max(0, Math.min(1, h / ATMO.H))) * (IRR_H - 1);
    const x0 = Math.min(IRR_W - 2, Math.floor(u)), y0 = Math.min(IRR_H - 2, Math.floor(v));
    const fx = u - x0, fy = v - y0;
    const at = (x: number, y: number, c: number) => b[(y * IRR_W + x) * 4 + c];
    const lerp = (c: number) =>
      (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
    return out.setRGB(lerp(0), lerp(1), lerp(2));
  }

  /** Per-view LUTs: sky-view + aerial perspective for a camera at camPos. */
  updateView(renderer: THREE.WebGLRenderer, camPos: THREE.Vector3, lightDir: THREE.Vector3, lightE: THREE.Color, quality: number): void {
    this.init(renderer);
    const h = Math.max(0.5, altitudeOf(camPos));
    const up = upAt(camPos, this._up);
    const mus = lightDir.dot(up);
    const u = this.uniforms;
    u.uAerialCamAlt.value = h;
    u.uAerialCamUp.value.copy(up);
    const tan = this._t.copy(lightDir).addScaledVector(up, -mus);
    if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0).addScaledVector(up, -up.x);
    u.uAerialSunTan.value.copy(tan.normalize());
    u.uLightDir.value.copy(lightDir);
    u.uLightE.value.set(lightE.r, lightE.g, lightE.b);
    u.uAerialOn.value = 1;

    const sm = this.skyPass.material.uniforms;
    sm.uH.value = h; sm.uMus.value = mus; sm.uE.value.set(lightE.r, lightE.g, lightE.b);
    sm.uSteps.value = [16, 22, 30, 40][quality];
    if (h < 60_000) this.skyPass.render(renderer, this.skyViewRT);

    const am = this.aerialPass.material.uniforms;
    am.uH.value = h; am.uMus.value = mus; am.uE.value.set(lightE.r, lightE.g, lightE.b);
    am.uSteps.value = [12, 16, 20, 28][quality];
    this.aerialPass.render(renderer, this.aerialRT);
  }

  /** Sea-level sky (for ocean reflections) at the ground point below `pos`. */
  updateSea(renderer: THREE.WebGLRenderer, pos: THREE.Vector3, lightDir: THREE.Vector3, lightE: THREE.Color): void {
    this.init(renderer);
    const up = upAt(pos, this._up);
    const sm = this.skyPass.material.uniforms;
    sm.uH.value = 1; sm.uMus.value = lightDir.dot(up); sm.uE.value.set(lightE.r, lightE.g, lightE.b);
    sm.uSteps.value = 24;
    this.skyPass.render(renderer, this.seaSkyRT);
  }
}
