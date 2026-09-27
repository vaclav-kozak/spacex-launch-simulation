// City lights at street scale for the California coast (SF Bay .. San Diego).
//
// earth_night_city.jpg is a native-resolution crop (~460 m/px) of the NASA Black Marble 2016 500 m
// tile A1 (prep_assets.py `night` step, box = NIGHT_CITY_BOX). It replaces the 1.3 km regional night
// texture inside the box on both the globe (earth.ts) and the terrain patches (terrain.ts).
//
// The Black Marble visualisation saturates the cores of the big metros (LA is one flat white-gold
// blob). Below ~300 m pixel footprint a mean-preserving procedural breakup is multiplied in: the
// 1-mile arterial grid (LA / Inland Empire / Valley streets run N-S / E-W on it), block-to-block
// brightness variation and darker districts. It is footprint-filtered, so at orbital distances
// the texture is unchanged and nothing sparkles.
import * as THREE from 'three';

/** lon0, lat0, lon1, lat1 (deg); must match CITY in tools/prep_assets.py */
export const NIGHT_CITY_BOX = new THREE.Vector4(-123.5, 32.0, -115.0, 38.4);

export const nightCityUniforms = {
  uNightCity: { value: null as THREE.Texture | null },
  /** off-planet until the texture has loaded (set to NIGHT_CITY_BOX by setNightCity) */
  uCityBox: { value: new THREE.Vector4(1000, 1000, 1001, 1001) },
};

export function setNightCity(tex: THREE.Texture | null): void {
  nightCityUniforms.uNightCity.value = tex;
  if (tex) nightCityUniforms.uCityBox.value.copy(NIGHT_CITY_BOX);
}

export const NIGHT_CITY_GLSL = /* glsl */ `
#ifndef NIGHT_CITY_INCLUDED
#define NIGHT_CITY_INCLUDED
uniform sampler2D uNightCity;
uniform vec4 uCityBox;
float ncHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float ncNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ncHash(i), ncHash(i + vec2(1.0, 0.0)), f.x),
             mix(ncHash(i + vec2(0.0, 1.0)), ncHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// nl = night radiance from the global / regional texture (linear), lon/lat in deg, fp = footprint (m)
vec3 nightCity(vec3 nl, float lon, float lat, float fp) {
  vec2 cuv = vec2((lon - uCityBox.x) / (uCityBox.z - uCityBox.x), (lat - uCityBox.y) / (uCityBox.w - uCityBox.y));
  float cw = smoothstep(0.0, 0.02, min(min(cuv.x, 1.0 - cuv.x), min(cuv.y, 1.0 - cuv.y)));
  if (cw <= 0.0) return nl;
  nl = mix(nl, texture(uNightCity, cuv).rgb, cw);
  // lit (warm) areas only: the dim blue land background of the visualisation stays smooth
  float lit = smoothstep(0.03, 0.3, nl.r) * cw;
  float wd = lit * (1.0 - smoothstep(80.0, 320.0, fp));
  if (wd <= 0.0) return nl;
  // local metres (E, N); precision ~1 m at these magnitudes
  vec2 m = vec2((lon + 120.0) * 91700.0, (lat - 34.0) * 110950.0);
  // arterials: 1609 m grid, ~45 m wide, box-filtered by the footprint
  float fw = max(fp, 20.0);
  vec2 d = abs(fract(m / 1609.0 + 0.5) - 0.5) * 1609.0;
  vec2 ln = clamp((22.5 + 0.5 * fw - d) / fw, 0.0, 1.0);
  float art = max(ln.x, ln.y);
  float artMean = 2.0 * 45.0 / 1609.0;
  // blocks (~400 m) and districts (~2.5 km), both mean 1
  float blk = 0.55 + 0.9 * ncNoise(m / 400.0 + 17.0);
  float dst = 0.55 + 0.9 * ncNoise(m / 2500.0 - 5.0);
  float P = 0.8 * blk * dst + 0.2 + 2.2 * (art - artMean);
  return nl * max(mix(1.0, P, 0.8 * wd), 0.0);
}
#endif
`;
