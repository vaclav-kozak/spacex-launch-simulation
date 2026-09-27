# Post notes / contract requests (owner: post, `src/render/post/**`)

## Public API (App.ts contract, unchanged)
`new PostPipeline(ctx)` per viewport, `render(view)` draws the view into `view.rect` (CSS px, top-left
origin) on the default framebuffer, `dispose()`. All render targets live in a per-renderer pool
(`PostShared`, refcounted) shared by every viewport; per-view state is only the 1x1 exposure
(persisted per PostPipeline = per `view.id`) and the previous camera for motion blur.

Extras:
* `PostPipeline.settings` (= `postSettings` from `PostSettings.ts`), shared by all views; photo-mode UI can write
  it directly: `exposureBias` (EV, added to `ctx.lighting.exposureBias`), `autoExposure` / `manualEV`,
  `toneMapper` `'agx' | 'aces' | 'neutral'`, `bloom`, `dirt`, `flares`, `flareStrength`, `grain`, `vignette`,
  `chromaticAberration`, `motionBlur`, `heatHaze`, `shimmer`, `lensDistortion`,
  `dof { enabled, autoFocus, focusDistance (m), fStop }`, `debug` (`depth|bloom|exposure|haze|dirt|flare`; `flare` = lens-ghost layer x8).
* Instance helpers: `setExposureBias(ev)`, `setToneMapper(t)`, `setGrain(on|k)`, `setVignette(on|k)`,
  `setFlares(on)`, `setMotionBlur(on)`, `setDOF(partial)`, `resetExposure()`, `readExposure()` (debug, sync readback).
* `PostPipeline.profiler` (assign a `GpuTimer` from `GpuTimer.ts`) gives GPU ms for 'scene' and 'post',
  summed over viewports. `PostPipeline.profileDetail = true` splits 'post' into bloom/meter/comp/smaa/final.
* `ctx.photoMode` forces quality 3 at render scale 1, turns motion blur off and freezes the grain. DOF only runs
  when `settings.dof.enabled` is set. Its circle of confusion is physically based on a full-frame sensor,
  so wide shots stay sharp and you only see blur with close focus or a long lens.

## Per-view pipeline
1. Opaque `LAYER_DEFAULT` goes into the HDR target (HalfFloat, plus 4x MSAA on quality 3). It clears
   to `scene.background` when that is a Color, otherwise to black.
2. The depth is linearized to view-space metres (R32F) and published as `ctx.sceneDepth`.
3. `LAYER_VFX` renders into the same target with the depth buffer bound. `ctx.sceneDepth.texture` is
   reset to null afterwards, and `scene.background`, the shadow map and the matrix auto-update are
   suspended for that pass.
4. Optional DOF, then a 6-level 13-tap bloom (Karis on the first level, soft knee at `bloomKnee` exposed
   units with a log tail), a 64-bin x 8-row histogram (+ a 65th subject-statistics column) of a ~64 px
   mip, and 1x1 temporal adaptation (see Exposure).
5. Lens-ghost source statistics (see Lens ghosts), then composite: heat haze, long-lens shimmer, camera motion
   blur, mesopic night look, exposure, local highlight compression, bloom + lens dirt, lens ghosts, sun
   glare/ghosts/star, AgX, sRGB and dither.
6. SMAA (q1+), then the final pass to the canvas: barrel distortion, chromatic aberration (q1+), sharpen,
   look, vignette, grain and `view.alpha`.

## Exposure (look-dev pass, settings in `PostSettings.meter` + per camera type in `PostPipeline` METERS)
Scene-referred units stay physical: twilight sky ~2^-13.5, moon-lit ground ~2^-11 (with env's night gain),
sunlit white ~2^1, plume-lit smoke at the pad 2^2..2^4.5, plume core 2^6+. Post does all the "camera":
* **Metering** = weighted mean of the log-luminance histogram between the 40th and 82nd percentile
  (dark voids and highlights rejected), centre-weighted (`center`), sky weighted `skyW`, geometry near the
  subject depth weighted `subjW`. Highlight guard: the 97th percentile may sit at most 9 stops over.
* **Subject constraint** (non-onboard cams): if >1.5..6 % of the central frame is at the subject depth,
  its mean may sit at most `subjectHeadroom` (1.5) + per-camera `subjHead` stops over the metered level
  (pad +1, deck +0.5, long lens +1.5). A white sunlit vehicle then lands ~2 stops over mid-grey and a dark
  background (space, dusk sky) goes dark instead of blowing the vehicle out.
* **Subject depth** = nearest depth around the frame centre, replaced by the tracked body's distance
  (`envLook.focusDist`, published by env) when they disagree by >4x (pad cam looking past the tower).
* **Key compensation:** metered level maps to `key` 0.18 in bright scenes and falls to `keyDark` 0.032
  for Ln <= -12 (twilight/night stay dark instead of being lifted to grey). At night (`envLook.night`) the
  key drops up to `nightKeyStops` more (Ln -8..-14), so empty moon-lit skies read dark.
* **EV clamps** per camera type (`minEV/maxEV` offsets on `minLum/maxLum`).
* **Onboard cams are near-fixed exposure** (`Meter.anchor`), like a webcast camera set up for the
  sunlit Earth. The window sits around `DAY_CARD_LOG` (18 % card under the unshadowed sun = log2 -1.82) + -1.8
  and replaces the EV clamp:
  * `onboard_engine`: may open up 0.5 stop and stop down 1.5. The MVac glow (0.35) stays orange rather than
    turning peach. After SECO the unlit bell goes dark (Earthshine) or sunlit grey; at night it goes black.
  * `onboard_down`: opens up to 8 stops (twilight ocean faint navy, moon-lit clouds dim) and stops down 2.
* **Daylight stop-down cap for pad / deck cams** (`Meter.dayCap` = 2): the metered level may sit at most
  2 stops above the incident-light prior (sun + sky gray card at the focus). It fades in with the focus
  `sunVisibility` 0.2..0.8. Plume-lit smoke filling the frame then clips a little instead of dragging a
  morning sky to navy. At twilight and night the cap is off.
* **Adaptation:** exponential (`speedUp` 3.5/s brighter, `speedDown` 1/s darker) with slew limits
  (24 EV/s stopping down at ignition, 4 EV/s opening up). A camera cut adapts 4x faster for 0.7 s.
* **Local highlight compression** (`highlightCompress`, `compressStart` 4 stops over key, range 3.5 stops in
  dark scenes .. 7 in bright): pixels far over the metered level get an exponential shoulder driven by
  min(own, wide-blur + 0.5) log luminance (blur = bloom up-chain level 2), so a night plume or plume-lit
  smoke keeps structure without halos, and daylight is untouched.
* **Night look** (`nightLook` 0.65 x `envLook.night`): dim scene regions (log2 lum -10 .. -4.5) lose colour
  toward a rod-weighted luminance with a slight blue shift (Purkinje). Flood-/plume-lit areas keep colour.
* The adaptation texture is per view (split views meter independently); the histogram target is pooled,
  so `readExposure()` is the per-view debug readout, not the histogram.

## Lens ghosts (round 3; replaces the screen-space ghost pass)
The old pass mirrored the whole bright image through the centre. A big plume came back as an orange disc
several hundred px wide, and its dark core showed as a hole. Now the ghosts are analytic:
* `GHOST_COLS_FRAG` + `GHOST_REDUCE_FRAG` (`shaders/passes.ts`) reduce the first bloom level with width ≤ 128
  to a 2x1 float texture: exposed flux F above `GHOST.threshold` (4 exposed units), its flux-weighted centroid,
  RMS spread σ (uv-y units, aspect-corrected) and mean colour. That is 2 tiny passes.
* The composite (`lensGhosts()`) draws 5 ghosts along the line through the optical centre, at
  centroid x {-0.42, -0.86, 0.38, -1.32, -0.16}. Each is a defocused aperture image (hex/round blend, filled
  discs or thin rings) with a radius proportional to the source spread (0.2–0.75 σ√2, min 0.002). They are faint
  coating tints (green/violet/amber/blue/warm) mixed 55% toward the source colour. Brightness is reflectance ×
  flux / ghost area, soft-capped at `GHOST.cap`, so a small source gives small, brighter ghosts. None has a dark
  centre.
* **Broad sources get no ghosts:** they fade out as σ goes from `spread0` 0.03 to `spread1` 0.075. This covers
  the chase plume at max-Q, the S2 chase plume (σ ~0.09) and the pad floodlight fields. Compact night
  plumes / engine glows get faint rings. The sun is masked out of the statistics (it has its own analytic ghosts).
* Gain `GHOST.gain` 1.2e-3 × `flareStrength` × lens profile `flare`. `debug=flare` shows the ghost layer x8.
* **Round 4: a ghost fades out when it would overlap its source.** Take the source at centroid distance `cl` from
  the centre. Ghost i then sits `cl·|1−K_i|` away from it. Ghosts fade in (smoothstep) between 0.12 + 2 r and
  0.32 + 3 r (frame-height units, r = source radius). Otherwise a centred source (the long lens at T+140,
  `pad:up`) puts the K −0.16/0.38 ghosts right on top of itself. That gave the green dot / rim around the vehicle
  and the green disc plus pink ring over the pad smoke. Off-centre sources still ghost as before.
  Shots: `shots/r4c/gh_tw_{136,140,143}.png`, `ghdbg_tw_*` (debug=flare).
* **The orange crescent near the nose (max-Q chase, twilight/night; `shots/pc3/after/tw_mq.png`,
  `ni_mq.png`) is not a post ghost.** It stays with ghosts off and goes away when the VFX plume PointLights are
  hidden. It is the fairing base annulus (r 1.83–2.6 m, facing aft) lit by the **unshadowed** plume point light
  ~70 m below it. The S1/S2 body should shadow it completely. Request to **vfx/models** below.

## Heat haze near clip (round 3)
`projectHaze` clips each capsule to the part whose axis lies at least one local radius (and 1.5x near) in front of
the camera. Both constraints are linear along the segment. Before, a capsule reaching past the camera plane was cut
at 1.5x near and projected to a screen-filling capsule. Its noise cell size (∝ projected radius) was then a
few huge swirls. The composite now interpolates depth and world radius perspective-correctly (1/z linear in screen
space; projected radius is already linear). It caps the turbulence cell and displacement radius at 0.12 uv-y, and
takes the strength at each clipped end from `uHazeC.x/.w` (1 → 0.45 along the capsule). The flow is a constant 2.2
radii/s. Test: `post-test.html?modes=onboard_engine&debug=haze` (camera beside the plume looking down it,
`shots/pc3/haze/before_dbg.png` vs `after_dbg.png`). **vfx:** `fadeHazeForView`'s depth fade for capsules crossing
the camera plane is no longer needed. Keep the distance fade if you like it.

## Contracts for other areas (please read)
* **`ctx.sceneDepth.resolution` is the pool texture size, not the viewport size** (the pool is shared by
  all views and only grows). Use `gl_FragCoord.xy / resolution` (or `texelFetch(ivec2(gl_FragCoord.xy))`)
  for UVs, as the contract says. **vfx:** `vfxShared.uViewH = uSceneRes.y` is therefore wrong for PiPs and
  split views; use the current viewport height instead: `renderer.getCurrentViewport(_v4).w` inside
  `onBeforeRender`.
* Depth values are linear view depth in metres (= -viewZ). Sky / no geometry reads about `camera.far`.
  The texture is R32F with NearestFilter, so sample it with `texture2D` at exact texel UVs or use `texelFetch`.
* `renderer.logarithmicDepthBuffer` is on: every custom opaque/VFX ShaderMaterial must include
  `<logdepthbuf_pars_vertex/fragment>` + `<logdepthbuf_vertex/fragment>` or its depth is wrong.
* Keep `renderer.toneMapping = NoToneMapping`. Materials output linear HDR radiance in the lighting units of
  `core/context.ts` (sun ~6, sky 1-2, plume core 60-150, night ~0.01). Post does exposure + tone mapping.
* **Lights and layers:** three.js culls lights by layer too. During the VFX pass the camera only sees
  `LAYER_VFX`, so a lit VFX material (e.g. MeshStandard smoke) gets no light unless the light has
  `light.layers.enable(LAYER_VFX)`. The same applies to plume PointLights that should light smoke.
* `ctx.hazeSources` must be **W positions**. A common bug is computing them from `object.matrixWorld`,
  which includes the floating-origin `worldRoot` offset of whichever view rendered last. Use sim state
  or add `ctx.renderOrigin` back. Post projects up to 2/3/4 sources (by quality) per view, sorted by
  strength × screen size. Only geometry behind the gas is distorted.
* ViewInfo fields used: `rect`, `alpha`, `camera`, `camWorldPos`, `mode` (lens profile), `onboard`
  (onboard look, subject-depth override), `shimmer` (long-lens shimmer 0..1), `focus`/`mode` changes (cut
  detection → fast exposure re-meter + no motion blur on that frame). `shake` is not used separately: real
  camera rotation already produces motion blur.
* Lighting fields used: `sunDir` (sun disc position), `sunColor` + `skyColor` (gray-card exposure prior
  for mostly-black frames like space/night sky), `sunVisibility` (sun glare/star/ghost gate),
  `exposureBias`. From env directly: `envLook` (`src/render/env/look.ts`): `night` (0..1) and
  `focusDist` (per view id).
* Lens profiles by `view.mode`: `long_lens` (low vignette, crisp, slight shimmer), `pad`, `onboard_down`,
  `onboard_engine` (strong vignette, barrel distortion, CA, soft, noisy, dirty), `deck` (wide, wet dirt),
  everything else gets the "cine" profile.

## Performance (RTX 5070 Ti via ANGLE/D3D12; timer queries are noisy on this stack)
GpuTimer 'post' reads 0.4-0.7 ms per view at q2 (1440x832 internal), but most of that is per-pass
overhead: synced micro-benchmarks give composite ~0.05 ms, histogram + adaptation ~0.006 ms each; a whole
`render()` with the scene hidden costs ~0.44 ms wall (q2) / ~0.35 ms (q0), CPU-submission bound (~20 passes).
q0 now skips SMAA (3 full-res passes) and the CA taps, and runs 5 bloom levels, no flares, no motion blur.
A GTX-1650-class GPU is ~6x slower in fill rate: expect ~1-1.5 ms post at q1/q2 1080p, well under 3 ms.
Photo-mode DOF adds about 3 ms.

## Requests
* **cameras: double fade.** Post blends each view with `view.alpha` (a true cross-dissolve over whatever is
  beneath it, or black canvas). The `.camvp-fade` black div also darkens by `1 - alpha`, so the result is
  `alpha²` and PiPs fade through black instead of dissolving. Pick one: drop the div's opacity, or
  set `PostPipeline.settings.viewAlpha = false` (post then draws opaque and the div does the fade).
* App / Quality: nothing required. Photo mode already bumps post to q3 internally.
* vfx: `uViewH` (see above) and `layers.enable(LAYER_VFX)` on any three lights that lit VFX materials rely on.
* **vfx / models (round 3): plume light leaks through the vehicle.** The top plume PointLight (main flame) is
  unshadowed. It lights aft-facing surfaces above the engines: the fairing base annulus shows as a bright orange
  crescent at the nose in every chase at twilight/night (max-Q, T+130). Options: (a) vfx: light the vehicle with a
  shadow-casting light for the main flame only (one cube or a 90° spot shadow looking up the stack; the stack is
  thin, so a 512² map is enough); (b) models: an analytic occlusion term in the vehicle materials for plume lights
  (cylinder of r 1.83 m along the stage axis between the light and the fragment: attenuate when the segment
  passes within the body radius). (b) is cheap and exact for the stack.
