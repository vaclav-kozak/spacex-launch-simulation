# UI notes / contract requests (owner: ui)

The HUD talks to the app only through `AppActions`. It reads `SimSnapshot` and `ctx.events`.
Every field below is optional, and the UI degrades gracefully when one is missing.
The whole HUD was verified against the real 6-DOF sim (round 2): countdown → deploy, abort/recycle, seek/rebuild, manual landing, replay and photo mode.

## What the UI sends / expects

### Countdown hold / abort (sim)
* `H` or the HOLD button before T−3 toggles `toggleHold()` (hold ↔ resume).
* Between T−3 and T−0 (TEA-TEB lit), the same control becomes **ABORT**:
  * The button turns red and `toggleHold()` is sent.
  * The sim emits `COUNTDOWN_HOLD {abort}` and recycles to T−60 after about 12 s (8 s + 4 s envT).
* During the abort:
  * The clock turns red and blinks.
  * The clock sub-line reads `ABORT · RECYCLING TO T−60`.
  * The button reads RECYCLING (disabled).
  * A red `LAUNCH ABORT` title shows.
* The HUD clears its abort state on `COUNTDOWN_RESUME`, `IGNITION_SEQUENCE` or `LIFTOFF`.
* `L` / LIFTOFF NOW is disabled while aborted and from T−3 on.

### Manual landing: `actions.setManualInput({ throttle, pitch, yaw })` (sim)
**When inputs are sent.** Every frame while all of these hold:
* `settings.manualLanding` is on;
* `S1.phase` is `AERO` or `LANDING_BURN` (not `ENTRY_BURN`);
* S1 is `free`;
* the sim is not paused.

The semantics follow `docs/notes/sim.md`.

**Lever and stick.**
* `throttle` is a persistent lever:
  * W/S ramp it at 0.7/s, and X cuts it to 0.
  * 0 = engine off; > 0 = lit (the sim clamps it to 40 %).
  * The sim allows at most 3 starts. The HUD counts off→on transitions to show `W TO RELIGHT (n LEFT)` / `NO RELIGHTS LEFT`.
* `pitch` / `yaw` (−1..1, 6/s slew) work in the ship frame, matching the deck map: yaw+ = +X (right), pitch+ = bow (up).

**Panel readouts.**
* **Throttle bar**
  * Lever (amber) and actual engine throttle (arrow).
  * A **REQ** line: the throttle needed for a constant-deceleration stop at the deck.
  * The REQ line uses the sim's thrust model, `F = thr·F_vac − p_amb·A_exit` with `A_exit = (F_vac − F_SL)/101325`, so `req = (m·a_need/cos lean + p_amb·A_exit)/F_vac`:
    * `a_need = v²/2h + g − ½·a_drag`. `a_drag` is the measured vertical acceleration minus gravity and thrust.
    * `v` and `h` are deck-relative. `h` is measured from the feet to the deck, or to the sea when more than 25 m off the ship.
    * It shows only while the burn matters: under 8 km, and while lit or once req > 30 %.
    * It turns red above 100 %.
* **STEER · LEAN**
  * Amber dot = stick.
  * White ring = the booster's actual lean in the deck frame (ring edge = 20°), shown only during the landing burn.
  * The ring shows what the fly-by-wire assist does with the stick: lean against drift high up, velocity command low down.
* **Deck map**
  * Auto-ranges ±55 m … ±15 km with hysteresis, and the label shows the range.
  * The predicted impact point comes from `snapshot.landing.impactPoint`.
  * Velocity is relative to the deck.

**Cues.**
* `IGNITION IN x.x s · PRESS W`, from `landing.burnStartT`.
* `IGNITE NOW` / `LATE · IGNITE NOW, FULL THROTTLE`.
* `THROTTLE UP · NEED n %` / `NEED n % · TOUCHDOWN x s`.
* `SINK RATE · FULL THROTTLE`.
* `CLIMBING · THROTTLE DOWN OR X TO CUT`.
* `FLAMEOUT · NO PROPELLANT`.
* `TOUCHDOWN · VEHICLE TIPPED OVER / LOST`.

**Warnings.**
* `OFF DECK`: miss > 26 m.
* `SINK RATE`: h < 40 m and descending faster than 8 m/s.
* `LOW PROPELLANT`: while lit, the burn time left at the current or required throttle is less than 1.05 × the time to stop.

**Verified.**
* With zero input the booster splashes (about 300–380 m from the ship).
* Inputs reach `setManualInput` every frame with the documented semantics. The cues follow `landing.burnStartT` (`IGNITION IN 15 s … 4.5 s`), then REQ tracking through the burn (`NEED 77 % … 54 %`), then `CLIMBING` / `RELIGHT (2 LEFT)` after the pilot cut.
* A crude scripted keyboard pilot (`shots/uia/man_pilot_*.png`) that tracks REQ reaches the deck, 1–5 m from centre at 50 m.
  * Its end-game is still poor. In one run it cut the engine at 5 m and landed hard (vVert 10 m/s, vHor 1.4, tilt 8.3°). In another it stopped above the deck, climbed at minimum throttle (T/W > 1), cut and fell.
  * The sim's own HUD-only pilot lands (see `sim.md`).

### Time warp (sim)
* **Ceiling.** The UI ceiling is `snapshot.maxWarp` (with the heuristic as fallback), capped at 8× while manual control is active. The buttons above the ceiling are disabled, and `[` / `]` skip them.
* **Drops are the sim's.** The sim's ladder (1 / 8 / 30 / 100) clamps the running warp itself, down to 1× within 5 s of every key event. The HUD no longer drops warp on its own.
* **Notice.** When the running warp falls below the one the user picked, the clock sub-line flashes `TIME WARP n× · <next marker>`. Verified: 30× at T+15:00 → `TIME WARP 8× · DEPLOY` → `TIME WARP 1× · DEPLOY` (`shots/uia/v_warp_simdrop.png`).

### Propellant bars (sim)
* The LOX / RP-1 bars use `propLox` / `propFuel` against a capacity split at O/F 2.56.
* When those fields are missing, the bars fall back to `propMass / propCapacity`.

### Events used
**Captions.**
* `CALLOUT` becomes a lower-third caption.
* `data.voice` maps to the speaker: 'lc' → LAUNCH CONTROL, 'host' → HOST. `data.speaker` overrides it.
* `lc_<digit>` ids are not captioned; the clock shows the count.

**Titles.** Key events show a big centered title. Alert variants:
* the abort (`COUNTDOWN_HOLD.data.abort`);
* a premature fairing (`FAIRING_SEP.data.damaged`);
* RUD, SPLASHDOWN, and TOUCHDOWN outcomes.

**Other events.**
* `SECO` / `ORBIT` / `PAYLOAD_DEPLOY` set the S2 outcome.
* `MISSION_END` opens the summary modal 2.5 s later, with the headline from `getSummary().outcome`.
* Events flagged `seeking` (a burst from `?seek=` or a rebuild), events more than 30 s behind the snapshot, and events during replay update state but are not captioned. The 30 s allowance is a safety net for late events. Before 4b8799d, `MAX_Q` arrived about 12.7 s after its back-dated `t`, and its title must still show.
* `FAIRING_SEP` is a single event (`data.bodies = ['FAIRING_A','FAIRING_B']`), so there is one title.

**Backward jumps.** When the mission time jumps backwards by more than 2 s outside replay (a backward seek or an abort recycle), the HUD resets its mission state:
* outcomes;
* the summary auto-open flag;
* captions;
* the user-picked warp.

### Summary (sim)
* **Before `MISSION_END`**, the SUMMARY button shows a HUD-derived headline, such as `BOOSTER LANDED · PAYLOAD IN ORBIT`. It does not use the sim's `outcome`, which reads "…FAILURE" until the payload is deployed.
* **After `MISSION_END`**, it shows `getSummary().outcome` and `.lines`.
* **Sub-line:** `STARLINK · SLC-4E VANDENBERG → OCISLY · T+ clock`.
* **Credit line:** the imagery credit sits under the buttons.

## Timeline arc
* Markers are the sim's predicted times, and they refine live (SECO 525 → PEG prediction).
* Markers that finished more than 200 s ago lose their label and dim.
* `cancelled` markers get a red dashed dot and a struck-through label.

## Mission-control panel
* It starts **collapsed** as a compact `CONTROLS ⌄` tab, top right, next to pause / mute / help.
  * On the very first visit the tab glows 3× as a hint.
  * The collapsed tab also shows the warp readout when warp ≠ 1×.
* Clicking the tab toggles it. The preference is saved in `localStorage['f9ui.cpanel']` (`open` / `closed`).
* While manual landing is active, the panel body hides so the landing panel has room.

## Attribution
* **Bottom-right band.** A tiny two-line credit (8 px, 34 % white) links to s2maps.eu:
  `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016) · Earth: NASA`.
* **Help overlay (`?`).** It has a CREDITS section. Rows:
  * Terrain imagery (EOX, CC BY 4.0);
  * Earth imagery (NASA Blue Marble / Black Marble / clouds);
  * Sky (NASA SVS, Yale BSC);
  * Elevation (Mapzen / AWS Terrain Tiles);
  * Type (D-DIN, OFL);
  * Voices (Kokoro-82M, Apache-2.0).
* **Summary modal.** It repeats the EOX line and adds `Earth imagery: NASA`.
* **Author byline.** `authorCredit()` (Controls.ts) renders "Created by Václav Kozák", GitHub / X icon links (`rel="me noopener"`) and vaclavkozak.cz / vyvoj.vaclavkozak.cz (`rel="noopener"`), all in a new tab.
  * It is the last row of the open control panel (under the action buttons) and the last line of the help CREDITS. Both hosts are closed by default, so it never sits in the broadcast picture.
  * `.by` is hidden outright in `?hud=min` and `?shot=1` (the root gets `.is-shot`), and the video tool's capture CSS hides both hosts. `?hud=0` hides the whole layer.
  * A focused link counts as a control: Space / Enter do not reach the global key map.

## `?hud=min` (vertical social video, small screens)
* **What shows.** One top-centre stack (`.minhud` > `.mh-col`): the T± clock (`.mh-clock`, D-DIN Exp 44 px), a hairline with the focused stage's tag (`.mh-tag`, STAGE 1 / STAGE 2), and its speed | altitude around a fixed centre axis (`.mh-read`), so growing numbers never shift the lockup. The big event titles (`.evt-title`) are re-parented under it. Hold / abort / warp notices use `.mh-state`.
* **Hidden.** The bottom band (gauges, timeline, credit), the control tab, the manual-landing panel and the summary pill. Lower-third captions stay (bottom left); the video tool hides them with `.captions { display: none }` and burns in its own subtitles.
* **Focused stage.** It is the focus of the largest visible view: S2 for S2 / fairing / payload cameras, S1 for everything else, including the droneship. A tie (the split staging tiles) keeps S1. The numbers snap on a switch.
* **Safe zone.** `--mz` sizes a 540 × 960 design space: `min(W/540, H/960)` in portrait and `min(W/960, H/800)` in landscape, with a floor of 0.8. In portrait the stack starts at 13.5 % of the height, below the ~12 % app tab bar. It is 300 px wide, and the longest title (SECOND ENGINE START) reaches 82 % of the width, clear of the right ~14 % button column. It stays above the burned-in subtitles (60–75 %). In landscape it starts at 6.5 %.
* **Legibility.** A layered text-shadow and soft radial scrims behind the lockup and the title (the title's scrim fades with it) keep the type readable over bright plumes without drawing a box.
* **Camera labels.** They belong to the cameras. Pass `labels=0` for video, or they sit top left in the tab-bar zone.
* **Credit.** The EOX credit is in the band, so it is hidden here. A video using `hud=min` must credit EOX / NASA in its end card or description.

## Narrow layout (phones in portrait, W < ~740 px)
* **Zoom.** `--z` is re-derived for a ~460 px design width: `clamp(min(W/460, H/760), 0.74, 1.2)`, which gives 390 → 0.85 and 540 → 1.17. Before, it sat at the 0.74 floor, which left 8 px labels and the clock cut off under a short arc.
* **Stage telemetry.** Each stage shows as its head plus one line of numbers (`.st-mini`: `7 872 KM/H  69.0 KM`), not gauges. S1 is bottom left, S2 bottom right, above a centred two-line credit footer.
* **Timeline.** The arc is rounder (`R = 0.94 W`). The block height is set by the clock (clock under the apex at `apexY + 14`). The arc labels only the next 3 events and the ones passed in the last 30 s. The others keep their dots and stay out of the label relaxation. The wide layout is unchanged.
* **Captions, title and pill.** Captions, title and badge sit above the band. The summary pill moves under the controls tab.

## Video stepping (tools/video)
* **Fades are CSS.** All HUD fades are CSS transitions / animations, which the tool's `__vt` clock steps.
* **Clocks.** Title / caption lifetimes count `dtReal` from `frame(dt)`. Caption removal uses `setTimeout` on Playwright's fake clock.
* **Caption fade-in.** It used to wait for `requestAnimationFrame`. It now forces a style flush and adds `.in` in the same frame.
* **Verified.** With a 100 ms wall-clock sleep between 1/60 s steps, the title fades over exactly 30 frames (0.5 s), the caption over 21 frames, and the rule grows over 0.9 s.

## Captions vs. picture-in-picture
* **Shift.** When a small view sits at the bottom left (a camera PiP: alpha > 0.05, w < 0.45 W, x < 0.3 W), the captions move right of it and shrink slightly. The x offset is PiP right edge + 18 px, converted to design px through `--z`. The narrow layout ignores this.
* **Layout.** PiPs are currently bottom left (`pipRects`), for example after the S1 landing until SECO+12. They are stacked above the HUD band, so captions and PiP no longer collide.

## Photo mode
* **env:** the UI writes `ctx.lighting.exposureBias` every frame while `ctx.photoMode` is true (the −3..+3 EV slider) and restores the previous value on exit. Please don't overwrite `exposureBias` while `ctx.photoMode` is on, or read it additively.
* **cameras:** the FOV buttons send `cameraCommand('fov:±5')`, and `C` sends `'cycle'`.

## Keyboard map (UI owns all global keys)
**Global keys.** Verified with the real sim:
* Space pause; L liftoff now; H hold / resume / abort.
* S stage sep and F fairing sep. Manual early staging and fairing work; an early fairing shows the alert title.
* 1–6 warp; [ ] warp step, respecting the ceiling.
* C camera cycle.
* Esc runs through help → summary → photo → replay → `cameraCommand('restore')`.
* P photo; R replay (after touchdown); M mute; K manual landing; ? help; Enter capture (photo mode).

**Manual-control keys** (while active): W/S throttle, X cut, arrows steer, A/D yaw.

**Audio unlock.** The first pointer or key gesture anywhere unlocks audio, and so does the "CLICK FOR SOUND" card. Either one creates and resumes the AudioContext and sets `muted: false`.

## DOM / layering
* `#app > .f9ui` has z-index 20 and `pointer-events: none`, except on its controls.
* The bottom ~250 px × `--z` is the webcast band. The top right holds the control tab. The top left of each viewport is free for the cameras' labels.
* `?hud=0` hides the whole layer; input handling still works. `?hud=min` shows only the minimal overlay (see above).

## Requests
1. **sim:** done in 4b8799d: `lc_holding` on the env clock, timely `MAX_Q`, and a tighter manual lean cap near the deck. The HUD's 30 s staleness allowance stays as a safety net.
2. **sim (optional):** expose `landing.startsLeft` (manual relights left) and the booster's `propMass` needed for the stop, so the HUD needn't estimate them.
3. **cameras:** now that the control panel is a small tab, PiPs could move to the top right (below the tab, about y = 60). The captions would then keep their full width. The HUD would work either way.
