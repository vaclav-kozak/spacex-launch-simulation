# Env notes / contracts (owner: env, `src/render/env/**`)

## Public API (unchanged)
`new Environment(ctx)`, `load()`, `update(snap, dt)` (once per frame), `beforeViewRender(view, snap)` (per view,
before the opaque pass). Useful public members: `keyLight` (shadow-casting DirectionalLight fitted to the
focus body), `fillLight`, `hemi` (used only until the first env probe exists), `terrain` (`heightAtLocal(x, z)`),
`clouds`, `earth`, `atm`.

* Time: env animates everything (ephemeris, waves, cloud drift) from `snap.envT ?? snap.t`.
* Env **never writes `ctx.lighting.exposureBias`**. UI and photo mode own it.
* Env sets `view.camera.aspect` from `view.rect` and updates the projection every view.
* `?clouds=0..1.5` scales the cloud coverage (0 = clear sky). `?cshadow=0` disables cloud shadows (debug).

## ctx.lighting (written per view in beforeViewRender, for the view's focus body)
* `sunDir` / `moonDir`: W unit vectors toward the body.
* `sunColor` is the direct solar irradiance at the focus, in linear scene units. It includes atmospheric
  transmittance and **the volumetric cloud transmittance toward the sun** (async probe, ~2 frames late,
  smoothed). `moonColor` is the same for the moon. The cloud factor applies only to whichever of the two is
  the key light.
* `sunVisibility` is the Earth-shadow visibility at the focus multiplied by the cloud transmittance
  toward the sun **at the camera**. Post uses it for flares and glare.
* `skyColor` / `groundColor`: hemisphere irradiance (sky dome incl. night glow / ground bounce).
* `envMap`: the PMREM probe (also `scene.environment`).
* `keyLight.color` stays **unshadowed by clouds**. Every patched lit material multiplies its directional
  lights by `aerialCloudShadow()` per fragment, so do not multiply by the cloud factor again.

## Aerial perspective (`aerial.ts`, API unchanged + additions)
* `aerialUniforms`, `AERIAL_GLSL` with `aerialApply / aerialTransmittance / aerialInscatter(rel)`,
  `aerialLookup(rel, out inscat, out trans)`, `aerialSunColor()`, `patchMaterial(mat)`, `patchObject(root)`.
  `rel` = fragment W position minus camera W position. Env patches `ctx.worldRoot` every 30 frames, and
  `material.userData.noAerial = true` opts a material out.
* **New:** `float aerialCloudShadow(vec3 rel)` returns the transmittance (0..1) of the volumetric clouds
  toward the key light, read from a per-view cloud shadow map. It returns 1 outside the map (a box of
  ±12..150 km around the camera, growing with altitude) and above the cloud shell.
  New uniforms: `uCloudShadow`, `uCloudShadowBox`, `uCloudShadowDir`. Patched lit materials
  (Standard/Physical/Lambert/Phong/Toon) apply it to all directional lights automatically. Custom shaders
  lit by `aerialSunColor()` should multiply by `aerialCloudShadow(rel)` for smoke or plumes below or inside the deck.

* **New (look-dev):** `float aerialEarthShadow(vec3 rel, vec3 lightDirW)` / `aerialSunVisibility(rel)`: 0..1
  Earth shadow at the fragment (horizon raised by 12 km like `core/frames` sunVisibility, ~1 deg soft).
  The key light is colored for the view's focus body, so without this a pad camera at twilight lit the
  whole pad with the sun the rocket sees at 70 km. Patched lit materials apply it per directional light
  automatically. **vfx:** smoke/plume shaders lit by `aerialSunColor()` should multiply by
  `aerialSunVisibility(rel)` (pad smoke / low exhaust while the focus is sunlit high up).

* **New (round 3):** `vec3 aerialLightTransRatio(vec3 rel, vec3 lightDirW)` = atmospheric transmittance toward
  the light at the fragment divided by the transmittance at the view's focus (clamped 0..4). The key light
  colour is evaluated at the focus, so with a focus at 30 km and a pad-level fragment at sunrise the ground was
  lit with the unreddened high-altitude sun (a visible seam where terrain met the globe). Patched lit
  materials apply it per directional light automatically, together with `aerialCloudShadow` and
  `aerialEarthShadow`. New uniforms: `uAerialTransLUT` (the atmosphere transmittance LUT, set by env) and
  `uAerialLightRef` (xyz = up at the focus, w = focus altitude m; w < 0 switches the ratio off). The
  material cache key is now `|aerial4` / `|aerialA4`. Custom shaders lit by `aerialSunColor()` can multiply by
  it the same way; it is 1 at the focus.

## Look values for post (`look.ts`)
`envLook.night` (0 day/twilight .. 1 night, same ramp as the moon/star night gain) and
`envLook.focusDist` (Map view id -> camera-to-focus-body distance, m, written in beforeViewRender).
Only post reads them.

## Sky / time of day (look-dev)
* Twilight epoch is `2026-12-23T01:24:00Z`: sun -6.0 deg at az 246 (end of civil twilight). The pad is in
  the Earth's shadow; the rocket climbs into sunlight at ~45-50 km (twilight "jellyfish"); a nearly full
  moon rises in the ENE.
* Ozone absorption is channel-integrated (`ozone [1.75, 1.7, 0.11] e-6`, was single-wavelength
  0.65/1.88/0.085): the Chappuis band covers the whole red and green sRGB bands, so red is absorbed
  about as much as green. The old values made long ozone paths magenta (purple twilight sky, pink
  booster at 75 km); now the twilight sky is blue overhead with an orange western horizon and grazing
  sunlight goes orange (tangent 12-16 km) -> white/lavender (25-35 km) -> white.

* **Twilight horizon band (round 3, checked, no change):** at the twilight epoch the sky already shows the
  orange sun-side band (WSW, az ~246) and a pink Belt of Venus over the dark Earth-shadow band opposite the
  sun (ENE), from the ground up to ~60 km camera altitude. At ~110 km the sun is above the limb and the limb
  reads white-blue (correct). The in-app cameras at T+100..200 mostly look up and see no horizon, so the band
  is rarely on screen (see requests).

## Night lighting (round 3)
* The moon light is graded cool: `MOON_TINT = [0.8, 0.97, 1.22]` in `Environment.ts` scales `moonColor` and
  the key light when the moon is the key. Luminance is about the physical value. The moon disc keeps its
  neutral colour. The night onboard view at ~110 km is smooth, dim and blue-grey, with no sparkle.
* Globe night lights now fade on the **real sun elevation** (`uAerialSunDir`). They used `uLightDir`, which is
  the moon on moonlit nights, so the globe switched its city lights off while the terrain kept them (seam).
* **City lights (`nightCity.ts`):** `earth_night_city.jpg` is a ~460 m/px Black Marble crop of the California
  coast (SF Bay .. San Diego, `NIGHT_CITY_BOX = (-123.5, 32.0, -115.0, 38.4)`, lon0/lat0/lon1/lat1). It replaces
  the 1.3 km regional night texture inside the box on the globe (`earth.ts`) and on both terrain patches
  (`terrain.ts`, emissive). Below ~300 m pixel footprint a mean-preserving street pattern is multiplied into
  the lit areas: the 1-mile arterial grid (45 m wide), 400 m block variation and 2.5 km districts. It is
  box-filtered by the footprint, so from altitude the texture is unchanged and nothing sparkles.
  `nightCityUniforms` (`uNightCity`, `uCityBox`) + `NIGHT_CITY_GLSL` (`vec3 nightCity(nl, lonDeg, latDeg,
  footprintM)`) can be reused by any shader. `uCityBox` stays off-planet until the texture has loaded.

## Clouds (`clouds.ts`, `cloudWeather.ts`)
* Volumetric clouds are a coastal marine stratocumulus deck, roughly 0.6–1.5 km thick near the coast.
  The deck burns off a few km inland and breaks up offshore, and scattered cumulus (tops up to ~3.4 km)
  lie further out. The shell is `CLOUD_SHELL = {bottom: 560, top: 3400}` m.
  Above ~60 km camera altitude, or beyond `clouds.maxDist`, the globe draws a matching 2D layer from the same weather
  model.
* **Weather model (round 3, fixes the visible tiling from altitude):** `cloud_weather.bin` is now 1024² and is
  sampled at three scales: fine (80 km tile, ~2 km closed cells), coarse (347 km tile rotated 37°: ~9 km closed
  cells, ~30 km open cells, 20-120 km coverage patches) and a regime field (610 km tile rotated −24°: patches, large
  clear areas). The fine lookup is domain-warped by the regime field, so no tile period lines up.
  * Near the coast the cells are small; offshore they grow.
  * Where the deck is partial, the organisation switches from closed cells (cloud with thin rifts) to open cells
    (rings of cumulus around clear centres).
  * Beyond ~90-320 km from the pad the synoptic coverage fades to the Blue Marble July cloud composite, so the view from
    orbit shows the real marine layer off California / Baja.
  * All thresholds are footprint-filtered: a cell smaller than the pixel returns its expected coverage, not a
    sub-pixel speckle.
  * `cldRegime / cldWeather / cldCover2D` are shared by the volumetric march and the globe's 2D layer (`earth.ts`),
    so the hand-off at 60 km / `maxDist` matches.
* The clouds render in the **LAYER_VFX pass** as two fullscreen meshes in `ctx.scene`:
  * `env.clouds` has renderOrder −100 and blends premultiplied over the HDR target. Its onBeforeRender runs the half-res
    ray march plus a temporal resolve, using `ctx.sceneDepth`.
  * `env.cloudsDepth` has renderOrder −99 and **writes the cloud's median depth** (log depth) where
    cloud opacity > 0.6. So VFX drawn afterwards with depthTest is hidden behind thick cloud and still
    draws in front of it. Give VFX a renderOrder > −99 (the default 0 is fine).
* Soft particles that read `ctx.sceneDepth` do not see the clouds, because the depth texture holds opaque geometry only.
* The plume lights (`ctx.plumeLights`, first 4) light the clouds, which makes the night-launch glow on the deck.
* S1 crossing the deck punches a hole on ascent (at 1 km) and on descent (at the shell top). The hole widens and
  drifts with the wind, and is reset on seek-back.
* Cost on an RTX 5070 Ti at 1080p is ~0.3–0.6 ms (march + resolve + composite + shadow map + probe), which
  is ~2–4 ms on a GTX 1650. Quality levels 0..3 change the steps (24/32/44/60), resolution (¼ at q0, ⅓ at q1, ½ at q2+),
  shadow map size (256/384/512/1024) and distance.
* The cloud shadow map (0.03–0.25 ms per render on the 5070 Ti) is re-rendered **every 4th frame at q0 and every 2nd
  at q1** (every frame at q2+). It is re-rendered sooner when the camera leaves the middle 8 % of the box, the box
  size changes > 4 %, the key light turns, or the wind offset jumps (seek). Between renders the stored map is
  reused at its stored world position, so nothing slides.

## Perf (round 3, RTX 5070 Ti, 1080p, `scripts/perf.py`, GPU ms)
The GPU is shared with other agents' headless browsers, so readings jump by up to 1 ms between runs. The
values below are the lower of two runs.

| View | q0 scene | q2 scene | q0 post | q2 post |
|---|---|---|---|---|
| `S1:pad:wide` T+8 | 0.56 | 1.04 | 0.56 | 0.86 |
| `S1:onboard` T+196 | 0.2–1.2 | 1.35 | 0.87 | 1.14 |
| `S1:chase` T+77 | 0.85 | 0.43 | 0.67 | 0.87 |
| `SHIP:deck` T+505 | 1.09 | 2.15 | 0.50 | 0.70 |
| `S1:onboard` T+330 night | 1.16 | 1.12 | 1.06 | 0.84 |

* `scene` is everything in the opaque + VFX passes: env, models and VFX.
* Env pre-pass (`beforeViewRender`: LUTs, probe, cloud shadow, FFT) costs 0.03–0.1 ms without clouds and 0.3–0.7 ms
  with volumetric clouds. The clouds cost ~0.4 ms of `scene` at q0 and ~1.1 ms at q2 (deck view).
* Estimated env total on the 5070 Ti is ~0.7–1.3 ms at q0 and ~1.5–2.5 ms at q2. Scaled ×5–6 for a GTX 1650,
  that is ≈ 3.5–7 ms at q0, around the 5 ms budget, and over budget at q2.
* On a 1650 the main lever is `clouds.maxDist` / march steps at q0. The rest of env is cheap.
* Wrapping `env.beforeViewRender` or cloud passes in the `GpuTimer` corrupts the `scene` reading (≈ 10 ms at
  pad q0). Timer queries do not nest, so time sub-passes only in isolation.

## Perf (round 4, env only, RTX 5070 Ti, 1080p, GPU ms)
Method: microbench (scratchpad `bench.py`). The app loop is frozen, then each env pass is timed alone, 20 renders
inside one timer query, and the min of 5 trials is taken. Each view was run twice and the min kept. Scene pieces
(earth, terrain, sky) are rendered alone into the scene target. Per-frame total = LUTs + FFT (if it runs) + cloud shadow
/ its frame interval + march + resolve + composite + cloud depth + earth + terrain + sky + probe/40. The GPU is
shared with other agents, so single values still jump by ±0.05 ms. The q2 rows changed by noise only, apart from
the FFT skip above 13 km and the earth gating.

| View | q0 before → after | q1 before → after | q2 before → after |
|---|---|---|---|
| `S1:pad:wide` T+8 | 0.23 → 0.14 | 0.42 → 0.24 | 0.72 → 0.59 |
| `SHIP:deck` T+505 | 0.31 → 0.20 | 0.65 → 0.28 | 0.76 → 0.63 |
| `S1:onboard` T+196 | 0.35 → 0.15 | 0.49 → 0.27 | 0.67 → 0.44 |
| `S1:long_lens` twilight T+130 | 0.22 → 0.16 | 0.38 → 0.21 | 0.66 → 0.52 |

* GTX 1650 factor: ~8× central (Time Spy; texture rate 7.4×, bandwidth 7×) and ~12× pessimistic for ALU-heavy passes.
  * Env after: q0 ≈ 1.1–1.6 ms (1.7–2.4 pessimistic), q1 ≈ 1.7–2.3 ms (2.5–3.5), q2 ≈ 3.5–5.2 ms.
  * Env before: q0 ≈ 1.7–2.8 ms, q1 ≈ 3.1–5.2 ms.
  * q0 and q1 are within the 5 ms budget.
  * The round-3 figure (3.5–7 ms) came from whole-scene perf.py deltas × 5–6 and included timer noise.
* Where the time went before: the ocean FFT was 50–70 % of env at q0, and it also ran every frame at 107 km, where
  it is invisible. At q1 the FFT, the cloud march (720×405, 0.11–0.13 ms) and the earth shader led.
* Changes (q0/q1 only unless noted):
  * **Ocean FFT** runs on a 128² grid at q ≤ 1 (256² at q2+): 0.13–0.16 → 0.07–0.09 ms.
    * The spectrum is drawn from the same 256² random realization, so the swell and wind-sea waves are
      identical. Only the capillary tail of cascade 1 above the 128 Nyquist is dropped.
    * The dropped slope variance (`fft.lostSlopeVar`) goes into the GGX roughness (`uFFTLost`), so the
      glitter level matches.
    * All qualities: the FFT is skipped entirely while no view is below 13 km altitude. It is re-run on the
      first frame a view comes back.
  * **Cloud march** at ⅓ resolution at q1 (480×270 instead of 720×405): 0.11–0.13 → 0.05–0.06 ms. The pad q1 A/B
    is visually identical, since the depth-aware upsample and temporal resolve hide it.
  * **Earth shader** (all qualities, same output):
    * FFT slopes are fetched only inside the FFT fade. They use `textureGrad` with gradients taken outside the
      branch; implicit derivatives in the branch gave dark speckle along the 12 km fade line, which is the
      deck horizon.
    * Foam noise and the wake are skipped beyond 20 km and 80 m from the hull.
    * Plume point lights are skipped outside their range.
  * **Terrain** (all qualities): T1/T2 are hidden when the tile is below the horizon (horizon distance of the
    camera + that of the tile's highest point, ×1.1 + 5 km). It saves little: terrain was already cheap thanks to
    early-z.
* Not changed: the LUTs (≈ 0.01 ms total), the cloud shadow (already amortised), and the q2/q3 steps, distance and
  resolution.
* Probe spike: the PMREM env-probe update (three r186, 256-sample GGX) costs ≈ 0.5 ms in the frame it runs,
  i.e. ~4–6 ms on a 1650, once every 40 frames at q ≤ 1 (every 20 at q2+). The cost is mostly the fixed PMREM
  blur, so it does not shrink with the 32² probe. It is the next lever if frame-time spikes matter
  (lower sample count, or split the update over frames).
* Shots: `shots/env4/*_q0_vs_q2.jpg` (left q0, right q2).
  * Views: pad wide T+8, deck T+505, onboard T+196 and twilight long lens T+130, plus morning pad and deck.
  * `ovals_before_top_after_bottom.png` shows the open-cell change.

## Terrain / ocean layering
* The terrain meshes (T1 40 km, T2 400 km, both from DEM) are drawn first. The Earth surface shader draws the sea
  everywhere inside the T2 box, and terrain occludes it where land is above sea level. Offshore DEM is ≤ −4 m (see
  docs/assets/env.md, `coast` step).

## Known issues / requests
* **VFX (twilight pink plume, `shots/pc3/after/tw_ll145.png`):** the sky is not pink. With the VFX root hidden,
  the same frame (long_lens:ground, T+145, twilight) is deep blue, display RGB ≈ (25, 40, 75). The salmon
  colour is the plume lit by `sunRadianceAt()` in `src/render/vfx/common.ts`, which still uses the
  single-wavelength ozone `BO = [0.65, 1.881, 0.085] e-6`. That set is what made long ozone paths magenta
  before env switched to the channel-integrated values (see Sky above).
  * At the S1 focus (62 km, sun −6.4°, grazing tangent ≈ 22 km, inside the ozone layer), vfx gets sun colour
    **(1.0, 0.35, 0.58)** (normalised), which reads salmon-pink.
  * Env's `ctx.lighting.sunColor` / `transmittanceCPU` at the same point is **(0.84, 0.68, 1.0)**, a white-lavender
    that matches the blue-white twilight jellyfish.
  * Fix: import `ATMO` from `render/env/atmosphere`, use `BO = ATMO.ozone`, and add the boundary-layer aerosol
    (`blExt`, `blH`). Or call the exported `transmittanceCPU(h, mu)` (48-step, soft horizon) and multiply
    it by the vfx Earth-shadow term.
* **VFX:** the long-lens view at twilight T+150 (`tw150_ll`) is grey, from plume haze. It is not the sky. The grey
  haze at the top of the T+151 morning chase is also plume or VFX.
* **Cameras:** to show the twilight band, frame the WSW horizon (az ~246, sun side, orange band) or the ENE
  horizon (Belt of Venus over the Earth shadow) for a few seconds at T+100..200 in the twilight preset. Current
  cameras look up at the rocket and never catch it.
* Env (open):
  * Toward the horizon, the open-cell holes in the 2D cloud layer read as similar-sized ovals. Improved in round 4:
    * The weather-map A channel (`gen_cloud_noise.py weather`) now has cell size varying ~2×, a per-cell
      clear-centre size and a ~1–2 cell fbm on the ramp, so holes differ in size and some close up.
    * R/G/B are byte-identical and there is no runtime cost. The march uses the same channel, so the hand-off
      still matches.
  * The LA core in the city lights is saturated. That is the Black Marble visualisation; the street pattern
    breaks it up only below ~300 m footprint.
  * In the `k60_side` twilight sky there is a faint dark-brown Earth-shadow smudge on the limb.
* App: `THREE.WebGLShadowMap: PCFSoftShadowMap has been removed` warning. This comes from `renderer.shadowMap.type` in
  App.ts (not env). Use `THREE.PCFShadowMap` (soft filtering is the default in r18x) to silence it.
* The cloud transmittance in `ctx.lighting.sunColor` is 1–2 frames late (async readback).
