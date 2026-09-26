// Yale Bright Star Catalogue (9096 stars, V ≤ 6.5) as camera-attached points at infinity.
// Irradiance from V magnitude relative to the sun (same radiometric units as the rest of the
// scene), colour from B-V via blackbody temperature, dimmed by the atmospheric transmittance
// along the line of sight, slight scintillation near the ground.
import * as THREE from 'three';
import { ATMO, ATMO_COMMON } from './atmosphere';

/** Ballesteros B-V -> temperature, then Planckian locus -> linear sRGB (luminance-normalized) */
function bvToRgb(bv: number): [number, number, number] {
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  // blackbody radiance sampled at sRGB primaries' dominant wavelengths (approx)
  const planck = (lnm: number) => {
    const l = lnm * 1e-9;
    return 1 / (Math.pow(l, 5) * (Math.exp(0.014388 / (l * T)) - 1));
  };
  let r = planck(610), g = planck(550), b = planck(465);
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r /= Y; g /= Y; b /= Y;
  // desaturate (eye/camera see star colours only faintly)
  const k = 0.55;
  return [1 + (r - 1) * k, 1 + (g - 1) * k, 1 + (b - 1) * k];
}

const VERT = /* glsl */ `
${ATMO_COMMON}
attribute vec3 aColor;
attribute float aMag;
uniform mat3 uEciToW;
uniform float uCamAlt;
uniform vec3 uCamUp;
uniform float uE0;
uniform float uPixelAng;
uniform float uTime;
uniform float uBoost;
varying vec3 vColor;
void main() {
  vec3 dir = normalize(uEciToW * position);
  vec4 clip = projectionMatrix * vec4((viewMatrix * vec4(dir, 0.0)).xyz, 1.0);
  clip.z = clip.w;
  gl_Position = clip;
  float mu = dot(dir, uCamUp);
  vec3 T = vec3(1.0);
  if (uCamAlt < ATM_H) {
    float muh = atmHorizonMu(uCamAlt);
    T = mu < muh ? vec3(0.0) : atmTransToTop(uCamAlt, mu);
  } else {
    float r = ATM_R + uCamAlt;
    float cTop = (uCamAlt - ATM_H) * (2.0 * ATM_R + uCamAlt + ATM_H);
    float disc = r * r * mu * mu - cTop;
    if (disc > 0.0 && mu < 0.0) {
      float t0 = cTop / (-r * mu + sqrt(disc));
      float muE = (r * mu + t0) / (ATM_R + ATM_H);
      T = atmDistToGround(ATM_H - 1.0, muE) > 0.0 ? vec3(0.0) : atmTransToTop(ATM_H - 1.0, muE);
    }
  }
  float E = uE0 * pow(10.0, -0.4 * aMag) * uBoost;
  // scintillation: stronger near the horizon, only inside the lower atmosphere
  float airmass = 1.0 / max(mu, 0.05);
  float tw = uCamAlt < 20000.0 ? 0.25 * min(airmass, 6.0) / 6.0 : 0.0;
  float ph = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  E *= 1.0 + tw * sin(uTime * (9.0 + 7.0 * fract(ph)) + ph) * sin(uTime * 3.1 + ph * 2.0);
  // brighter stars get a slightly larger footprint (PSF), energy conserved
  float size = clamp(2.2 + (2.0 - aMag) * 0.35, 2.0, 4.5);
  gl_PointSize = size;
  float omega = size * size * uPixelAng * uPixelAng * 0.36; // gaussian PSF effective solid angle
  vColor = aColor * T * E / omega;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float w = exp(-dot(p, p) * 3.2);
  gl_FragColor = vec4(vColor * w, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export async function loadStars(url: string, shared: Record<string, THREE.IUniform>): Promise<THREE.Points> {
  const buf = await (await fetch(url)).arrayBuffer();
  const a = new Float32Array(buf);
  const n = a.length / 4;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ra = a[i * 4], dec = a[i * 4 + 1];
    pos[i * 3] = Math.cos(dec) * Math.cos(ra);
    pos[i * 3 + 1] = Math.cos(dec) * Math.sin(ra);
    pos[i * 3 + 2] = Math.sin(dec);
    mag[i] = a[i * 4 + 2];
    const c = bvToRgb(a[i * 4 + 3]);
    col.set(c, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      ...shared,
      uEciToW: { value: new THREE.Matrix3() },
      // irradiance of a V=0 star relative to the sun (V=-26.74)
      uE0: { value: ATMO.sunE * Math.pow(10, -0.4 * 26.74) },
      uPixelAng: { value: 0.0005 },
      uTime: { value: 0 },
      uBoost: { value: 3 },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 10_001;
  pts.name = 'env.stars';
  return pts;
}
