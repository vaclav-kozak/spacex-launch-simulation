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
  plume march steps `[16, 24, 36, 52]` (+ up to 0.6x for the fine flame sub-march; x0.72 when the warped
  march is active), condensation steps and the self-shadow grid. A plume proxy that covers more than
  `LOWRES_COVERAGE = [0.03, 0.1, 0.18, 0.4]` of the screen is marched at half resolution and upsampled
  with a joint-bilateral composite (depth-aware).

## Changes, polish pass 2 (screens: `shots/vfx2/before/*.png` vs `shots/vfx2/*.png`, iterations in `shots/vfx2/it/`)
**Plume (`plume.ts`)**
* Half-resolution march for large on-screen plumes (see Quality) with a joint-bilateral upsample. This keeps
  the frame-filling pad/landing/entry plumes affordable.
* Outer march is warped (`coneMarchT`): samples are uniform in s(a) = ∫da/R(a) of the expanding cone, so the
  thin root near the nozzle gets as many samples as the wide far field. Fixes the checker/mesh dither along
  the jet edge. Disabled in retro (entry/landing), where the flame sub-march covers the cushion.
* High-altitude "jellyfish" is a thin shell: limb-brightened membrane (shell term, shellK by expansion),
  faint interior fill that starts only downstream (0.04L..0.35L), radial streamers. τ through the middle is
  ≈0.05-0.2. The fill no longer fogs a camera sitting inside the bell (S1 chase at ~60 km).
* MVac plume starts at the nozzle exit plane (no haze over the bell on `S2:onboard_engine`); faint, bluish
  vacuum plume.
* Entry/landing retro cushion: bow-shock cushion length capped (`min(2.2 Lc, 30 m)`), turbulence weights
  retuned. No more frame-filling starburst at T+398.
* Flame edge wobble 0.38 → 0.14 (it produced regularly spaced horizontal bands on the side-on tower cam);
  flame turbulence stretched along the flow (7.5 R) and rotated off the noise lattice.
**Particles (`particles.ts`, `emitters.ts`)**
* Plume-lit smoke x0.04 with a saturated light colour (1, 0.42, 0.12): pad smoke is now ~2^-3..2^-0.6 scene
  units (look-dev target 2^-3..2^-1.5), sunlit smoke reads white with an orange base.
* Earth shadow: every puff is lit with `sunRadianceAt()` (CPU, per puff, Earth shadow + atmosphere
  extinction), the same as `aerialSunVisibility`. At twilight the pad smoke is in shadow while the vehicle is lit.
* Lighting: Lambert with soft terminator + diffuse transmission (`transD`) + silver lining keyed on optical
  depth; thin puffs blend by `exp(-1.5 τ)`. Near-camera fade (no more blurry beige puffs in the max-Q chase).
* Instance stride 24 with a per-puff elongation axis (`iAxis`), used for jet/sheet puffs.
* Pad emission rebalanced (trench 2.5, fire 14, radial 3); separation/MVac wisps removed; trail optical depth
  fades with altitude (26-62 km).
* Landing: steam life/buoyancy tuned so the deck clears in ~5-8 s after touchdown; linger emission stops at +10 s.
**VFX.ts**
* Heat-haze capsules faded per view (`fadeHazeForView`) by camera distance and depth. Post's haze degenerates
  when a capsule crosses the camera plane.

### Perf (RTX 5070 Ti, 1080p, VFX GPU time)
| view | q0 | q2 |
|---|---|---|
| pad engine cam T+0 | 0.62 ms | ~1.2 ms |
| ascent chase T+120 | – | 0.97 ms |
| twilight orbit T+130 | – | 1.0 ms |
GTX 1650 estimate (~4-5x slower): q0 ~2.5-3 ms, q2 4-6 ms. q2 is over the 3 ms budget on that GPU; use q0/q1 there.

## Contract requests
**cameras (`src/cameras/**`)**
1. `S1:chase` above ~50 km sits inside the expanded plume (bell radius > chase offset). The frame then shows
   the plume from the inside. A larger offset or a side-on offset after T+120 would frame the jellyfish shell.
2. `long_lens:ground` at T+140..200 (FOV 0.43° / 0.12°) frames only the inside of the bell: a flat, structureless
   frame (plume only +1..+3 stops over the sky). A wider FOV (~2-4°) for this window would show the shell and limb.

**look-dev (`src/render/post/**`, `src/render/env/**`)**
1. Lens ghost: an orange disc with a dark hole near the nose in chase/ascent views (also max-Q, `sep_ch`). It
   is post's ghost of the plume, not VFX.
2. "Leopard-spot" cloud layer from ~60 km (`ent_ob`, `ent_ch`): regular dotted pattern in the cloud deck.
3. Post heat haze degenerates for capsules that cross the camera plane. VFX now fades those capsules per view;
   a near-plane clip in post would be the real fix.
4. `pad:up` at T+3 sits inside the plume glow (camera problem too).
5. The salmon twilight long-lens frame at T+145 is the sky itself. The plume adds only ~+1 stop there.

## Known remaining issues
* Post-MECO the high-altitude jellyfish remnant vanishes almost at once (trail optical depth at altitude
  is ~0). A slowly expanding, fading shell after MECO is missing.
* `pad:up` twilight: the high plume/trail is a soft orange blob without shell structure.
* Night pad smoke peaks at ~2^-0.6, up to ~1 stop over the look-dev target.
