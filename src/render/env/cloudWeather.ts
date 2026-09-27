// Cloud weather model shared by the volumetric clouds (clouds.ts) and the 2D far-field cloud layer
// on the globe (earth.ts), so both show the same deck / cumulus field.
//
// Regime: a coastal marine stratocumulus deck (thick near the coast, burning off a few km inland
// over the hills, breaking up offshore) plus scattered cumulus. Near the pad it is driven by the
// regional land mask (blurred through its mip chain) and a large-scale procedural field; further out
// (> ~100-300 km) the synoptic coverage comes from the Blue Marble cloud composite, so the view from
// orbit shows the real July marine layer off California / Baja (sheets, clear slots, broken edges).
//
// Mesoscale structure (weather map, 1024^2 RGBA, gen_cloud_noise.py) is sampled at two scales:
// fine (80 km tile, ~2 km closed cells, domain-warped by the big field so the tile never repeats
// visibly) and coarse (347 km tile, rotated: ~9 km closed cells, ~30 km open cells, 20-120 km
// coverage patches). Near the coast the cells are small; offshore they grow, and where the deck is
// partial the organisation switches from closed cells (cloud with thin rifts) to open cells (rings
// of cumulus around clear centres). All thresholds are footprint-filtered: when a cell is smaller
// than the pixel footprint the layer returns the expected coverage instead of a sub-pixel speckle.
// All positions are W-frame horizontal coordinates (x east, z south, m from the pad).
import * as THREE from 'three';
import { EARTH_RADIUS, PAD_LAT_DEG, PAD_LON_DEG } from '../../core/constants';

/** cloud shell (m above sea level) — everything the cloud model can produce lies inside */
export const CLOUD_SHELL = { bottom: 560, top: 3400 };
/** fine weather tile (m) */
export const CLOUD_TILE = 80_000;
/** coarse weather tile (m, rotated 37 deg) */
export const CLOUD_TILE_C = 347_000;
/** large-scale regime tile (m, rotated -24 deg) */
export const CLOUD_BIG_TILE = 610_000;
/** weather map resolution */
export const CLOUD_WEATHER_N = 1024;
/** uCldWind wraps at this period (m); every lookup is continuous across the wrap only in
 * theory, but at cloud-level winds it takes > 100 h of sim time to get there */
export const CLOUD_WIND_WRAP = 4_000_000;

export const cloudWeatherUniforms = {
  uCldWeather: { value: null as THREE.Texture | null },
  uCldMask: { value: null as THREE.Texture | null },
  /** Blue Marble cloud composite (global equirectangular, luminance) */
  uCldBM: { value: null as THREE.Texture | null },
  uCldRegBox: { value: new THREE.Vector4(-130, 18, -106, 42) },
  /** weather-texture offset (m): -windVelocity * t */
  uCldWind: { value: new THREE.Vector2() },
  /** global coverage multiplier (URL ?clouds=0..1.5) */
  uCldCover: { value: 1 },
};

const f = (x: number) => x.toFixed(9);
const M2DEG = 180 / (Math.PI * EARTH_RADIUS);
const rot = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return `mat2(${c.toFixed(6)}, ${s.toFixed(6)}, ${(-s).toFixed(6)}, ${c.toFixed(6)})`;
};

export const CLOUD_WEATHER_GLSL = /* glsl */ `
#ifndef CLD_WEATHER_INCLUDED
#define CLD_WEATHER_INCLUDED
uniform sampler2D uCldWeather;
uniform sampler2D uCldMask;
uniform sampler2D uCldBM;
uniform vec4 uCldRegBox;
uniform vec2 uCldWind;
uniform float uCldCover;
#define CLD_TILE ${CLOUD_TILE.toFixed(1)}
#define CLD_TILE_C ${CLOUD_TILE_C.toFixed(1)}
#define CLD_BIG_TILE ${CLOUD_BIG_TILE.toFixed(1)}
#define CLD_TEX_N ${CLOUD_WEATHER_N.toFixed(1)}

struct CldReg {
  float sc;    // stratocumulus deck coverage 0..1
  float cu;    // cumulus coverage 0..1
  float open;  // 0 = closed cells .. 1 = open cells
  float big;   // 0 = small coastal cells .. 1 = large offshore cells
  vec2 warp;   // domain warp of the fine weather lookup (m)
};
struct CldW {
  vec4 w;      // r = coverage variation, g = cell field (uniform 0..1), b = layer height, a = thickness
  float k;     // 0 = cells resolved .. 1 = cells well below the footprint (use expected coverage)
};

// large-scale regime at W horizontal position xz
CldReg cldRegime(vec2 xz) {
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
  // big field: r = equalised warped fbm (patches, large clear areas), b = smooth fbm
  vec4 G = textureLod(uCldWeather, ${rot(-24)} * (xz + uCldWind * 0.2) / CLD_BIG_TILE + vec2(0.5, 0.13), 1.5);
  // Blue Marble synoptic coverage (real July marine layer), blended in away from the pad
  float bm = textureLod(uCldBM, vec2((lon + 180.0) / 360.0, (lat + 90.0) / 180.0), 0.0).r;
  float bmCov = smoothstep(0.05, 0.55, bm);
  float wBM = smoothstep(90e3, 320e3, length(xz));
  CldReg R;
  // procedural regime (near the pad)
  float big = G.r;
  float scP = mix(0.06, 0.8, coast) * (1.0 - 0.97 * inland) * (0.45 + 1.1 * big);
  float cuP = mix(0.45, 0.1, coast) * (1.0 - 0.9 * inland) * (0.2 + 1.5 * big * big);
  // Blue Marble regime: deck over the sea, convective cumulus over land
  float scB = bmCov * (1.0 - 0.97 * inland) * (0.8 + 0.45 * big);
  float cuB = bmCov * mix(0.12, 0.55, inland) * (0.5 + big);
  R.sc = clamp(mix(scP, scB, wBM) * uCldCover, 0.0, 1.0);
  R.cu = clamp(mix(cuP, cuB, wBM) * uCldCover, 0.0, 1.0);
  // open cells offshore where the deck is partial (Blue Marble) / in parts of the big field
  float openP = (1.0 - coast) * smoothstep(0.5, 0.8, G.b);
  float openB = (1.0 - 0.8 * coast) * smoothstep(0.1, 0.25, bm) * (1.0 - smoothstep(0.4, 0.7, bm));
  R.open = clamp(mix(openP, openB, wBM), 0.0, 1.0);
  R.big = clamp((1.0 - coast) * 0.9 + (G.b - 0.5) * 0.8, 0.0, 1.0);
  R.warp = (vec2(G.b, G.r) - 0.5) * 28000.0;
  return R;
}

// local weather at xz; fp = footprint (m) of the sample (0 = finest)
CldW cldWeather(vec2 xz, CldReg R, float fp) {
  vec2 p = xz + uCldWind;
  float lodF = log2(max(fp, 1.0) * (CLD_TEX_N / CLD_TILE));
  float lodC = lodF - ${Math.log2(CLOUD_TILE_C / CLOUD_TILE).toFixed(6)};
  vec4 F = textureLod(uCldWeather, (p + R.warp) / CLD_TILE, max(lodF, 0.0));
  vec4 C = textureLod(uCldWeather, ${rot(37)} * p / CLD_TILE_C + vec2(0.29, 0.71), max(lodC, 0.0));
  float kF = smoothstep(2.0, 5.0, lodF), kC = smoothstep(2.0, 5.0, lodC);
  // closed cells: fine near the coast, coarse (with fine texture) offshore
  float gC = mix(F.g, 0.75 * C.g + 0.25 * F.g, R.big);
  float kG = mix(kF, mix(kF, kC, 0.75), R.big);
  // open cells: coarse walls, beaded by the fine cells
  float gO = clamp(C.a + (F.g - 0.5) * 0.25, 0.0, 1.0);
  CldW W;
  W.w.g = mix(gC, gO, R.open);
  W.k = mix(kG, kC, R.open);
  W.w.r = clamp(0.5 + (F.r - 0.5) * 0.4 + (C.r - 0.5) * 1.0, 0.0, 1.0);
  W.w.b = 0.5 * (F.b + C.b);
  W.w.a = clamp(0.5 * F.b + 0.5 * F.g, 0.0, 1.0);
  return W;
}

// fraction of the ground hidden by cloud seen from above (2D far-field layer), footprint-filtered
// x = deck, y = cumulus
vec2 cldCover2D(CldReg R, CldW W) {
  vec4 w = W.w;
  float k = W.k;
  float covS = clamp(R.sc * (0.55 + 0.9 * w.r), 0.0, 1.0);
  float covC = clamp(R.cu * (0.3 + 1.4 * w.r * w.r), 0.0, 1.0);
  // cell field is uniform on 0..1: thresholding at 1 - c covers a fraction ~c
  float wd = 0.16 + 0.3 * k;
  float deck = mix(smoothstep(1.0 - covS - wd, 1.0 - covS + wd, w.g), covS, k * k);
  // a nearly closed deck: the rifts between cells are thinner cloud, not clear sky
  deck = max(deck, smoothstep(0.35, 0.95, covS) * (0.22 + 0.4 * w.g) * (0.6 + 0.4 * w.a));
  float tc = 1.0 - covC;
  float cells = mix(smoothstep(tc - wd * 0.5, tc + 0.25 + wd, w.g), covC * 0.8, k * k);
  return vec2(deck, cells * (0.45 + 0.55 * w.a));
}
#endif
`;
