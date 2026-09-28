// HDR composite: heat haze + long-lens shimmer distortion, camera motion blur, bloom + lens dirt,
// flares, auto-exposure, tone mapping (AgX / ACES / Neutral), sRGB encode + dither -> LDR.
import { COMMON } from './common';

export const MAX_HAZE = 4;

export const TONEMAP_GLSL = /* glsl */ `
const mat3 LIN_REC2020_TO_LIN_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187));
const mat3 LIN_SRGB_TO_LIN_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
// AgX (Sobotka / Filament / three.js), with an ASC-CDL look in AgX space. Linear sRGB in/out.
vec3 tonemapAgX(vec3 color, vec3 look) {
  const mat3 AgXInset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393;
  const float AgxMaxEv = 4.026069;
  color = LIN_SRGB_TO_LIN_REC2020 * color;
  color = AgXInset * color;
  color = max(color, 1e-10);
  color = clamp((log2(color) - AgxMinEv) / (AgxMaxEv - AgxMinEv), 0.0, 1.0);
  color = agxContrast(color);
  // look: slope, power, saturation
  color = pow(max(color * look.x, 0.0), vec3(look.y));
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = l + look.z * (color - l);
  color = AgXOutset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LIN_REC2020_TO_LIN_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 tonemapACES(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 tonemapNeutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
${COMMON}
${TONEMAP_GLSL}
#define MAX_HAZE ${MAX_HAZE}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec4 uSceneX;       // region transform of scene/depth
uniform vec2 uScenePx;      // valid size in px
uniform sampler2D tBloom;
uniform vec4 uBloomX;
uniform sampler2D tGhost;   // 2x1 ghost source statistics (GHOST_REDUCE_FRAG)
uniform vec4 uGhost;        // gain (0 = off), spread where ghosts start to fade / are gone (frame-height units), cap
uniform sampler2D tDirt;
uniform vec4 uDirtX;        // dirt uv = vUv * xy + zw
uniform sampler2D tExp;
uniform float uAspect;
uniform float uTime;
uniform float uFrame;
uniform vec4 uBloom;        // strength, dirt, _, _
uniform int uHazeCount;
uniform vec4 uHazeA[MAX_HAZE];  // uv start.xy, uv end.zw
uniform vec4 uHazeB[MAX_HAZE];  // radius start/end (uv-y), depth start/end (m)
uniform vec4 uHazeC[MAX_HAZE];  // strength at start, world radius start/end, strength at end
uniform vec4 uShimmer;      // amount, near fade (m), far (m), _
uniform vec4 uMB;           // on, samples, max length (uv-y), shutter scale
uniform mat4 uReproj;
uniform vec4 uProj;         // P00, P11, P20(=elements[8]), P21(=elements[9])
uniform float uSubjOverride;
uniform vec4 uSun;          // pos (aspect-centered).xy, on, strength
uniform vec4 uSunRot;       // starburst rotation, sun radius (uv-y), _, _
uniform sampler2D tLocal;   // wide blurred HDR (bloom up-chain level) = local adaptation level
uniform vec4 uLocalX;
uniform vec4 uLocal;        // strength (0 = off), start (stops over key), range dark, range bright (stops)
uniform vec4 uKey;          // same as the adapt pass: log2 key dark/bright, Ln dark/bright
uniform vec4 uNight;        // mesopic look: strength (0 = off), log2 scene lum fully scotopic, log2 lum photopic, blue shift
uniform int uTonemap;       // 0 agx, 1 aces, 2 neutral
uniform vec3 uLook;
uniform int uDebug;
varying vec2 vUv;

vec3 sceneAt(vec2 uv) { return texture2D(tScene, rgn(uv, uSceneX)).rgb; }
float depthAt(vec2 uv) { return texture2D(tDepth, rgn(uv, uSceneX)).r; }

vec2 hazeOffset(vec2 uv, float depth, out float mask) {
  vec2 off = vec2(0.0);
  mask = 0.0;
  vec2 asp = vec2(uAspect, 1.0);
  for (int i = 0; i < MAX_HAZE; i++) {
    if (i >= uHazeCount) break;
    vec4 A = uHazeA[i], B = uHazeB[i], C = uHazeC[i];
    vec2 pa = (uv - A.xy) * asp;
    vec2 ba = (A.zw - A.xy) * asp;
    float bb = max(dot(ba, ba), 1e-12);
    float h = clamp(dot(pa, ba) / bb, 0.0, 1.0);
    float dist = length(pa - ba * h);
    // projected radius is linear in screen space; depth and world radius are perspective-correct (1/z linear)
    float r = max(mix(B.x, B.y, h), 1e-5);
    if (dist > r) continue;
    float iz = mix(1.0 / B.z, 1.0 / B.w, h);
    float zc = 1.0 / iz;
    float rw = mix(C.y / B.z, C.z / B.w, h) * zc;
    // only distort what lies behind the hot gas
    float behind = smoothstep(zc - rw, zc + rw * 0.25, depth);
    float m = 1.0 - smoothstep(0.2, 1.0, dist / r);
    m *= m * behind * mix(C.x, C.w, h);
    if (m <= 0.0) continue;
    vec2 dir = ba * inversesqrt(bb);
    vec2 perp = vec2(-dir.y, dir.x);
    // turbulence cell size follows the capsule radius, capped so a capsule close to the lens stays a fine
    // shimmer instead of a few screen-sized swirls
    float rn = min(r, 0.12);
    vec2 q = vec2(dot(pa, dir), dot(pa, perp)) / rn;
    q.x -= uTime * 2.2 * r / rn;  // flow ~2.2 capsule radii per second
    float s = float(i) * 13.7;
    vec2 n = vec2(gnoise(q * vec2(1.3, 2.2) + s) + 0.5 * gnoise(q * vec2(3.1, 5.0) + s + 7.1),
                  gnoise(q * vec2(1.3, 2.2) + s + 31.3) + 0.5 * gnoise(q * vec2(3.1, 5.0) + s + 53.9));
    vec2 d = (n.x * perp + n.y * dir) * rn * 0.09 * m;
    off += d;
    mask = max(mask, m);
  }
  float l = length(off);
  if (l > 0.012) off *= 0.012 / l;
  return off / asp;
}

vec2 shimmerOffset(vec2 uv, float depth) {
  float s = uShimmer.x * smoothstep(uShimmer.y, uShimmer.z, depth);
  if (s <= 0.0) return vec2(0.0);
  vec2 q = uv * vec2(uAspect, 1.0);
  float t = uTime;
  // fine boil (rising turbulent cells) + slow large-scale wander
  vec2 n1 = vec2(gnoise(q * vec2(30.0, 55.0) + vec2(0.0, -t * 3.1)), gnoise(q * vec2(30.0, 55.0) + vec2(17.0, -t * 2.7)));
  vec2 n2 = vec2(gnoise(q * vec2(6.0, 9.0) + vec2(t * 0.6, -t * 0.9)), gnoise(q * vec2(6.0, 9.0) + vec2(9.0 - t * 0.5, t * 0.4)));
  vec2 d = (n1 * 0.0007 + n2 * 0.0016) * s;
  return d / vec2(uAspect, 1.0);
}

vec3 motionBlur(vec2 uv, vec2 uvd, float depth, float subj) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 pv = vec3((ndc.x + uProj.z) * depth / uProj.x, (ndc.y + uProj.w) * depth / uProj.y, -depth);
  vec4 pc = uReproj * vec4(pv, 1.0);
  vec3 c0 = sceneAt(uvd);
  if (pc.w <= 1e-4) return c0;
  vec2 prev = pc.xy / pc.w * 0.5 + 0.5;
  vec2 vel = (uv - prev) * uMB.w;
  // only the background streaks: the tracked subject (and everything bolted to an onboard cam)
  // moves with the camera in reality
  vel *= smoothstep(subj * 1.25, subj * 2.5, depth);
  vec2 va = vel * vec2(uAspect, 1.0);
  float len = length(va);
  if (len > uMB.z) { vel *= uMB.z / len; len = uMB.z; }
  if (len * uScenePx.y < 0.7) return c0;
  int N = int(uMB.y);
  float jit = hash12(gl_FragCoord.xy + fract(uFrame * 0.618) * 97.0) - 0.5;
  vec3 acc = c0;
  float wsum = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= N) break;
    float t = (float(i) + 0.5 + jit) / float(N) - 0.5;
    vec2 su = uvd + vel * t;
    float w = smoothstep(subj * 1.1, subj * 1.6, depthAt(su));
    acc += sceneAt(su) * w;
    wsum += w;
  }
  return acc / wsum;
}

float sdHex(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// Lens ghosts of the dominant COMPACT highlight (a distant plume core, a lamp). Each ghost is a
// defocused image of the aperture at centroid * k on the line through the optical centre (k < 0:
// mirrored through it): soft rounded-hexagon discs and thin rings, coating-tinted, each smaller than
// the source. Brightness = reflected share of the source flux spread over the ghost's area, faded
// out for broad sources (a plume filling the frame makes no visible ghosts) and soft-capped so a
// ghost stays a faint tint however hot the source is.
vec3 lensGhosts(vec2 p) {
  vec4 g0 = texelFetch(tGhost, ivec2(0, 0), 0);
  float F = g0.x;
  if (!(F > 1e-7) || !(F < 1e6)) return vec3(0.0);
  // spread relative to the frame's short side: in portrait, frame-height units would make a plume that fills
  // the width look compact (red ghost rings beside the MECO plume in 9:16)
  float compact = 1.0 - smoothstep(uGhost.y, uGhost.z, g0.w / min(uAspect, 1.0));
  if (compact <= 0.0) return vec3(0.0);
  vec4 g1 = texelFetch(tGhost, ivec2(1, 0), 0);
  vec3 src = max(g1.rgb, vec3(0.0));
  src = mix(vec3(1.0), src / max(luma(src), 1e-4), 0.55);
  vec2 c = g0.yz;
  float srcR = max(g0.w * 1.41421, 0.008); // rms radius -> radius of an equivalent disc
  const mat2 ROT = mat2(0.966, 0.259, -0.259, 0.966);
  float K[5] = float[](-0.42, -0.86, 0.38, -1.32, -0.16);
  float S[5] = float[](0.42, 0.75, 0.28, 0.6, 0.2);    // ghost radius / source radius
  float FILL[5] = float[](0.85, 0.15, 0.9, 0.25, 1.0); // filled disc share (rest = thin ring)
  float RR[5] = float[](1.0, 0.55, 0.7, 0.35, 0.8);    // relative reflectance
  vec3 TT[5] = vec3[](vec3(0.55, 1.0, 0.7), vec3(0.8, 0.6, 1.0), vec3(1.0, 0.8, 0.55), vec3(0.55, 0.75, 1.0), vec3(1.0, 0.95, 0.85));
  vec3 acc = vec3(0.0);
  float cl = length(c);
  for (int i = 0; i < 5; i++) {
    // defocus floor: even a point source makes a soft disc, not a pin-point dot
    float r = srcR * S[i] + 0.006;
    // a ghost lands |c| (1 - K) from its source. Near the optical centre (a tracked vehicle) it sits on / next
    // to the source, buried in its glare: drawn there it only tints the core or leaves a coloured dot beside it
    // (green rim at T+140 on the long lens; a green disc + pink ring on the stage above the plume on
    // pad:up). Fade it in only once it is well clear of the source: a tracked (centred) subject makes none,
    // an off-centre highlight still does.
    float sep = cl * abs(1.0 - K[i]);
    float apart = smoothstep(0.12 + 2.0 * srcR, 0.32 + 3.0 * srcR, sep);
    if (apart <= 0.0) continue;
    vec2 d = p - c * K[i];
    float dl = length(d);
    if (dl > r * 1.35) continue;
    float sd = mix(dl - r, sdHex(ROT * d, r * 0.95), 0.6);
    float disc = 1.0 - smoothstep(-r * 0.3, r * 0.08, sd);
    float rim = exp(-(sd * sd) / (r * r * 0.012));
    float shape = disc * FILL[i] + rim * (1.0 - FILL[i]) * 1.8;
    acc += TT[i] * (shape * RR[i] * apart / (3.14159 * r * r));
  }
  acc *= src * (F * uGhost.x * compact);
  float l = luma(acc);
  return l > 0.0 ? acc * (uGhost.w * (1.0 - exp(-l / uGhost.w)) / l) : acc;
}

// analytic sun lens effects: faint aperture-shaped ghosts along the optical axis, a soft glare
// core and a thin 6-blade diffraction star (strength per lens: uSunRot.z)
vec3 sunFx(vec2 p, float disp) {
  vec2 s = uSun.xy;
  vec3 acc = vec3(0.0);
  const int NG = 5;
  float F[5] = float[](-0.42, -0.9, 0.5, -1.45, -0.2);
  float R[5] = float[](0.04, 0.085, 0.022, 0.17, 0.012);
  vec3 TT[5] = vec3[](vec3(0.55, 0.9, 0.6), vec3(0.85, 0.65, 1.0), vec3(0.6, 0.8, 1.0), vec3(1.0, 0.8, 0.55), vec3(0.9, 0.95, 1.0));
  float I[5] = float[](0.018, 0.010, 0.022, 0.005, 0.03);
  float edgeFade = 1.0 - smoothstep(0.35, 0.95, length(s) / max(uAspect, 1.0));
  for (int i = 0; i < NG; i++) {
    vec2 c = s * F[i];
    float r = R[i];
    float d = sdHex((p - c) * mat2(0.966, 0.259, -0.259, 0.966), r);
    float m = 1.0 - smoothstep(-r * 0.3, r * 0.25, d);
    float rim = 1.0 + 0.5 * smoothstep(-r * 0.5, 0.0, d);
    acc += TT[i] * m * rim * I[i] * (0.3 + 0.7 * edgeFade);
  }
  vec2 d = p - s;
  float rr = length(d);
  float sr = max(uSunRot.y, 1e-4);
  float a = atan(d.y, d.x) + uSunRot.x;
  float spikes = pow(abs(cos(a * 3.0)), 900.0) + 0.3 * pow(abs(cos(a * 3.0 + 1.5708)), 1500.0);
  float fall = exp(-rr / (sr * 14.0));
  acc += vec3(1.0, 0.97, 0.92) * spikes * fall * uSunRot.z;
  // veiling glare core just outside the disc
  acc += vec3(1.0, 0.94, 0.86) * (exp(-rr / (sr * 2.5)) * 0.5 + exp(-rr / (sr * 12.0)) * 0.06);
  return acc * disp;
}

void main() {
  vec2 uv = vUv;
  float depth = depthAt(uv);
  vec4 E = texelFetch(tExp, ivec2(0), 0);
  float exposure = E.g;

  vec2 off = vec2(0.0);
  float hazeMask = 0.0;
  if (uHazeCount > 0) off += hazeOffset(uv, depth, hazeMask);
  if (uShimmer.x > 0.0) off += shimmerOffset(uv, depth);
  vec2 uvd = uv + off;

  float subj = uSubjOverride > 0.0 ? min(E.a, uSubjOverride) : E.a;
  vec3 col = uMB.x > 0.5 ? motionBlur(uv, uvd, depth, subj) : sceneAt(uvd);

  vec3 bloom = texture2D(tBloom, rgn(uv, uBloomX)).rgb;
  vec3 dirt = texture2D(tDirt, uv * uDirtX.xy + uDirtX.zw).rgb;
  // mesopic / scotopic vision at night: dim (moon-lit) regions lose colour toward the rod response
  // (Purkinje: blue-greens stay, reds sink) with a slight blue cast. Driven by scene luminance, so
  // flood-lit and plume-lit areas keep their colour. Env scales uNight.x with the night factor.
  if (uNight.x > 0.0) {
    float ls = log2(max(luma(col), 1e-20));
    float m = uNight.x * (1.0 - smoothstep(uNight.y, uNight.z, ls)); // edges ordered (GLSL: e0 >= e1 undefined)
    float rod = dot(col, vec3(0.05, 0.55, 0.40));
    vec3 tint = mix(vec3(1.0), vec3(0.80, 0.93, 1.25), uNight.w);
    tint /= dot(tint, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, rod * tint, m);
  }
  col *= exposure;
  // local highlight compression ("camera knee" + local adaptation): regions far above the metered
  // level (a night / twilight plume, plume-lit smoke) are pulled down with an exponential shoulder
  // that saturates at "range" stops over the start point. The compression amount comes from
  // min(own, local average), so detail inside bright regions is kept (slope 1 where a pixel is
  // brighter than its surroundings) and dark pixels next to bright ones are untouched (no halos).
  if (uLocal.x > 0.0) {
    float keyL = log2(max(exposure, 1e-30)) + E.r;       // log2 display level of the metered lum
    float day = smoothstep(uKey.x, uKey.y, keyL);
    float start = keyL + uLocal.y;
    float R = mix(uLocal.z, uLocal.w, day);
    float yo = log2(max(luma(col), 1e-12));
    float yb = log2(max(luma(texture2D(tLocal, rgn(uv, uLocalX)).rgb) * exposure, 1e-12));
    float ex = max(min(yo, yb + 0.5) - start, 0.0);
    float off = (R * (1.0 - exp(-ex / R)) - ex) * uLocal.x;
    col *= exp2(off);
  }
  col = mix(col, bloom * exposure, uBloom.x) + bloom * exposure * dirt * uBloom.y;
  vec3 ghosts = vec3(0.0);
  if (uGhost.x > 0.0) {
    ghosts = lensGhosts((uv - 0.5) * vec2(uAspect, 1.0));
    col += ghosts * (1.0 + dirt * 1.5);
  }
  if (uSun.z > 0.5) {
    float disp = uSun.w * (1.0 - exp(-E.b * exposure / 30.0));
    if (disp > 0.001) {
      vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
      col += sunFx(p, disp) * (1.0 + dirt * 2.0);
    }
  }

  vec3 outc;
  if (uTonemap == 1) outc = tonemapACES(col);
  else if (uTonemap == 2) outc = clamp(tonemapNeutral(col), 0.0, 1.0);
  else outc = tonemapAgX(col, uLook);

  if (uDebug == 1) outc = vec3(fract(log2(max(depth, 1.0)) / 4.0), log2(max(depth, 1.0)) / 30.0, 0.0);
  else if (uDebug == 2) outc = tonemapAgX(bloom * exposure, vec3(1.0));
  else if (uDebug == 3) outc = vec3(clamp((E.r + 8.0) / 16.0, 0.0, 1.0), exposure > 1.0 ? 1.0 : exposure, 0.0);
  else if (uDebug == 4) outc = vec3(abs(off) * 150.0, hazeMask);
  else if (uDebug == 5) outc = dirt;
  else if (uDebug == 6) outc = tonemapAgX(ghosts * 8.0, vec3(1.0));

  outc = linearToSrgb(outc);
  // triangular dither before 8-bit quantization
  float n = hash12(gl_FragCoord.xy + fract(uFrame * 0.1234) * 311.0) + hash12(gl_FragCoord.yx * 1.37 + 17.0 + fract(uFrame * 0.377) * 97.0) - 1.0;
  outc += n / 255.0;
  gl_FragColor = vec4(outc, 1.0);
}
`;
