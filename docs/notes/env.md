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

## Clouds (`clouds.ts`, `cloudWeather.ts`)
* Volumetric clouds are a coastal marine stratocumulus deck, roughly 0.6–1.5 km thick near the coast.
  The deck burns off a few km inland and breaks up offshore, and scattered cumulus (tops up to ~3.4 km)
  lie further out. The shell is `CLOUD_SHELL = {bottom: 560, top: 3400}` m.
  Above ~60 km camera altitude, or beyond `clouds.maxDist`, the globe draws a matching 2D layer from the same weather
  model.
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
  is ~2–4 ms on a GTX 1650. Quality levels 0..3 change the steps (24/32/44/60), resolution (¼ at q0, ½ otherwise),
  shadow map size (256/384/512/1024) and distance.

## Terrain / ocean layering
* The terrain meshes (T1 40 km, T2 400 km, both from DEM) are drawn first. The Earth surface shader draws the sea
  everywhere inside the T2 box, and terrain occludes it where land is above sea level. Offshore DEM is ≤ −4 m (see
  docs/assets/env.md, `coast` step).

## Known issues / requests
* City lights (`earth_night_reg.jpg`, 2048² over 24x24 deg = 1.3 km/px from the 3 km Black Marble) read as
  a smooth golden glow from altitude (LA basin at T+150 night looks like sunlit cloud). A 500 m Black
  Marble crop of the SoCal coast would fix it (asset task).
* App: `THREE.WebGLShadowMap: PCFSoftShadowMap has been removed` warning. This comes from `renderer.shadowMap.type` in
  App.ts (not env). Use `THREE.PCFShadowMap` (soft filtering is the default in r18x) to silence it.
* The cloud transmittance in `ctx.lighting.sunColor` is 1–2 frames late (async readback).
