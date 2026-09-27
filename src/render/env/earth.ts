// Earth surface: one camera-centered projected grid on the sea-level sphere, used from 2 m above
// the waves to 700 km. Near field: the shared core/waves.ts Gerstner sum (same phase as the
// ship) + FFT detail cascades, foam, ship wake. Far field: exact per-pixel ray/sphere hit, LEAN
// roughness (sun glitter from orbit), Blue Marble / Black Marble land outside the local terrain
// patches, 2D cloud layer from orbit, aerial perspective. Writes logarithmic depth.
import * as THREE from 'three';
import { ATMO, ATMO_COMMON, IRR_LOOKUP_GLSL } from './atmosphere';
import type { WaveSet } from '../../core/waves';
import { EARTH_RADIUS, PAD_LAT_DEG, PAD_LON_DEG } from '../../core/constants';
import { worldDirToEcef } from '../../core/frames';
import { CASCADE_L } from './oceanFFT';
import { CLOUD_WEATHER_GLSL, cloudWeatherUniforms } from './cloudWeather';
import { NIGHT_CITY_GLSL, nightCityUniforms } from './nightCity';
import { AERIAL_GLSL, aerialUniforms } from './aerial';

export const NWAVES = 12;
export const MAX_PLUME_LIGHTS = 4;

export const OCEAN_BRDF_GLSL = /* glsl */ `
float oceanGGX_D(float NdH, float a2) {
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}
float oceanSmithG1(float NdX, float a2) {
  return 2.0 * NdX / (NdX + sqrt(a2 + (1.0 - a2) * NdX * NdX));
}
// specular BRDF * NdL for a light of irradiance E from L
vec3 oceanSpec(vec3 N, vec3 V, vec3 L, float a2, vec3 E) {
  float NdL = dot(N, L);
  if (NdL <= 0.0) return vec3(0.0);
  vec3 H = normalize(V + L);
  float NdV = max(dot(N, V), 1e-3);
  float NdH = max(dot(N, H), 0.0);
  float VdH = max(dot(V, H), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  float D = oceanGGX_D(NdH, a2);
  float G = oceanSmithG1(NdV, a2) * oceanSmithG1(NdL, a2);
  return E * (D * G * F / (4.0 * NdV));
}
`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec4 uGridBox;
uniform float uAerialCamAlt;
uniform vec3 uAerialCamUp;
uniform vec4 uWaveA[${NWAVES}];
uniform vec4 uWaveB[${NWAVES}];
uniform float uPixAng;
uniform float uGridPx;
uniform sampler2D uFFTDisp0;
uniform vec4 uFFTOff;
uniform vec2 uFFTInvL;
uniform float uWaveOn;
varying vec3 vRel;
varying vec2 vRest;
void main() {
  vec2 ndc = mix(uGridBox.xy, uGridBox.zw, position.xy);
  vec4 v = inverse(projectionMatrix) * vec4(ndc, -1.0, 1.0);
  vec3 dir = normalize((inverse(viewMatrix) * vec4(v.xyz / v.w, 0.0)).xyz);
  const float R = ${EARTH_RADIUS.toFixed(1)};
  float h = max(uAerialCamAlt, 0.05);
  float mu = dot(dir, uAerialCamUp);
  float r = R + h;
  float rho2 = h * (2.0 * R + h);
  float disc = r * r * mu * mu - rho2;
  vec3 rel;
  float t;
  if (mu < 0.0 && disc > 0.0) {
    t = rho2 / (-r * mu + sqrt(disc));
    rel = dir * t;
  } else {
    vec3 hd = dir - uAerialCamUp * mu;
    float lh = length(hd);
    hd = lh > 1e-6 ? hd / lh : vec3(1.0, 0.0, 0.0);
    float muh = -sqrt(rho2) / r;
    t = sqrt(rho2);
    rel = (hd * sqrt(max(0.0, 1.0 - muh * muh)) + uAerialCamUp * muh) * t;
  }
  vec3 up = normalize(rel + uAerialCamUp * r);
  vec3 ex = normalize(vec3(1.0, 0.0, 0.0) - up * up.x);
  vec3 ez = cross(ex, up);
  vec3 disp = vec3(0.0);
  if (uWaveOn > 0.5) {
    float fp = t * uPixAng * uGridPx / max(abs(dot(dir, up)), 0.08);
    for (int i = 0; i < ${NWAVES}; i++) {
      vec4 A = uWaveA[i];
      vec4 B = uWaveB[i];
      float lambda = 6.2831853 / A.z;
      float f = 1.0 - smoothstep(0.12 * lambda, 0.35 * lambda, fp);
      if (f <= 0.0) continue;
      float th = A.z * (A.x * rel.x + A.y * rel.z) + B.x;
      float c = cos(th), s = sin(th);
      float qa = B.y * A.w * f;
      disp.x += qa * A.x * c;
      disp.z += qa * A.y * c;
      disp.y += A.w * f * s;
    }
    float ff = 1.0 - smoothstep(0.4, 1.5, fp);
    if (ff > 0.0) {
      vec2 uv0 = rel.xz * uFFTInvL.x + uFFTOff.xy;
      disp += textureLod(uFFTDisp0, uv0, max(0.0, log2(fp / (${CASCADE_L[0]} / 256.0)))).xyz * ff;
    }
  }
  vRest = rel.xz;
  vec3 P = rel + ex * disp.x + ez * disp.z + up * disp.y;
  vRel = P;
  gl_Position = projectionMatrix * (viewMatrix * vec4(P, 1.0));
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_COMMON}
${AERIAL_GLSL}
${IRR_LOOKUP_GLSL}
${OCEAN_BRDF_GLSL}
${CLOUD_WEATHER_GLSL}
${NIGHT_CITY_GLSL}
uniform sampler2D uSeaSkyLUT;
uniform vec3 uLightDir;
uniform vec3 uLightE;
uniform vec4 uWaveA[${NWAVES}];
uniform vec4 uWaveB[${NWAVES}];
uniform float uPixAng;
uniform vec2 uNearFar;
uniform sampler2D uFFTDisp0;
uniform sampler2D uFFTDisp1;
uniform sampler2D uFFTSlope0;
uniform sampler2D uFFTSlope1;
uniform vec4 uFFTOff;
uniform vec2 uFFTInvL;
uniform float uWaveOn;
uniform float uCoxMunk;      // total mean-square slope of the sea (Cox-Munk)
uniform float uFoamAmount;
uniform float uTime;
// geo
uniform mat3 uWtoEcef;
uniform sampler2D uDayGlobal;
uniform sampler2D uDayReg;
uniform sampler2D uNight;
uniform sampler2D uNightReg;
uniform sampler2D uMaskGlobal;
uniform sampler2D uMaskReg;
uniform sampler2D uClouds;
uniform vec4 uRegBox;        // lon0, lat0, lon1, lat1 (deg)
uniform vec4 uTerrainBox;    // local tangent box (x0, z0, x1, z1) where terrain meshes provide land
uniform float uCloudOn;
uniform vec4 uCloudFade;     // x = volumetric clouds on (0..1), y..z = distance band where the 2D layer takes over
uniform float uNightLights;
// ship
uniform vec3 uShipRel;
uniform vec3 uShipX;
uniform vec3 uShipZ;
uniform float uShipOn;
// plume lights
uniform vec3 uPlPos[${MAX_PLUME_LIGHTS}];
uniform vec3 uPlCol[${MAX_PLUME_LIGHTS}];
uniform float uPlRange[${MAX_PLUME_LIGHTS}];
uniform int uPlCount;
varying vec3 vRel;
varying vec2 vRest;

vec3 seaSky(vec3 R, vec3 up, vec3 lightTan) {
  float mu = clamp(dot(R, up), 0.0, 1.0);
  vec3 rh = R - up * mu;
  float lh = length(rh);
  float cosAz = lh > 1e-5 ? dot(rh / lh, lightTan) : 1.0;
  vec2 uv = atmViewUV(1.0, mu, cosAz);
  uv = vec2(0.5 / 96.0, 0.5 / 64.0) + uv * vec2(95.0 / 96.0, 63.0 / 64.0);
  return texture(uSeaSkyLUT, uv).rgb;
}

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

void main() {
  const float R = ${EARTH_RADIUS.toFixed(1)};
  float h = max(uAerialCamAlt, 0.05);
  vec3 dir = normalize(vRel);
  float mu = dot(dir, uAerialCamUp);
  float r = R + h;
  float rho2 = h * (2.0 * R + h);
  float disc = r * r * mu * mu - rho2;
  float tEx = (mu < 0.0 && disc > 0.0) ? rho2 / (-r * mu + sqrt(disc)) : -1.0;
  float dNear = length(vRel);
  float farW = smoothstep(uNearFar.x, uNearFar.y, dNear);
  if (tEx < 0.0 && farW > 0.5) discard;
  vec3 rel = tEx > 0.0 ? mix(vRel, dir * tEx, farW) : vRel;
  vec2 rest = tEx > 0.0 ? mix(vRest, rel.xz, farW) : vRest;
  float dist = length(rel);
  vec3 up = normalize(rel + uAerialCamUp * r);
  vec3 ex = normalize(vec3(1.0, 0.0, 0.0) - up * up.x);
  vec3 ez = cross(ex, up);
  vec3 V = -dir;

  // ---- geography
  vec3 pc = rel + uAerialCamUp * r;              // Earth-center relative
  vec3 ecef = uWtoEcef * pc;
  float lat = degrees(asin(clamp(ecef.z / length(ecef), -1.0, 1.0)));
  float lon = degrees(atan(ecef.y, ecef.x));
  // tangent-plane coords around the pad (azimuthal equidistant): pad up = +Y
  vec3 upp = normalize(pc);
  float th = atan(length(upp.xz), upp.y);
  vec2 tp = length(upp.xz) > 1e-9 ? normalize(upp.xz) * th * R : vec2(0.0);
  bool inTerrain = tp.x > uTerrainBox.x && tp.x < uTerrainBox.z && tp.y > uTerrainBox.y && tp.y < uTerrainBox.w;
  vec2 guv = vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0);
  vec2 ruv = vec2((lon - uRegBox.x) / (uRegBox.z - uRegBox.x), (lat - uRegBox.y) / (uRegBox.w - uRegBox.y));
  float regW = smoothstep(0.0, 0.03, min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y)));
  // seam-free derivatives for the global texture
  vec2 gdx = dFdx(guv), gdy = dFdy(guv);
  gdx.x -= floor(gdx.x + 0.5); gdy.x -= floor(gdy.x + 0.5);
  float land;
  if (inTerrain) land = 0.0;
  else {
    float lg = textureGrad(uMaskGlobal, guv, gdx, gdy).r;
    float lr = regW > 0.0 ? texture(uMaskReg, ruv).r : 0.0;
    land = smoothstep(0.35, 0.65, mix(lg, lr, regW));
  }

  float mus = dot(uLightDir, up);
  vec3 Esun = uLightE * atmLightTrans(0.0, mus);
  Esun *= aerialCloudShadow(rel);
  vec3 Esky = uLightE * atmSkyIrradiance(0.0, mus);
  vec3 col = vec3(0.0);

  // ---- ocean
  if (land < 1.0) {
    float fpx = dist * uPixAng / max(sqrt(abs(dot(dir, up))), 0.15);
    vec2 slope = vec2(0.0);
    float jy = 1.0;
    float varR = 0.0;
    float crest = 0.0;
    if (uWaveOn > 0.5) {
      for (int i = 0; i < ${NWAVES}; i++) {
        vec4 A = uWaveA[i];
        vec4 B = uWaveB[i];
        float lambda = 6.2831853 / A.z;
        float wa = A.z * A.w;
        float f = 1.0 - smoothstep(0.25 * lambda, 1.0 * lambda, fpx);
        varR += (1.0 - f) * 0.5 * wa * wa;
        if (f <= 0.0) continue;
        float ph = A.z * (A.x * rest.x + A.y * rest.y) + B.x;
        float c = cos(ph), s = sin(ph);
        slope += vec2(A.x, A.y) * wa * c * f;
        jy -= B.y * wa * s * f;
        crest += B.y * wa * s * f;
      }
    } else {
      for (int i = 0; i < ${NWAVES}; i++) { float wa = uWaveA[i].z * uWaveA[i].w; varR += 0.5 * wa * wa; }
    }
    // FFT detail (LEAN moments: mean slope + mean squared slope, mip-filtered)
    vec2 uv0 = rest * uFFTInvL.x + uFFTOff.xy;
    vec2 uv1 = rest * uFFTInvL.y + uFFTOff.zw;
    vec4 s0 = texture(uFFTSlope0, uv0);
    vec4 s1 = texture(uFFTSlope1, uv1);
    float fftFade = 1.0 - smoothstep(4000.0, 12000.0, dist);
    s0 *= fftFade; s1 *= fftFade;
    vec2 sm = s0.xy + s1.xy;
    float varF = max(0.0, s0.z - s0.x * s0.x) + max(0.0, s0.w - s0.y * s0.y) + max(0.0, s1.z - s1.x * s1.x) + max(0.0, s1.w - s1.y * s1.y);
    // anything not resolved by Gerstner+FFT: capillaries + (far away) the whole spectrum
    float resolved = varF + (1.0 - fftFade) * 0.0;
    float a2 = max(0.0025, varR + varF * 1.0 + 0.004 + (1.0 - fftFade) * uCoxMunk);
    a2 = min(a2, uCoxMunk * 1.6 + 0.01);
    vec3 nT = normalize(vec3(-(slope.x + sm.x), max(jy, 0.2), -(slope.y + sm.y)));
    vec3 N = normalize(ex * nT.x + up * nT.y + ez * nT.z);
    // keep the normal facing the viewer (grazing views)
    float NdV = dot(N, V);
    if (NdV < 0.02) { N = normalize(N + V * (0.02 - NdV)); NdV = 0.02; }
    vec3 Rf = reflect(-V, N);
    if (dot(Rf, up) < 0.0) Rf = normalize(Rf - 2.0 * dot(Rf, up) * up * 0.999);
    float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    // rough-surface Fresnel softening at grazing angles (energy lost to shadowing)
    F = mix(F, F * 0.75, clamp(sqrt(a2) * 2.0, 0.0, 1.0) * pow(1.0 - NdV, 3.0));
    vec3 lightTan = uLightDir - up * mus;
    lightTan = length(lightTan) > 1e-5 ? normalize(lightTan) : ex;
    vec3 skyR = seaSky(Rf, up, lightTan);
    vec3 spec = oceanSpec(N, V, uLightDir, a2, Esun);
    // water body: deep Pacific upwelling (subsurface) lit by down-welling light
    vec3 Ed = Esun * max(mus, 0.0) + Esky;
    vec3 deep = vec3(0.0020, 0.0078, 0.0140);
    vec3 water = Ed * deep * (1.0 - F);
    // sunlit translucent wave tips (forward scattering through crests)
    float sss = pow(clamp(dot(V, -uLightDir) * 0.5 + 0.5, 0.0, 1.0), 3.0) * clamp(crest * 1.2 + (s0.x + s0.y) * 0.5, 0.0, 1.0);
    water += Esun * vec3(0.004, 0.022, 0.020) * sss * max(mus + 0.1, 0.0);
    vec3 ocean = water + F * skyR + spec;
    // ---- foam: whitecaps (FFT jacobian foam + Gerstner crests), scaled by sea state / wind
    vec4 d0 = texture(uFFTDisp0, uv0);
    float foamN = fbm2(rest * 0.35 + vec2(uTime * 0.05, 0.0));
    float cover = clamp(d0.w * fftFade * 1.2, 0.0, 1.0) * uFoamAmount;
    cover += smoothstep(0.55, 0.9, crest) * uFoamAmount * 0.8;
    float foam = clamp(cover * smoothstep(0.35, 0.75, foamN + cover * 0.4), 0.0, 1.0);
    // ship wake / hull wash ring
    if (uShipOn > 0.5) {
      vec3 sp = rel - uShipRel;
      vec2 lp = vec2(dot(sp, uShipX), dot(sp, uShipZ));
      vec2 q = abs(lp) - vec2(15.5, 45.9);
      float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 3.0;
      float ring = exp(-max(sd, 0.0) / 7.0) * smoothstep(-2.0, 1.0, sd);
      float streak = fbm2(lp * vec2(0.25, 0.08) + vec2(0.0, uTime * 0.3));
      foam = max(foam, ring * smoothstep(0.25, 0.7, streak + ring * 0.3) * 0.9);
    }
    // far away foam averages into a slight brightening
    foam *= 1.0 - smoothstep(3000.0, 20000.0, dist);
    float foamAvg = uFoamAmount * 0.02 * smoothstep(3000.0, 20000.0, dist);
    vec3 foamCol = vec3(0.85) * (Esun * max(dot(N, uLightDir) * 0.6 + 0.4, 0.0) * max(mus, 0.0) + Esky) / 3.14159;
    ocean = mix(ocean, foamCol, clamp(foam + foamAvg, 0.0, 1.0));
    // plume light: diffuse into the water + glossy reflection
    for (int i = 0; i < ${MAX_PLUME_LIGHTS}; i++) {
      if (i >= uPlCount) break;
      vec3 lv = uPlPos[i] - rel;
      float d2 = dot(lv, lv);
      float dl = sqrt(d2);
      vec3 L = lv / dl;
      float win = pow(clamp(1.0 - pow(dl / uPlRange[i], 4.0), 0.0, 1.0), 2.0);
      vec3 E = uPlCol[i] / max(d2, 1.0) * win;
      ocean += oceanSpec(N, V, L, max(a2, 0.01), E);
      ocean += E * max(dot(up, L), 0.0) * (deep * 2.0 * (1.0 - F) + foam * 0.25);
    }
    col = ocean;
  }
  // ---- land (globe, outside the terrain patches)
  if (land > 0.0) {
    vec3 albG = textureGrad(uDayGlobal, guv, gdx, gdy).rgb;
    vec3 alb = regW > 0.0 ? mix(albG, texture(uDayReg, ruv).rgb, regW) : albG;
    alb *= 0.85;
    vec3 lc = alb * (Esun * max(mus, 0.0) + Esky) / 3.14159;
    vec3 nl = textureGrad(uNight, guv, gdx, gdy).rgb;
    if (regW > 0.0) nl = mix(nl, texture(uNightReg, ruv).rgb, regW);
    nl = nightCity(nl, lon, lat, dist * uPixAng / max(sqrt(abs(dot(dir, up))), 0.15));
    // real sun elevation (uLightDir is the moon on moonlit nights)
    float nightF = smoothstep(0.02, -0.12, dot(uAerialSunDir, up));
    lc += nl * uNightLights * nightF;
    col = mix(col, lc, land);
  }
  // ---- 2D cloud layer (from altitude, outside the volumetric cloud domain)
  if (uCloudOn > 0.0) {
    float domain = mix(1.0, smoothstep(uCloudFade.y, uCloudFade.z, dist), uCloudFade.x);
    float cov = 0.0, thick = 0.5, tex = 0.5;
    if (domain > 0.0) {
      float cd = textureGrad(uClouds, guv, gdx, gdy).r;
      cov = smoothstep(0.15, 0.85, cd);
      thick = cd;
      // near the pad: the same regime/weather model as the volumetric clouds (footprint-filtered)
      float rw = 1.0 - smoothstep(700e3, 1000e3, length(tp));
      if (rw > 0.0) {
        // footprint between the geometric mean and the long (depth) axis: no sub-pixel cumulus dashes at grazing angles
        float fp = dist * uPixAng / pow(max(abs(dot(dir, up)), 0.03), 0.75);
        CldReg cR = cldRegime(tp);
        CldW cW = cldWeather(tp, cR, fp);
        vec2 c2 = cldCover2D(cR, cW);
        cov = mix(cov, 1.0 - (1.0 - c2.x) * (1.0 - c2.y), rw);
        thick = mix(thick, cW.w.a, rw);
        tex = mix(tex, mix(cW.w.g, 0.5, cW.k), rw);
      }
    }
    cov *= uCloudOn * domain;
    if (cov > 0.0) {
      // albedo from thickness + cell texture (brighter cores, greyer rifts / thin edges)
      float alb = (0.6 + 0.3 * thick) * (0.8 + 0.4 * tex);
      // cloud-top sunlit even slightly past the terminator (clouds sit ~1-3 km up)
      vec3 cl = alb * (Esun * (max(mus, 0.0) * 0.8 + 0.2 * max(mus + 0.1, 0.0)) + Esky * 1.3) / 3.14159;
      col = mix(col, cl, cov);
    }
  }
  // ---- aerial perspective
  vec3 ai, at;
  aerialLookup(rel, ai, at);
  col = col * at + ai;
  gl_FragColor = vec4(col, 1.0);
  vec4 vp = viewMatrix * vec4(rel, 1.0);
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    gl_FragDepth = log2(1.0 + max(-vp.z, 1e-4)) * logDepthBufFC * 0.5;
  #else
    vec4 cp = projectionMatrix * vp;
    gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function gridGeometry(nx: number, ny: number): THREE.BufferGeometry {
  const pos = new Float32Array(nx * ny * 3);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    // denser rows toward the horizon (top of the box)
    const v = j / (ny - 1);
    for (let i = 0; i < nx; i++) {
      pos[k++] = i / (nx - 1);
      pos[k++] = v;
      pos[k++] = 0;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const GRID_RES: [number, number][] = [
  [128, 96],
  [192, 144],
  [256, 192],
  [320, 256],
];

export interface EarthTextures {
  dayGlobal: THREE.Texture;
  dayReg: THREE.Texture;
  night: THREE.Texture;
  nightReg: THREE.Texture;
  maskGlobal: THREE.Texture;
  maskReg: THREE.Texture;
  clouds: THREE.Texture;
}

export class EarthSurface {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geoms = GRID_RES.map(([x, y]) => gridGeometry(x, y));
  private waveKey = '';
  private waves: WaveSet | null = null;

  constructor(shared: Record<string, THREE.IUniform>, tex: EarthTextures) {
    const wtoe = new THREE.Matrix3();
    {
      const ex = worldDirToEcef(new THREE.Vector3(1, 0, 0));
      const ey = worldDirToEcef(new THREE.Vector3(0, 1, 0));
      const ez = worldDirToEcef(new THREE.Vector3(0, 0, 1));
      wtoe.set(ex.x, ey.x, ez.x, ex.y, ey.y, ez.y, ex.z, ey.z, ez.z);
    }
    void PAD_LAT_DEG; void PAD_LON_DEG;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...(aerialUniforms as unknown as Record<string, THREE.IUniform>),
        ...shared,
        ...(cloudWeatherUniforms as unknown as Record<string, THREE.IUniform>),
        ...(nightCityUniforms as unknown as Record<string, THREE.IUniform>),
        uGridBox: { value: new THREE.Vector4(-1, -1, 1, 1) },
        uWaveA: { value: Array.from({ length: NWAVES }, () => new THREE.Vector4()) },
        uWaveB: { value: Array.from({ length: NWAVES }, () => new THREE.Vector4()) },
        uPixAng: { value: 0.0006 },
        uGridPx: { value: 6 },
        uNearFar: { value: new THREE.Vector2(3000, 6000) },
        uFFTDisp0: { value: null },
        uFFTDisp1: { value: null },
        uFFTSlope0: { value: null },
        uFFTSlope1: { value: null },
        uFFTOff: { value: new THREE.Vector4() },
        uFFTInvL: { value: new THREE.Vector2(1 / CASCADE_L[0], 1 / CASCADE_L[1]) },
        uWaveOn: { value: 1 },
        uCoxMunk: { value: 0.03 },
        uFoamAmount: { value: 0.5 },
        uTime: { value: 0 },
        uWtoEcef: { value: wtoe },
        uDayGlobal: { value: tex.dayGlobal },
        uDayReg: { value: tex.dayReg },
        uNight: { value: tex.night },
        uNightReg: { value: tex.nightReg },
        uMaskGlobal: { value: tex.maskGlobal },
        uMaskReg: { value: tex.maskReg },
        uClouds: { value: tex.clouds },
        uRegBox: { value: new THREE.Vector4(-130, 18, -106, 42) },
        uTerrainBox: { value: new THREE.Vector4(0, 0, 0, 0) },
        uCloudOn: { value: 1 },
        uCloudFade: { value: new THREE.Vector4(0, 1e9, 1e9, 0) },
        uNightLights: { value: 0.02 },
        uShipRel: { value: new THREE.Vector3() },
        uShipX: { value: new THREE.Vector3(1, 0, 0) },
        uShipZ: { value: new THREE.Vector3(0, 0, 1) },
        uShipOn: { value: 0 },
        uPlPos: { value: Array.from({ length: MAX_PLUME_LIGHTS }, () => new THREE.Vector3()) },
        uPlCol: { value: Array.from({ length: MAX_PLUME_LIGHTS }, () => new THREE.Vector3()) },
        uPlRange: { value: new Array(MAX_PLUME_LIGHTS).fill(1) },
        uPlCount: { value: 0 },
      },
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geoms[2], this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'env.earth';
    this.mesh.renderOrder = 100;
  }

  setWaves(set: WaveSet): void {
    this.waves = set;
    const u = this.material.uniforms;
    for (let i = 0; i < NWAVES; i++) {
      const w = set.waves[i];
      const A = u.uWaveA.value[i] as THREE.Vector4;
      if (!w) { A.set(1, 0, 1, 0); continue; }
      A.set(w.dirX, w.dirZ, w.k, w.amplitude);
    }
    const hs = set.significantHeight;
    // Cox-Munk mean square slope from an equivalent wind for the sea state
    const u10 = 2.5 + 2.6 * set.seaState;
    u.uCoxMunk.value = 0.003 + 0.00512 * u10;
    u.uFoamAmount.value = Math.min(1, Math.max(0, (set.seaState - 1.5) / 3.5));
    u.uNearFar.value.set(Math.max(1500, 400 * hs + 1500), Math.max(3000, 800 * hs + 3000));
  }

  /** per frame: wave phases relative to the render origin (double precision on the CPU) */
  updatePhases(origin: THREE.Vector3, t: number): void {
    const set = this.waves;
    if (!set) return;
    const u = this.material.uniforms;
    const TAU = Math.PI * 2;
    for (let i = 0; i < NWAVES; i++) {
      const w = set.waves[i];
      const B = u.uWaveB.value[i] as THREE.Vector4;
      if (!w) { B.set(0, 0, 0, 0); continue; }
      let ph = w.k * (w.dirX * origin.x + w.dirZ * origin.z) - w.omega * t + w.phase;
      ph = ph - Math.floor(ph / TAU) * TAU;
      B.set(ph, w.steepness, w.omega, 0);
    }
    const off = u.uFFTOff.value as THREE.Vector4;
    const L0 = CASCADE_L[0], L1 = CASCADE_L[1];
    const m = (a: number, L: number) => { const x = a / L; return x - Math.floor(x); };
    off.set(m(origin.x, L0), m(origin.z, L0), m(origin.x, L1), m(origin.z, L1));
  }

  setQuality(level: number): void {
    this.mesh.geometry = this.geoms[level];
    this.material.uniforms.uGridPx.value = 0;
  }

  private _inv = new THREE.Matrix4();
  private _v = new THREE.Vector4();
  private _d = new THREE.Vector3();

  /** fit the projected grid to the below-horizon part of the view */
  fitGrid(camera: THREE.PerspectiveCamera, camAlt: number, camUp: THREE.Vector3, viewportPx: number, level: number): void {
    const R = EARTH_RADIUS;
    const h = Math.max(camAlt, 0.05);
    const r = R + h;
    const rho2 = h * (2 * R + h);
    const muh = -Math.sqrt(rho2) / r;
    this._inv.copy(camera.projectionMatrixInverse);
    const rot = camera.matrixWorld;
    let x0 = 2, y0 = 2, x1 = -2, y1 = -2;
    const S = 12;
    for (let j = 0; j <= S; j++)
      for (let i = 0; i <= S; i++) {
        const nx = -1 + (2 * i) / S, ny = -1 + (2 * j) / S;
        this._v.set(nx, ny, -1, 1).applyMatrix4(this._inv);
        this._d.set(this._v.x / this._v.w, this._v.y / this._v.w, this._v.z / this._v.w).transformDirection(rot);
        const mu = this._d.dot(camUp);
        // below the horizon (with margin: waves + one cell)
        if (mu < muh + 0.02) {
          x0 = Math.min(x0, nx); x1 = Math.max(x1, nx);
          y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
        }
      }
    const u = this.material.uniforms;
    if (x1 < x0) {
      u.uGridBox.value.set(-1, -1, -1, -1); // nothing below the horizon
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const c = 2 / S;
    // extra margin near the water: wave displacement pulls the grid edges inward
    const m = 0.03 + 0.35 / (1 + h / 15);
    x0 = x0 <= -1 ? -1 - m : x0 - c; x1 = x1 >= 1 ? 1 + m : x1 + c;
    y0 = y0 <= -1 ? -1 - m : y0 - c; y1 = Math.min(1.02, y1 + c);
    u.uGridBox.value.set(x0, y0, x1, y1);
    const [gx, gy] = GRID_RES[level];
    this.mesh.geometry = this.geoms[level];
    // grid cell size in pixels (vertical spacing dominates near the horizon)
    u.uGridPx.value = Math.max(((y1 - y0) / 2) * (viewportPx / gy), ((x1 - x0) / 2) * ((viewportPx * camera.aspect) / gx));
  }
}

void ATMO;
