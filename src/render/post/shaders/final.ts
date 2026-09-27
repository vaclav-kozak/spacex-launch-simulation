// Final pass into the canvas viewport: upscale from internal res, lens distortion, chromatic
// aberration, sharpen/soften, video look, vignette, sensor grain, view fade (alpha).
import { COMMON } from './common';

export const FINAL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform vec4 uSrc;         // region transform of the LDR image
uniform vec2 uTexel;       // 1/texSize of the LDR image
uniform sampler2D tExp;
uniform vec2 uOut;         // output size (device px)
uniform float uAspect;
uniform float uAlpha;
uniform float uFrame;
uniform vec4 uLens;        // vignette, CA (px at the corner, output), barrel k, sharpen(+)/soften(-)
uniform vec4 uGrain;       // amount, chroma, reference log2 exposure, gain slope
uniform vec4 uLook;        // saturation, contrast, black lift, _
varying vec2 vUv;

vec3 tex(vec2 uv) { return texture2D(tColor, rgn(uv, uSrc)).rgb; }

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float rc2 = 0.25 * (uAspect * uAspect + 1.0);
  float r2 = dot(p, p);
  // barrel distortion (corners stay put, center magnified)
  float k = uLens.z;
  vec2 pd = p * (1.0 + k * r2) / (1.0 + k * rc2);
  vec2 uvd = pd / vec2(uAspect, 1.0) + 0.5;

  // lateral chromatic aberration grows with r^2
  vec2 dir = uvd - 0.5;
  float caUv = uLens.y / uOut.y;           // px -> uv-y units
  float s = caUv * (r2 / rc2);
  vec2 dca = dir / max(length(dir * vec2(uAspect, 1.0)), 1e-4) * s;
  vec3 cg = tex(uvd);
  vec3 c = cg;
  if (uLens.y > 0.0) {
    c.r = tex(uvd + dca).r;
    c.b = tex(uvd - dca * 0.8).b;
  }

  // sharpen (broadcast) or soften (onboard) with a 4-tap diagonal kernel at source texel scale
  if (abs(uLens.w) > 0.001) {
    vec2 tt = uTexel / uSrc.xy * 0.75;
    vec3 b = tex(uvd + vec2(tt.x, tt.y)) + tex(uvd - vec2(tt.x, tt.y)) + tex(uvd + vec2(tt.x, -tt.y)) + tex(uvd + vec2(-tt.x, tt.y));
    b *= 0.25;
    if (uLens.w > 0.0) {
      vec3 d = cg - b;
      c += clamp(d, -0.08, 0.08) * uLens.w * 2.0;
    } else {
      c = mix(c, b, -uLens.w);
    }
  }

  // video look: saturation / contrast around mid-gray, black lift
  float l = luma(c);
  c = mix(vec3(l), c, uLook.x);
  c = (c - 0.45) * uLook.y + 0.45;
  c = c * (1.0 - uLook.z) + uLook.z;

  // vignette (optical falloff ~cos^4)
  float vr = r2 / rc2;
  float v = 1.0 / pow(1.0 + uLens.x * vr * 1.6, 2.0);
  c *= v;

  // sensor noise: stronger at high gain (dark scenes), mostly in shadows/mids
  float ex = texelFetch(tExp, ivec2(0), 0).g;
  float gain = clamp(1.0 + uGrain.w * (log2(max(ex, 1e-6)) - uGrain.z), 1.0, 3.5);
  vec2 fc = gl_FragCoord.xy;
  float seed = fract(uFrame * 0.61803) * 1000.0;
  float n = (hash12(fc + seed) + hash12(fc * 1.713 + seed + 41.0) + hash12(fc * 0.731 + seed + 83.0)) / 1.5 - 1.0;
  float lum = clamp(luma(c), 0.0, 1.0);
  float resp = (1.0 - 0.75 * smoothstep(0.25, 1.0, lum)) * (0.35 + 0.65 * smoothstep(0.0, 0.12, lum));
  float amt = uGrain.x * gain * resp;
  vec3 chroma = vec3(hash12(fc + seed + 7.0), hash12(fc + seed + 13.0), hash12(fc + seed + 29.0)) - 0.5;
  c += n * amt + chroma * amt * uGrain.y;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), uAlpha);
}
`;
