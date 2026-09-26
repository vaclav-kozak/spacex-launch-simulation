# VFX notes / contract requests (owner: vfx, `src/render/vfx/**`)

## Public API (unchanged)
`new VFX(ctx)`, `await load()`, `update(snap, dt)`, `beforeViewRender(view, snap)`.
Everything VFX draws is on `LAYER_VFX` (1) under one root group. Nothing else is required from App.ts.

What VFX writes into ctx every `update()`:
* `ctx.plumeLights` holds up to 4 `{pos (true W), color * intensity, range}`, sorted by intensity. They cover
  the main flame, the pad/deck impact flash, trench-mouth fire, MVac, the TEA-TEB green flash and the landed
  smoulder. Intensity is in "W/sr-like" scene units: irradiance at d is roughly `color / d^2` (sun ~6).
* Three real `THREE.PointLight`s (decay 2, `distance = sqrt(I/0.004)` capped at 4 km) mirror the top 3
  candidates. They light the vehicle, pad and deck. **Both layers 0 and 1 are enabled** on them.
* `ctx.hazeSources` holds plume heat-haze capsules in true W positions (not floating-origin shifted):
  S1/S2 near-field plume (strength ~ sqrt(rho/rho0), reduced in retro) and the pad trench-mouth column.

## Rendering assumptions
* Post renders `LAYER_VFX` after the scene-depth copy. VFX samples `ctx.sceneDepth.texture` (R32F linear view
  depth) at `gl_FragCoord.xy / ctx.sceneDepth.resolution` (resolution is the POOL size). Pixel-size math uses
  the real viewport from `renderer.getCurrentViewport()`. Without a depth texture, materials fall back to
  depthTest.
* All VFX shaders include the log-depth chunks, never tone map, and write premultiplied radiance
  (blend ONE / ONE_MINUS_SRC_ALPHA) in the same linear units as the scene (sun ~6, sky 1-2, plume core 60-190).
* Aerial perspective: `AERIAL_GLSL` from `render/env/aerial` is used in the particle **vertex** shader (per
  puff) and in the plume/condensation fragment shaders. Emission is multiplied by `aerialTransmittance`;
  alpha parts also add `aerialInscatter * alpha`.
* Plume proxy: a frustum in a mirrored local frame (plume axis = -Y), so the triangle winding is flipped.
  With scene depth, or when the camera is inside the proxy, the mesh draws `FrontSide` (the far faces, after
  the mirror) with depthTest off. Otherwise it draws `BackSide` with depthTest on. Do not "fix" the side
  flag without accounting for the mirror.
* Particles: `ParticleSystem.mesh` holds the far puffs (renderOrder 10). Child `meshNear` (renderOrder 30)
  holds the puffs nearer to the camera than the plume axis, so plumes (renderOrder 20, glow 21) composite between
  them. Both are on LAYER_VFX.

## Coordination
* Pad flame trench: `PAD_TRENCH_AZIMUTH_DEG = 200` (deg from N, clockwise), exit 42 m from the mount,
  9 m deep (`src/render/vfx/emitters.ts`). **models**: please keep the pad trench / flame deflector
  on this heading, or tell vfx the real value.
* Droneship deck: deck frame from `snap.bodies.SHIP` pose; half-extents come from `F9`/constants in emitters
  (`deckFrame`, `OCISLY.deckWidth/deckLength`). Particles collide with the deck plane (`P_DECK`) and with sea level (`P_OCEAN`).
* Seek / replay / restart: VFX detects time jumps (sim time moving backwards, or more than 3x the expected dt + 0.5 s) and pre-warms the particles.
  It re-simulates the pad cloud, trail and landing steam in coarse steps up to the new time, so a seek
  looks like continuous playback, apart from particle randomness.
* Quality: `ctx.quality.level` 0..3 scales the particle cap `[1400, 2400, 3600, 5000]`, the emission rate,
  plume march steps `[16, 24, 36, 52]` (+ up to 0.6x for the fine flame sub-march), condensation steps and
  the self-shadow grid.

## Contract requests
None open.
