// VFX look-dev page (vfx-test.html). Standalone: fake snapshot + stand-in environment + a
// two-pass HDR pipeline that mirrors what post does (layer 0 -> linear depth copy -> layer 1),
// simple bloom and AgX. URL params:
//   p=pad|ascent|maxq|meco|sep|entry|landing|vac|rcs   t=<mission time>   cam=<preset cam>
//   tod=day|twilight|night   alt=<m>  h=<m above deck>  mach=<M>  ev=<exposure EV>  q=0..3
//   pre=<s of simulated pre-roll>  warm=seek (use the VFX seek pre-warm instead of simulating)
//   pause=1 (freeze after pre-roll)
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import { LAYER_DEFAULT, LAYER_VFX, SUN_INTENSITY } from '../../core/context';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { BodyId, BodyState, EngineState, SimSnapshot } from '../../core/types';
import { F9, OCISLY } from '../../core/vehicleSpec';
import { EARTH_RADIUS, LAUNCH_AZIMUTH_DEG, PAD_ELEVATION, SHIP_NOMINAL_DOWNRANGE } from '../../core/constants';
import { altitudeOf, padHeadingDir, pointAlongAzimuth, quatFromAxis, upAt } from '../../core/frames';
import { aerialUniforms } from '../env/aerial';
import { VFX } from './VFX';
import { ambientAt, airDensity, sunRadianceAt } from './common';
import { nominalPadHeight, TRENCH_DIR, PAD_TRENCH_EXIT_DIST } from './emitters';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);
const preset = P.get('p') ?? 'pad';
const tod = P.get('tod') ?? (preset === 'meco' || preset === 'sep' ? 'twilight' : 'day');

// ---------------------------------------------------------------- renderer + ctx
const W = window.innerWidth, H = window.innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const worldRoot = new THREE.Group();
scene.add(worldRoot);
const q = Math.max(0, Math.min(3, num('q', 2))) as 0 | 1 | 2 | 3;
const ctx: AppContext = {
  renderer, scene, worldRoot, renderOrigin: new THREE.Vector3(),
  settings: { ...DEFAULT_SETTINGS },
  quality: { level: q, renderScale: 1, frameMs: 16 },
  events: new EventBus(),
  lighting: {
    sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(1, 1, 1), sunVisibility: 1,
    skyColor: new THREE.Color(0.4, 0.6, 1), groundColor: new THREE.Color(0.1, 0.12, 0.15),
    envMap: null, exposureBias: 0, moonDir: new THREE.Vector3(0, 1, 0), moonColor: new THREE.Color(0, 0, 0),
  },
  hazeSources: [], plumeLights: [],
  sceneDepth: { texture: null, resolution: new THREE.Vector2(W, H) },
  photoMode: false, replay: false, realTime: 0, width: W, height: H,
};

// sun direction from time of day: sunset over the Pacific (west = -X), slightly south
const sunEl = P.has('sunel') ? num('sunel', 30) : ({ day: 32, twilight: -7.5, night: -30 } as Record<string, number>)[tod] ?? 30;
const sunAz = num('sunaz', 250) * (Math.PI / 180); // deg from north clockwise
const el = sunEl * (Math.PI / 180);
ctx.lighting.sunDir.set(Math.sin(sunAz) * Math.cos(el), Math.sin(el), -Math.cos(sunAz) * Math.cos(el)).normalize();

// ---------------------------------------------------------------- fake bodies
function engines(n: number): EngineState[] {
  return Array.from({ length: n }, () => ({ on: false, throttle: 0, gimbalX: 0, gimbalZ: 0, spool: 0, ignitionT: -Infinity, thrust: 0 }));
}
function body(id: BodyId, nEng: number): BodyState {
  return {
    id, status: 'stacked', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), angVel: new THREE.Vector3(),
    mass: 0, propMass: 0, propCapacity: 1, altitude: 0, speedInertial: 0, speed: 0, verticalSpeed: 0, mach: 0,
    dynPressure: 0, ambientPressure: 101325, density: 1.225, downrange: 0, gLoad: 1, engines: engines(nEng),
    thrust: 0, rcs: new Array(8).fill(0), heating: 0,
  };
}
const bodies = {
  S1: body('S1', 9), S2: body('S2', 1), FAIRING_A: body('FAIRING_A', 0), FAIRING_B: body('FAIRING_B', 0),
  PAYLOAD: body('PAYLOAD', 0), SHIP: body('SHIP', 0),
} as Record<BodyId, BodyState>;
bodies.S1.phase = 'PRELAUNCH';
bodies.SHIP.status = 'free';
const snap: SimSnapshot = {
  t: num('t', 2), paused: false, countdownHeld: false, warp: 1, bodies,
  wind: new THREE.Vector3(4, 0, 2), timeline: [],
};
pointAlongAzimuth(SHIP_NOMINAL_DOWNRANGE, LAUNCH_AZIMUTH_DEG, OCISLY.deckHeight, bodies.SHIP.pos);
quatFromAxis(upAt(bodies.SHIP.pos), new THREE.Vector3(0, 0, 1), bodies.SHIP.quat);

function pressureAt(alt: number): number {
  return 101325 * Math.exp(-Math.max(alt, 0) / 7400) * (alt > 20000 ? Math.exp(-(alt - 20000) / 60000) : 1);
}
function setEngines(b: BodyState, idx: number[], t: number, ign: number, throttle = 1, stagger = 0.05) {
  b.engines.forEach((e, k) => {
    const i = idx.indexOf(k);
    if (i < 0 || t < ign) { e.on = false; e.spool = 0; e.throttle = 0; e.thrust = 0; return; }
    const ik = ign + i * stagger;
    e.ignitionT = ik;
    e.on = t >= ik;
    e.spool = Math.max(0, Math.min(1, (t - ik) / 0.9));
    e.throttle = e.on ? throttle : 0;
    e.thrust = 845e3 * e.spool * throttle;
  });
}
function derive(b: BodyState) {
  b.altitude = altitudeOf(b.pos);
  b.ambientPressure = pressureAt(b.altitude);
  b.density = airDensity(b.altitude) * (b.altitude > 20000 ? Math.exp(-(b.altitude - 20000) / 60000) : 1);
  b.speed = b.vel.length();
  const a = Math.max(b.altitude, 0);
  const sos = a < 11000 ? 340 - 0.0039 * a : 295;
  b.mach = b.speed / sos;
}
function stackUpper() {
  const S1 = bodies.S1, S2 = bodies.S2;
  S2.pos.set(0, F9.s2.mountY, 0).applyQuaternion(S1.quat).add(S1.pos);
  S2.quat.copy(S1.quat); S2.vel.copy(S1.vel);
  for (const id of ['FAIRING_A', 'FAIRING_B', 'PAYLOAD'] as BodyId[]) {
    bodies[id].pos.set(0, F9.fairing.baseY, 0).applyQuaternion(S2.quat).add(S2.pos);
    bodies[id].quat.copy(S2.quat); bodies[id].vel.copy(S2.vel);
  }
}

const dirS = padHeadingDir(LAUNCH_AZIMUTH_DEG);
interface Cam { pos: THREE.Vector3; target: THREE.Vector3; up?: THREE.Vector3; fov: number }
interface Preset { step(t: number, dt: number): void; cam(name: string): Cam; ev: number; t0: number }

// place a vehicle at altitude `alt` along the nominal ascent with pitch `pitch` (rad from vertical)
function placeAscent(b: BodyState, alt: number, down: number, pitch: number, speed: number, dtFromT0 = 0) {
  const up = new THREE.Vector3(0, 1, 0);
  b.pos.set(0, alt, 0).addScaledVector(dirS, down);
  const axis = up.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(dirS, Math.sin(pitch)).normalize();
  quatFromAxis(axis, new THREE.Vector3(0, 0, 1), b.quat);
  b.vel.copy(axis).multiplyScalar(speed);
  b.pos.addScaledVector(b.vel, dtFromT0); // fly along the axis so trails are laid down correctly
}

const presets: Record<string, () => Preset> = {
  pad: () => ({
    t0: num('t', 3), ev: num('ev', tod === 'day' ? 0 : -2.5),
    step(t) {
      const S1 = bodies.S1;
      const hN = t < 0 ? 4 : nominalPadHeight(t);
      S1.pos.set(0, PAD_ELEVATION + hN, 0);
      quatFromAxis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), S1.quat);
      S1.vel.set(0, t > 0 ? 4.4 * t : 0, 0);
      setEngines(S1, [0, 1, 5, 2, 6, 3, 7, 4, 8], t, -3, 1, 0.06);
      S1.phase = t < 0 ? 'PRELAUNCH' : 'ASCENT';
      stackUpper();
    },
    cam(name) {
      const S1 = bodies.S1;
      const base = new THREE.Vector3(0, PAD_ELEVATION, 0);
      if (name === 'close') return { pos: new THREE.Vector3(-45, PAD_ELEVATION + 6, 60), target: S1.pos.clone().add(new THREE.Vector3(0, 10, 0)), fov: 55 };
      if (name === 'far') return { pos: new THREE.Vector3(-1500, PAD_ELEVATION + 30, -1800), target: base.clone().add(new THREE.Vector3(0, 80, 0)), fov: 24 };
      if (name === 'side') return { pos: new THREE.Vector3(-420, PAD_ELEVATION + 12, -120), target: S1.pos.clone().multiplyScalar(0.5).add(base.clone().multiplyScalar(0.5)).add(new THREE.Vector3(0, 25, 60)), fov: 40 };
      if (name === 'track') return { pos: new THREE.Vector3(-900, PAD_ELEVATION + 20, -600), target: S1.pos.clone().add(new THREE.Vector3(0, 10, 0)), fov: 14 };
      return { pos: new THREE.Vector3(-320, PAD_ELEVATION + 8, -380), target: base.clone().add(new THREE.Vector3(0, 38, 20)), fov: 42 };
    },
  }),
  ascent: () => ({
    t0: num('t', 40), ev: num('ev', 0),
    step(t) {
      const S1 = bodies.S1;
      const alt = num('alt', 6000);
      placeAscent(S1, alt, alt * 0.25, 0.35, num('v', 300), t - num('t', 40));
      setEngines(S1, [0, 1, 2, 3, 4, 5, 6, 7, 8], t, -3, 1);
      S1.phase = 'ASCENT';
      stackUpper();
    },
    cam(name) { return chaseCam(bodies.S1, name, 25); },
  }),
  maxq: () => ({
    t0: num('t', 62), ev: num('ev', 0),
    step(t) {
      const S1 = bodies.S1;
      const alt = num('alt', 10500);
      placeAscent(S1, alt, alt * 0.3, 0.45, num('mach', 1.02) * 300, t - num('t', 62));
      setEngines(S1, [0, 1, 2, 3, 4, 5, 6, 7, 8], t, -3, 0.7);
      S1.phase = 'ASCENT';
      stackUpper();
      derive(S1);
      S1.mach = num('mach', 1.02);
    },
    cam(name) { return chaseCam(bodies.S1, name, 40); },
  }),
  meco: () => ({
    t0: num('t', 140), ev: num('ev', tod === 'day' ? 0 : 3),
    step(t) {
      const S1 = bodies.S1;
      const alt = num('alt', 65000);
      placeAscent(S1, alt, 70000, 1.1, num('v', 2200), t - num('t', 140));
      setEngines(S1, [0, 1, 2, 3, 4, 5, 6, 7, 8], t, -3, 1);
      S1.phase = 'ASCENT';
      stackUpper();
    },
    cam(name) { return chaseCam(bodies.S1, name, 30); },
  }),
  sep: () => ({
    t0: num('t', 152), ev: num('ev', tod === 'day' ? 0 : 3),
    step(t) {
      const S1 = bodies.S1, S2 = bodies.S2;
      const alt = 68000;
      const ts = t - 150; // sep at 150
      placeAscent(S1, alt, 72000, 1.15, 2250, t - 150);
      setEngines(S1, [], t, 1e9);
      S1.status = ts > 0 ? 'free' : 'stacked';
      S1.phase = 'COAST';
      stackUpper();
      if (ts > 0) {
        S2.status = 'free';
        const ax = new THREE.Vector3(0, 1, 0).applyQuaternion(S1.quat);
        S2.pos.addScaledVector(ax, 0.5 * 1.5 * ts * ts + 1 * ts);
        S2.vel.addScaledVector(ax, 1.5 * ts);
        for (const id of ['FAIRING_A', 'FAIRING_B', 'PAYLOAD'] as BodyId[]) bodies[id].pos.addScaledVector(ax, 0.5 * 1.5 * ts * ts + ts);
        setEngines(S2, [0], t, 157, 1, 0);
        S1.rcs = S1.rcs.map((_, i) => (ts > 1.5 && ((i === 2 || i === 6) || (Math.floor(ts * 2) % 3 === i % 3 && i < 2)) ? 1 : 0));
      }
    },
    cam(name) {
      if (name === 'ground') return groundCam(bodies.S2);
      return chaseCam(bodies.S2, name === 'far' ? 'far' : 'side', 30);
    },
  }),
  entry: () => ({
    t0: num('t', 385), ev: num('ev', tod === 'day' ? 0 : -1),
    step(t) {
      const S1 = bodies.S1;
      const alt = num('alt', 55000) - (t - 385) * 1200;
      S1.status = 'free'; S1.phase = 'ENTRY_BURN';
      S1.pos.copy(pointAlongAzimuth(560000, LAUNCH_AZIMUTH_DEG, alt));
      const up = upAt(S1.pos);
      const vdir = up.clone().multiplyScalar(-0.93).addScaledVector(dirS, 0.37).normalize();
      S1.vel.copy(vdir).multiplyScalar(num('v', 1700));
      quatFromAxis(vdir.clone().negate(), new THREE.Vector3(0, 0, 1), S1.quat); // engines first
      setEngines(S1, [0, 1, 5], t, 380, 1);
      S1.gridFins = { deploy: 1, angles: [0, 0, 0, 0] };
    },
    cam(name) {
      if (name === 'onboard') return onboardDown(bodies.S1);
      if (name === 'ground') return groundCam(bodies.S1);
      return chaseCam(bodies.S1, name, 45);
    },
  }),
  landing: () => ({
    t0: num('t', 505), ev: num('ev', tod === 'day' ? 0 : -3),
    step(t) {
      const S1 = bodies.S1, SHIP = bodies.SHIP;
      const hEnd = num('h', 12);
      // hoverslam: constant deceleration to touchdown at t_td
      const tTd = 510;
      const tau = Math.max(0, tTd - t);
      const a = 8;
      const hh = Math.max(num('hmin', 0), hEnd - 0 + 0.5 * a * tau * tau + (P.has('h') ? 0 : 0)) ;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(SHIP.quat);
      S1.pos.copy(SHIP.pos).addScaledVector(up, (P.has('h') ? hEnd : hh) + 2.0);
      quatFromAxis(up, new THREE.Vector3(0, 0, 1), S1.quat);
      S1.vel.copy(up).multiplyScalar(-a * tau);
      S1.status = 'free'; S1.phase = 'LANDING_BURN';
      setEngines(S1, [0], t, 485, P.has('thr') ? num('thr', 0.7) : 0.7, 0);
      S1.legs = 1;
    },
    cam(name) {
      const SHIP = bodies.SHIP;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(SHIP.quat);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(SHIP.quat);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(SHIP.quat);
      if (name === 'deck') return { pos: SHIP.pos.clone().addScaledVector(fwd, -40).addScaledVector(right, 18).addScaledVector(up, 3), target: bodies.S1.pos.clone().addScaledVector(up, 8), up, fov: 60 };
      if (name === 'boat') return { pos: SHIP.pos.clone().addScaledVector(fwd, -600).addScaledVector(right, 250).addScaledVector(up, 5), target: SHIP.pos.clone().addScaledVector(up, 20), up, fov: 12 };
      if (name === 'onboard') return onboardDown(bodies.S1);
      return { pos: SHIP.pos.clone().addScaledVector(fwd, -140).addScaledVector(right, 90).addScaledVector(up, 30), target: SHIP.pos.clone().addScaledVector(up, 14), up, fov: 45 };
    },
  }),
  vac: () => ({
    t0: num('t', 300), ev: num('ev', 0),
    step(t) {
      const S1 = bodies.S1, S2 = bodies.S2;
      S1.status = 'free';
      S1.pos.set(0, -1e6, 0);
      S2.status = 'free';
      S2.pos.copy(pointAlongAzimuth(900000, LAUNCH_AZIMUTH_DEG, num('alt', 180000)));
      const up = upAt(S2.pos);
      const fwd = up.clone().cross(new THREE.Vector3(1, 0, 0)).normalize();
      const ax = fwd.clone().multiplyScalar(0.97).addScaledVector(up, 0.24).normalize();
      quatFromAxis(ax, up, S2.quat);
      S2.vel.copy(ax).multiplyScalar(5000);
      setEngines(S2, [0], t, 157, 1, 0);
      for (const id of ['FAIRING_A', 'FAIRING_B'] as BodyId[]) bodies[id].status = 'gone';
      bodies.PAYLOAD.pos.set(0, F9.fairing.baseY, 0).applyQuaternion(S2.quat).add(S2.pos);
      bodies.PAYLOAD.quat.copy(S2.quat);
    },
    cam(name) {
      if (name === 'engine') {
        const S2 = bodies.S2;
        const c = F9.s2.cams.engine;
        const a = (c.angleDeg * Math.PI) / 180;
        const pos = new THREE.Vector3(Math.cos(a) * c.radius, c.y, Math.sin(a) * c.radius).applyQuaternion(S2.quat).add(S2.pos);
        const target = new THREE.Vector3(0, -30, 0).applyQuaternion(S2.quat).add(S2.pos);
        return { pos, target, up: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(S2.quat), fov: 75 };
      }
      if (name === 'ground') return groundCam(bodies.S2);
      return chaseCam(bodies.S2, name, 25);
    },
  }),
  rcs: () => ({
    t0: num('t', 170), ev: num('ev', 0),
    step(t) {
      const S1 = bodies.S1;
      S1.status = 'free'; S1.phase = 'FLIP';
      S1.pos.copy(pointAlongAzimuth(90000, LAUNCH_AZIMUTH_DEG, 100000));
      const up = upAt(S1.pos);
      quatFromAxis(up.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.9 + (t - 170) * 0.15), new THREE.Vector3(0, 0, 1), S1.quat);
      S1.vel.set(0, 0, 0);
      setEngines(S1, [], t, 1e9);
      S1.rcs = S1.rcs.map((_, i) => ((Math.floor(t * 1.5) + i) % 4 === 0 || i === 2 ? 1 : 0));
      S1.gridFins = { deploy: 1, angles: [0, 0, 0, 0] };
    },
    cam(name) { return chaseCam(bodies.S1, name === 'far' ? 'far' : 'side', 30); },
  }),
};

function chaseCam(b: BodyState, name: string, focusY: number): Cam {
  const ax = new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat);
  const up = upAt(b.pos);
  const side = new THREE.Vector3().crossVectors(ax, up);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const center = b.pos.clone().addScaledVector(ax, focusY);
  if (name === 'far') return { pos: center.clone().addScaledVector(side, 900).addScaledVector(ax, -150), target: center.clone().addScaledVector(ax, -250), fov: 45, up };
  if (name === 'below') return { pos: center.clone().addScaledVector(side, 60).addScaledVector(ax, -140), target: center.clone().addScaledVector(ax, -60), fov: 60, up: ax };
  if (name === 'fairing') {
    const c2 = b.pos.clone().addScaledVector(ax, F9.s2.mountY + F9.fairing.baseY - 2);
    return { pos: c2.clone().addScaledVector(side, num('cd', 45)).addScaledVector(ax, -6).addScaledVector(up, 4), target: c2, fov: 45, up: ax };
  }
  if (name === 'huge') return { pos: center.clone().addScaledVector(side, 6000).addScaledVector(ax, -1500), target: center.clone().addScaledVector(ax, -1800), fov: 50, up };
  return { pos: center.clone().addScaledVector(side, 110).addScaledVector(ax, -20), target: center.clone().addScaledVector(ax, -35), fov: 50, up };
}
function groundCam(b: BodyState): Cam {
  const pos = new THREE.Vector3(-3000, PAD_ELEVATION + 10, -6000);
  return { pos, target: b.pos.clone(), fov: num('fov', 3) };
}
function onboardDown(b: BodyState): Cam {
  const c = F9.s1.cams.down;
  const a = (c.angleDeg * Math.PI) / 180;
  const pos = new THREE.Vector3(Math.cos(a) * c.radius, c.y, Math.sin(a) * c.radius).applyQuaternion(b.quat).add(b.pos);
  const target = new THREE.Vector3(Math.cos(a) * 4.5, -20, Math.sin(a) * 4.5).applyQuaternion(b.quat).add(b.pos);
  return { pos, target, up: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(b.quat), fov: 80 };
}

const pr = (presets[preset] ?? presets.pad)();

// ---------------------------------------------------------------- stand-in environment
const sunLight = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
const hemi = new THREE.HemisphereLight(0x88aaff, 0x334455, 1.0);
scene.add(sunLight, sunLight.target, hemi);

const skyMat = new THREE.ShaderMaterial({
  uniforms: { uSun: { value: ctx.lighting.sunDir }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uAlt: { value: 0 } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
    uniform vec3 uSun; uniform vec3 uUp; uniform float uAlt; varying vec3 vDir;
    void main(){
      vec3 d = normalize(vDir);
      float mu = dot(d, uUp);
      float sEl = dot(uSun, uUp);
      float day = smoothstep(-0.18, 0.12, sEl);
      float thin = exp(-uAlt / 9000.0);
      vec3 zen = vec3(0.10, 0.22, 0.55) * day * 1.2;
      vec3 hor = vec3(0.55, 0.62, 0.75) * day * 1.4;
      float hz = pow(1.0 - clamp(mu, 0.0, 1.0), 4.0);
      vec3 c = mix(zen, hor, hz) * mix(0.03, 1.0, thin);
      // twilight glow toward the sun near the horizon
      float cs = max(dot(d, normalize(uSun - uUp * sEl)), 0.0);
      float tw = smoothstep(-0.2, 0.0, sEl) * (1.0 - smoothstep(0.0, 0.25, sEl));
      c += vec3(1.0, 0.45, 0.15) * pow(cs, 6.0) * exp(-max(mu, 0.0) * 12.0) * tw * 0.6;
      c += vec3(0.08, 0.1, 0.25) * tw * exp(-max(mu,0.0)*3.0) * 0.5;
      c *= mix(0.004, 1.0, smoothstep(-0.05, 0.1, sEl)); // twilight sky is ~100x darker than day
      c += vec3(0.00015, 0.0002, 0.0004); // night floor
      // sun disc
      c += vec3(1.0, 0.9, 0.8) * 4000.0 * smoothstep(0.99996, 0.99999, dot(d, uSun)) * step(-0.01, sEl + 0.01);
      if (mu < -0.02 - 0.01 * sqrt(max(uAlt, 0.0) / 1000.0)) c = vec3(0.01, 0.015, 0.02) * (0.1 + day);
      gl_FragColor = vec4(c, 1.0);
    }`,
  side: THREE.BackSide, depthWrite: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(sky);

// ground near the pad + ocean + pad structures + vehicle + ship
const groundMat = new THREE.MeshStandardMaterial({ color: 0x5a5140, roughness: 0.95 });
const ground = new THREE.Mesh(new THREE.CircleGeometry(4000, 64).rotateX(-Math.PI / 2), groundMat);
ground.position.set(0, PAD_ELEVATION, 0);
worldRoot.add(ground);
const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8780, roughness: 0.9 });
const apron = new THREE.Mesh(new THREE.BoxGeometry(90, 1, 90), concrete);
apron.position.set(0, PAD_ELEVATION + 0.02 - 0.5, 0);
worldRoot.add(apron);
const trench = new THREE.Mesh(new THREE.PlaneGeometry(10, PAD_TRENCH_EXIT_DIST + 6).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x151412, roughness: 1 }));
trench.position.copy(TRENCH_DIR).multiplyScalar(PAD_TRENCH_EXIT_DIST / 2).setY(PAD_ELEVATION + 0.05);
trench.rotation.y = Math.atan2(TRENCH_DIR.x, TRENCH_DIR.z);
worldRoot.add(trench);
const steel = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.6, metalness: 0.6 });
for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 4, 1.5), steel);
  m.position.set(x, PAD_ELEVATION + 2, z);
  worldRoot.add(m);
}
const tower = new THREE.Mesh(new THREE.BoxGeometry(6, 70, 6), steel);
tower.position.set(-12, PAD_ELEVATION + 35, 0);
worldRoot.add(tower);
const ocean = new THREE.Mesh(new THREE.CircleGeometry(2e6, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0a1a28, roughness: 0.25, metalness: 0.0 }));
worldRoot.add(ocean);
const oceanShip = new THREE.Mesh(new THREE.CircleGeometry(20000, 64), new THREE.MeshStandardMaterial({ color: 0x0b1c2c, roughness: 0.3 }));
worldRoot.add(oceanShip);

const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.55 });
const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
const metal = new THREE.MeshStandardMaterial({ color: 0x6b5d50, roughness: 0.4, metalness: 0.8 });
function mkS1(): THREE.Group {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(F9.radius, F9.radius, 40.3 - 1.35, 32), white);
  tank.position.y = (40.3 + 1.35) / 2;
  const inter = new THREE.Mesh(new THREE.CylinderGeometry(F9.radius, F9.radius, 47 - 40.3, 32), black);
  inter.position.y = (47 + 40.3) / 2;
  const web = new THREE.Mesh(new THREE.CylinderGeometry(F9.radius, F9.radius, 0.3, 32), black);
  web.position.y = 1.35;
  g.add(tank, inter, web);
  for (let k = 0; k < 9; k++) {
    const a = ((k - 1) * 45 * Math.PI) / 180;
    const r = k === 0 ? 0 : F9.s1.engineRingRadius;
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.22, F9.s1.nozzleExitRadius, 1.4, 20, 1, true), metal);
    bell.position.set(Math.cos(a) * r, 0.7, Math.sin(a) * r);
    g.add(bell);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i * 90 * Math.PI) / 180;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8.6, 0.3), black);
    leg.position.set(Math.cos(a) * (F9.radius + 0.12), 1.6 + 4.3, Math.sin(a) * (F9.radius + 0.12));
    leg.lookAt(leg.position.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))));
    g.add(leg);
  }
  return g;
}
function mkS2(): THREE.Group {
  const g = new THREE.Group();
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.5, F9.s2.mvac.exitRadius, 3.6, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2220, roughness: 0.5, metalness: 0.6, emissive: new THREE.Color(1.0, 0.25, 0.05), emissiveIntensity: preset === 'vac' ? 3 : 0, side: THREE.DoubleSide }));
  bell.position.y = 1.8;
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(F9.radius, F9.radius, 13.8 - 4.4, 32), white);
  tank.position.y = (13.8 + 4.4) / 2;
  const fair = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 7, 32), white);
  fair.position.y = 13.8 + 1.4 + 3.5;
  const boat = new THREE.Mesh(new THREE.CylinderGeometry(2.6, F9.radius, 1.4, 32), white);
  boat.position.y = 13.8 + 0.7;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(2.6, 4.7, 32), white);
  nose.position.y = 13.8 + 8.4 + 2.35;
  g.add(bell, tank);
  if (preset !== 'vac') g.add(fair, boat, nose);
  return g;
}
const s1Mesh = mkS1();
const s2Mesh = mkS2();
worldRoot.add(s1Mesh, s2Mesh);
const shipG = new THREE.Group();
const deckMesh = new THREE.Mesh(new THREE.BoxGeometry(OCISLY.deckWidth, 3, OCISLY.deckLength), new THREE.MeshStandardMaterial({ color: 0x2c2c2e, roughness: 0.8 }));
deckMesh.position.y = -1.5;
const hull = new THREE.Mesh(new THREE.BoxGeometry(OCISLY.hullBeam, 6, OCISLY.hullLength), new THREE.MeshStandardMaterial({ color: 0x1d2530, roughness: 0.7 }));
hull.position.y = -5;
const xmark = new THREE.Mesh(new THREE.RingGeometry(11, 12.2, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd8c040, roughness: 0.7 }));
xmark.position.y = 0.02;
shipG.add(deckMesh, hull, xmark);
worldRoot.add(shipG);

// ---------------------------------------------------------------- pipeline
const rtMain = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
rtMain.depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
const rtDepth = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false });
rtDepth.texture.minFilter = rtDepth.texture.magFilter = THREE.NearestFilter;
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function fsPass(frag: string, uniforms: Record<string, THREE.IUniform>, toneMapped = false) {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.0,1.0); }`,
    fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped,
  });
  const mesh = new THREE.Mesh(fsGeo, m);
  mesh.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(mesh);
  return { m, sc };
}
const camera = new THREE.PerspectiveCamera(45, W / H, 0.3, 2e7);
const depthCopy = fsPass(`
  uniform sampler2D tDepth; uniform float uLogFar; varying vec2 vUv;
  void main(){ float d = texture2D(tDepth, vUv).r; float z = d >= 0.99999 ? 1e12 : exp2(d * uLogFar) - 1.0; gl_FragColor = vec4(z, 0.0, 0.0, 1.0); }`,
  { tDepth: { value: rtMain.depthTexture }, uLogFar: { value: Math.log2(camera.far + 1) } });
// bloom mip chain
const mips: THREE.WebGLRenderTarget[] = [];
{ let w = W >> 1, h = H >> 1; for (let i = 0; i < 6; i++) { mips.push(new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, depthBuffer: false })); w >>= 1; h >>= 1; } }
const down = fsPass(`uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){ vec3 c = vec3(0.0);
    c += texture2D(tSrc, vUv + uTexel*vec2(-1.0,-1.0)).rgb; c += texture2D(tSrc, vUv + uTexel*vec2(1.0,-1.0)).rgb;
    c += texture2D(tSrc, vUv + uTexel*vec2(-1.0,1.0)).rgb; c += texture2D(tSrc, vUv + uTexel*vec2(1.0,1.0)).rgb;
    gl_FragColor = vec4(min(c*0.25, vec3(6e4)), 1.0); }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
const up = fsPass(`uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){ vec3 c = vec3(0.0);
    c += texture2D(tSrc, vUv + uTexel*vec2(-1.0,0.0)).rgb; c += texture2D(tSrc, vUv + uTexel*vec2(1.0,0.0)).rgb;
    c += texture2D(tSrc, vUv + uTexel*vec2(0.0,-1.0)).rgb; c += texture2D(tSrc, vUv + uTexel*vec2(0.0,1.0)).rgb;
    gl_FragColor = vec4(c*0.25, 1.0); }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
up.m.blending = THREE.AdditiveBlending; up.m.transparent = true;
const comp = fsPass(`uniform sampler2D tHdr; uniform sampler2D tBloom; uniform float uExp; uniform float uBloom; varying vec2 vUv;
  void main(){ vec3 c = texture2D(tHdr, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom; gl_FragColor = vec4(c * uExp, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }`, { tHdr: { value: rtMain.texture }, tBloom: { value: mips[0].texture }, uExp: { value: 1 }, uBloom: { value: 0.06 } }, true);

// ---------------------------------------------------------------- VFX
const vfx = new VFX(ctx);
const view: ViewInfo = {
  id: 'main', label: 'test', camera, camWorldPos: new THREE.Vector3(), focus: 'S1', mode: 'chase',
  rect: { x: 0, y: 0, w: W, h: H }, alpha: 1, shimmer: 0, shake: 0, onboard: false,
};

function syncVisuals() {
  const b = bodies;
  s1Mesh.visible = b.S1.status !== 'gone';
  s1Mesh.position.copy(b.S1.pos); s1Mesh.quaternion.copy(b.S1.quat);
  s2Mesh.position.copy(b.S2.pos); s2Mesh.quaternion.copy(b.S2.quat);
  shipG.position.copy(b.SHIP.pos); shipG.quaternion.copy(b.SHIP.quat);
  oceanShip.position.copy(b.SHIP.pos).addScaledVector(upAt(b.SHIP.pos), -OCISLY.deckHeight);
  oceanShip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), upAt(b.SHIP.pos));
}

function updateLighting(focus: THREE.Vector3) {
  const L = ctx.lighting;
  sunRadianceAt(focus.x, focus.y, focus.z, L.sunDir, L.sunColor);
  const lum = Math.max(0, Math.min(1, (L.sunDir.dot(upAt(focus)) + 0.12) / 0.4));
  L.skyColor.setRGB(0.35, 0.5, 0.95).multiplyScalar(0.03 + 1.3 * lum);
  L.sunVisibility = L.sunColor.r > 0 ? 1 : 0;
  sunLight.color.copy(L.sunColor).multiplyScalar(1 / SUN_INTENSITY);
  sunLight.intensity = SUN_INTENSITY;
  hemi.color.copy(L.skyColor); hemi.intensity = 1;
  hemi.groundColor.setRGB(0.1, 0.1, 0.1).multiplyScalar(0.05 + lum);
  // stand-in aerial perspective params
  aerialUniforms.uAerialFogColor.value.setRGB(0.5, 0.6, 0.8).multiplyScalar(0.02 + 0.9 * lum);
}

let simT = pr.t0;
function stepSim(dt: number) {
  simT += dt;
  snap.t = simT;
  pr.step(simT, dt);
  for (const b of Object.values(bodies)) derive(b);
  if (preset === 'maxq') bodies.S1.mach = num('mach', 1.02);
}

function renderFrame() {
  const c = pr.cam(P.get('cam') ?? 'default');
  view.camWorldPos.copy(c.pos);
  ctx.renderOrigin.copy(c.pos);
  worldRoot.position.copy(c.pos).negate();
  camera.position.set(0, 0, 0);
  camera.fov = c.fov;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.up.copy(c.up ?? upAt(c.pos));
  camera.lookAt(c.target.clone().sub(c.pos));
  camera.updateMatrixWorld();
  skyMat.uniforms.uUp.value.copy(upAt(c.pos));
  skyMat.uniforms.uAlt.value = altitudeOf(c.pos);
  sky.position.set(0, 0, 0);
  sunLight.position.copy(ctx.lighting.sunDir).multiplyScalar(100);
  sunLight.target.position.set(0, 0, 0);
  // aerial uniforms
  aerialUniforms.uAerialCamAlt.value = altitudeOf(c.pos);
  aerialUniforms.uAerialCamUp.value.copy(upAt(c.pos));
  scene.updateMatrixWorld();
  vfx.beforeViewRender(view, snap);
  scene.updateMatrixWorld();

  // pass 1: opaque
  camera.layers.set(LAYER_DEFAULT);
  renderer.setRenderTarget(rtMain);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  // linear depth copy
  ctx.sceneDepth.texture = null;
  renderer.setRenderTarget(rtDepth);
  renderer.render(depthCopy.sc, fsCam);
  // pass 2: vfx
  ctx.sceneDepth.texture = rtDepth.texture;
  ctx.sceneDepth.resolution.set(W, H);
  camera.layers.set(LAYER_VFX);
  renderer.setRenderTarget(rtMain);
  const t0 = performance.now();
  renderer.render(scene, camera);
  gpuMsHint = performance.now() - t0;
  ctx.sceneDepth.texture = null;
  // bloom
  let src: THREE.Texture = rtMain.texture;
  let sw = W, sh = H;
  for (const m of mips) {
    down.m.uniforms.tSrc.value = src; down.m.uniforms.uTexel.value.set(0.5 / sw, 0.5 / sh);
    renderer.setRenderTarget(m); renderer.render(down.sc, fsCam);
    src = m.texture; sw = m.width; sh = m.height;
  }
  for (let i = mips.length - 1; i > 0; i--) {
    up.m.uniforms.tSrc.value = mips[i].texture; up.m.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
    renderer.setRenderTarget(mips[i - 1]); renderer.render(up.sc, fsCam);
  }
  // composite
  renderer.setRenderTarget(null);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  comp.m.uniforms.uExp.value = Math.pow(2, pr.ev + num('evadj', 0)) * 0.55;
  renderer.render(comp.sc, fsCam);
  renderer.toneMapping = THREE.NoToneMapping;
}
let gpuMsHint = 0;

const hud = document.getElementById('hud')!;
const app = { frameCount: 0, vfx, ctx, snap, stepSim };
(window as unknown as { __app: unknown }).__app = app;

async function main() {
  await vfx.load();
  // pre-roll
  const pre = num('pre', preset === 'pad' ? Math.max(0, pr.t0 + 4) : preset === 'landing' ? 6 : 3);
  const warmSeek = P.get('warm') === 'seek';
  simT = pr.t0 - (warmSeek ? 0 : pre);
  stepSim(0);
  syncVisuals();
  updateLighting(bodies.S1.status !== 'gone' && preset !== 'vac' ? bodies.S1.pos : bodies.S2.pos);
  const dtp = 1 / 30;
  if (!warmSeek) {
    vfx.update(snap, dtp); // establishes lastT (seek at the pre-roll start)
    for (let tt = 0; tt < pre - 1e-6; tt += dtp) {
      stepSim(dtp);
      syncVisuals();
      vfx.update(snap, dtp);
    }
  } else {
    vfx.update(snap, dtp);
  }
  const paused = P.get('pause') === '1';
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.realTime += dt;
    if (!paused) stepSim(dt);
    snap.paused = paused;
    syncVisuals();
    updateLighting(bodies.S1.status !== 'gone' && preset !== 'vac' ? bodies.S1.pos : bodies.S2.pos);
    vfx.update(snap, dt);
    renderFrame();
    app.frameCount++;
    hud.textContent = `${preset} t=${snap.t.toFixed(2)} alt=${(bodies.S1.altitude / 1000).toFixed(2)}km  cpu-vfx-draw=${gpuMsHint.toFixed(2)}ms  lights=${ctx.plumeLights.length} haze=${ctx.hazeSources.length}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
main().catch((e) => { console.error(e); hud.textContent = String(e?.stack ?? e); });
void EARTH_RADIUS; void ambientAt;
