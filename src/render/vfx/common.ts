// Shared VFX helpers: uniforms shared by every VFX material, GLSL snippets (scene depth, noise,
// blackbody, phase functions), and CPU-side atmosphere helpers (sun radiance at an arbitrary
// W position incl. Earth shadow + reddening, air density, wind profile).
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import { EARTH_RADIUS } from '../../core/constants';
import { ATMO } from '../env/atmosphere';

/** Uniform objects shared (by reference) across all VFX materials. */
export const vfxShared = {
  uSceneDepth: { value: null as THREE.Texture | null },
  uSceneRes: { value: new THREE.Vector2(1, 1) },
  uHasDepth: { value: 0 },
  uNoise3D: { value: null as THREE.Data3DTexture | null },
  uVfxTime: { value: 0 },
  /** light direction (toward the sun) in view space of the current camera */
  uSunView: { value: new THREE.Vector3(0, 1, 0) },
  /** local up at the camera in view space */
  uUpView: { value: new THREE.Vector3(0, 1, 0) },
  /** viewport height in pixels (for pixel-size clamps) */
  uViewH: { value: 1080 },
};

/**
 * Refresh per-draw shared uniforms from ctx (called from onBeforeRender of every VFX mesh, so the
 * CURRENT view's depth texture is used even when each post pipeline owns a different one).
 */
export function refreshSharedForDraw(ctx: AppContext, camera: THREE.Camera, mat: THREE.Material, allowDepthTestFallback = true): void {
  const sd = ctx.sceneDepth;
  const has = !!sd.texture;
  vfxShared.uSceneDepth.value = sd.texture;
  vfxShared.uHasDepth.value = has ? 1 : 0;
  if (has) vfxShared.uSceneRes.value.copy(sd.resolution);
  else {
    const px = ctx.renderer.getPixelRatio();
    vfxShared.uSceneRes.value.set(Math.max(1, ctx.width * px), Math.max(1, ctx.height * px));
  }
  // actual viewport height of the view being drawn (the depth pool can be larger than the view)
  ctx.renderer.getCurrentViewport(_vp);
  vfxShared.uViewH.value = _vp.w > 0 ? _vp.w : vfxShared.uSceneRes.value.y;
  // with a linear scene depth we do occlusion + soft intersections ourselves
  if (allowDepthTestFallback) mat.depthTest = !has;
  _m3.setFromMatrix4(camera.matrixWorldInverse);
  vfxShared.uSunView.value.copy(ctx.lighting.sunDir).applyMatrix3(_m3).normalize();
  _up.set(ctx.renderOrigin.x, ctx.renderOrigin.y + EARTH_RADIUS, ctx.renderOrigin.z).normalize();
  vfxShared.uUpView.value.copy(_up).applyMatrix3(_m3).normalize();
}
const _m3 = new THREE.Matrix3();
const _vp = new THREE.Vector4();
const _up = new THREE.Vector3();

export const DEPTH_GLSL = /* glsl */ `
uniform sampler2D uSceneDepth;
uniform vec2 uSceneRes;
uniform float uHasDepth;
float vfxSceneDepth() {
  if (uHasDepth < 0.5) return 1e20;
  return texture2D(uSceneDepth, gl_FragCoord.xy / uSceneRes).r;
}
`;

export const NOISE_GLSL = /* glsl */ `
uniform highp sampler3D uNoise3D;
float n3(vec3 p) { return texture(uNoise3D, p).r; }
vec4 n3v(vec3 p) { return texture(uNoise3D, p); }
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

export const COLOR_GLSL = /* glsl */ `
// Approximate blackbody chromaticity (linear sRGB, max component = 1) for 1000..12000 K.
vec3 blackbody(float T) {
  T = clamp(T, 800.0, 12000.0) / 100.0;
  vec3 c;
  c.r = T <= 66.0 ? 1.0 : clamp(1.292936 * pow(T - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = T <= 66.0 ? clamp(0.39008158 * log(T) - 0.63184144, 0.0, 1.0)
                  : clamp(1.129890861 * pow(T - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.54320679 * log(T - 10.0) - 1.19625409, 0.0, 1.0));
  // sRGB-ish -> linear
  return pow(c, vec3(2.2));
}
// Visible radiance of a soot-laden flame vs temperature, normalised to 1 at 2300 K.
float flameRadiance(float T) {
  float x = max(T - 700.0, 0.0) / 1600.0;
  return x * x * x * x;
}
float hgPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
`;

// ---------------------------------------------------------------------------------------------
// CPU atmosphere helpers

// extinction coefficients: env's atmosphere (ATMO), so the per-puff / per-plume sun matches
// env's transmittanceCPU (ctx.lighting.sunColor) and the sky
const BR = ATMO.rayleigh; // Rayleigh (1/m)
const BO = ATMO.ozone; // ozone absorption (1/m), RGB-band averaged
const R_TOP = EARTH_RADIUS + ATMO.H;

/** Air density (kg/m^3), simple exponential atmosphere good enough for visuals. */
export function airDensity(alt: number): number {
  return 1.225 * Math.exp(-Math.max(alt, -100) / 8500);
}

export function altitudeW(x: number, y: number, z: number): number {
  const cy = y + EARTH_RADIUS;
  return Math.sqrt(x * x + cy * cy + z * z) - EARTH_RADIUS;
}

/**
 * Direct sun radiance (linear RGB, env units: ATMO.sunE) reaching W point p: Earth shadow with a
 * soft terminator plus Rayleigh/Mie/ozone extinction integrated along the sun ray through a
 * spherical shell atmosphere. Gives the red/golden twilight tints on high plumes.
 */
export function sunRadianceAt(px: number, py: number, pz: number, sun: THREE.Vector3, out: THREE.Color): THREE.Color {
  const cx = px, cy = py + EARTH_RADIUS, cz = pz;
  const r0 = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const mu = (cx * sun.x + cy * sun.y + cz * sun.z) / r0;
  // Earth shadow: closest approach of the sun ray to Earth's center (only if the sun is "below")
  let vis = 1;
  if (mu < 0) {
    const dmin = r0 * Math.sqrt(Math.max(0, 1 - mu * mu));
    // soft edge ~ the refracting lower atmosphere (0..15 km) acts as the penumbra
    vis = smooth(EARTH_RADIUS - 2000, EARTH_RADIUS + 14000, dmin);
  }
  if (vis <= 0) return out.setRGB(0, 0, 0);
  // integrate optical depth toward the sun until leaving the atmosphere
  let tTop = 0;
  if (r0 < R_TOP) {
    const b = r0 * mu;
    tTop = -b + Math.sqrt(Math.max(0, b * b - (r0 * r0 - R_TOP * R_TOP)));
  }
  // column densities: Rayleigh, aerosol (background + marine boundary layer, as extinction) and
  // the ozone tent; a grazing ray (sun near / below the local horizon) gets more samples
  let tr = 0, tm = 0, to = 0;
  const N = mu < 0.2 ? 28 : 12;
  let prevT = 0;
  for (let i = 1; i <= N; i++) {
    const f = i / N;
    const t = tTop * f * f; // denser near the start
    const tmid = 0.5 * (t + prevT);
    const dt = t - prevT;
    prevT = t;
    const rr = Math.sqrt(r0 * r0 + tmid * tmid + 2 * r0 * tmid * mu);
    const h = Math.max(rr - EARTH_RADIUS, 0);
    tr += Math.exp(-h / ATMO.rayleighH) * dt;
    tm += (ATMO.mieExt * Math.exp(-h / ATMO.mieH) + ATMO.blExt * Math.exp(-h / ATMO.blH)) * dt;
    to += Math.max(0, 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneHalfWidth) * dt;
  }
  const k = ATMO.sunE * vis;
  out.r = k * Math.exp(-(BR[0] * tr + tm + BO[0] * to));
  out.g = k * Math.exp(-(BR[1] * tr + tm + BO[1] * to));
  out.b = k * Math.exp(-(BR[2] * tr + tm + BO[2] * to));
  return out;
}

/** Sky ambient irradiance at altitude (scales env's sky color, fades to near-black in space). */
export function ambientAt(alt: number, ctx: AppContext, out: THREE.Color): THREE.Color {
  const f = 0.04 + 0.96 * Math.exp(-Math.max(alt, 0) / 9000);
  return out.copy(ctx.lighting.skyColor).multiplyScalar(f);
}

/** Wind at altitude: log-law near the ground, strengthening toward the jet stream, fading above. */
export function windScale(alt: number): number {
  const h = Math.max(alt, 1);
  const surf = Math.min(1.3, Math.max(0.35, Math.log(h / 0.3) / Math.log(10 / 0.3)));
  const jet = 1 + 2.2 * Math.exp(-Math.pow((h - 11000) / 6000, 2));
  const high = h > 20000 ? Math.exp(-(h - 20000) / 25000) : 1;
  return surf * jet * high;
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cheap deterministic hash -> [0,1). */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Small fast PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function loadNoise3D(url: string): Promise<THREE.Data3DTexture> {
  let data: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    data = new Uint8Array(await res.arrayBuffer());
  } catch {
    // fallback: white-ish noise so shaders still work
    const r = makeRng(1);
    data = new Uint8Array(64 * 64 * 64 * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 255);
  }
  const tex = new THREE.Data3DTexture(data, 64, 64, 64);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
