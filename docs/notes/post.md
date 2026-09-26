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
  `dof { enabled, autoFocus, focusDistance (m), fStop }`, `debug` (`depth|bloom|exposure|haze|dirt|flare`).
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
4. Optional DOF, then a 6-level 13-tap bloom (Karis on the first level), a histogram (center-weighted)
   and 1x1 temporal adaptation.
5. Screen-space ghosts, then composite: heat haze, long-lens shimmer, camera motion blur, bloom + lens
   dirt, sun glare/ghosts/star, AgX, sRGB and dither.
6. SMAA, then the final pass to the canvas: barrel distortion, chromatic aberration, sharpen, look,
   vignette, grain and `view.alpha`.

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
  `exposureBias`.
* Lens profiles by `view.mode`: `long_lens` (low vignette, crisp, slight shimmer), `pad`, `onboard_down`,
  `onboard_engine` (strong vignette, barrel distortion, CA, soft, noisy, dirty), `deck` (wide, wet dirt),
  everything else gets the "cine" profile.

## Performance (1080p, RTX 5070 Ti via ANGLE/D3D12; timer queries are noisy on this stack)
Post costs about 0.5 ms at q0 and 0.8-1.1 ms at q2/q3 for a single view, and about 1.8 ms for 4 split
views (they share the pool, so the per-view cost scales with pixels). Photo-mode DOF adds about 3 ms.
A GTX-1650-class GPU is roughly 5-6x slower, so the auto quality (q1 @0.75 scale) should keep post
around 2-3 ms there.

## Requests
* **cameras: double fade.** Post blends each view with `view.alpha` (a true cross-dissolve over whatever is
  beneath it, or black canvas). The `.camvp-fade` black div also darkens by `1 - alpha`, so the result is
  `alpha²` and PiPs fade through black instead of dissolving. Pick one: drop the div's opacity, or
  set `PostPipeline.settings.viewAlpha = false` (post then draws opaque and the div does the fade).
* App / Quality: nothing required. Photo mode already bumps post to q3 internally.
* vfx: `uViewH` (see above) and `layers.enable(LAYER_VFX)` on any three lights that lit VFX materials rely on.
