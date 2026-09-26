// Camera-attached sky: atmosphere radiance (sky-view LUT near the ground, per-pixel ray march
// from high altitude / space), sun disc, moon disc, Milky Way. Drawn as a full-screen triangle
// at the far plane after the opaque geometry (early-z rejects covered pixels).
import * as THREE from 'three';
import { ATMO, ATMO_COMMON } from './atmosphere';

export const SKY_FUNCS_GLSL = /* glsl */ `
${ATMO_COMMON}
uniform sampler2D uSkyViewLUT;
uniform float uCamAlt;
uniform vec3 uCamUp;
uniform vec3 uLightDir;
uniform vec3 uLightE;
uniform vec3 uLightTan;
uniform float uUseLUT;
uniform float uSkySteps;

// radiance of the atmosphere along dir from the camera (no sun disc), + transmittance to space
vec3 skyRadiance(vec3 dir, out vec3 Tview, out bool hitsGround) {
  float h = uCamAlt;
  float mu = dot(dir, uCamUp);
  float t0, t1;
  bool hg;
  bool inAtm = atmSegment(h, mu, t0, t1, hg);
  hitsGround = hg;
  Tview = vec3(1.0);
  if (!inAtm) return vec3(0.0);
  vec3 L;
  if (uUseLUT > 0.5) {
    vec3 dh = dir - uCamUp * mu;
    float lh = length(dh);
    float cosAz = lh > 1e-5 ? dot(dh / lh, uLightTan) : 1.0;
    vec2 uv = atmViewUV(h, mu, cosAz);
    uv = vec2(0.5 / 192.0, 0.5 / 108.0) + uv * vec2(191.0 / 192.0, 107.0 / 108.0);
    L = texture(uSkyViewLUT, uv).rgb;
  } else {
    float mus = dot(uLightDir, uCamUp);
    float nu = dot(dir, uLightDir);
    vec3 Tm;
    atmIntegrate(h, mu, mus, nu, t0, t1, int(uSkySteps), h > ATM_H ? 0 : 1, uLightE, L, Tm);
  }
  if (hg) Tview = vec3(0.0);
  else if (h <= ATM_H) Tview = atmTransToTop(h, mu);
  else {
    float r = ATM_R + h;
    float muE = (r * mu + t0) / (ATM_R + ATM_H);
    Tview = atmTransToTop(ATM_H - 1.0, muE);
  }
  return L;
}
`;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // unproject at the near plane (the far plane is numerically degenerate with far = 1e8)
  vec4 v = inverse(projectionMatrix) * vec4(position.xy, -1.0, 1.0);
  vDir = (inverse(viewMatrix) * vec4(v.xyz / v.w, 0.0)).xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
${SKY_FUNCS_GLSL}
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uMoonDir;
uniform float uMoonAngR;
uniform vec3 uMoonE;        // moon disc irradiance scale
uniform sampler2D uMoonTex;
uniform vec3 uMoonNorth;
uniform sampler2D uMilkyWay;
uniform mat3 uWtoEci;
uniform float uMWScale;
uniform vec3 uNightGlow;
uniform float uPixelAng;

void main() {
  vec3 dir = normalize(vDir);
  vec3 Tv;
  bool hg;
  vec3 L = skyRadiance(dir, Tv, hg);
  float px = uPixelAng;
  // sun disc with limb darkening (disc integrates to uSunE)
  float cs = dot(dir, uSunDir);
  float ang = acos(clamp(cs, -1.0, 1.0));
  const float SR = ${ATMO.sunAngularRadius};
  if (ang < SR + 2.0 * px) {
    float x = clamp(ang / SR, 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - x * x)));
    float cover = 1.0 - smoothstep(SR - px, SR + px, ang);
    L += Tv * uSunE / (ATM_PI * SR * SR * (1.0 - 0.6 / 3.0)) * limb * cover;
  }
  // moon disc (Lommel-Seeliger lit sphere, LROC albedo)
  float cm = dot(dir, uMoonDir);
  float am = acos(clamp(cm, -1.0, 1.0));
  if (am < uMoonAngR + 2.0 * px) {
    vec3 right = normalize(cross(uMoonNorth, uMoonDir));
    vec3 upm = cross(uMoonDir, right);
    vec3 d = dir / max(cm, 1e-4) - uMoonDir;
    vec2 q = vec2(dot(d, right), dot(d, upm)) / tan(uMoonAngR);
    float rr = dot(q, q);
    float cover = 1.0 - smoothstep(1.0 - px / uMoonAngR, 1.0 + px / uMoonAngR, sqrt(rr));
    vec2 qc = q / max(1.0, sqrt(rr));
    float z = sqrt(max(0.0, 1.0 - dot(qc, qc)));
    // normal in W: facing the viewer is -uMoonDir
    vec3 n = normalize(qc.x * right + qc.y * upm - z * uMoonDir);
    float mu0 = max(dot(n, uSunDir), 0.0);
    float mu1 = max(z, 1e-3);
    float ls = mu0 / (mu0 + mu1) * 2.0;
    // selenographic lon/lat: near side center faces Earth
    float lon = atan(qc.x, z);
    float lat = asin(clamp(qc.y, -1.0, 1.0));
    vec3 alb = texture(uMoonTex, vec2(0.5 + lon / (2.0 * ATM_PI), 0.5 + lat / ATM_PI)).rgb;
    vec3 moonL = uMoonE * alb * ls;
    // earthshine
    moonL += uMoonE * alb * 0.002;
    L = mix(L, L + Tv * moonL, cover);
  }
  // Milky Way + faint airglow (visible only once the sky is dark enough; auto-exposure decides)
  if (!hg) {
    vec3 e = uWtoEci * dir;
    float ra = atan(e.y, e.x);
    float dec = asin(clamp(e.z, -1.0, 1.0));
    vec2 uv = vec2(0.5 - ra / (2.0 * ATM_PI), 0.5 + dec / ATM_PI);
    vec3 mw = texture(uMilkyWay, uv).rgb;
    mw = pow(mw, vec3(2.2));
    L += Tv * (mw * uMWScale + uNightGlow);
  }
  gl_FragColor = vec4(L, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSkyMaterial(shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      ...shared,
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Vector3(6, 6, 6) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonAngR: { value: 0.00452 },
      uMoonE: { value: new THREE.Vector3(0, 0, 0) },
      uMoonTex: { value: null },
      uMoonNorth: { value: new THREE.Vector3(0, 0, -1) },
      uMilkyWay: { value: null },
      uWtoEci: { value: new THREE.Matrix3() },
      uMWScale: { value: 0 },
      uNightGlow: { value: new THREE.Vector3() },
      uPixelAng: { value: 0.0005 },
    },
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    side: THREE.DoubleSide,
  });
}

export function createSkyMesh(mat: THREE.ShaderMaterial): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 10_000;
  m.name = 'env.sky';
  return m;
}
