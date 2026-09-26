// Environment look-dev page (env-test.html). Standalone ctx + Environment + a minimal HDR
// pipeline mirroring post (layer 0 -> linear depth -> layer 1), auto exposure, AgX.
// URL params:
//   v=pad|ship|cloud|12k|60k|150k|400k|700k   (preset camera)  or
//   cam=lat,lon,alt,headingDeg,pitchDeg
//   hd=<heading override> pt=<pitch override> fov=<deg>
//   tod=morning|twilight|night  t=<mission time s>  sea= wind= windfrom=  q=0..3
//   ev=<exposure bias EV>  ae=0 (fixed exposure: ev is absolute log2 exposure)
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import { LAYER_DEFAULT, LAYER_VFX } from '../../core/context';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS, settingsFromUrl } from '../../core/settings';
import type { BodyId, BodyState, SimSnapshot } from '../../core/types';
import { LAUNCH_AZIMUTH_DEG, PAD_ELEVATION, PAD_LAT_DEG, PAD_LON_DEG, SHIP_NOMINAL_DOWNRANGE } from '../../core/constants';
import { enuAt, geodeticToWorld, pointAlongAzimuth, worldToGeodetic, altitudeOf } from '../../core/frames';
import { Environment } from './Environment';
import { azEl } from './ephemeris';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);

const W = window.innerWidth, H = window.innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: true, stencil: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const worldRoot = new THREE.Group();
scene.add(worldRoot);
const q = Math.max(0, Math.min(3, num('q', 2))) as 0 | 1 | 2 | 3;
const ctx: AppContext = {
  renderer, scene, worldRoot, renderOrigin: new THREE.Vector3(),
  settings: settingsFromUrl({ ...DEFAULT_SETTINGS }, P),
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

// ---------------------------------------------------------------- fake snapshot
function body(id: BodyId): BodyState {
  return {
    id, status: 'stacked', pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), angVel: new THREE.Vector3(),
    mass: 0, propMass: 0, propCapacity: 1, altitude: 0, speedInertial: 0, speed: 0, verticalSpeed: 0, mach: 0,
    dynPressure: 0, ambientPressure: 101325, density: 1.225, downrange: 0, gLoad: 1, engines: [],
    thrust: 0, rcs: [], heating: 0,
  } as unknown as BodyState;
}
const bodies = {
  S1: body('S1'), S2: body('S2'), FAIRING_A: body('FAIRING_A'), FAIRING_B: body('FAIRING_B'), PAYLOAD: body('PAYLOAD'), SHIP: body('SHIP'),
} as Record<BodyId, BodyState>;
const shipPos = pointAlongAzimuth(SHIP_NOMINAL_DOWNRANGE, LAUNCH_AZIMUTH_DEG, 0);
bodies.SHIP.pos.copy(shipPos);
{
  const e = enuAt(shipPos);
  // bow toward the pad-ish (north-west)
  const bow = e.north.clone().multiplyScalar(0.7).addScaledVector(e.east, -0.7).normalize();
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(e.up, bow), e.up, bow);
  bodies.SHIP.quat.setFromRotationMatrix(m);
}
for (const id of ['S1', 'S2', 'PAYLOAD', 'FAIRING_A', 'FAIRING_B'] as BodyId[]) bodies[id].pos.set(0, PAD_ELEVATION, 0);
const snap: SimSnapshot = { t: num('t', 0), paused: false, countdownHeld: false, warp: 1, bodies, wind: new THREE.Vector3(), timeline: [], envT: 100 } as SimSnapshot;

// ---------------------------------------------------------------- camera
const shipGeo = worldToGeodetic(shipPos);
const presets: Record<string, [number, number, number, number, number]> = {
  pad: [PAD_LAT_DEG, PAD_LON_DEG, PAD_ELEVATION + 2, 250, 4],
  pad2: [PAD_LAT_DEG - 0.004, PAD_LON_DEG + 0.003, PAD_ELEVATION + 2, 330, 8],
  ship: [shipGeo.lat, shipGeo.lon, 2, 150, 2],
  shipdeck: [shipGeo.lat + 0.0012, shipGeo.lon - 0.001, 12, 140, -6],
  cloud: [PAD_LAT_DEG - 0.05, PAD_LON_DEG - 0.1, 1000, 240, 2],
  '12k': [PAD_LAT_DEG - 0.2, PAD_LON_DEG + 0.1, 12_000, 250, -5],
  '60k': [PAD_LAT_DEG - 0.8, PAD_LON_DEG + 0.4, 60_000, 250, -8],
  '150k': [PAD_LAT_DEG - 2.0, PAD_LON_DEG + 1.0, 150_000, 300, -15],
  '400k': [PAD_LAT_DEG - 3.5, PAD_LON_DEG + 2.0, 400_000, 320, -25],
  '700k': [PAD_LAT_DEG - 5.0, PAD_LON_DEG + 3.0, 700_000, 330, -32],
};
const vname = P.get('v') ?? 'pad';
let camDef = presets[vname] ?? presets.pad;
if (P.has('cam')) camDef = P.get('cam')!.split(',').map(Number) as typeof camDef;
if (P.has('hd')) camDef[3] = num('hd', 0);
if (P.has('pt')) camDef[4] = num('pt', 0);
const camWorldPos = geodeticToWorld(camDef[0], camDef[1], camDef[2]);
const camera = new THREE.PerspectiveCamera(num('fov', 55), W / H, 0.5, 1e8);
{
  const e = enuAt(camWorldPos);
  const hd = (camDef[3] * Math.PI) / 180, pt = (camDef[4] * Math.PI) / 180;
  const fwd = new THREE.Vector3().addScaledVector(e.east, Math.sin(hd) * Math.cos(pt)).addScaledVector(e.north, Math.cos(hd) * Math.cos(pt)).addScaledVector(e.up, Math.sin(pt));
  camera.up.copy(e.up);
  camera.position.set(0, 0, 0);
  camera.lookAt(fwd);
  camera.updateMatrixWorld();
}
const view: ViewInfo = {
  id: 'main', label: 'env', camera, camWorldPos, focus: vname.startsWith('ship') ? 'SHIP' : null, mode: 'orbit',
  rect: { x: 0, y: 0, w: W, h: H }, alpha: 1, shimmer: 0, shake: 0, onboard: false,
};

// test props: a grey sphere + white cylinder near the camera to judge lighting
if (P.get('props') !== '0') {
  const e = enuAt(camWorldPos);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  fwd.addScaledVector(e.up, -fwd.dot(e.up)).normalize();
  const base = camWorldPos.clone().addScaledVector(fwd, 40).addScaledVector(e.up, -camDef[2] + (vname.startsWith('pad') ? PAD_ELEVATION : 0));
  if (camDef[2] < 200 || vname.startsWith('pad')) {
    const g = new THREE.Mesh(new THREE.SphereGeometry(3, 48, 24), new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5 }));
    g.position.copy(base).addScaledVector(e.up, 4).addScaledVector(new THREE.Vector3().crossVectors(fwd, e.up), 6);
    g.castShadow = g.receiveShadow = true;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(1.83, 1.83, 40, 48), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35, metalness: 0 }));
    c.position.copy(base).addScaledVector(e.up, 20);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.up);
    c.castShadow = c.receiveShadow = true;
    worldRoot.add(g, c);
    const pl = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshStandardMaterial({ color: 0x9a9a95, roughness: 0.9 }));
    pl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), e.up);
    pl.position.copy(base).addScaledVector(e.up, 0.05);
    pl.receiveShadow = true;
    if (vname.startsWith('pad')) worldRoot.add(pl);
  }
}

// ---------------------------------------------------------------- HDR pipeline
const hdr = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
hdr.depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
hdr.texture.generateMipmaps = false;
const linDepth = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false });
const lum = new THREE.WebGLRenderTarget(32, 18, { type: THREE.FloatType, depthBuffer: false });
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const vs = 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.0,1.0); }';
const depthMat = new THREE.ShaderMaterial({
  vertexShader: vs,
  fragmentShader: `uniform sampler2D tD; uniform float uLogFar; varying vec2 vUv;
    void main(){ float d = texture2D(tD, vUv).r; gl_FragColor = vec4(d >= 1.0 ? 1e9 : exp2(d * uLogFar) - 1.0, 0.0, 0.0, 1.0); }`,
  uniforms: { tD: { value: hdr.depthTexture }, uLogFar: { value: Math.log2(camera.far + 1) } },
  depthTest: false, depthWrite: false, toneMapped: false,
});
const lumMat = new THREE.ShaderMaterial({
  vertexShader: vs,
  fragmentShader: `uniform sampler2D tS; varying vec2 vUv;
    void main(){ vec3 s = vec3(0.0); float n = 0.0;
      for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
        vec2 o = (vec2(float(i), float(j)) + 0.5) / 8.0 - 0.5;
        s += log(max(texture2D(tS, vUv + o * vec2(1.0/32.0, 1.0/18.0)).rgb, vec3(1e-7))); n += 1.0; }
      gl_FragColor = vec4(s / n, 1.0); }`,
  uniforms: { tS: { value: hdr.texture } }, depthTest: false, depthWrite: false, toneMapped: false,
});
const outMat = new THREE.ShaderMaterial({
  vertexShader: vs,
  fragmentShader: `uniform sampler2D tS; uniform float uExp; varying vec2 vUv;
    void main(){ gl_FragColor = vec4(texture2D(tS, vUv).rgb * uExp, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`,
  uniforms: { tS: { value: hdr.texture }, uExp: { value: 1 } }, depthTest: false, depthWrite: false, toneMapped: true,
});
const fs = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(fsGeo, depthMat);
fs.frustumCulled = false;
const fsScene = new THREE.Scene();
fsScene.add(fs);
function blit(mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
  fs.material = mat;
  renderer.setRenderTarget(target);
  renderer.render(fsScene, fsCam);
}
const lumBuf = new Float32Array(32 * 18 * 4);
let logAvg = Math.log(0.1);
let exposure = 1;

// ---------------------------------------------------------------- run
const env = new Environment(ctx);
const hud = document.getElementById('hud')!;
let frames = 0;
let t0 = performance.now();
let ms = 16;
(window as unknown as Record<string, unknown>).__env = env;
(window as unknown as Record<string, unknown>).__lum = lumBuf;

async function main() {
  await env.load();
  // debug: ?dbg=<glsl vec3 expr> replaces the sky output; ?edbg= the earth output
  if (P.has('dbg')) {
    env.skyMat.fragmentShader = env.skyMat.fragmentShader.replace('gl_FragColor = vec4(L, 1.0);', `gl_FragColor = vec4(${P.get('dbg')}, 1.0);`);
    env.skyMat.needsUpdate = true;
  }
  if (P.has('edbg')) {
    const m = env.earth.material;
    m.fragmentShader = m.fragmentShader.replace('gl_FragColor = vec4(col, 1.0);', `gl_FragColor = vec4(${P.get('edbg')}, 1.0);`);
    m.needsUpdate = true;
  }
  const s1Alt = num('s1alt', -1);
  const plumeI = num('plume', 0);
  const plumeLight = { pos: new THREE.Vector3(), color: new THREE.Color(), range: 1 };
  const step = () => {
    if (s1Alt >= 0 && frames >= 5) {
      const up = enuAt(bodies.S1.pos.set(0, 0, 0)).up;
      bodies.S1.pos.set(0, PAD_ELEVATION, 0).addScaledVector(up, s1Alt);
      bodies.S1.altitude = PAD_ELEVATION + s1Alt;
      snap.t = num('t', 0) + num('holeage', 0);
    } else bodies.S1.altitude = PAD_ELEVATION;
    ctx.plumeLights.length = 0;
    if (plumeI > 0) {
      plumeLight.pos.copy(bodies.S1.pos).y -= 25;
      plumeLight.color.setRGB(1, 0.55, 0.25).multiplyScalar(plumeI);
      plumeLight.range = Math.min(4000, Math.sqrt(plumeI / 0.004));
      ctx.plumeLights.push(plumeLight);
    }
    const now = performance.now();
    ms = ms * 0.9 + (now - t0) * 0.1;
    t0 = now;
    ctx.realTime = now / 1000;
    snap.envT = 100 + ctx.realTime * (P.get('pause') === '1' ? 0 : 1) - (P.get('pause') === '1' ? ctx.realTime : 0);
    env.update(snap, 1 / 60);
    ctx.renderOrigin.copy(view.camWorldPos);
    worldRoot.position.copy(view.camWorldPos).negate();
    scene.updateMatrixWorld();
    env.beforeViewRender(view, snap);
    if ((window as unknown as Record<string, unknown>).__cloudsOff) env.clouds.composite.visible = env.clouds.depthMesh.visible = false;
    const hide = ((window as unknown as Record<string, unknown>).__hide ?? '') as string;
    if (hide) {
      if (hide.includes('sky')) env.sky.visible = false;
      if (hide.includes('earth')) env.earth.mesh.visible = false;
      if (hide.includes('terrain')) env.terrain.group.visible = false;
      if (hide.includes('clouds')) env.clouds.composite.visible = env.clouds.depthMesh.visible = false;
    }
    if (P.get('nolut') === '1') env.skyMat.uniforms.uUseLUT.value = 0;
    if (P.has('detail')) (env.terrain as unknown as { detailU: { value: number } }).detailU.value = num('detail', 1);
    if (P.get('noenv') === '1') {
      scene.environment = null;
      env.hemi.intensity = 1;
      env.hemi.color.copy(ctx.lighting.skyColor);
      env.hemi.groundColor.copy(ctx.lighting.groundColor);
    }
    scene.updateMatrixWorld();
    // opaque
    renderer.setRenderTarget(hdr);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    camera.layers.set(LAYER_DEFAULT);
    renderer.render(scene, camera);
    blit(depthMat, linDepth);
    ctx.sceneDepth.texture = linDepth.texture;
    ctx.sceneDepth.resolution.set(W, H);
    camera.layers.set(LAYER_VFX);
    renderer.setRenderTarget(hdr);
    const sa = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = sa;
    camera.layers.set(LAYER_DEFAULT);
    ctx.sceneDepth.texture = null;
    // exposure
    blit(lumMat, lum);
    if (frames % 4 === 0) {
      renderer.readRenderTargetPixels(lum, 0, 0, 32, 18, lumBuf);
      let s = 0;
      // mean of the cell (geometric-mean) luminances, center weighted; black space does not drag it to 0
      let wsum = 0;
      for (let y = 0; y < 18; y++)
        for (let x = 0; x < 32; x++) {
          const i = y * 32 + x;
          const wgt = 1.5 - Math.hypot((x - 15.5) / 16, (y - 8.5) / 9);
          s += wgt * Math.exp(0.2126 * lumBuf[i * 4] + 0.7152 * lumBuf[i * 4 + 1] + 0.0722 * lumBuf[i * 4 + 2]);
          wsum += wgt;
        }
      const la = Math.log(Math.max(1e-9, s / wsum));
      logAvg = frames < 8 ? la : logAvg + (la - logAvg) * 0.3;
    }
    const Lavg = Math.exp(logAvg);
    // darker key for dark scenes (night stays night)
    const key = 0.25 * THREE.MathUtils.clamp(1.2 + 0.25 * Math.log10(Lavg), 0.2, 1);
    exposure = P.get('ae') === '0' ? Math.pow(2, num('ev', 0)) : (key / Lavg) * Math.pow(2, num('ev', 0));
    outMat.uniforms.uExp.value = exposure;
    renderer.toneMapping = THREE.AgXToneMapping;
    blit(outMat, null);
    renderer.toneMapping = THREE.NoToneMapping;
    frames++;
    (window as unknown as Record<string, unknown>).__envFrames = frames;
    if (frames % 10 === 0) {
      const s = azEl(env.eph.sunDir), m = azEl(env.eph.moonDir);
      const L = ctx.lighting;
      hud.textContent =
        `${vname} alt ${(altitudeOf(camWorldPos) / 1000).toFixed(2)} km  tod ${ctx.settings.timeOfDay}  q${q}  ${ms.toFixed(1)} ms\n` +
        `sun az ${s.az.toFixed(1)} el ${s.el.toFixed(2)}  moon az ${m.az.toFixed(1)} el ${m.el.toFixed(1)} illum ${env.eph.moonIllum.toFixed(2)}\n` +
        `Lavg ${Lavg.toExponential(2)}  exp ${exposure.toExponential(2)}  sunC ${L.sunColor.r.toFixed(2)},${L.sunColor.g.toFixed(2)},${L.sunColor.b.toFixed(2)} vis ${L.sunVisibility.toFixed(2)}\n` +
        `sky ${L.skyColor.r.toExponential(2)},${L.skyColor.g.toExponential(2)},${L.skyColor.b.toExponential(2)}  gnd ${L.groundColor.r.toExponential(2)}  moonC ${L.moonColor.r.toExponential(2)}`;
    }
  };
  const loop = () => {
    step();
    requestAnimationFrame(loop);
  };
  (window as unknown as Record<string, unknown>).__bench = (n: number) => {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    step();
    sync();
    const t = performance.now();
    for (let i = 0; i < n; i++) { step(); sync(); }
    return (performance.now() - t) / n;
  };
  requestAnimationFrame(loop);
}
main();
