// Look-dev viewer for the vehicle / pad / ship models (models-viewer.html). OWNER: models.
//
// Drives the real VehicleVisuals with a synthetic SimSnapshot, under a neutral studio-ish light
// rig (RoomEnvironment PMREM + a 6-unit sun), tone-mapped locally (the app itself uses post).
//
// Query params (also accepted after '#'):
//   asset=stack|s1|landed|sep|fairing|payload|ship|pad   scene preset (default stack)
//   legs=0..1 fins=0..1 fin=deg (all fins) gx,gz=deg (centre engine gimbal)
//   soot=0|1 heat=0..1 mvac=0..1 (glow; or mvacT=seconds of burn) parafoil=0..1 deployT=s
//   lod=0|1|2 (force)  q=0..3 quality  tod=morning|twilight|night
//   view=front|side|base|top|fins|legs|octa|engine|deck|far   az,el,dist,ty (orbit overrides)
//   sun=az,el (deg)  exp=exposure  env=0..3 env intensity  pad=0 (hide pad)  ship=0
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AppContext, ViewInfo } from '../../core/context';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS, type Settings } from '../../core/settings';
import type { BodyId, BodyState, SimSnapshot, TimelineMarker } from '../../core/types';
import { F9 } from '../../core/vehicleSpec';
import { PAD_ELEVATION } from '../../core/constants';
import { VehicleVisuals, LAUNCH_MOUNT_HEIGHT } from './VehicleVisuals';

const raw = (location.search + '&' + location.hash.replace(/^#/, '')).replace(/^\?/, '');
const P = new URLSearchParams(raw);
const num = (k: string, d: number) => (P.has(k) && P.get(k) !== '' ? Number(P.get(k)) : d);
const str = (k: string, d: string) => P.get(k) ?? d;

const asset = str('asset', 'stack');
const W = window.innerWidth, H = window.innerHeight;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = num('exp', 0.32);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.5, 0.56, 0.64).multiplyScalar(num('bg', 1.0));
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex;
scene.environmentIntensity = num('env', 1.6);

const worldRoot = new THREE.Group();
scene.add(worldRoot);

const settings: Settings = { ...DEFAULT_SETTINGS, sootyBooster: num('soot', 0) === 1, timeOfDay: (str('tod', 'morning') as Settings['timeOfDay']) };
const ctx: AppContext = {
  renderer, scene, worldRoot, renderOrigin: new THREE.Vector3(), settings,
  quality: { level: Math.max(0, Math.min(3, num('q', 3))) as 0 | 1 | 2 | 3, renderScale: 1, frameMs: 16 },
  events: new EventBus(),
  lighting: {
    sunDir: new THREE.Vector3(), sunColor: new THREE.Color(6, 6, 6), sunVisibility: 1,
    skyColor: new THREE.Color(1, 1, 1), groundColor: new THREE.Color(0.3, 0.3, 0.3), envMap: envTex,
    exposureBias: 0, moonDir: new THREE.Vector3(0, 1, 0), moonColor: new THREE.Color(0, 0, 0),
  },
  hazeSources: [], plumeLights: [], photoMode: false,
  sceneDepth: { texture: null, resolution: new THREE.Vector2(W, H) }, replay: false, realTime: 0, width: W, height: H,
};

// sun
const [sunAz, sunEl] = (str('sun', '215,32').split(',').map(Number) as [number, number]);
const sunDir = new THREE.Vector3(
  Math.cos(sunEl * Math.PI / 180) * Math.sin(sunAz * Math.PI / 180),
  Math.sin(sunEl * Math.PI / 180),
  -Math.cos(sunEl * Math.PI / 180) * Math.cos(sunAz * Math.PI / 180),
);
ctx.lighting.sunDir.copy(sunDir);
const sun = new THREE.DirectionalLight(0xfff6ea, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- synthetic snapshot
function body(id: BodyId): BodyState {
  const nEng = id === 'S1' ? 9 : id === 'S2' ? 1 : 0;
  return {
    id, status: 'gone', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), angVel: new THREE.Vector3(),
    mass: 1, propMass: 0, propCapacity: 1, altitude: 0, speedInertial: 0, speed: 0, verticalSpeed: 0, mach: 0, dynPressure: 0,
    ambientPressure: 101325, density: 1.2, downrange: 0, gLoad: 1,
    engines: Array.from({ length: nEng }, () => ({ on: false, throttle: 0, gimbalX: 0, gimbalZ: 0, spool: 0, ignitionT: -Infinity, thrust: 0 })),
    thrust: 0, rcs: new Array(8).fill(0), heating: 0,
    gridFins: id === 'S1' ? { deploy: 0, angles: [0, 0, 0, 0] } : undefined,
    legs: id === 'S1' ? 0 : undefined, parafoil: id.startsWith('FAIRING') ? 0 : undefined,
  };
}
const ids: BodyId[] = ['S1', 'S2', 'FAIRING_A', 'FAIRING_B', 'PAYLOAD', 'SHIP'];
const bodies = Object.fromEntries(ids.map((i) => [i, body(i)])) as Record<BodyId, BodyState>;
const timeline: TimelineMarker[] = [];
const snap: SimSnapshot = { t: 0, paused: false, countdownHeld: false, warp: 1, bodies, wind: new THREE.Vector3(), timeline };

const S1 = bodies.S1, S2 = bodies.S2, FA = bodies.FAIRING_A, FB = bodies.FAIRING_B, PL = bodies.PAYLOAD, SH = bodies.SHIP;
const deg = Math.PI / 180;

function stackUpper(): void {
  S2.status = FA.status = FB.status = PL.status = 'stacked';
  S2.pos.set(0, F9.s2.mountY, 0).applyQuaternion(S1.quat).add(S1.pos);
  S2.quat.copy(S1.quat);
  for (const b of [FA, FB, PL]) {
    b.pos.set(0, F9.fairing.baseY, 0).applyQuaternion(S2.quat).add(S2.pos);
    b.quat.copy(S2.quat);
  }
}

const padBase = new THREE.Vector3(0, PAD_ELEVATION, 0);
const shipPos = new THREE.Vector3(0, 3.2, -2000);
let focus = new THREE.Vector3();
let focusSize = 70;

S1.legs = num('legs', 0);
S1.gridFins!.deploy = num('fins', 0);
S1.gridFins!.angles = [0, 1, 2, 3].map(() => num('fin', 0) * deg) as [number, number, number, number];
S1.engines[0].gimbalX = num('gx', 0) * deg;
S1.engines[0].gimbalZ = num('gz', 0) * deg;
S1.heating = num('heat', 0);

switch (asset) {
  case 'stack':
  default:
    S1.status = 'stacked';
    S1.pos.copy(padBase).y += LAUNCH_MOUNT_HEIGHT;
    stackUpper();
    focus.copy(S1.pos).y += 34; focusSize = 80;
    break;
  case 's1':
    S1.status = 'free';
    S1.pos.set(400, 200, 0);
    focus.copy(S1.pos).y += 24; focusSize = 55;
    break;
  case 'landed':
    SH.status = 'free'; SH.pos.copy(shipPos);
    S1.status = 'landed'; S1.legs = P.has('legs') ? S1.legs : 1; S1.gridFins!.deploy = P.has('fins') ? S1.gridFins!.deploy : 1;
    S1.pos.copy(shipPos).add(new THREE.Vector3(1.5, -F9.s1.leg.footY, -3));
    focus.copy(S1.pos).y += 12; focusSize = 90;
    break;
  case 'sep': {
    S1.status = 'free'; S1.pos.set(400, 200, 0);
    stackUpper();
    S2.status = 'free'; S2.pos.y += 9;
    for (const b of [FA, FB, PL]) b.pos.y += 9;
    focus.copy(S1.pos).y += 45; focusSize = 80;
    break;
  }
  case 'fairing': {
    S2.status = 'free'; S2.pos.set(400, 200, 0);
    for (const b of [FA, FB, PL]) { b.pos.set(0, F9.fairing.baseY, 0).add(S2.pos); b.status = 'free'; }
    PL.status = 'stacked';
    const o = num('open', 6);
    FA.pos.x += o; FB.pos.x -= o;
    FA.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -num('tilt', 12) * deg);
    FB.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), num('tilt', 12) * deg);
    const pf = num('parafoil', 0);
    FA.parafoil = FB.parafoil = pf;
    focus.copy(S2.pos).y += 16; focusSize = pf > 0 ? 120 : 40;
    break;
  }
  case 'payload': {
    S2.status = 'free'; S2.pos.set(400, 200, 0);
    PL.status = num('deployT', 0) > 0 ? 'deployed' : 'stacked';
    PL.pos.set(0, F9.payload.baseY, 0).add(S2.pos);
    FA.status = FB.status = 'gone';
    timeline.push({ type: 'PAYLOAD_DEPLOY', label: 'DEPLOY', t: 0, done: true });
    snap.t = num('deployT', 0);
    focus.copy(PL.pos).y += 4; focusSize = 25;
    break;
  }
  case 'ship':
    SH.status = 'free'; SH.pos.copy(shipPos);
    focus.copy(shipPos); focusSize = 110;
    break;
  case 'pad':
    focus.copy(padBase).y += 20; focusSize = 220;
    break;
}
// MVac glow: explicit level or simulated burn time
S2.engines[0].on = P.has('mvac') || P.has('mvacT');
S2.engines[0].spool = 1; S2.engines[0].throttle = 1;
if (P.has('mvacT')) { S2.engines[0].ignitionT = snap.t - num('mvacT', 0); }

// ---------------------------------------------------------------- scene + camera
const vehicles = new VehicleVisuals(ctx);
const camera = new THREE.PerspectiveCamera(num('fov', 35), W / H, 0.05, 2e6);
const controls = new OrbitControls(camera, renderer.domElement);
const view: ViewInfo = {
  id: 'viewer', label: 'VIEWER', camera, camWorldPos: camera.position, focus: null, mode: 'orbit',
  rect: { x: 0, y: 0, w: W, h: H }, alpha: 1, shimmer: 0, shake: 0, onboard: false,
};

// detail presets: [az (deg, from +Z toward +X), el (deg), distance (m), target height above S1 origin
// (null = scene focus)]. Wide presets scale with the scene size.
const presets: Record<string, [number, number, number, number | null]> = {
  front: [200, 8, 1.45 * focusSize, null],
  side: [110, 5, 1.45 * focusSize, null],
  far: [200, 5, 5 * focusSize, null],
  deck: [150, 22, 0.8 * focusSize, null],
  top: [200, 55, 0.4 * focusSize, null],
  fins: [225, 12, 9, 45.3],
  finsup: [205, -35, 8, 45.3],
  rcs: [95, 5, 7, 44],
  inter: [200, 8, 16, 44],
  legs: [215, 4, 30, 3],
  legtop: [215, 4, 9, 8],
  base: [205, -4, 12, 1.5],
  octa: [200, -62, 9, 0.5],
  engine: [180, -20, 5, 0.6],
  mvac: [200, -12, 11, F9.s2.mountY + 2],
  s2top: [200, 10, 20, F9.s2.mountY + 12],
};
const pv = presets[str('view', asset === 'ship' || asset === 'landed' ? 'deck' : 'front')] ?? presets.front;
const az = num('az', pv[0]) * deg, el = num('el', pv[1]) * deg;
const dist = num('dist', pv[2]);
const tgt = pv[3] === null ? focus.clone() : S1.pos.clone().add(new THREE.Vector3(0, pv[3], 0));
if (P.has('ty')) tgt.y += num('ty', 0);
controls.target.copy(tgt);
camera.position.set(tgt.x + dist * Math.cos(el) * Math.sin(az), tgt.y + dist * Math.sin(el), tgt.z + dist * Math.cos(el) * Math.cos(az));
controls.update();

function placeSun(): void {
  sun.position.copy(controls.target).addScaledVector(sunDir, 400);
  sun.target.position.copy(controls.target);
  const s = Math.max(40, focusSize * 0.9);
  const c = sun.shadow.camera;
  c.left = c.bottom = -s; c.right = c.top = s; c.near = 1; c.far = 900;
  c.updateProjectionMatrix();
}

const hud = document.getElementById('hud')!;
const app = { frameCount: 0, ctx: { quality: { frameMs: 16, level: ctx.quality.level } }, vehicles, snap, camera, controls };
(window as unknown as { __app: unknown }).__app = app;

(async () => {
  await vehicles.load();
  if (num('pad', 1) === 0 && vehicles.padVisual) vehicles.padVisual.enabled = false;
  const lodForce = P.has('lod') ? num('lod', 0) : -1;
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    app.ctx.quality.frameMs = app.ctx.quality.frameMs * 0.9 + dt * 1000 * 0.1;
    ctx.realTime += dt;
    controls.update();
    vehicles.update(snap, dt);
    if (P.has('mvac')) vehicles.materials.setMvacGlow(num('mvac', 0));
    vehicles.beforeViewRender(view, snap);
    if (lodForce >= 0) forceLod(lodForce);
    placeSun();
    renderer.render(scene, camera);
    app.frameCount++;
    const i = renderer.info.render;
    hud.textContent = `${asset}  tris ${(i.triangles / 1000).toFixed(0)}k  calls ${i.calls}  ${(1000 / app.ctx.quality.frameMs).toFixed(0)} fps\n` +
      `legs ${S1.legs} fins ${S1.gridFins!.deploy} soot ${settings.sootyBooster ? 1 : 0} heat ${S1.heating}`;
    requestAnimationFrame(loop);
  };
  loop();
})();

function forceLod(l: number): void {
  worldRoot.traverse((o) => {
    const m = /^(S1|S2)_L(\d)$|^F[AB]_L(\d)$/.exec(o.name);
    if (m) o.visible = Number(m[2] ?? m[3]) === l;
  });
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  view.rect.w = window.innerWidth; view.rect.h = window.innerHeight;
});
camera.aspect = W / H;
camera.updateProjectionMatrix();
