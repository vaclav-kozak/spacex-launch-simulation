// SMAA 1x (Jimenez et al., MIT) — adapted from three.js' WebGL port (MIT) for sub-viewport
// rendering: vUv spans the valid region, `uScale` maps it into the pooled texture, and color
// fetches are clamped to the valid region (`uMaxUv`) so neighbouring viewports never bleed in.

const VS_HEAD = /* glsl */ `
uniform vec2 resolution;   // 1 / texture size
uniform vec2 uScale;       // valid / texture size
varying vec2 vUv;
`;

export const SMAA_EDGES_VERT = /* glsl */ `
${VS_HEAD}
varying vec4 vOffset[3];
void main() {
  vUv = uv * uScale;
  vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-1.0, 0.0, 0.0, 1.0);
  vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(1.0, 0.0, 0.0, -1.0);
  vOffset[2] = vUv.xyxy + resolution.xyxy * vec4(-2.0, 0.0, 0.0, 2.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SMAA_EDGES_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uMaxUv;
uniform float uThreshold;
varying vec2 vUv;
varying vec4 vOffset[3];
vec3 C_(vec2 c) { return texture2D(tDiffuse, min(c, uMaxUv)).rgb; }
void main() {
  vec2 threshold = vec2(uThreshold);
  vec4 delta;
  vec3 C = C_(vUv);
  vec3 t = abs(C - C_(vOffset[0].xy));
  delta.x = max(max(t.r, t.g), t.b);
  t = abs(C - C_(vOffset[0].zw));
  delta.y = max(max(t.r, t.g), t.b);
  vec2 edges = step(threshold, delta.xy);
  if (dot(edges, vec2(1.0, 1.0)) == 0.0) discard;
  t = abs(C - C_(vOffset[1].xy));
  delta.z = max(max(t.r, t.g), t.b);
  t = abs(C - C_(vOffset[1].zw));
  delta.w = max(max(t.r, t.g), t.b);
  float maxDelta = max(max(max(delta.x, delta.y), delta.z), delta.w);
  t = abs(C - C_(vOffset[2].xy));
  delta.z = max(max(t.r, t.g), t.b);
  t = abs(C - C_(vOffset[2].zw));
  delta.w = max(max(t.r, t.g), t.b);
  maxDelta = max(max(maxDelta, delta.z), delta.w);
  edges.xy *= step(0.5 * maxDelta, delta.xy);
  gl_FragColor = vec4(edges, 0.0, 1.0);
}
`;

export const SMAA_WEIGHTS_VERT = /* glsl */ `
${VS_HEAD}
varying vec4 vOffset[3];
varying vec2 vPixcoord;
void main() {
  vUv = uv * uScale;
  vPixcoord = vUv / resolution;
  vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-0.25, 0.125, 1.25, 0.125);
  vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(-0.125, 0.25, -0.125, -1.25);
  vOffset[2] = vec4(vOffset[0].xz, vOffset[1].yw) + vec4(-2.0, 2.0, -2.0, 2.0) * resolution.xxyy * float(SMAA_MAX_SEARCH_STEPS);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SMAA_WEIGHTS_FRAG = /* glsl */ `
#define SMAA_AREATEX_MAX_DISTANCE 16
#define SMAA_AREATEX_PIXEL_SIZE (1.0 / vec2(160.0, 560.0))
#define SMAA_AREATEX_SUBTEX_SIZE (1.0 / 7.0)
#define SMAASampleLevelZeroOffset(tex, coord, offset) texture2D(tex, coord + vec2(offset) * resolution, 0.0)
uniform sampler2D tDiffuse;
uniform sampler2D tArea;
uniform sampler2D tSearch;
uniform vec2 resolution;
varying vec2 vUv;
varying vec4 vOffset[3];
varying vec2 vPixcoord;

float SMAASearchLength(sampler2D searchTex, vec2 e, float bias, float scale) {
  e.r = bias + e.r * scale;
  return 255.0 * texture2D(searchTex, e, 0.0).r;
}
float SMAASearchXLeft(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
  vec2 e = vec2(0.0, 1.0);
  for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
    e = texture2D(edgesTex, texcoord, 0.0).rg;
    texcoord -= vec2(2.0, 0.0) * resolution;
    if (!(texcoord.x > end && e.g > 0.8281 && e.r == 0.0)) break;
  }
  texcoord.x += 0.25 * resolution.x;
  texcoord.x += resolution.x;
  texcoord.x += 2.0 * resolution.x;
  texcoord.x -= resolution.x * SMAASearchLength(searchTex, e, 0.0, 0.5);
  return texcoord.x;
}
float SMAASearchXRight(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
  vec2 e = vec2(0.0, 1.0);
  for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
    e = texture2D(edgesTex, texcoord, 0.0).rg;
    texcoord += vec2(2.0, 0.0) * resolution;
    if (!(texcoord.x < end && e.g > 0.8281 && e.r == 0.0)) break;
  }
  texcoord.x -= 0.25 * resolution.x;
  texcoord.x -= resolution.x;
  texcoord.x -= 2.0 * resolution.x;
  texcoord.x += resolution.x * SMAASearchLength(searchTex, e, 0.5, 0.5);
  return texcoord.x;
}
float SMAASearchYUp(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
  vec2 e = vec2(1.0, 0.0);
  for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
    e = texture2D(edgesTex, texcoord, 0.0).rg;
    texcoord += vec2(0.0, 2.0) * resolution;
    if (!(texcoord.y > end && e.r > 0.8281 && e.g == 0.0)) break;
  }
  texcoord.y -= 0.25 * resolution.y;
  texcoord.y -= resolution.y;
  texcoord.y -= 2.0 * resolution.y;
  texcoord.y += resolution.y * SMAASearchLength(searchTex, e.gr, 0.0, 0.5);
  return texcoord.y;
}
float SMAASearchYDown(sampler2D edgesTex, sampler2D searchTex, vec2 texcoord, float end) {
  vec2 e = vec2(1.0, 0.0);
  for (int i = 0; i < SMAA_MAX_SEARCH_STEPS; i++) {
    e = texture2D(edgesTex, texcoord, 0.0).rg;
    texcoord -= vec2(0.0, 2.0) * resolution;
    if (!(texcoord.y < end && e.r > 0.8281 && e.g == 0.0)) break;
  }
  texcoord.y += 0.25 * resolution.y;
  texcoord.y += resolution.y;
  texcoord.y += 2.0 * resolution.y;
  texcoord.y -= resolution.y * SMAASearchLength(searchTex, e.gr, 0.5, 0.5);
  return texcoord.y;
}
vec2 SMAAArea(sampler2D areaTex, vec2 dist, float e1, float e2, float offset) {
  vec2 texcoord = float(SMAA_AREATEX_MAX_DISTANCE) * round(4.0 * vec2(e1, e2)) + dist;
  texcoord = SMAA_AREATEX_PIXEL_SIZE * texcoord + (0.5 * SMAA_AREATEX_PIXEL_SIZE);
  texcoord.y += SMAA_AREATEX_SUBTEX_SIZE * offset;
  return texture2D(areaTex, texcoord, 0.0).rg;
}
void main() {
  vec4 weights = vec4(0.0);
  vec2 texcoord = vUv;
  vec2 e = texture2D(tDiffuse, texcoord).rg;
  if (e.g > 0.0) {
    vec2 d;
    vec2 coords;
    coords.x = SMAASearchXLeft(tDiffuse, tSearch, vOffset[0].xy, vOffset[2].x);
    coords.y = vOffset[1].y;
    d.x = coords.x;
    float e1 = texture2D(tDiffuse, coords, 0.0).r;
    coords.x = SMAASearchXRight(tDiffuse, tSearch, vOffset[0].zw, vOffset[2].y);
    d.y = coords.x;
    d = d / resolution.x - vPixcoord.x;
    vec2 sqrt_d = sqrt(abs(d));
    coords.y -= 1.0 * resolution.y;
    float e2 = SMAASampleLevelZeroOffset(tDiffuse, coords, ivec2(1, 0)).r;
    weights.rg = SMAAArea(tArea, sqrt_d, e1, e2, 0.0);
  }
  if (e.r > 0.0) {
    vec2 d;
    vec2 coords;
    coords.y = SMAASearchYUp(tDiffuse, tSearch, vOffset[1].xy, vOffset[2].z);
    coords.x = vOffset[0].x;
    d.x = coords.y;
    float e1 = texture2D(tDiffuse, coords, 0.0).g;
    coords.y = SMAASearchYDown(tDiffuse, tSearch, vOffset[1].zw, vOffset[2].w);
    d.y = coords.y;
    d = d / resolution.y - vPixcoord.y;
    vec2 sqrt_d = sqrt(abs(d));
    coords.y -= 1.0 * resolution.y;
    float e2 = SMAASampleLevelZeroOffset(tDiffuse, coords, ivec2(0, 1)).g;
    weights.ba = SMAAArea(tArea, sqrt_d, e1, e2, 0.0);
  }
  gl_FragColor = weights;
}
`;

export const SMAA_BLEND_VERT = /* glsl */ `
${VS_HEAD}
varying vec4 vOffset[2];
void main() {
  vUv = uv * uScale;
  vOffset[0] = vUv.xyxy + resolution.xyxy * vec4(-1.0, 0.0, 0.0, 1.0);
  vOffset[1] = vUv.xyxy + resolution.xyxy * vec4(1.0, 0.0, 0.0, -1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SMAA_BLEND_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;   // weights
uniform sampler2D tColor;
uniform vec2 resolution;
uniform vec2 uMaxUv;
varying vec2 vUv;
varying vec4 vOffset[2];
void main() {
  vec2 texcoord = vUv;
  vec4 a;
  a.xz = texture2D(tDiffuse, min(texcoord, uMaxUv)).xz;
  a.y = texture2D(tDiffuse, min(vOffset[1].zw, uMaxUv)).g;
  a.w = texture2D(tDiffuse, min(vOffset[1].xy, uMaxUv)).a;
  if (dot(a, vec4(1.0)) < 1e-5) {
    gl_FragColor = texture2D(tColor, min(texcoord, uMaxUv), 0.0);
    return;
  }
  vec2 offset;
  offset.x = a.a > a.b ? a.a : -a.b;
  offset.y = a.g > a.r ? -a.g : a.r;
  if (abs(offset.x) > abs(offset.y)) offset.y = 0.0;
  else offset.x = 0.0;
  vec4 C = texture2D(tColor, min(texcoord, uMaxUv), 0.0);
  texcoord += sign(offset) * resolution;
  vec4 Cop = texture2D(tColor, min(texcoord, uMaxUv), 0.0);
  float s = abs(offset.x) > abs(offset.y) ? abs(offset.x) : abs(offset.y);
  C.xyz = pow(C.xyz, vec3(2.2));
  Cop.xyz = pow(Cop.xyz, vec3(2.2));
  vec4 mixed = mix(C, Cop, s);
  mixed.xyz = pow(mixed.xyz, vec3(1.0 / 2.2));
  gl_FragColor = mixed;
}
`;
