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
  Lights that sit below a stacked fairing (S1 main flame / impact flash while S2 is stacked, MVac) also get
  `distance <= 0.93 * |light - fairing base ring|`: an unshadowed point light otherwise lit the aft-facing
  fairing base ring (orange crescent near the nose in the max-Q chase). The ring is ~57 m above the S1 exits,
  so pad/deck lighting (all within ~50 m) is unchanged.
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
  plume march steps `PLUME_Q.march = [16, 24, 36, 52]` (+ up to 0.6x for the fine flame sub-march; x0.72 when
  the warped march is active), MVac samples `PLUME_Q.vac = [10, 14, 20, 28]`, condensation steps and the
  self-shadow grid. A plume proxy that covers more than `PLUME_Q.lowres = [0.03, 0.1, 0.18, 0.4]` of the
  screen is marched at half resolution, above `PLUME_Q.third = [0.15, 0.3, 0.45, off]` at third resolution,
  and upsampled with a joint-bilateral composite (depth-aware). `PLUME_Q` / `MVAC_TUNE` are live-tunable
  from the console via `__app.vfx.plumeS1.qTune` / `__app.vfx.plumeS2.vacTune`.

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
  when a capsule crosses the camera plane. (Round 3: the depth fade is removed, post clips at the near plane.)

### Perf (RTX 5070 Ti, 1080p, VFX GPU time)
| view | q0 | q2 |
|---|---|---|
| pad engine cam T+0 | 0.62 ms | ~1.2 ms |
| ascent chase T+120 | – | 0.97 ms |
| twilight orbit T+130 | – | 1.0 ms |
GTX 1650 estimate (~4-5x slower): q0 ~2.5-3 ms, q2 4-6 ms. q2 is over the 3 ms budget on that GPU; use q0/q1 there.

## Changes, round 3 (before: `shots/vfx3/before/`, `shots/vfx3/light_before/`; after: `shots/vfx3/after/`, `shots/vfx3/light_after/`, `shots/vfx3/after_rem/`, `shots/vfx3/sunfix/`, `shots/vfx3/perf/`)
**MVac vacuum plume (`plume.ts`, `PLUME_MVAC` path)** — new model, own march (`vacMarch`).
* Density `K F(θ,R) cond(R) / (R² + R0²)` around a virtual source on the axis (Simons source flow). F: faint
  core (half-width 0.3 rad), a brighter boundary shell at θB = 0.4 rad (half-width 0.06, builds up over
  ~25 m), weak fill and wings, flow-aligned streamers. `cond(R)`: nothing within ~R0 = 8 m of the exit (not
  condensed yet, so the bell stays clear), then a far-field condensate gain (x20 over 1.5 km), fade over 2.5 km.
* Equi-angular sampling about the source (σ dt = K F dφ / B): 10-28 samples resolve the 4 km proxy.
* Sunlit with a weak forward phase (HG 0.35 mixed 50/50 with isotropic: sub-micron condensate), plus sky
  ambient. Near-camera thinning (`smoothstep(0.12 Dn, 0.5 Dn, t)`) so the onboard/chase camera does not sit in fog.
* Emissive exit core is small and faint (0.01, e-folding 1.6 m, colour (0.42, 0.5, 1)); night therefore shows
  only a faint bluish core, twilight a blue-white sunlit jellyfish, day a pale translucent cone.
* Tunables: `MVAC_TUNE` (exported; live via `__app.vfx.plumeS2.vacTune`).
**S1 post-MECO jellyfish remnant (`VFX.ts updateRemnant`, `plume.ts setRemnant`)**
* At MECO a third plume instance (`plumeRem`) takes a copy of the S1 shell (no cores / flame / inner jet).
  It drifts with 0.35x the vehicle velocity (gas braked by the thin air) + gravity, grows `1 + 0.11 age`,
  lets go of the (departed) nozzle, and fades over `REM_LIFE = 20 s`. Lit with `sunRadianceAt` at its position.
* It is not rebuilt after a seek into the post-MECO window (needs the pre-MECO shell).
**Sun colour at altitude (`common.ts sunRadianceAt`)**
* Now uses env's `ATMO` constants (Rayleigh, 3-band ozone tent, Mie + boundary layer, `sunE`), so CPU puff
  and plume sun colour matches env's transmittance. The old single-wavelength ozone gave salmon (1, 0.35, 0.58)
  at twilight T+140; it now gives the env's blue-white. Soft Earth-shadow penumbra kept.
**Particles**
* Daylight steam / smoke white balance: the sun term is pulled toward its luminance by up to 70% when the sun
  is up (`wb`), dense puffs a further 30%, so morning landing steam is neutral white-grey; warm tints stay with
  a low / setting sun and with the flame light. Landing fire puffs are neutral grey albedo (0.46/0.45/0.44);
  landing steam glows only 15% of the time (emis 4), so it is orange only near the flame and mostly at night.
* Plume light on smoke softened (`d² + 0.35 size² + 30`), gain 0.028: night pad smoke on the engine cam at
  T+2 is p10/p50/p90 = 2^-2.9 / 2^-2.0 / 2^-1.5 scene units (target 2^-3..2^-1.5). Wide cam p90 2^-1.6..2^-4.3.
**Perf**
* Third-resolution march for proxies that fill the view (`PLUME_Q.third`), same joint-bilateral composite
  (`uLowF` = 2 or 3). No visible difference in the pad-engine, max-Q, chase and long-lens shots (`shots/vfx3/perf/half` vs `third`).
* The MVac path is much cheaper than the old Merlin-style march it replaced (10-28 importance samples).

### Perf, round 3 (RTX 5070 Ti, 1920x1080, VFX GPU ms = scene pass with VFX minus without, paused frame, median of 5)
| view | q2 before (half-res only) | q2 after | q0 before | q0 after |
|---|---|---|---|---|
| pad engine T+2 night | 0.25 | 0.16 | 0.09 | 0.09 |
| pad wide T+5 twilight | 0.43 | 0.33 | 0.14 | 0.10 |
| max-Q chase T+72 | 0.31 | 0.20 | 0.11 | 0.05 |
| chase T+120 | 1.03 | 0.53 | 0.33 | 0.26 |
| long lens ground T+130 twilight (worst) | 2.51 | 1.56 | 0.68 | 0.47 |
| S2 chase T+196 | 0.13 | 0.07 | 0.12 | 0.06 |
| S2 onboard engine T+460 | ~0 | ~0 | ~0 | ~0 |
| deck T+505 | 0.45 | 0.45 | noise | noise |
Round-2 method (vfxperf, running sim) for reference: chase T+120 1.56, onboard MVac T+460 1.37 ms at q2.
GTX 1650 estimate (4-5x): q2 worst case (T+130 long lens) ~6-8 ms, of which particles ~2.5-3 ms (1377 large,
overlapping expanded trail puffs seen end-on); other views <= ~2.5 ms. q0 <= ~2.3 ms everywhere.

## Contract requests
**cameras (`src/cameras/**`)**
1. `S1:chase` above ~50 km sits inside the expanded plume (bell radius > chase offset). The frame then shows
   the plume from the inside. A larger offset or a side-on offset after T+120 would frame the jellyfish shell.
2. `long_lens:ground` at T+140..200 (FOV 0.43° / 0.12°) frames only the inside of the bell: a flat, structureless
   frame (plume only +1..+3 stops over the sky). A wider FOV (~2-4°) for this window would show the shell and limb.

3. (round 3) The post-MECO remnant jellyfish is best seen wide from the ground or the ship at T+147..170
   twilight (a slowly growing, fading sunlit shell). The S1 chase leaves it within ~3 s. A wide ground/ship shot
   in that window would show it.
4. (round 3) `pad:up` does not frame the vehicle after ~T+10; `long_lens` FOV is too narrow for the MVac far field
   (the frame fills with the km-scale streamers).

**look-dev (`src/render/post/**`, `src/render/env/**`)**
1. (fixed in round 3, it was VFX) The orange crescent near the nose was the unshadowed plume point light on the
   fairing base ring, not a lens ghost.
2. "Leopard-spot" cloud layer from ~60 km (`ent_ob`, `ent_ch`): regular dotted pattern in the cloud deck.
3. (done by post) near-plane haze clip; VFX dropped its depth fade.
4. `pad:up` at T+3 sits inside the plume glow (camera problem too).
5. (fixed in round 3, it was VFX) The salmon twilight long-lens frame at T+140..145 came from
   `sunRadianceAt`'s old ozone.
6. (round 3) A small green dot / rim near the vehicle at T+140 twilight long lens looks like a post ghost.

**models**
1. (round 3) MVac bell interior has no emissive: at night the MVac now only shows a faint core, so a dull
   hot-bell glow from the model would help.

## Known remaining issues
* Remnant is not rebuilt after a seek into T+MECO..MECO+20 (needs the pre-MECO shell).
* Twilight S1 orbit view: pink, clumpy RCS / engine-transient puffs near S1 after MECO.
* `pad:up` twilight: the high plume/trail is a soft orange blob without shell structure.
* Perf: T+112..129 long-lens (plume seen end-on from the ground) is still ~6-8 ms on a GTX 1650 at q2, about
  40% of it particle overdraw. Next steps if needed: low-res particle pass for large far puffs, or a lower
  particle cap at q2.
