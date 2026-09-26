# UI notes / contract requests (owner: ui)

The HUD only talks to the app through `AppActions` and reads `SimSnapshot` + `ctx.events`.
Everything below is optional: the UI degrades gracefully when a field is missing.

## What the UI sends / expects

### Manual landing — `actions.setManualInput({ throttle, pitch, yaw })` (sim)
Sent **every frame** while `settings.manualLanding` is on and `S1.phase` is `AERO` or
`LANDING_BURN` (not during `ENTRY_BURN`, not while paused / replay / photo mode).
* `throttle` 0..1 is a **persistent lever** (W/S ramp it at 0.7/s, X cuts to 0). When manual control
  starts the lever is initialised from the current engine state (0 if the landing engine is off).
  Proposed semantics: `0` = landing engine off / not yet lit, `> 0` = lit, sim clamps to the 40 %
  Merlin minimum. So the player times the hoverslam ignition themselves (the HUD shows
  `IGNITION IN x.x s` from `snapshot.landing.burnStartT`).
* `pitch`, `yaw` −1..1 are held-key commands (arrows / A-D) with a 6/s slew.
  **Proposed frame: ship/deck frame**, so they match the HUD deck map (top-down, ship +Z = bow is up):
  `yaw +1` = push the booster / impact point toward ship **+X** (right on the map),
  `pitch +1` = toward ship **+Z** (bow, up on the map). The sim converts to engine gimbal.
  If you prefer body-frame gimbal instead, tell me and I'll relabel the hints.
* HUD reads back `S1.engines[0].throttle / gimbalX / gimbalZ / on` for the "actual" markers,
  `snapshot.landing.{impactPoint, missDistance, burnStartT, touchdownT}` for the deck map + cues.

### Time warp (sim)
The UI enables 30×/100× only when `t > 0`, not held, not in manual control, not during the stack's powered ascent, and the next undone
timeline marker is > 15 s (30×) / > 45 s (100×) away. The sim's auto-drop remains authoritative;
the warp segmented control always mirrors `snapshot.warp`.
**Request (optional):** `snapshot.maxWarp?: number` — the sim's own current ceiling; if present
I'll use it instead of the heuristic.

### Propellant bars (sim)
LOX / RP-1 bars both use `propMass / propCapacity` (they drain together at the O/F ratio).
**Optional:** `BodyState.propLox?` / `propFuel?` (kg) if the sim ever tracks them separately
(e.g. residuals after a flameout) — the HUD will pick them up.

### Events used
`CALLOUT` (lower-third caption; `data.voice` 'lc' → LAUNCH CONTROL, 'host' → HOST; `data.speaker`
overrides; ids `lc_<digit>` are not captioned because the clock shows the count), the key events
(big centered title), `TOUCHDOWN.data.outcome`, `SPLASHDOWN/RUD/FLAMEOUT` (body), `SECO/ORBIT`,
`PAYLOAD_DEPLOY`, `MISSION_END` (summary modal opens 2.5 s later).
Events whose `t` is > 5 s behind the snapshot (e.g. a burst from `?seek=`) update state but are
not captioned.

### Summary (sim)
`getSummary().outcome` is used as the headline when it's non-empty and not `"placeholder"`,
otherwise the HUD derives "BOOSTER LANDED · PAYLOAD IN ORBIT" etc. from events / statuses.
`lines` are shown as label/value rows (label is upper-cased by CSS).

## Photo mode
* **env:** the UI writes `ctx.lighting.exposureBias` every frame while `ctx.photoMode` is true
  (−3..+3 EV slider) and restores the previous value on exit. Please don't overwrite
  `exposureBias` while `ctx.photoMode` (or read it additively).
* **cameras:** the FOV buttons send `actions.cameraCommand('fov:+5')` / `('fov:-5')` (delta in
  degrees, + = wider) and the `C` key / button sends `'cycle'`. Please support `fov:<delta>`
  on the primary / maximised view. The UI displays `views[0].camera.fov`.

## Keyboard map (UI owns all global keys)
Space pause · L liftoff now · H hold/resume · S stage sep · F fairing sep · 1–6 warp ·
[ ] warp step · C camera cycle · Esc (help → summary → photo → replay → `cameraCommand('restore')`) ·
P photo · R replay · M mute · K manual landing · ? help · Enter capture (photo mode).
Manual control (while active): W/S throttle, X cut, arrows gimbal, A/D yaw.
Other modules should not bind global keys; ask here if you need one.

## DOM / layering
`#app > .f9ui` (z-index 20, `pointer-events: none` except on its controls). Bottom ~250 px × `--z`
is the webcast band; the top-right is the control panel; the top-left of each viewport is free
for the cameras' labels. `?hud=0` hides the whole layer (input handling still works).
