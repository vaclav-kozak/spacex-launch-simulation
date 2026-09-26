// Standalone post-pipeline test bench (post-test.html). Synthetic HDR scene in the real lighting
// units: sky + sun disc, pad ground, lattice tower, white PBR rocket, radiance ~90 plume (LAYER_VFX),
// soft-particle smoke sampling ctx.sceneDepth (LAYER_VFX), heat-haze sources, 1-4 viewports with
// animated rects.
//   ?scene=day|twilight|night|space  views=1..4  anim=1  move=1  q=0..3  photo=1  dof=1
//   debug=depth|bloom|exposure|haze|dirt|flare  modes=chase,long_lens,onboard_down,pad  tm=agx|aces
import * as THREE from 'three';
import { LAYER_DEFAULT, LAYER_VFX, type AppContext, type ViewInfo, type CameraMode } from '../../core/context';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS } from '../../core/settings';
import { PostPipeline } from './PostPipeline';
import { GpuTimer } from './GpuTimer';

const P = new URLSearchParams(location.search);
const SCENE = P.get('scene') ?? 'day';
const NVIEWS = Math.max(1, Math.min(4, Number(P.get('views') ?? 1)));
const ANIM = P.get('anim') === '1';
const MOVE = P.get('move') === '1';
const SPIN = Number(P.get('spin') ?? 0.15);
const QL = P.has('q') ? (Number(P.get('q')) as 0 | 1 | 2 | 3) : 2;
const MODES = (P.get('modes') ?? 'chase,long_lens,onboard_down,pad').split(',') as CameraMode[];

const renderer = new THREE.WebGLRenderer({
  antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const ctx: AppContext = {
  renderer, scene, worldRoot, renderOrigin: new THREE.Vector3(),
  settings: { ...DEFAULT_SETTINGS },
  quality: { level: QL, renderScale: [0.6, 0.75, 0.9, 1][QL], frameMs: 16 },
  events: new EventBus(),
  lighting: {
    sunDir: new THREE.Vector3(0.5, 0.35, -0.8).normalize(), sunColor: new THREE.Color(1, 0.96, 0.9).multiplyScalar(6), sunVisibility: 1,
    skyColor: new THREE.Color(0.5, 0.7, 1.1), groundColor: new THREE.Color(0.15, 0.13, 0.1), envMap: null, exposureBias: 0,
    moonDir: new THREE.Vector3(0, 1, 0), moonColor: new THREE.Color(0, 0, 0),
  },
  hazeSources: [], plumeLights: [],
  sceneDepth: { texture: null, resolution: new THREE.Vector2(1, 1) },
  photoMode: P.get('photo') === '1', replay: false, realTime: 0,
  width: innerWidth, height: innerHeight,
};
if (P.get('dof') === '1') PostPipeline.settings.dof.enabled = true;
const dbg = P.get('debug');
if (dbg) PostPipeline.settings.debug = dbg as typeof PostPipeline.settings.debug;
const tm = P.get('tm');
if (tm === 'aces' || tm === 'neutral' || tm === 'agx') PostPipeline.settings.toneMapper = tm;
if (P.has('ev')) PostPipeline.settings.exposureBias = Number(P.get('ev'));

// ------------------------------------------------------------------ scenario lighting
const L = ctx.lighting;
let skyZenith = new THREE.Color(0.12, 0.25, 0.6), skyHorizon = new THREE.Color(0.55, 0.65, 0.8), sunDisc = 3000, stars = 0;
let hemi = 1.0, sunI = 6, plumeScale = 1, smokeColor = new THREE.Color(0.9, 0.9, 0.92), plumeLightI = 0;
const altitude = SCENE === 'space' ? 180_000 : 0;
if (SCENE === 'twilight') {
  L.sunDir.set(0.6, -0.03, -0.8).normalize();
  L.sunVisibility = 0;
  L.sunColor.setRGB(1, 0.5, 0.25).multiplyScalar(0.0);
  skyZenith = new THREE.Color(0.01, 0.02, 0.06); skyHorizon = new THREE.Color(0.25, 0.12, 0.08); sunDisc = 0;
  hemi = 0.08; sunI = 0; smokeColor = new THREE.Color(0.6, 0.35, 0.2).multiplyScalar(1.4); plumeLightI = 2500;
  L.skyColor.setRGB(0.05, 0.05, 0.08);
} else if (SCENE === 'night') {
  L.sunVisibility = 0; L.sunColor.setRGB(0, 0, 0);
  skyZenith = new THREE.Color(0.0003, 0.0005, 0.0012); skyHorizon = new THREE.Color(0.0012, 0.0012, 0.0016); sunDisc = 0; stars = 0.08;
  hemi = 0.01; sunI = 0; smokeColor = new THREE.Color(1.0, 0.55, 0.25).multiplyScalar(2.2); plumeLightI = 6000;
  L.skyColor.setRGB(0.01, 0.01, 0.015);
} else if (SCENE === 'space') {
  skyZenith = new THREE.Color(0, 0, 0); skyHorizon = new THREE.Color(0, 0, 0); stars = 0.05; hemi = 0.02; plumeScale = 0.08;
  L.skyColor.setRGB(0.02, 0.02, 0.03);
}

// sky dome (camera-attached)
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false,
  uniforms: { uZen: { value: skyZenith }, uHor: { value: skyHorizon }, uSun: { value: L.sunDir }, uDisc: { value: sunDisc } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w * 0.9999; }`,
  fragmentShader: `uniform vec3 uZen, uHor, uSun; uniform float uDisc; varying vec3 vDir;
    void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0.0, 1.0);
      vec3 c = mix(uHor, uZen, pow(h, 0.45));
      float mu = dot(d, normalize(uSun));
      c += uHor * 0.6 * pow(max(mu, 0.0), 8.0) * step(0.0001, uDisc);
      c += vec3(1.0, 0.95, 0.85) * uDisc * smoothstep(0.99997, 0.999985, mu);
      if (d.y < 0.0) c = mix(uHor, uHor * 0.4, clamp(-d.y * 4.0, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0); }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(5e5, 64, 32), skyMat);
sky.renderOrder = -1000;
sky.frustumCulled = false;
scene.add(sky);
if (stars > 0) {
  const n = 3000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(4e5);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = stars * Math.pow(Math.random(), 6) * 4;
    col.set([b, b * 0.97, b * 1.05], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(pts);
}

const sunLight = new THREE.DirectionalLight(0xfff4e6, sunI);
sunLight.castShadow = sunI > 0;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 2000 });
worldRoot.add(sunLight, sunLight.target);
const hemiLight = new THREE.HemisphereLight(L.skyColor, L.groundColor, hemi);
scene.add(hemiLight);

// ------------------------------------------------------------------ geometry
const padY = 60;
const rocket = new THREE.Group();
worldRoot.add(rocket);
const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.45, metalness: 0.0 });
const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
const body = new THREE.Mesh(new THREE.CylinderGeometry(1.83, 1.83, 40, 48), white);
body.position.y = 3 + 20;
const inter = new THREE.Mesh(new THREE.CylinderGeometry(1.83, 1.83, 6.7, 48), black);
inter.position.y = 43 + 3.35;
const s2 = new THREE.Mesh(new THREE.CylinderGeometry(1.83, 1.83, 12, 48), white);
s2.position.y = 49.7 + 6;
const fair = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 2.6, 13, 48), white);
fair.position.y = 55.7 + 6.5;
const oct = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.6, 32), new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8, metalness: 0.4 }));
oct.position.y = 2.2;
for (const m of [body, inter, s2, fair, oct]) { m.castShadow = true; m.receiveShadow = true; rocket.add(m); }
// grid-fin-ish thin plates (thin geometry test)
for (let k = 0; k < 4; k++) {
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 0.05), black);
  const a = (k * Math.PI) / 2 + Math.PI / 4;
  fin.position.set(Math.cos(a) * 2.5, 45, Math.sin(a) * 2.5);
  fin.rotation.y = -a + Math.PI / 2;
  rocket.add(fin);
}

// plume (VFX layer): bright additive core + fainter outer sheath
const plumeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.7, 0.4).multiplyScalar(90 * plumeScale), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
const plume = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.2, 24, 32, 1, true), plumeMat);
plume.position.y = -12;
plume.layers.set(LAYER_VFX);
rocket.add(plume);
const plumeOuterMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.25).multiplyScalar(4 * plumeScale), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const plumeOuter = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 6, 60, 32, 1, true), plumeOuterMat);
plumeOuter.position.y = -30;
plumeOuter.layers.set(LAYER_VFX);
rocket.add(plumeOuter);
const plumeLight = new THREE.PointLight(0xffa060, plumeLightI, 0, 2);
plumeLight.position.y = -8;
rocket.add(plumeLight);

// soft smoke particles (VFX layer) sampling ctx.sceneDepth
const smokeMat = new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: smokeColor } },
  vertexShader: `#include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec2 vUv; varying float vViewZ;
    void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    }`,
  fragmentShader: `#include <common>
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D tDepth; uniform vec2 uRes; uniform vec3 uColor; varying vec2 vUv; varying float vViewZ;
    void main(){
      #include <logdepthbuf_fragment>
      float sceneZ = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
      float soft = clamp((sceneZ - vViewZ) / 10.0, 0.0, 1.0);
      float r = length(vUv - 0.5) * 2.0;
      float a = smoothstep(1.0, 0.1, r) * 0.85 * soft;
      gl_FragColor = vec4(uColor * a, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
});
const smokeGroup = new THREE.Group();
worldRoot.add(smokeGroup);
const smokeGeo = new THREE.PlaneGeometry(1, 1);
const smokes: THREE.Mesh[] = [];
if (SCENE !== 'space') {
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(smokeGeo, smokeMat);
    const a = (i / 14) * Math.PI * 2;
    const rr = 18 + (i % 3) * 9;
    m.position.set(Math.cos(a) * rr, padY + 5 + (i % 4) * 3, Math.sin(a) * rr);
    m.scale.setScalar(22 + (i % 5) * 5);
    m.layers.set(LAYER_VFX);
    m.onBeforeRender = () => {
      smokeMat.uniforms.tDepth.value = ctx.sceneDepth.texture;
      (smokeMat.uniforms.uRes.value as THREE.Vector2).copy(ctx.sceneDepth.resolution);
    };
    smokes.push(m);
    smokeGroup.add(m);
  }
}

if (SCENE !== 'space') {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60_000, 64), new THREE.MeshStandardMaterial({ color: 0x77705f, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = padY;
  ground.receiveShadow = true;
  worldRoot.add(ground);
  const concrete = new THREE.Mesh(new THREE.BoxGeometry(80, 1, 80), new THREE.MeshStandardMaterial({ color: 0xa8a49a, roughness: 0.8 }));
  concrete.position.y = padY - 0.4;
  concrete.receiveShadow = true;
  worldRoot.add(concrete);
  // lattice tower (thin members: AA test)
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.5, metalness: 0.6 });
  const tower = new THREE.Group();
  tower.position.set(-14, padY, 4);
  for (let y = 0; y < 72; y += 4) {
    for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4, 0.25), steel);
      post.position.set(x, y + 2, z);
      tower.add(post);
    }
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5.6, 0.12), steel);
    brace.position.set(0, y + 2, -2);
    brace.rotation.z = Math.atan2(4, 4);
    tower.add(brace);
    const brace2 = brace.clone();
    brace2.position.z = 2;
    brace2.rotation.z = -brace.rotation.z;
    tower.add(brace2);
  }
  tower.traverse((o) => { o.castShadow = true; });
  worldRoot.add(tower);
  // distant hills / structures for parallax + shimmer
  const rock = new THREE.MeshStandardMaterial({ color: 0x5d5a4c, roughness: 1 });
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2 + 0.3;
    const d = 3000 + (i % 7) * 1500;
    const hh = 150 + ((i * 37) % 11) * 60;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(900 + (i % 5) * 300, hh, 12), rock);
    hill.position.set(Math.cos(a) * d, padY + hh / 2 - 5, Math.sin(a) * d);
    worldRoot.add(hill);
  }
  // floodlights at night
  if (SCENE === 'night') {
    for (const [x, z] of [[40, 40], [-40, 40]]) {
      const l = new THREE.SpotLight(0xfff0dd, 60000, 0, 0.5, 0.6, 2);
      l.position.set(x, padY + 25, z);
      l.target.position.set(0, padY + 20, 0);
      worldRoot.add(l, l.target);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(400) }));
      bulb.position.copy(l.position);
      worldRoot.add(bulb);
    }
  }
}

// ------------------------------------------------------------------ views
function makeView(i: number, mode: CameraMode): ViewInfo {
  const fov = mode === 'long_lens' ? 2.5 : mode === 'onboard_down' ? 70 : mode === 'pad' ? 35 : 45;
  const cam = new THREE.PerspectiveCamera(fov, 1, mode === 'onboard_down' ? 0.1 : 0.5, 2e7);
  return {
    id: `v${i}`, label: mode, camera: cam, camWorldPos: new THREE.Vector3(), focus: 'S1', mode,
    rect: { x: 0, y: 0, w: 100, h: 100 }, alpha: 1, shimmer: mode === 'long_lens' ? 0.8 : 0, shake: 0,
    onboard: mode.startsWith('onboard'),
  };
}
const views: ViewInfo[] = [];
for (let i = 0; i < NVIEWS; i++) views.push(makeView(i, MODES[i % MODES.length]));
const posts = new Map<string, PostPipeline>();

function layout(t: number) {
  const W = innerWidth, H = innerHeight;
  const n = views.length;
  const k = ANIM ? 0.5 + 0.5 * Math.sin(t * 0.8) : 0.5;
  views.forEach((v, i) => {
    if (n === 1) Object.assign(v.rect, { x: 0, y: 0, w: W, h: H });
    else if (n === 2) {
      const sw = W * (ANIM ? 0.25 + 0.5 * k : 0.5);
      Object.assign(v.rect, i === 0 ? { x: 0, y: 0, w: sw, h: H } : { x: sw, y: 0, w: W - sw, h: H });
    } else {
      const cx = W * (ANIM ? 0.3 + 0.4 * k : 0.5), cy = H * 0.5;
      const r = [{ x: 0, y: 0, w: cx, h: cy }, { x: cx, y: 0, w: W - cx, h: cy }, { x: 0, y: cy, w: cx, h: H - cy }, { x: cx, y: cy, w: W - cx, h: H - cy }][i];
      Object.assign(v.rect, r);
      if (n === 3 && i === 2) v.rect.w = W;
    }
    v.alpha = ANIM && i === n - 1 ? 0.5 + 0.5 * Math.cos(t * 1.3) : 1;
  });
}

const rocketPos = new THREE.Vector3(0, padY + 3 + altitude, 0);
const tmp = new THREE.Vector3();
function updateScene(t: number) {
  const climb = MOVE ? 0.5 * 12 * t * t : SCENE === 'space' ? 0 : 25;
  rocketPos.set(0, padY + 3 + altitude + climb, 0);
  if (SCENE === 'space') { rocket.rotation.z = 0.6; rocketPos.x = t * 30; }
  rocket.position.copy(rocketPos);
  rocket.updateMatrixWorld(true);
  // hazeSources are W positions (rocket.matrixWorld includes worldRoot's floating-origin offset)
  const nozzle = new THREE.Vector3(0, 0, 0).applyQuaternion(rocket.quaternion).add(rocketPos);
  const tail = new THREE.Vector3(0, -40, 0).applyQuaternion(rocket.quaternion).add(rocketPos);
  ctx.hazeSources.length = 0;
  ctx.hazeSources.push({ start: nozzle, end: tail, radius0: 3.5, radius1: 14, strength: SCENE === 'space' ? 0.1 : 1 });
  sunLight.position.copy(rocketPos).addScaledVector(L.sunDir, 500);
  sunLight.target.position.copy(rocketPos);
  const mid = new THREE.Vector3(0, 25, 0).applyQuaternion(rocket.quaternion).add(rocketPos);
  // rocket pose in W (rocket.matrixWorld includes worldRoot's floating-origin offset)
  const rocketW = new THREE.Matrix4().compose(rocketPos, rocket.quaternion, new THREE.Vector3(1, 1, 1));
  for (const v of views) {
    const cam = v.camera;
    if (v.mode === 'chase') {
      v.camWorldPos.copy(mid).add(new THREE.Vector3(Math.sin(t * SPIN) * 70, -10, Math.cos(t * SPIN) * 70));
      cam.up.set(0, 1, 0);
      cam.lookAt(tmp.copy(mid).sub(v.camWorldPos));
    } else if (v.mode === 'long_lens') {
      v.camWorldPos.set(1100, padY + 6, 1700);
      cam.lookAt(tmp.copy(rocketPos).add(new THREE.Vector3(0, 10, 0)).sub(v.camWorldPos));
    } else if (v.mode === 'pad') {
      v.camWorldPos.set(120, padY + 1.6, 160);
      cam.lookAt(tmp.copy(rocketPos).add(new THREE.Vector3(0, 30, 0)).sub(v.camWorldPos));
    } else {
      // onboard: bolted to the interstage looking down the side
      v.camWorldPos.copy(new THREE.Vector3(2.1, 43.5, 0.7).applyMatrix4(rocketW));
      const target = new THREE.Vector3(2.4, -30, 1.5).applyMatrix4(rocketW);
      cam.up.set(1, 0, 0).applyQuaternion(rocket.quaternion);
      cam.lookAt(target.sub(v.camWorldPos));
    }
    cam.position.set(0, 0, 0);
  }
}

// ------------------------------------------------------------------ loop
let frameCount = 0;
(window as unknown as { __app: unknown }).__app = { get frameCount() { return frameCount; }, ctx, views, posts, PostPipeline };
function resize() {
  ctx.width = innerWidth;
  ctx.height = innerHeight;
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

const info = document.getElementById('info')!;
const timer = new GpuTimer(renderer);
PostPipeline.profiler = timer;
PostPipeline.profileDetail = P.get('prof') === '1';
let last = performance.now();
let tSim = Number(P.get('t') ?? 0);
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  ctx.realTime += dt;
  ctx.quality.frameMs = ctx.quality.frameMs * 0.95 + dt * 1000 * 0.05;
  tSim += dt;
  updateScene(tSim);
  layout(tSim);
  renderer.setRenderTarget(null);
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  for (const v of views) {
    if (v.alpha <= 0.001 || v.rect.w < 2 || v.rect.h < 2) continue;
    ctx.renderOrigin.copy(v.camWorldPos);
    worldRoot.position.copy(v.camWorldPos).negate();
    v.camera.position.set(0, 0, 0);
    scene.updateMatrixWorld();
    let p = posts.get(v.id);
    if (!p) posts.set(v.id, (p = new PostPipeline(ctx)));
    p.render(v);
  }
  frameCount++;
  timer.tick();
  if (frameCount % 30 === 0) {
    const e = posts.get('v0')?.readExposure() ?? [];
    info.textContent = `${SCENE} q${QL} ${(1000 / ctx.quality.frameMs).toFixed(0)} fps  L=${e[0]?.toFixed(2)} exp=${e[1]?.toFixed(3)} sun=${e[2]?.toFixed(1)} subj=${e[3]?.toFixed(0)}  ${timer.summary()}`;
    (window as unknown as { __timing: string }).__timing = timer.summary();
  }
  requestAnimationFrame(frame);
}
void LAYER_DEFAULT;
requestAnimationFrame(frame);
