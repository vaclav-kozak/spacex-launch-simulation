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
  Presets: pad `wide|tower|engine|up`; long_lens `near|ground|ship`; cinematic `flyby|ship_orbit|dolly`.
  Examples: `?cam=S1:pad:engine`, `?cam=S1:deck&seek=500`, `?cam=S1:cinematic:ship_orbit`.
* `split=1` with `cam=` — force the mode on that body but keep the auto split.
* `director=0` — director off (views stay on chase unless user picks).
* `labels=0` / `hud=0` — hide viewport labels.
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

## Terrain
Cameras are clamped above an approximate surface: ocean 0 m, pad terrace `PAD_ELEVATION` within 1.5 km of
the pad, ramping to 0 m at 3 km. If env gets a real heightfield, a `ctx.groundHeight?(p)` would be used.
