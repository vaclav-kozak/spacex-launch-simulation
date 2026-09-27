// Environment: real-ephemeris sun & moon, physically based atmosphere (sky, aerial perspective,
// LUTs per view), stars + Milky Way, Earth surface (ocean + globe), sun/moon lights with fitted
// shadows, PMREM environment probes, ctx.lighting publishing.
// OWNER: env. Public API: constructor(ctx), load(), update(snap, dt), beforeViewRender(view, snap).
import * as THREE from 'three';
import type { AppContext, FrameModule, ViewInfo } from '../../core/context';
import type { SimSnapshot, BodyId } from '../../core/types';
import type { TimeOfDay } from '../../core/settings';
import { getWaveSet } from '../../core/waves';
import { altitudeOf, upAt, sunVisibility } from '../../core/frames';
import { Atmosphere, ATMO, transmittanceCPU } from './atmosphere';
import { aerialUniforms, patchObject } from './aerial';
import { createSkyMaterial, createSkyMesh } from './sky';
import { loadStars } from './stars';
import { computeEphemeris, TOD_EPOCHS, type Ephemeris } from './ephemeris';
import { OceanFFT } from './oceanFFT';
import { EarthSurface, MAX_PLUME_LIGHTS, type EarthTextures } from './earth';
import { EnvProbe } from './envprobe';
import { Terrain } from './terrain';
import { Clouds } from './clouds';
import { envLook } from './look';

const D2R = Math.PI / 180;
/** artistic gain of everything lit by the night sky (moon, stars, airglow, city lights) so a
 * moonlit night lands at ~0.003..0.02 irradiance (contract) instead of the physical ~1e-5 */
const NIGHT_GAIN = 800;
/** full-moon irradiance relative to the sun (physical) */
const MOON_SUN_RATIO = 2.5e-6;
const MOON_ANG_R = 0.00452;
const MOON_ALBEDO_MEAN = 0.30; // mean linear value of the near side in moon.jpg
const MW_RADIANCE = 6e-8; // brightest Milky Way (~20 mag/arcsec^2) in scene radiance units
const AIRGLOW = 9e-9; // ~22 mag/arcsec^2
const STAR_BOOST = 3;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function tex1(r: number, g: number, b: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

interface ViewState {
  probe: EnvProbe | null;
  frame: number;
}

export class Environment implements FrameModule {
  readonly atm = new Atmosphere();
  readonly skyMat: THREE.ShaderMaterial;
  readonly sky: THREE.Mesh;
  stars: THREE.Points | null = null;
  readonly earth: EarthSurface;
  readonly fft: OceanFFT;
  readonly terrain: Terrain;
  readonly clouds: Clouds;
  /** key light (sun, or the moon when it is brighter at the focus) casts shadows */
  readonly keyLight = new THREE.DirectionalLight(0xffffff, 1);
  /** fill light: the other of sun/moon, no shadows */
  readonly fillLight = new THREE.DirectionalLight(0xffffff, 0);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  eph: Ephemeris;
  private pmrem: THREE.PMREMGenerator;
  private views = new Map<string, ViewState>();
  private probeBudget = 1;
  private frame = 0;
  private tod: TimeOfDay | '' = '';
  private seaKey = '';
  private nightGain = 1;
  private moonE = 0; // TOA moon irradiance (scene units, incl. night gain)
  private shared: Record<string, THREE.IUniform>;
  private skyU = {
    uCamAlt: { value: 0 },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uUseLUT: { value: 1 },
    uSkySteps: { value: 24 },
  };
  private envTime = 0;
  private missionT = 0;
  private qLevel = -1;
  // scratch
  private _v = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _c = new THREE.Color();
  private _c2 = new THREE.Color();
  private _lightE = new THREE.Color();
  private _lightDir = new THREE.Vector3();
  private _focus = new THREE.Vector3();

  constructor(private ctx: AppContext) {
    const atm = this.atm;
    // share the aerial uniform objects with everyone else (vfx/vehicles use aerialUniforms)
    aerialUniforms.uAerialIn.value = atm.aerialRT.textures[0];
    aerialUniforms.uAerialTr.value = atm.aerialRT.textures[1];
    const au = atm.uniforms as unknown as Record<string, THREE.IUniform>;
    const ae = aerialUniforms as unknown as Record<string, THREE.IUniform>;
    for (const k of ['uAerialIn', 'uAerialTr', 'uAerialCamUp', 'uAerialSunTan', 'uAerialCamAlt', 'uAerialOn']) au[k] = ae[k];
    this.shared = {
      ...au,
      uLightTan: au.uAerialSunTan,
      ...this.skyU,
    };

    ctx.scene.background = null;
    this.skyMat = createSkyMaterial(this.shared);
    this.sky = createSkyMesh(this.skyMat);
    this.sky.userData.noAerial = true;
    ctx.scene.add(this.sky);

    const blank: EarthTextures = {
      dayGlobal: tex1(20, 40, 70), dayReg: tex1(20, 40, 70), night: tex1(0, 0, 0), nightReg: tex1(0, 0, 0),
      maskGlobal: tex1(0, 0, 0), maskReg: tex1(0, 0, 0), clouds: tex1(0, 0, 0),
    };
    this.earth = new EarthSurface(this.shared, blank);
    this.earth.mesh.userData.noAerial = true;
    ctx.worldRoot.add(this.earth.mesh);

    this.fft = new OceanFFT(ctx.renderer.capabilities.getMaxAnisotropy());
    this.terrain = new Terrain(ctx, this.shared);
    this.clouds = new Clouds(ctx, this.shared);

    this.eph = computeEphemeris(Date.parse(TOD_EPOCHS[ctx.settings.timeOfDay]));

    const kl = this.keyLight;
    kl.castShadow = true;
    kl.shadow.mapSize.set(2048, 2048);
    kl.shadow.bias = -0.0003;
    kl.shadow.normalBias = 0.03;
    const sc = kl.shadow.camera;
    sc.near = 1; sc.far = 6000;
    ctx.worldRoot.add(kl, kl.target, this.fillLight, this.fillLight.target);
    ctx.scene.add(this.hemi);
    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
  }

  async load(): Promise<void> {
    const r = this.ctx.renderer;
    const aniso = r.capabilities.getMaxAnisotropy();
    const loader = new THREE.TextureLoader();
    const load = async (url: string, srgb: boolean, repeat = false, mips = true): Promise<THREE.Texture | null> => {
      try {
        const t = await loader.loadAsync(url);
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = aniso;
        if (repeat) t.wrapS = THREE.RepeatWrapping;
        t.generateMipmaps = mips;
        t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        return t;
      } catch (e) {
        console.warn('[env] texture failed', url, e);
        return null;
      }
    };
    const T = '/textures/env/';
    const hi = this.ctx.quality.level >= 2;
    const [dayG, dayR, nightG, nightR, maskG, maskR, clouds, moon, mw, stars] = await Promise.all([
      load(T + (hi ? 'earth_day.jpg' : 'earth_day.jpg'), true, true),
      load(T + 'earth_day_reg.jpg', true),
      load(T + 'earth_night.jpg', true, true),
      load(T + 'earth_night_reg.jpg', true),
      load(T + 'mask_global.png', false, true),
      load(T + 'mask_reg.png', false),
      load(T + 'earth_clouds.jpg', false, true),
      load(T + 'moon.jpg', true),
      load(T + 'milkyway.jpg', false, true),
      loadStars('/data/env/stars.bin', { ...this.shared }).catch((e) => {
        console.warn('[env] stars failed', e);
        return null;
      }),
      this.terrain.load().catch((e) => console.warn('[env] terrain failed', e)),
      this.clouds.load().catch((e) => console.warn('[env] clouds failed', e)),
    ]);
    const eu = this.earth.material.uniforms;
    if (dayG) eu.uDayGlobal.value = dayG;
    if (dayR) eu.uDayReg.value = dayR;
    if (nightG) eu.uNight.value = nightG;
    if (nightR) eu.uNightReg.value = nightR;
    if (maskG) eu.uMaskGlobal.value = maskG;
    if (maskR) eu.uMaskReg.value = maskR;
    if (clouds) eu.uClouds.value = clouds;
    this.terrain.setGlobalTextures(eu.uDayReg.value, eu.uNightReg.value);
    this.clouds.setGlobalCoverage(eu.uClouds.value, eu.uMaskReg.value);
    const su = this.skyMat.uniforms;
    if (moon) su.uMoonTex.value = moon;
    if (mw) su.uMilkyWay.value = mw;
    if (stars) {
      this.stars = stars;
      stars.userData.noAerial = true;
      // share camera uniforms with the sky
      const pu = (stars.material as THREE.ShaderMaterial).uniforms;
      pu.uCamAlt = this.skyU.uCamAlt;
      pu.uCamUp = this.skyU.uCamUp;
      this.ctx.scene.add(stars);
    }
    try {
      this.atm.init(r);
    } catch (e) {
      console.warn('[env] atmosphere init failed', e);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(snap: SimSnapshot, _dt: number): void {
    const ctx = this.ctx;
    this.frame++;
    this.probeBudget = 1;
    const s = ctx.settings;
    const q = ctx.quality.level;
    if (q !== this.qLevel) {
      this.qLevel = q;
      const ms = [1024, 2048, 2048, 4096][q];
      const sh = this.keyLight.shadow;
      if (sh.mapSize.x !== ms) {
        sh.mapSize.set(ms, ms);
        sh.map?.dispose();
        (sh as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
      }
      this.terrain.setQuality(q);
    }
    // sea state / wind
    const sk = `${s.seaState}|${s.windSpeed}|${s.windFromDeg}`;
    if (sk !== this.seaKey) {
      this.seaKey = sk;
      const set = getWaveSet(s.seaState, s.windFromDeg);
      this.earth.setWaves(set);
      this.fft.setConditions(set, s.windSpeed, s.windFromDeg);
      this.clouds.setWind(s.windSpeed, s.windFromDeg);
    }
    if (s.timeOfDay !== this.tod) {
      this.tod = s.timeOfDay;
      // drop probes so reflections refresh at once
      for (const v of this.views.values()) v.frame = -1e9;
      this.clouds.resetHistory();
    }
    this.missionT = snap.t;
    this.envTime = snap.envT ?? snap.t;
    const ms = Date.parse(TOD_EPOCHS[s.timeOfDay]) + snap.t * 1000;
    computeEphemeris(ms, this.eph);
    const e = this.eph;
    // global night gain from the sun elevation at the pad (pad up = +Y)
    const sunEl = Math.asin(THREE.MathUtils.clamp(e.sunDir.y, -1, 1)) / D2R;
    this.nightGain = 1 + (NIGHT_GAIN - 1) * smooth(-10, -18, sunEl);
    envLook.night = (this.nightGain - 1) / (NIGHT_GAIN - 1);
    this.moonE = ATMO.sunE * MOON_SUN_RATIO * Math.pow(e.moonIllum, 3) * this.nightGain;

    // ocean detail (only needed when some camera is near the sea)
    try {
      this.fft.update(ctx.renderer, this.envTime);
    } catch (err) {
      if (this.frame < 3) console.warn('[env] fft', err);
    }
    this.clouds.update(snap, _dt);
    if (this.frame % 30 === 1) patchObject(ctx.worldRoot);
    if (this.stars) (this.stars.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.realTime;
    this.earth.material.uniforms.uTime.value = this.envTime;
  }

  /** atmosphere light for a camera: the sun, or the moon once the sun is well below the horizon */
  private pickLight(up: THREE.Vector3, outDir: THREE.Vector3, outE: THREE.Color): boolean {
    const e = this.eph;
    const sunMu = e.sunDir.dot(up);
    if (sunMu > Math.sin(-13 * D2R)) {
      outDir.copy(e.sunDir);
      outE.setRGB(ATMO.sunE, ATMO.sunE, ATMO.sunE);
      return false;
    }
    outDir.copy(e.moonDir);
    // moonlight is slightly redder than sunlight
    outE.setRGB(1.0, 0.95, 0.88).multiplyScalar(this.moonE);
    return true;
  }

  beforeViewRender(view: ViewInfo, snap: SimSnapshot): void {
    const ctx = this.ctx;
    const fb = view.focus ? snap.bodies[view.focus] : undefined;
    envLook.focusDist.set(view.id, fb ? view.camWorldPos.distanceTo(fb.pos) : 0);
    const r = ctx.renderer;
    const q = ctx.quality.level;
    const cam = view.camera;
    const aspect = view.rect.w / Math.max(1e-3, view.rect.h);
    if (Math.abs(cam.aspect - aspect) > 1e-6) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    let vs = this.views.get(view.id);
    if (!vs) this.views.set(view.id, (vs = { probe: null, frame: -1e9 }));

    const camPos = view.camWorldPos;
    const camAlt = altitudeOf(camPos);
    const up = upAt(camPos, this._up);
    const moonIsLight = this.pickLight(up, this._lightDir, this._lightE);
    const lightDir = this._lightDir, lightE = this._lightE;
    const e = this.eph;

    try {
      this.atm.updateView(r, camPos, lightDir, lightE, q);
      this.atm.updateSea(r, camPos, lightDir, lightE);
    } catch (err) {
      if (this.frame < 3) console.warn('[env] atmosphere', err);
    }

    // ---- sky / stars
    const px = (view.rect.h * r.getPixelRatio()) || 1;
    const pixAng = (cam.fov * D2R) / px;
    const su = this.skyMat.uniforms;
    this.skyU.uCamAlt.value = Math.max(0.5, camAlt);
    this.skyU.uCamUp.value.copy(up);
    this.skyU.uUseLUT.value = camAlt < 60_000 ? 1 : 0;
    this.skyU.uSkySteps.value = [14, 18, 24, 32][q];
    su.uSunDir.value.copy(e.sunDir);
    su.uSunE.value.set(ATMO.sunE, ATMO.sunE, ATMO.sunE);
    su.uMoonDir.value.copy(e.moonDir);
    su.uMoonAngR.value = MOON_ANG_R;
    const moonDisc = this.moonE / (Math.PI * MOON_ANG_R * MOON_ANG_R * MOON_ALBEDO_MEAN * Math.max(0.05, Math.pow(e.moonIllum, 3)));
    su.uMoonE.value.set(1.0, 0.96, 0.9).multiplyScalar(moonDisc * Math.pow(e.moonIllum, 3));
    su.uMoonNorth.value.set(e.eciToW.elements[6], e.eciToW.elements[7], e.eciToW.elements[8]);
    (su.uWtoEci.value as THREE.Matrix3).copy(e.eciToW).transpose();
    const g = this.nightGain;
    su.uMWScale.value = MW_RADIANCE * STAR_BOOST * g;
    su.uNightGlow.value.set(0.85, 1.0, 0.9).multiplyScalar(AIRGLOW * STAR_BOOST * g * smooth(-6, -14, Math.asin(THREE.MathUtils.clamp(e.sunDir.dot(up), -1, 1)) / D2R));
    su.uPixelAng.value = pixAng;
    if (this.stars) {
      const pu = (this.stars.material as THREE.ShaderMaterial).uniforms;
      (pu.uEciToW.value as THREE.Matrix3).copy(e.eciToW);
      pu.uPixelAng.value = pixAng;
      pu.uBoost.value = STAR_BOOST * g;
    }

    // ---- volumetric clouds (per-view setup; the march itself runs inside the LAYER_VFX pass)
    this.clouds.beforeViewRender(view, camAlt, lightDir, lightE, q, su.uNightGlow.value as THREE.Vector3);

    // ---- Earth surface
    const eu = this.earth.material.uniforms;
    this.earth.fitGrid(cam, camAlt, up, px, q);
    this.earth.updatePhases(ctx.renderOrigin, this.envTime);
    eu.uPixAng.value = pixAng;
    eu.uFFTDisp0.value = this.fft.disp[0];
    eu.uFFTDisp1.value = this.fft.disp[1];
    eu.uFFTSlope0.value = this.fft.slope[0];
    eu.uFFTSlope1.value = this.fft.slope[1];
    eu.uWaveOn.value = camAlt < 40_000 ? 1 : 0;
    eu.uCloudOn.value = 0.95;
    eu.uCloudFade.value.set(this.clouds.volumetricOn * (this.clouds.active ? 1 : 0), this.clouds.maxDist * 0.6, this.clouds.maxDist, 0);
    eu.uNightLights.value = 5e-5 * Math.max(g, 30);
    const ship = snap.bodies?.SHIP;
    if (ship) {
      eu.uShipOn.value = 1;
      eu.uShipRel.value.copy(ship.pos).sub(ctx.renderOrigin);
      eu.uShipX.value.set(1, 0, 0).applyQuaternion(ship.quat);
      eu.uShipZ.value.set(0, 0, 1).applyQuaternion(ship.quat);
    } else eu.uShipOn.value = 0;
    const pls = ctx.plumeLights;
    let n = 0;
    for (let i = 0; i < pls.length && n < MAX_PLUME_LIGHTS; i++) {
      const p = pls[i];
      (eu.uPlPos.value[n] as THREE.Vector3).copy(p.pos).sub(ctx.renderOrigin);
      const c = p.color;
      (eu.uPlCol.value[n] as THREE.Vector3).set(c.r, c.g, c.b);
      eu.uPlRange.value[n] = p.range;
      n++;
    }
    eu.uPlCount.value = n;
    const sunElPad = Math.asin(THREE.MathUtils.clamp(e.sunDir.y, -1, 1)) / D2R;
    this.terrain.beforeViewRender(view, camAlt, pixAng, eu.uNightLights.value, smooth(2, -6, sunElPad));
    this.earth.material.uniforms.uTerrainBox.value.copy(this.terrain.oceanBox);

    // ---- lighting at the focus
    const focusPos = this.focusPosition(view, snap, this._focus);
    const fAlt = Math.max(0, altitudeOf(focusPos));
    const fUp = upAt(focusPos, this._v2);
    const L = ctx.lighting;
    L.sunDir.copy(e.sunDir);
    const sunMu = e.sunDir.dot(fUp);
    transmittanceCPU(fAlt, sunMu, this._c);
    L.sunColor.copy(this._c).multiplyScalar(ATMO.sunE);
    L.sunVisibility = sunVisibility(focusPos, e.sunDir);
    L.moonDir.copy(e.moonDir);
    const moonMu = e.moonDir.dot(fUp);
    transmittanceCPU(fAlt, moonMu, this._c2);
    L.moonColor.setRGB(1.0, 0.95, 0.88).multiply(this._c2).multiplyScalar(this.moonE);
    // ambient irradiance (sky dome on a horizontal surface; ground bounce from below)
    const lightMuF = lightDir.dot(fUp);
    this.atm.skyIrradianceCPU(fAlt, lightMuF, L.skyColor);
    L.skyColor.r *= lightE.r; L.skyColor.g *= lightE.g; L.skyColor.b *= lightE.b;
    const glow = su.uNightGlow.value as THREE.Vector3;
    L.skyColor.r += glow.x * Math.PI; L.skyColor.g += glow.y * Math.PI; L.skyColor.b += glow.z * Math.PI;
    // ground: albedo (ocean -> cloud tops from altitude) x total irradiance at the surface below
    transmittanceCPU(0, lightMuF, this._c);
    const gAlb = 0.07 + 0.2 * smooth(2_000, 20_000, fAlt);
    this.atm.skyIrradianceCPU(0, lightMuF, this._c2);
    L.groundColor.setRGB(
      (this._c.r * Math.max(0, lightMuF) + this._c2.r) * lightE.r * gAlb,
      (this._c.g * Math.max(0, lightMuF) + this._c2.g) * lightE.g * gAlb,
      (this._c.b * Math.max(0, lightMuF) + this._c2.b) * lightE.b * gAlb,
    );
    void moonIsLight;

    // ---- key/fill lights
    const sunLum = L.sunColor.r + L.sunColor.g + L.sunColor.b;
    const moonLum = L.moonColor.r + L.moonColor.g + L.moonColor.b;
    const sunKey = sunLum >= moonLum;
    this.placeKey(sunKey ? e.sunDir : e.moonDir, sunKey ? L.sunColor : L.moonColor, focusPos, fUp, view);
    // cloud shadows: spatial map along the key light (patched lit materials, terrain, earth apply it
    // to the key light themselves), plus the probed transmittance at the focus/camera for consumers
    // of ctx.lighting (the key light itself keeps the unshadowed color)
    this.clouds.updateShadow(r, sunKey ? e.sunDir : e.moonDir, focusPos, fAlt, camAlt);
    const cT = this.clouds.focusTransmittance();
    if (sunKey) {
      L.sunColor.multiplyScalar(cT);
      L.sunVisibility *= this.clouds.cameraTransmittance();
    } else L.moonColor.multiplyScalar(cT);
    const fl = this.fillLight;
    fl.color.copy(sunKey ? L.moonColor : L.sunColor);
    fl.intensity = 1;
    fl.position.copy(focusPos).addScaledVector(sunKey ? e.moonDir : e.sunDir, 1000);
    fl.target.position.copy(focusPos);
    fl.updateMatrixWorld();
    fl.target.updateMatrixWorld();

    // ---- environment probe (PMREM), low rate, one update per frame across all views
    if (!vs.probe) vs.probe = new EnvProbe(this.shared, q >= 2 ? 64 : 32);
    const due = this.frame - vs.frame > (q >= 2 ? 20 : 40);
    if (due && this.probeBudget > 0) {
      this.probeBudget--;
      vs.frame = this.frame;
      const pu = this.probeGlow;
      pu.copy(glow);
      try {
        this.probeAlbedo.setRGB(gAlb * 0.9, gAlb, gAlb * 1.1);
        vs.probe.update(r, this.pmrem, Math.max(1, fAlt), fUp, lightDir, lightE, this.probeAlbedo, pu);
      } catch (err) {
        if (this.frame < 5) console.warn('[env] probe', err);
      }
    }
    const envTex = vs.probe.pmremRT ? vs.probe.pmremRT.texture : null;
    ctx.scene.environment = envTex;
    L.envMap = envTex;
    if (envTex) {
      this.hemi.intensity = 0;
    } else {
      this.hemi.intensity = 1;
      this.hemi.color.copy(L.skyColor);
      this.hemi.groundColor.copy(L.groundColor);
    }
    aerialUniforms.uAerialSunDir.value.copy(e.sunDir);
    aerialUniforms.uAerialSunColor.value.copy(L.sunColor);

  }

  private probeGlow = new THREE.Vector3();
  private _kx = new THREE.Vector3();
  private _ky = new THREE.Vector3();
  private _kc = new THREE.Vector3();
  private probeAlbedo = new THREE.Color();

  private focusPosition(view: ViewInfo, snap: SimSnapshot, out: THREE.Vector3): THREE.Vector3 {
    const f = view.focus as BodyId | null;
    const b = f ? snap.bodies?.[f] : undefined;
    if (b) return out.copy(b.pos);
    // no focus: a point 60 m in front of the camera
    const fwd = this._v.set(0, 0, -1).transformDirection(view.camera.matrixWorld);
    return out.copy(view.camWorldPos).addScaledVector(fwd, 60);
  }

  private placeKey(dir: THREE.Vector3, color: THREE.Color, focus: THREE.Vector3, fUp: THREE.Vector3, view: ViewInfo): void {
    const kl = this.keyLight;
    kl.color.copy(color);
    kl.intensity = 1;
    // shadow box around the focus body (the stack is ~70 m tall; pos is at the nozzle exit)
    const box = view.focus === 'SHIP' ? 200 : 150;
    const center = this._kc.copy(focus).addScaledVector(fUp, view.focus === 'SHIP' ? 5 : 30);
    // texel snapping in absolute W light space (stable under camera motion)
    const mapSize = kl.shadow.mapSize.x;
    const texel = box / mapSize;
    const z = dir;
    const x = this._kx.set(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
    x.normalize();
    const y = this._ky.crossVectors(z, x);
    const tx = center.dot(x), ty = center.dot(y);
    center.addScaledVector(x, Math.round(tx / texel) * texel - tx).addScaledVector(y, Math.round(ty / texel) * texel - ty);
    kl.target.position.copy(center);
    kl.position.copy(center).addScaledVector(dir, 3000);
    const sc = kl.shadow.camera;
    const hb = box / 2;
    if (sc.right !== hb) {
      sc.left = -hb; sc.right = hb; sc.top = hb; sc.bottom = -hb;
      sc.updateProjectionMatrix();
    }
    kl.updateMatrixWorld();
    kl.target.updateMatrixWorld();
  }
}
