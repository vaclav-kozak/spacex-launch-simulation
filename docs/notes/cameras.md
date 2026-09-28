# Cameras notes / contract requests (owner: cameras, `src/cameras/**`)

## Public API (App.ts contract, unchanged)
`new ViewportManager(ctx, domRoot)`, `views: ViewInfo[]`, `update(snap, dtReal)`, `primaryView()`,
`applyUrlParams(params)`, `command(cmd)`. Extra: `modesFor(viewId): CameraMode[]` (mode buttons for a view).

* `views[0]` is always the **primary** view (maximized, else largest tile; the photo view in photo mode).
  Remaining tiles follow, PiPs last (render order = draw order, PiPs on top).
* `primaryView()` = maximized, else largest non-PiP visible view (audio listener).
* Floating origin: every camera sits at (0,0,0); its W position is `view.camWorldPos`; `up = upAt(camWorldPos)`.
  near 0.1 (0.03 onboard, 1 long lens), far 1e8, aspect from `view.rect`.

## `command(cmd)`
| cmd | effect |
|---|---|
| `cycle` | next mode button on the primary view (user pick, director locked ~20 s) |
| `restore` | un-maximize (UI routes Esc here) |
| `maximize:<viewId>` | maximize a view (others become PiPs); needs ≥ 2 views |
| `mode:<CameraMode>` | set mode on the primary view (`onboard` resolves per focus) |
| `fov:<deg>` | + = wider, on primary view; relative scale on top of the rig's auto-FOV; reset on mode change / photo exit |
| `director:on\|off\|toggle` | auto director |

Cameras bind **no global keys** (UI owns the keyboard). Mouse on viewports is ours:
click = maximize/restore, left-drag = orbit (switches to orbit from current pose), right/middle-drag = pan, wheel = zoom.

## URL params
* `cam=<BODY>:<mode>[:<preset>]` or `cam=<mode>[:<preset>]` — single fullscreen view, director off for it.
  Bodies: `S1|BOOSTER|STACK|F9`, `S2`, `FAIRING|FA|FB`, `PAYLOAD`, `SHIP|OCISLY|DECK` (SHIP alone → deck).
  Modes: `chase onboard onboard_down onboard_engine long_lens deck pad orbit cinematic`.
  Presets: pad `wide|tower|engine|up`; long_lens `near|ground|ship|twilight`; cinematic `flyby|ship_orbit|dolly`.
  Examples: `?cam=S1:pad:engine`, `?cam=S1:deck&seek=500`, `?cam=S1:cinematic:ship_orbit`.
* `split=1` with `cam=` — force the mode on that body but keep the auto split.
* `director=0` — director off (views stay on chase unless user picks).
* `labels=0` / `hud=0` — hide viewport labels.
* DEV: `s2cam=angle,r,y,tilt,roll,fov` overrides the S2 engine-cam mount (S2 body frame).
  `padup=heading,dist,h,aimY,fov,aimOff,trk` overrides the pad `up` (LOW ANGLE) camera. `twsite=dist,heading,alt`
  moves the twilight coast site. `s2far=<m>` sets the S2 long-lens far-field span (default 11000).
* `camfake=1|splash|rud` — DEV ONLY: replaces `sim.getSnapshot` with a keyframed full mission
  (sep T+150, flip, entry 380–400, landing burn 485, touchdown 510 on OCISLY, SECO 525) for testing
  cameras/tiling without the real sim. `splash`/`rud` = failure variants.

## ViewInfo fields for other areas
* `view.alpha` — fade in/out on split/merge. Cameras also draw a black fade div over the viewport, so
  render/post don't need to apply it (App already skips alpha≈0 views).
* `view.shimmer` 0..1 — long-lens heat haze (path length through low turbulent air × magnification).
* `view.shake` 0..1 — shake amplitude already applied to the camera rotation; post may add motion blur.
* `view.onboard` — onboard cams (lens dirt/rolling-shutter/vignette are welcome).

## Assumptions / requests to sim
* Stacked detection: `S2.status === 'stacked'`. S1 story ends on `S1.status` `landed|tipped` (PiP after ~18 s, merged by SECO+12) or `splashed|destroyed|gone` (merged after ~7 s).
* S1 phases used: `FLIP COAST ENTRY_BURN AERO LANDING_BURN LANDED LOST`. Fairing story ends 70 s after `FAIRING_SEP` or 20 s after `FAIRING_A.parafoil > 0.5`.
* Timeline marker ids used: `LIFTOFF MAX_Q MECO STAGE_SEP SES1 BOOSTER_FLIP FAIRING_SEP
  ENTRY_BURN_START ENTRY_BURN_END LANDING_BURN_START TOUCHDOWN SECO PAYLOAD_DEPLOY` (predicted `t` before,
  actual when `done`). Event log is the fallback.
* `snapshot.landing.touchdownT` (predicted) drives the deck-cam cut; falls back to 2h/|v|.
* `BodyState.vel` must be populated (chase travel direction, lag, long-lens lead).
* Replay: cameras only need `ctx.replay` and the snapshot fed to `update()` during replay.

## Rig / director behaviour (2026-09-27 polish)
* **S2 engine cam (round 3):** pod on a boom ~1.7 m outboard and ~1.9 m below the aft skirt (body angle 225°,
  r 3.5, y 2.1), looking in and down at 67° off the stage axis, fov 80 (16:9). The old rim pod (r 1.95, y 3.85,
  tilt 28°) looked almost straight down the bell, so the round exit rim read as a circle and the bell as an egg.
  Now the bell flares from the throat at the top of the frame to a flat rim ellipse near the bottom, ~30–35% of the
  frame width, with the Earth (limb + black sky on the left) behind it. Onboard cams are **hor+** in narrow tiles:
  they keep the 16:9 horizontal coverage (vertical fov capped at 92°), so the bell does not fill a half-width tile.
* **Chase:** per-phase `fill` (share of the frame for the body plus a slice of plume), fitted to the body's
  *projected* extent in the 16:9 frame. When 48° is not wide enough it dollies out (`pull` ≤ 3), with a
  **hard cap of 250 m**. Measured at max-Q the chase is 104–110 m. Descent phases use `level` offsets
  (horizontal travel direction), so ENTRY_BURN, AERO and LANDING_BURN are side-on with the horizon behind.
  * **Stacked ascent above ~25 km (round 3):** the booster plume balloons into a ~70° "jellyfish". `clearOfPlume`
    swings the chase offset forward (same distance) about the stage axis, up to 100° from the aft axis, until the
    camera is outside the plume boundary (x1.1 + 8% of the distance). From ~30 km on, the chase is side-on/slightly
    ahead of the engine plane and sees the shell from outside. The boundary comes from `plumeBoundary()` in
    `util.ts`, which restates vfx's `plumeRadiusAt` shape law (cameras only import core). **vfx:** if you change
    the plume shape constants in `plume.ts` (`P_EXIT`, `tanT`, `L`, `bellP`, `a0`), please ping cameras, or publish
    the shape in ctx and cameras will read it.
  * The audio report "listener 64 → 2460 m at T+72" is not the camera. It is the retarded-time source distance:
    at Mach 1.5 the vehicle outruns its own sound, so a camera flying alongside hears emissions from seconds ago.
* **Long lens:** fits the *projected* length (foreshortened booster falling toward the ship) with a
  plume-width floor. A plume-heavy frame uses a wider fill (0.42 → 0.24), so the high-altitude plume reads as a
  shape against the sky instead of a flat wall. **Round 3:** with an expanded plume (`plumeBoundary`) it also fits
  the shell's near field (width at 0.35 L aft of the nozzle, or its projected length) into 65% of the frame and
  aims 0.45 of that length aft. `long_lens:ground` at T+135–145 is now ~3.7°–3.2° (was 0.43°), and S2 at T+195 is
  0.55° (MVac plume streamers around the stage). Without a plume (booster coasting after MECO, T+175) it stays
  on the vehicle (0.12° floor), as before. The near site is on the ridge SE of the pad (900 m / 150°);
  the old site saw only hillside.
* **Pad `up` (round 4, label LOW ANGLE):** a low ground tracker 240 m west of the mount (heading 272°, 1.5 m
  above the terrace), fov 34. It is the reverse angle to `wide`. It aims at 34 m on the vehicle, then blends to
  35% up the S1 body once the body passes that height. That rise is ~4.5 m/s², so the blend runs over ~T+3..6.
  The rotation lerps with a 0.6 s time constant.
  The old walkway spot (4.4 m from the vehicle, fov 70) was engulfed by the apron steam from T+3, and the vehicle
  had left the frame by T+4. A camera north of the pad sees the vehicle behind the TE. Anything inside ~150 m is
  inside the smoke by T+3..5, and the trench exhaust flows to 200°, so the site is to the west.
  T−2..+6 now reads as the vehicle on the mount, then climbing out of the steam with the tower on the left
  (`shots/r4c/padup_{mo,tw,ni}_*.png`).
* **Long lens, S2 in vacuum (round 4):** once the MVac plume has expanded (plumeBoundary `L` past ~60% of full),
  the fov floor also covers `S2_FAR.span` (11 km) × max(0.55, sin(view angle)). At T+195 the MVac far-field
  streaks stop filling the frame: the stage and the plume shell read as a shape (~1.5–2°). Morning and night show
  little: the plume is unlit or sub-pixel, and the director does not use this shot.
* **Twilight wide (round 4, `long_lens:twilight`):** a coast tracking site 200 km ESE of the pad
  (`COAST_SITE`: 115°, 12 m ASL, Palos Verdes shore) looks WSW over the sea toward the set sun (az 246°, −6°).
  The rig fits the angular box of the S1 MECO remnant (`s1Remnant`: 2300 m × grow, centre 0.25 L behind the
  booster, radius 0.65 L, life 20 s) and S2 plus its near field into 72% of the frame, with fov 20–40° in 16:9.
  While the fit allows, it pins the horizon near the bottom of the frame (−0.85), so the orange twilight band
  sits under the jellyfish. Label COAST TRACKING · WIDE.
  **Director:** in `tod=twilight`, the S1 tile takes this shot from MECO+3 to MECO+17 (`TWILIGHT_WIDE`, ~T+148–162).
  The S1/S2 split logic is unchanged, and the S2 tile stays on its own shot.
  Shots: `shots/r4c/dir_tw_{150..166}.png`.
* **Deck cam (round 5, `SHIP:deck`, label OCISLY):** replaces the deck PTZ. It is a fixed wide camera on the stern
  mast platform beside the satcom domes (ship frame x −9, y 9.5, z −44.2; +X port, +Z bow), ~45 m aft of the landing
  point, looking forward along the deck: both wing railings and the flood poles run toward the booster (the classic
  webcast deck view). The lens (`fitStandingLocal`, 30–100°) is set for the *landed* booster: feet at 20%, top at
  93% of the frame height, ~70° vertical in 16:9, and wider in portrait so its width fits. The lens stays fixed, with
  no zoom and no tilt (`tiltMax` 0; it only pans with the booster's deck spot, clamped to the deck). As on the real fixed
  cam, the deck (floods, landing circle) holds the frame while the plume glow grows. The plume enters from the top at
  ~T+503, then the booster with its legs out, and it touches down mid-frame. An operator tilt after the high booster
  (tried 7–25°) lost the deck under the HUD right after the cut. Dev override: `?deckcam=x,y,z,lo,hi,tiltMax`.
  A low wing-corner position (−24.5, 6.2, −28.5) was tried and rejected: it sits inside the touchdown steam.
* **Cinematic `ship_orbit` (round 5, label DECK ORBIT):** a slow orbit/push-in around the landed booster, which
  is anchored at its deck spot (ship axes flattened to the horizon, so the swell does not tilt the move).
  Timing is from `landing.touchdownT` (else from the cut). It starts at azimuth 196° (ship frame, from +X toward +Z:
  starboard-aft, looking WSW at the twilight band, with the moon behind the camera) and turns at 1.6°/s. Over 22 s
  (smoothstep) it pushes from 92 m to 58 m and descends from 17 m to 10 m above the sea. `fitStanding` puts the
  feet at 16% and the top at 95% of the frame height (above the HUD band / MinHud), widened when the booster's width
  needs it (portrait-safe), fov 12–70. Without a booster it frames the ship (+30 m).
  Dev override: `?shiporbit=az0,rate,d0,d1,h0,h1,push,lo,hi`. The old version sat 150 m out and 7 m up, and the ship was tiny.
* **Portrait (round 5, 9:16 cuts `tools/video/cuts/v*.json`):**
  * The chase fits its projected extent with the real aspect. It used `max(1, aspect)`, so a diagonal booster
    (entry burn, staging) was cut by the narrow frame edges.
  * The long lens bounds the operator lag (`maxErr`) by the *horizontal* fov when the frame is narrower than it is tall.
  * Deck and ship_orbit are aspect-aware as above.
  * Onboard cams and the twilight wide were already hor+. Pad `up`/`engine` frame the vehicle full-height as is.
  * Checked shots: `scratchpad/agents/landing/after/p_*.png`.
* **Director, booster descent:**
  * AERO: chase for 14 s after ENTRY_BURN_END, then onboard_down to +30 s, then chase.
  * Support-ship long lens only when the booster is inside 15 km of the ship site (≥ ~25% of the frame at the
    longest lens). At T+440 it is 35 km out, so that is chase now (look-dev camera request 2).
  * LANDING_BURN: onboard_down, then **deck cut at predicted tgo < `DECK_CUT_TGO` = 6.2 s**. This is ~7.6 s
    before the actual touchdown (dir3 run: cut at T+499.5, touchdown T+506.7).
* **Director, S2:** the engine cam stays 13 s after SECO (the cooling glow), then chase. **At night** (`tod=night`,
  stage in the Earth's shadow) it cuts after **7.5 s**: by then the MVac extension has cooled to ~1100 K and the
  frame is black. `directorShot(key, snap, evT, { night })`; ViewportManager passes
  `ctx.settings.timeOfDay === 'night'`.
* **PiP:** bottom-left, clear of the HUD band × `--z` (`uiZoom()` mirrors HUD.ts); the UI shifts the captions
  right of it. Split tiles still run full height under the overlay, like the main view.

## Requests
* **Sim:** during LANDING_BURN, `landing.touchdownT` runs ~1.9 s early. It is a constant-deceleration prediction and
  ignores the terminal creep (the last ~5 m at 2–3 m/s). `DECK_CUT_TGO` compensates; a creep-aware prediction
  would let it go back to ~8 s.
* **Look-dev:** the post-SECO `onboard_engine` meter lifts the unlit bell to mid-grey (see models.md).
  Look-dev camera request 1 (twilight long_lens:ground into the plume wall, T+140..200): the current director
  is on chase / S2 engine cam in that window, and the long lens widens for plume-heavy frames.
* **VFX:** the MVac plume haze is drawn over the lower bell in the engine cam. (Round 2: fixed in vfx.)
* **VFX (round 3):** done: request 1 (S1 chase inside the plume above ~50 km) and request 2 (`long_lens:ground`
  0.43°/0.12° at T+140..200). See the rig notes above.
* **VFX (round 4):** `s1Remnant` / `REMNANT_LIFE` in `util.ts` restate the remnant constants in VFX.ts
  (`REM_LIFE` 20, group drift 0.35·vel·age, ~2200·grow m crescent). Please ping cameras if they change. In the
  twilight wide shot (fov ~25°) the far-field remnant crescent and the S2 plume proxy have hard white edges.
* **Env (round 4):** from the 200 km coast site, the land and ocean foreground renders blocky and low-res, and
  clouds partly hide the twilight band.
* **Models (round 3):** the new engine-cam angle shows horizontal shading bands on the sunlit MVac extension
  (twilight T+545, `shots/pc3/after/tw_e545.png`).

## Terrain
Cameras are clamped above an approximate surface: ocean 0 m, pad terrace `PAD_ELEVATION` within 1.5 km of
the pad, ramping to 0 m at 3 km. If env gets a real heightfield, a `ctx.groundHeight?(p)` would be used.
