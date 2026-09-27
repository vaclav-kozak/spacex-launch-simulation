# Look-dev notes / requests (owner: look-dev = `src/render/post/**` + `src/render/env/**`)

What changed in this pass is in `post.md` (Exposure section) and `env.md` (Sky / time of day,
`aerialEarthShadow`, `look.ts`). Screenshots: `shots/lookdev/before/` vs `shots/lookdev/after/`
(`_morning.jpg`, `_twilight.jpg`, `_night.jpg` = director at the 11 checkpoint seeks,
`_m_<tod>.jpg` = every camera mode / pad + long-lens preset).

## Requests to vfx (`src/render/vfx/**`)
1. **High-altitude sunlit plume (twilight T+110..200, "jellyfish").** It is now sunlit correctly, but the volume
   is a huge, uniformly bright, hard-edged cone (see `shots/lookdev/it4/jo150.png`, `jo185.png`). From the ground
   the long lens looks straight into it and gets a flat, structureless wall: log2 -4.8 salmon at T+146
   (`it4/j140.png`), log2 -2 beige at T+181 (`it4/j175.png`), 9-12 stops over the sky. A real jellyfish is a thin,
   translucent expanding shell: optical depth well below 1 through the middle and limb-brightened edges, with the
   dark-blue sky and stars showing through it. Suggestions: shell density (1/r² falloff plus a brighter rim),
   τ ≈ 0.1-0.3 through the centre, radiance ≈ sunColor × phase × τ (strong forward scattering toward the sun), and
   colour from the grazing sunlight (orange low, white/blue-white higher up).
2. **Earth shadow for custom-lit smoke:** any shader lit by `aerialSunColor()` should multiply by
   `aerialSunVisibility(rel)` (new in `AERIAL_GLSL`). `aerialSunColor()` is the sun at the *focus* body, so pad
   smoke/exhaust is otherwise sunlit at twilight while the rocket is high up.
3. **Plume-lit smoke at the pad is very bright:** 2^2..2^4.5 scene units, about 10x sunlit white paint. Auto
   exposure handles it (it now stops down at 24 EV/s), but the first ~0.7 s after ignition is still blown out and
   AgX turns it cream/beige. About 2 stops less radiance would read better. A more saturated plume-light colour
   (e.g. (1, 0.42, 0.12) instead of (1, 0.5, 0.2)) would help too: AgX desaturates bright orange toward cream.
   **Follow-up (pad launch-mount cam, T-2..+4):** plume-lit smoke measures 2^2..2^4.5, while sunlit white
   paint is 2^0.8. From night-launch photo exposures (EV100 ~14 on plume-lit smoke), I estimate
   ~2000-5000 cd/m² = **~2^-3..2^-1.5 scene units**, i.e. about 5 stops lower. At that level, daylight
   ignition smoke would read white (sunlit) with an orange base. The smoke-to-twilight-sky gap would drop from ~16 to ~11
   stops. Post now caps the daylight stop-down (pad/deck `dayCap`) so a morning sky stays blue. At twilight and night
   the black sky between smoke puffs is correct for this radiance, and only a lower smoke radiance can fix it.
4. Big blurry beige puffs right in front of the camera in the max-Q chase (still there with `clouds=0`), and the
   entry-burn/landing-burn blob scale (T+398 is a frame-filling starburst).

## Requests to models (`src/render/vehicles/pad.ts`)
1. **Pad floodlights at twilight.** They are night-only (`s.visible = this.night`). At the end of civil twilight
   they are on at real launches. Please enable them at twilight at roughly 0.1-0.2 of the night intensity
   (~2e3-3e3). With the new per-fragment Earth shadow the pad at twilight is lit only by the sky (ground ~2^-15.5,
   sky 2^-13.5); floods would put the vehicle ~4 stops over the sky, like the reference photos.

## Requests to cameras (`src/cameras/**`)
1. Twilight T+140..200: `long_lens:ground` has a narrow FOV and points into the plume wall above (flat frame).
   Until vfx item 1 lands, the director could prefer `pad:up` or a wider long-lens FOV for this window.
   `pad:up` at T+150 twilight now looks right: deep-blue sky with the orange high plume.
2. `SHIP:long_lens` at T+440 aims at a booster 580 km away (sub-pixel), so the frame is empty.

## FYI
* Screenshots that are exactly black or white (zero variance, no grain or vignette) are page reloads caused by
  concurrent HMR, not an exposure failure. Post output always carries dither, grain and vignette.
* Post and env read no new fields from `core`. New env→post data goes through `src/render/env/look.ts`.
