// Aerial-perspective API (atmospheric extinction + in-scattering between the camera and a
// fragment). OWNER: env agent — this file is a simple exponential-fog STAND-IN with the FINAL
// API; replace the implementation, keep the exported names/signatures.
//
// Usage from custom ShaderMaterials (vfx etc.):
//   uniforms: { ...aerialUniforms, ...yours }          // share the SAME uniform objects
//   fragment: `${AERIAL_GLSL}` at top level, then e.g.
//     vec3 rel = worldPosRelCamera;                       // fragment W pos minus camera W pos
//     color = aerialApply(color, rel);                    // opaque / alpha-blended
//     color *= aerialTransmittance(rel);                  // additive emitters (no inscatter)
// Standard three.js materials under ctx.worldRoot are patched automatically by env
// (patchMaterial is idempotent; env traverses new objects each frame).

import * as THREE from 'three';

export const aerialUniforms = {
  uAerialCamAlt: { value: 0 }, // camera altitude (m)
  uAerialCamUp: { value: new THREE.Vector3(0, 1, 0) }, // local up at camera (W)
  uAerialSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uAerialSunColor: { value: new THREE.Color(1, 1, 1) },
  uAerialFogColor: { value: new THREE.Color(0.55, 0.65, 0.8) },
  uAerialDensity: { value: 1 / 40000 },
};

export const AERIAL_GLSL = /* glsl */ `
uniform float uAerialCamAlt;
uniform vec3 uAerialCamUp;
uniform vec3 uAerialSunDir;
uniform vec3 uAerialSunColor;
uniform vec3 uAerialFogColor;
uniform float uAerialDensity;
float aerialOpticalDepth(vec3 rel) {
  float d = length(rel);
  float h0 = uAerialCamAlt;
  float h1 = uAerialCamAlt + dot(rel, uAerialCamUp);
  float H = 8000.0;
  float dh = h1 - h0;
  float avg = abs(dh) < 1.0 ? exp(-h0 / H) : H * (exp(-h0 / H) - exp(-h1 / H)) / dh;
  return d * uAerialDensity * max(avg, 0.0);
}
vec3 aerialTransmittance(vec3 rel) { return vec3(exp(-aerialOpticalDepth(rel))); }
vec3 aerialInscatter(vec3 rel) { return uAerialFogColor * (1.0 - exp(-aerialOpticalDepth(rel))); }
vec3 aerialApply(vec3 color, vec3 rel) { return color * aerialTransmittance(rel) + aerialInscatter(rel); }
`;

/** Patch a built-in lit material (MeshStandard/Physical/Lambert/Basic) for aerial perspective. */
export function patchMaterial(mat: THREE.Material): void {
  const m = mat as THREE.Material & { userData: Record<string, unknown> };
  if (m.userData.aerialPatched) return;
  m.userData.aerialPatched = true;
  // stand-in: no-op (env agent implements via onBeforeCompile)
}
