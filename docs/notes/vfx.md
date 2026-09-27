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
  them. Both are on LAYER_VFX. (round 4) Each of the two draws can hand its back range to a reduced-resolution
  pass: a screen-rect composite quad (renderOrder 9 / 29) renders those puffs from its `onBeforeRender` into a
  private RGBA16F target (nested render, like the plume low-res pass) and upsamples them depth-aware.

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
  above `PLUME_Q.fill = [0.6, 0.8, 0.95, off]` as a "far fill" (round 4; camera outside the proxy only: 1/`fillF`
  resolution, `fillSteps` x the march samples),
  and upsampled with a joint-bilateral composite (depth-aware). Particles: overdraw-driven reduced-resolution
  pass, `PS_LOWRES` (see round 4; live via `__app.vfx.ps.lowTune`, off via `__app.vfx.ps.lowResEnabled = false`). `PLUME_Q` / `MVAC_TUNE` are live-tunable
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
* (round 4) Rebuilt on a seek into the post-MECO window, see round 4.
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

## Changes, round 4 (shots: `shots/vfx4/before/`, `shots/vfx4/*.png` sanity pass, `shots/vfx4/{perf,rem,haze,rcs}/`)
**Particle overdraw (`particles.ts`, `PS_LOWRES`)**
* Per view, every drawn puff gets its clipped screen fraction (quad area / view area); summed per draw (far /
  near) that is the overdraw in screens (`__app.vfx.ps.diag`). Above `on = [2, 3, 4, off]` screens (x0.75
  hysteresis per camera) a draw keeps its nearest puffs up to `full = [0.6, 0.8, 1.2]` screens at full res and
  sends the contiguous back range (sorting stays exact) to a reduced-resolution pass: F = 2, 3 above
  `f3 = [4, 6, 8]`, 4 above `f4 = [12, 16, 24]` screens (x0.8 hysteresis). Needs >= 2 puffs and >= 1 screen.
* The low pass is the same shader (`VFX_LOWRES`: scene depth fetched at the texel's representative full-res
  pixel) into a cleared RGBA16F target with premultiplied "over", composited by a screen-rect quad (NDC bbox of
  the low puffs) right before the draw's full-res puffs: bilinear inside, 2x2 joint-bilateral at depth edges; a
  thin occluder in front of everything the low pass saw keeps the (background) puffs behind it.
* Decided from coverage only (no frame-time input), so it cannot oscillate with `QualityManager`.
* Puffs that engulf the camera (distance < max(0.35 size, 2 m)) are skipped: the VS faded them to 0 anyway
  but they still cost full-screen fragments.
**Plume "far fill" (`plume.ts`, `PLUME_Q.fill / fillF / fillSteps`)**
* A proxy covering > `fill = [0.6, 0.8, 0.95, off]` of the view with the camera outside it (the long lens
  looking up the plume from the ground) is marched at quarter res with 0.67x the samples (the cost there is
  sample-bound: scattered noise taps). The quarter-res composite interior uses a cubic B-spline (4 bilinear
  taps); a tent over 4x4 px blocks made the end-on flame visibly square. The quarter-res march uses a
  checkerboard dither (only a (pi, pi) term, <= 1/9 through the B-spline): IGN left a diagonal mesh, a 2x2
  Bayer an 8 px grid. It also samples more coherently than IGN, which is most of the speed-up.

**Remnant after a seek (`VFX.ts rebuildRemnant`)**
* A seek into MECO..MECO+20 s back-propagates S1 ballistically to MECO, builds a synthetic 9-engine MECO drive
  (throttle 5.6/9, `pressureAt`/`densityAt` at that altitude, attitude from the velocity), runs it through
  `plumeRem.setDrive` and captures the result, so `?seek=150&tod=twilight` shows the shell.
* The remnant's interior fill empties into the shell within ~1 s (`fill = exp(-age / 0.8)`); the shell has
  fine radial striations (one extra noise tap, remnant only).
**Twilight grey haze (`tw150_ll`, `mo151_chase`)**
* `tw150_ll` before SES1 (T+150..154.8): the S1 remnant shell, seen as a ~1 km patch by the long lens, was
  flat. Now striated. After SES1: the MVac far field. Its streamers now keep 80 % (was 50 %) of their
  contrast far downstream and have a wider range (0.4..1.6), so the end-on frame shows rays and billows.
  Shots: `shots/vfx4/haze/`.
* `mo151_chase` (T+155): the grey fan at the top was the stage-sep / engine-transient puffs from round 3.
  In thin air they are now smaller, faster and neutral grey (below), so only small sunlit wisps remain.
**RCS / event puffs in thin air (`emitters.ts`)**
* Vacuum RCS: narrow, fast N2 streaks (spread 0.3 + 0.12 vac, aspect up to 3.2, size up to 25 m, life x0.22,
  tau lower), twice the emission rate so a firing reads as a short continuous jet. Sep-pusher and
  engine-transient puffs expand and thin out ~2x faster in thin air, and transients in thin air
  (`thinAir > 0.5`) are neutral grey with no incandescence (no afterburning soot).
* The emit is back-dated (`ps.emitLag`): puffs spawned in substep i are advanced (n - i) h before drawing, so
  body-attached spawns now start at the body's position at that substep. Before, they sat up to one frame's
  travel (tens of m at 2 km/s) ahead of the vehicle. Lighting uses the corrected `sunRadianceAt` and Earth
  shadow at the spawn point: bright when sunlit, near-invisible in shadow.
**Twilight coast wide shot (`long_lens:twilight`, S1 tile T+148..162, ~200 km, ~100 m/px; `plume.ts PLUME_FAR`)**
* The three objects in that frame: the white lens is the S1 remnant, the orange "sausage" is the S1 *ascent
  trail* (particles emitted ~T+125..MECO at 40-65 km, lit by grazing sunlight reddened through the lower
  atmosphere; orange-red is physical there), and the small white triangle from T+155 is the MVac plume.
* The shells were tens-of-metres membranes (sub-pixel there), so they drew as hard, opaque cut-outs. Per view
  `uFar` (metres per pixel: MVac 25 -> 100, remnant 10 -> 60; 0 in every close / ground long-lens view) blends in
  a wider (x2.3 remnant, x2.6 MVac), fainter shell. For the remnant it also adds a faint translucent interior,
  a flatter-than-1/R^2 column so the outer bell glows, a taper reaching 1.5 L instead of cutting at ~0.5-1 L
  (it reads ~1.5x larger and soft), and half-contrast striations (at a few px they only aliased into hair).
  For the MVac it tapers the far end (was a flat cut at `MVAC_REACH`), makes the gas 30 % thinner and keeps
  a faint warm point at the head (glow sprite: violet core + ~1300 K nozzle extension). The proxy grows per
  view to hold the softer edge (`boundsBase`, radius x1.45 remnant / x1.8 MVac, remnant length x1.5).
  Tuning: `__app.vfx.plumeRem.farTune`. Shots: `shots/vfx4/dirtw/` (`base_*` before, `after_*`).
* Remnant drift / growth constants (`VFX.updateRemnant`: 0.35x MECO velocity + free fall, grow 1 + 0.11 age,
  REM_LIFE 20) are unchanged, so the copy in `cameras/util.ts` still matches. Only far views draw it longer
  (fading out to 1.5 L instead of ~L), so a framing that fits the far-view remnant can allow ~1.5x its length.
* `pad:up` T+6 "hard-edged smoke top": the water-tower tank. It occludes the cloud correctly but is unlit, so
  at twilight (sky exposed to black by the flame) its silhouette reads as a cut in the smoke. At night, where
  the tank is visible, the same frame is fine. This is models/env lighting (the tank gets no plume light), not
  VFX. Shots: `shots/vfx4/padup/{twilight,night}_6.png`.
**Fixes**
* Reduced-resolution targets were never cleared when the draw before the low pass left the colour mask off.
  `env.cloudsDepth` (renderOrder -99, `colorWrite: false`) is that draw for the far particle composite
  (renderOrder 9), so every frame piled onto the last: an opaque slab of old cloud filled the composite rect,
  with the wrong scale after an F change (pad wide T+5). Both low passes (particles, plume) now force the mask
  on before the clear, and the nested render no longer leaves `uViewH` at the low target's height.
* Green-flash on seek: `localIgn` was re-armed on every S1 engine that was already running at a seek (TEA-TEB
  green on the plume at T+145). Now it is armed only on an off-to-on edge (`prevEOn`), which is seeded on seek.

**Perf (q2, 1920x1080, RTX via ANGLE/D3D12, GPU ms of the VFX pass, median of 3; `old` = low-res particles off
and far fill off, i.e. round 3)**

| view | query / T | old | new |
|---|---|---|---|
| ll118 (worst) | `seek=112&tod=twilight&cam=S1:long_lens:ground`, 118 | 1.49 | 0.43 |
| ll125 | same, 125 | 1.22 | 0.43 |
| tw155 | `seek=150&tod=twilight&cam=S1:long_lens:ground`, 155.4 | 0.66 | 0.19 |
| dirtw158 | `seek=146&tod=twilight&cam=S1:long_lens:twilight`, 158 | 0.15 | 0.15 |
| padeng | `seek=-3&tod=night&cam=S1:pad:engine`, 2 | 0.38 | 0.38 |
| padwide | `seek=0&tod=twilight&cam=S1:pad:wide`, 5 | 0.38 | 0.26 |
| padup6 | `seek=0&tod=twilight&cam=S1:pad:up`, 6 | 0.41 | 0.41 |
| maxq | `seek=62&tod=morning&cam=S1:chase`, 66 | 0.18 | 0.17 |
| ch120 | `seek=116&cam=S1:chase`, 120 | 0.57 | 0.57 |
| deck | `seek=498&cam=SHIP:deck`, 505 | 0.53 | 0.44 |

The worst view is now ch120 at 0.57 ms, which is plume-bound (4 puffs). Low res changes nothing there.
`quality=auto` in ll118..137 holds level 2 with no oscillation both ways (frame time pinned at 16.7 ms by vsync;
the low-res switch never looks at frame time). Under 60 Hz vsync `QualityManager` can never reach its < 13 ms
raise threshold, so auto never goes to q3. That is expected there and is not a VFX issue.

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
7. (round 4, env) VFX occludes against `ctx.sceneDepth`, which has no clouds (`env.cloudsDepth` only writes
   the hardware depth, and VFX draws run with `depthTest` off once a scene depth exists). A cloud depth or
   transmittance texture would let far plumes sit behind low cumulus (twilight coast shot).

**models**
1. (round 3) MVac bell interior has no emissive: at night the MVac now only shows a faint core, so a dull
   hot-bell glow from the model would help.
2. (round 4) `pad:up` T+6 twilight: the water-tower tank is unlit (no plume point light / exposure), so it cuts a
   hard black silhouette out of the lit exhaust cloud. The occlusion is correct; the tank just needs light.

## Known remaining issues
* Particles and plumes ignore `env.cloudsDepth`: with a scene depth they occlude in the shader against
  `ctx.sceneDepth` (opaque only) and run with `depthTest` off, so low cumulus in front of a far plume (the
  twilight coast shot) does not hide it. Needs a cloud depth (or cloud transmittance) texture from env.
* Far twilight: the S1 ascent trail (40-65 km) is still a smooth orange tube, with no shell or filament
  structure. The remnant is softer and larger but still reads as a lens (its bell seen obliquely), not a
  full jellyfish dome.
* Rebuilt remnant after a seek is approximate (synthetic MECO drive from a ballistic back-propagation), so it
  can differ slightly from the one captured live.
* The quarter-res far fill keeps a faint (pi, pi) dither residue at 3-4x contrast boost; not visible normally.
* GTX 1650 estimate for the T+112..130 long lens at q2 is now ~2-3 ms (4-5x the perf table above).
