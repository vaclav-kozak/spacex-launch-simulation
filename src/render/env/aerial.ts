// Aerial-perspective API: atmospheric extinction + in-scattering between the camera and a
// fragment, from the env's physically based atmosphere (direction × distance LUT recomputed per
// view by Environment.beforeViewRender; valid from 0 m to 700 km camera altitude and for
// distances up to the far side of the atmosphere).
//
// Usage from custom ShaderMaterials (vfx etc.):
//   uniforms: { ...aerialUniforms, ...yours }          // share the SAME uniform objects
//   fragment: `${AERIAL_GLSL}` at top level, then e.g.
//     vec3 rel = worldPosRelCamera;                       // fragment W pos minus camera W pos
//     color = aerialApply(color, rel);                    // opaque / alpha-blended
//     color *= aerialTransmittance(rel);                  // additive emitters (no inscatter)
//   (in the floating-origin scene the camera sits at the origin, so for objects under
//    ctx.worldRoot: rel = (modelMatrix * vec4(pos,1)).xyz - cameraPosition)
// Standard three.js materials under ctx.worldRoot are patched automatically by env
// (patchMaterial is idempotent; env traverses the scene periodically). Opt out with
// material.userData.noAerial = true. Additive-blended materials get transmittance only.
//
// Extra helpers in AERIAL_GLSL: aerialLookup(rel, out inscat, out trans) (one fetch for both),
// aerialSunColor() (direct sun/moon irradiance at the camera, linear), aerialSunDir,
// aerialCloudShadow(rel) (0..1 transmittance of the volumetric clouds toward the key light at the
// fragment; 1 outside the per-view cloud shadow map), aerialEarthShadow(rel, lightDirW) /
// aerialSunVisibility(rel) (0..1 Earth shadow at the fragment). Patched lit materials apply both
// to their directional lights automatically; custom shaders lit by aerialSunColor() should multiply
// by aerialSunVisibility(rel) (smoke on the ground while the focus is sunlit high up).

import * as THREE from 'three';
import { AERIAL_LOOKUP_GLSL, ATMO } from './atmosphere';
import { CLOUD_SHELL } from './cloudWeather';
import { EARTH_RADIUS } from '../../core/constants';

export const aerialUniforms = {
  // LUT (owned/filled by env; the texture objects are swapped in at init)
  uAerialIn: { value: null as THREE.Texture | null },
  uAerialTr: { value: null as THREE.Texture | null },
  uAerialCamUp: { value: new THREE.Vector3(0, 1, 0) },
  uAerialSunTan: { value: new THREE.Vector3(1, 0, 0) },
  uAerialCamAlt: { value: 0 },
  /** 0 until the first LUT is ready (then aerial* return identity) */
  uAerialOn: { value: 0 },
  // convenience values for custom shaders
  uAerialSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uAerialSunColor: { value: new THREE.Color(1, 1, 1) },
  // volumetric cloud shadow map (per view, filled by env): x = cloud transmittance from the ground along
  // the key light, y/z = lowest/highest cloud altitude met on the way
  uCloudShadow: { value: null as THREE.Texture | null },
  /** xy = box min (W x,z) relative to the camera, z = 1/box size, w = on */
  uCloudShadowBox: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** key light direction (W) the map was traced along */
  uCloudShadowDir: { value: new THREE.Vector3(0, 1, 0) },
  // directional light colours are evaluated at the view's focus (ctx.lighting); patched lit materials
  // rescale them per fragment by T(fragment) / T(focus) from the atmosphere transmittance LUT
  uAerialTransLUT: { value: null as THREE.Texture | null },
  /** xyz = local up at the point the light colours were evaluated at (W), w = its altitude (m); w < 0 = off */
  uAerialLightRef: { value: new THREE.Vector4(0, 1, 0, -1) },
  // legacy stand-in uniforms (unused, kept so older code keeps compiling)
  uAerialFogColor: { value: new THREE.Color(0.55, 0.65, 0.8) },
  uAerialDensity: { value: 1 / 40000 },
};

export const AERIAL_GLSL = /* glsl */ `
#ifndef AERIAL_GLSL_INCLUDED
#define AERIAL_GLSL_INCLUDED
${AERIAL_LOOKUP_GLSL}
uniform vec3 uAerialSunDir;
uniform vec3 uAerialSunColor;
uniform vec3 uAerialFogColor;
uniform float uAerialDensity;
vec3 aerialTransmittance(vec3 rel) { vec3 i, t; aerialLookup(rel, i, t); return t; }
vec3 aerialInscatter(vec3 rel) { vec3 i, t; aerialLookup(rel, i, t); return i; }
vec3 aerialApply(vec3 color, vec3 rel) { vec3 i, t; aerialLookup(rel, i, t); return color * t + i; }
vec3 aerialSunColor() { return uAerialSunColor; }
uniform sampler2D uCloudShadow;
uniform vec4 uCloudShadowBox;
uniform vec3 uCloudShadowDir;
float aerialCloudShadow(vec3 rel) {
  if (uCloudShadowBox.w < 0.5) return 1.0;
  float h = uAerialCamAlt + dot(rel, uAerialCamUp);
  if (h > ${CLOUD_SHELL.top.toFixed(1)}) return 1.0;
  // ground point whose light ray crosses the same clouds
  vec3 g = rel - uCloudShadowDir * (max(h, 0.0) / max(dot(uCloudShadowDir, uAerialCamUp), 0.02));
  vec2 uv = (g.xz - uCloudShadowBox.xy) * uCloudShadowBox.z;
  float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  if (edge <= 0.0) return 1.0;
  vec3 s = texture(uCloudShadow, uv).xyz; // x = transmittance from the ground, y/z = cloud bottom/top
  float f = clamp((s.z - h) / max(s.z - s.y, 1.0), 0.0, 1.0);
  return mix(1.0, pow(clamp(s.x, 1e-6, 1.0), f), smoothstep(0.0, 0.04, edge));
}
// Earth shadow toward a light (W unit direction) at the fragment: 0 below the horizon raised by
// the opaque lower atmosphere (+12 km, as core/frames sunVisibility), 1 above, ~1 degree soft.
// The key light is colored for the view's focus body; this keeps a pad in the Earth's shadow dark
// while the tracked rocket 70 km up is sunlit (pad cam at twilight).
float aerialEarthShadow(vec3 rel, vec3 L) {
  vec3 p = uAerialCamUp * (${EARTH_RADIUS.toFixed(1)} + uAerialCamAlt) + rel;
  float r = length(p);
  float zen = acos(clamp(dot(p, L) / r, -1.0, 1.0));
  const float Reff = ${(EARTH_RADIUS + 12000).toFixed(1)};
  float dip = r > Reff ? acos(Reff / r) : 0.0;
  return clamp((1.5707963 + dip - zen) / 0.0188 + 0.5, 0.0, 1.0);
}
float aerialSunVisibility(vec3 rel) { return aerialEarthShadow(rel, uAerialSunDir); }
// atmospheric transmittance toward a light (W unit direction) at the fragment relative to the point
// the light colour was evaluated at (the focus): a terrain / ship / smoke fragment near sea level gets
// the reddened, dimmer light of the lower atmosphere while the key is coloured for a rocket 60 km up.
uniform sampler2D uAerialTransLUT;
uniform vec4 uAerialLightRef;
vec3 aerialTransToTop(float h, float mu) {
  const float R0 = ${EARTH_RADIUS.toFixed(1)}, HT = ${ATMO.H.toFixed(1)};
  h = clamp(h, 0.0, HT);
  float rho = sqrt(max(h * (2.0 * R0 + h), 0.0));
  float Hh = sqrt(HT * (2.0 * R0 + HT));
  // light below the geometric horizon: aerialEarthShadow handles the shadow, hold the horizon value
  mu = max(mu, -rho / (R0 + h) + 0.002);
  float r = R0 + h;
  float d = max(0.0, -r * mu + sqrt(max(r * r * mu * mu + (HT - h) * (2.0 * R0 + HT + h), 0.0)));
  float dMin = HT - h, dMax = rho + Hh;
  vec2 uv = vec2(clamp((d - dMin) / max(dMax - dMin, 1e-3), 0.0, 1.0), rho / Hh);
  uv = vec2(0.5 / 256.0, 0.5 / 64.0) + uv * vec2(1.0 - 1.0 / 256.0, 1.0 - 1.0 / 64.0);
  return texture(uAerialTransLUT, uv).rgb;
}
vec3 aerialLightTransRatio(vec3 rel, vec3 L) {
  if (uAerialLightRef.w < 0.0) return vec3(1.0);
  vec3 p = uAerialCamUp * (${EARTH_RADIUS.toFixed(1)} + uAerialCamAlt) + rel;
  float r = length(p);
  vec3 tF = aerialTransToTop(r - ${EARTH_RADIUS.toFixed(1)}, dot(p, L) / r);
  vec3 tR = aerialTransToTop(uAerialLightRef.w, dot(uAerialLightRef.xyz, L));
  return clamp(tF / max(tR, vec3(1e-3)), 0.0, 4.0);
}
#endif
`;

const LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshToonMaterial']);
const DIR_LIGHT_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';

const PATCHABLE = new Set([
  'MeshStandardMaterial',
  'MeshPhysicalMaterial',
  'MeshBasicMaterial',
  'MeshLambertMaterial',
  'MeshPhongMaterial',
  'MeshToonMaterial',
  'PointsMaterial',
  'SpriteMaterial',
]);

/** Patch a built-in material (MeshStandard/Physical/Lambert/Basic/Phong/Toon/Points/Sprite) for
 * aerial perspective via onBeforeCompile. Idempotent; chains an existing onBeforeCompile. */
export function patchMaterial(mat: THREE.Material): void {
  const m = mat as THREE.Material & { userData: Record<string, unknown> };
  if (m.userData.aerialPatched || m.userData.noAerial) return;
  if (!PATCHABLE.has(m.type)) return;
  m.userData.aerialPatched = true;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  const additive = m.blending === THREE.AdditiveBlending;
  m.onBeforeCompile = function (shader, renderer) {
    prev?.call(this, shader, renderer);
    Object.assign(shader.uniforms, aerialUniforms);
    let vs = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vAerialRel;');
    if (vs.includes('#include <project_vertex>')) {
      vs = vs.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          #ifdef USE_INSTANCING
            vec4 aerialWp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #else
            vec4 aerialWp = modelMatrix * vec4(transformed, 1.0);
          #endif
          vAerialRel = aerialWp.xyz - cameraPosition;
        }`,
      );
    } else {
      // sprites: use the object origin
      vs = vs.replace('#include <logdepthbuf_vertex>', 'vAerialRel = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz - cameraPosition;\n#include <logdepthbuf_vertex>');
    }
    shader.vertexShader = vs;
    // blending multiplies by alpha afterwards, so in-scatter is added unweighted here
    const apply = additive ? 'gl_FragColor.rgb *= aerialT;' : 'gl_FragColor.rgb = gl_FragColor.rgb * aerialT + aerialI;';
    let fs = shader.fragmentShader;
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    if (LIT.has(m.type) && fs.includes('#include <lights_fragment_begin>') && chunk.includes(DIR_LIGHT_LINE)) {
      // volumetric cloud shadows on the directional (sun/moon) lights
      fs = fs.replace(
        '#include <lights_fragment_begin>',
        'float aerialCloudSh = aerialCloudShadow(vAerialRel);\n' + chunk.replace(DIR_LIGHT_LINE, DIR_LIGHT_LINE + '\n\t\t{ vec3 aerLW = normalize((vec4(directionalLight.direction, 0.0) * viewMatrix).xyz);\n\t\tdirectLight.color *= aerialCloudSh * aerialEarthShadow(vAerialRel, aerLW) * aerialLightTransRatio(vAerialRel, aerLW); }'),
      );
    }
    shader.fragmentShader = fs
      .replace('#include <common>', `#include <common>\nvarying vec3 vAerialRel;\n${AERIAL_GLSL}`)
      .replace(
        '#include <tonemapping_fragment>',
        `{ vec3 aerialI, aerialT; aerialLookup(vAerialRel, aerialI, aerialT); ${apply} }
        #include <tonemapping_fragment>`,
      );
  };
  m.customProgramCacheKey = function () {
    return (prevKey ? prevKey.call(this) : '') + (additive ? '|aerialA4' : '|aerial4');
  };
  m.needsUpdate = true;
}

/** Patch every material under root (cheap; call periodically). */
export function patchObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (o.userData.noAerial) return;
    if (Array.isArray(mat)) mat.forEach(patchMaterial);
    else patchMaterial(mat);
  });
}
