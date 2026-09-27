// Cloud weather model shared by the volumetric clouds (clouds.ts) and the 2D far-field cloud layer
// on the globe (earth.ts), so both show the same deck / cumulus field.
//
// Regime: a coastal marine stratocumulus deck (thick near the coast, burning off a few km inland
// over the hills, breaking up offshore) plus scattered cumulus far offshore. Driven by the regional
// land mask (blurred through its mip chain) and a tileable weather texture advected by the wind.
// All positions are W-frame horizontal coordinates (x east, z south, m from the pad).
import * as THREE from 'three';
import { EARTH_RADIUS, PAD_LAT_DEG, PAD_LON_DEG } from '../../core/constants';

/** cloud shell (m above sea level) — everything the cloud model can produce lies inside */
export const CLOUD_SHELL = { bottom: 560, top: 3400 };
/** weather texture tile size (m) */
export const CLOUD_TILE = 80_000;
/** large-scale modulation tile (m) */
export const CLOUD_BIG_TILE = 610_000;

export const cloudWeatherUniforms = {
  uCldWeather: { value: null as THREE.Texture | null },
  uCldMask: { value: null as THREE.Texture | null },
  uCldRegBox: { value: new THREE.Vector4(-130, 18, -106, 42) },
  /** weather-texture offset (m): -windVelocity * t, wrapped */
  uCldWind: { value: new THREE.Vector2() },
  /** global coverage multiplier (URL ?clouds=0..1.5) */
  uCldCover: { value: 1 },
};

const f = (x: number) => x.toFixed(9);
const M2DEG = 180 / (Math.PI * EARTH_RADIUS);

export const CLOUD_WEATHER_GLSL = /* glsl */ `
#ifndef CLD_WEATHER_INCLUDED
#define CLD_WEATHER_INCLUDED
uniform sampler2D uCldWeather;
uniform sampler2D uCldMask;
uniform vec4 uCldRegBox;
uniform vec2 uCldWind;
uniform float uCldCover;
#define CLD_TILE ${CLOUD_TILE.toFixed(1)}
#define CLD_BIG_TILE ${CLOUD_BIG_TILE.toFixed(1)}
// large-scale regime: x = stratocumulus deck coverage, y = cumulus coverage (0..1)
vec2 cldRegime(vec2 xz) {
  float lat = ${f(PAD_LAT_DEG)} - xz.y * ${M2DEG.toExponential(9)};
  float lon = ${f(PAD_LON_DEG)} + xz.x * ${M2DEG.toExponential(9)} / cos(radians(lat));
  vec2 ruv = (vec2(lon, lat) - uCldRegBox.xy) / (uCldRegBox.zw - uCldRegBox.xy);
  float landL = 0.0, landN = 0.0;
  if (ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {
    landL = textureLod(uCldMask, ruv, 2.5).r;
    landN = textureLod(uCldMask, ruv, 6.5).r;
  }
  float coast = smoothstep(0.0, 0.2, landN);
  float inland = smoothstep(0.45, 0.85, landL);
  float big = textureLod(uCldWeather, (xz + uCldWind * 0.2) / CLD_BIG_TILE + 0.5, 0.0).b;
  float sc = mix(0.06, 0.8, coast) * (1.0 - 0.97 * inland) * (0.55 + 0.9 * big);
  float cu = mix(0.5, 0.1, coast) * (1.0 - 0.9 * inland) * (0.4 + 1.2 * big);
  return clamp(vec2(sc, cu) * uCldCover, 0.0, 1.0);
}
// local weather texel: r = coverage variation, g = cumulus cells, b/a = layer height/thickness
vec4 cldWeather(vec2 xz) { return textureLod(uCldWeather, (xz + uCldWind) / CLD_TILE, 0.0); }
// expected opacity of the cloud field seen from above (2D far-field layer)
float cldCover2D(vec2 xz, vec4 w) {
  vec2 reg = cldRegime(xz);
  float sc = clamp(reg.x * (0.55 + 0.9 * w.r), 0.0, 1.0);
  float cu = clamp(reg.y * (0.6 + 0.8 * w.r), 0.0, 1.0);
  float cells = smoothstep(1.0 - cu, 1.0 - cu + 0.3, w.g) * (0.35 + 0.65 * w.a);
  // deck: closed cells with thinner walls (matches the volumetric deck's cell organisation)
  float deck = smoothstep(0.2, 0.65, sc) * (0.7 + 0.3 * smoothstep(0.25, 0.7, w.g));
  return max(deck, cells * 0.8);
}
#endif
`;
