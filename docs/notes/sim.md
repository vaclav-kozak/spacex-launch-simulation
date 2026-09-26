# Simulation notes (owner: sim)

Headless flight simulation + GNC in `src/sim/**`. `src/sim/Simulation.ts` is the real-time
wrapper used by the app (public API unchanged); `FlightSim.ts` is the deterministic core.
Test: `npm run simtest` (all scenarios), `npm run simtest -- nominal --trace --callouts`.

## Files

| file | contents |
|---|---|
| `Simulation.ts` | accumulator + warp/pause/hold, render-time interpolation, history, seek, summary, nominal pre-sim (`runNominal`) |
| `FlightSim.ts` | vehicles (STACK → BOOSTER / UPPER / FAIRING / PAYLOAD), 6-DOF stepping, ascent/booster/S2/fairing GNC, events, callouts, timeline, touchdown evaluation |
| `rigidbody.ts` | RK4 6-DOF in the rotating W frame (point-mass gravity + Coriolis/centrifugal) |
| `aero.ts`, `atmosphere.ts`, `wind.ts` | Mach tables (axial/normal, grid fins, retro-propulsion shielding), US76, wind profile + jet + seeded gusts |
| `engines.ts`, `control.ts`, `massprops.ts` | per-engine spool/throttle/gimbal, attitude control + gimbal/fin/RCS allocation, mass properties |
| `guidance/peg.ts` | closed-loop S2 guidance (linear-tangent / PEG-style), orbit elements |
| `guidance/predict.ts` | booster rollout predictor (coast, entry burn, landing burn), landing-burn law shared with the 6-DOF guidance |
| `ship.ts` | OCISLY station keeping + heave/pitch/roll from `core/waves.ts` (sampled over the hull at `envT`) |
| `history.ts` | replay ring buffer (≥ 120 s at 30 Hz) |
| `callouts.ts` | `CALLOUTS` / `CALLOUT_LINES` (single source of spoken text) |

## Conventions

* W frame: Earth-fixed, origin at sea level under the pad, +X east, +Y up, +Z south. `BodyState.vel`
  is Earth-relative; `speedInertial` includes Earth rotation (≈ 400 m/s at rest on the pad or deck —
  the HUD currently shows `speedInertial`, so a landed booster reads ~1450 km/h; use `speed` if an
  Earth-relative number is wanted near the ground).
* `BodyState.pos` = model origin per `core/vehicleSpec` (S1: nozzle-exit plane; S2: MVac exit).
* All bodies get `vel, speed, mach, dynPressure, ambientPressure, density, altitude, gLoad` every
  step (fairings/payload share their vehicle's aero state). Engine `spool/throttle/gimbal/on/thrust`
  for S1 (9) and S2 (1). `propLox/propFuel` (O/F 2.56) on S1/S2.
* `snapshot.paused / countdownHeld` are refreshed on every `advance()` call, including while paused
  or held. `snapshot.maxWarp`: 8 during burns / within 4× warp-time of a key event, 30 in coast, 100
  only when every live vehicle is passive and the next key event is far away.
* Deterministic: everything (gusts, waves, ship) is a pure function of settings + time; `seek(t)`
  forward fast-forwards, backwards rebuilds from T−60. seek(900) ≈ 0.6 s (node).
* `Simulation.flight` (FlightSim), `nominalMs`, `setAutoFairing(on)` are extra (tests/tools).

## Manual landing (`setManualInput`)

Implements the ui.md proposal. Active while `settings.manualLanding` and S1 phase AERO / LANDING_BURN.
* `throttle` lever: 0 = landing engine off (not lit), > 0 = lit, clamped to 40 %. Max 3 relights
  (TEA-TEB). The HUD ignition cue is `snapshot.landing.burnStartT` (autopilot's predicted ignition).
* `pitch`/`yaw` −1..1 in the ship frame (pitch+ → ship +Z/bow, yaw+ → ship +X).
  - AERO: commands a lateral acceleration (up to 6 m/s²) produced by body/grid-fin lift (the
    controller picks the engines-first AoA).
  - LANDING_BURN: *assisted* attitude — stick neutral = retrograde relative to the deck while fast
    (cancels drift like the autopilot's gravity turn), near-vertical below ~15 m/s; the stick tilts
    the thrust up to 14° toward bow / +X. Legs deploy automatically.
* Zero input → no landing burn → booster hits the ocean (simtest `manual-landing-zero-input`).

## Booster recovery GNC (summary)

Flip → boost-back only if needed (early staging) → coast → entry burn (3 engines, ignition at
q ≈ 350 Pa, cut at ~1000 m/s or reserve) → aero phase: engines-first AoA steering of the predicted
impact point (rollout every 0.5 s, adaptive lift-slope estimate) → landing burn (1 engine) lit when
the predicted stop height (0.8 throttle) reaches the deck.
Landing-burn law (identical in the predictor and the 6-DOF): vertical constant deceleration to
3.5 m/s at 5 m then to 1.6 m/s at contact; thrust along the gravity turn (air-relative at high q,
Earth-relative below) + a lateral correction 5·e_IP/t_go² from a 4 Hz rollout; below 30 m ZEM/ZEV
position hold relative to the moving deck with tilt ≤ 10°→3°.
Touchdown outcome (feet vs moving deck): centre off deck → `offdeck` (slides off → ocean);
legs < 0.9 or v_vert > 12 m/s → `hard` + RUD; v_vert > 6 → `hard` (legs crushed, topples);
tilt > 8°, v_hor > 2 m/s or a foot off the deck → `tipped` (topples, RUD at 84°); else `success`.

## Events (data fields)

`TOUCHDOWN {outcome, vVert, vHor, tilt, miss, prop, legs}` · `SONIC_BOOM body:S1 {pos, alt, t}` at the
Mach-1 crossing on descent · `SPLASHDOWN {speed, dist}` · `RUD {reason, members}` ·
`MECO/STAGE_SEP {manual, …}` · `FAIRING_SEP body:FAIRING_A {manual, q, heatFlux, damaged}` ·
`PARAFOIL_DEPLOY` twice per half: `{stage:'drogue', alt≈11 km}` then `{stage:'parafoil', alt≈2.5 km}`
(`BodyState.parafoil` ramps 0→1 over 14 s after the second) · `SECO {flameout, perigee, apogee, inc, prop}` ·
`ORBIT {a, e, perigee, apogee, incDeg}` · `PAYLOAD_DEPLOY {damaged}` · `FLAMEOUT` ·
`MISSION_END {outcome}` once the booster outcome and the S2 orbit/deploy (or failure) are resolved ·
`CALLOUT {id, text, voice}` (ids from `callouts.ts`).

## Callouts / audio

All 71 `CALLOUT_LINES` (ids + texts) match `public/audio/callouts/manifest.json` as of this writing —
no new or changed lines, no clip regeneration needed. If lines change later, rerun
`tools/audio/gen_callouts.py` (it imports `CALLOUT_LINES` directly).

## Nominal timeline (simtest, sea 3, wind 6 m/s from 300°)

| event | sim | target / real |
|---|---|---|
| supersonic | T+0:52 | ~T+1:00 |
| Max-Q | T+1:05 · 31.5 kPa | ~T+1:10 · 30–35 kPa |
| MECO | T+2:21 · 2.27 km/s · 65 km · 29 t reserve | ~T+2:27 · 2.2–2.4 km/s · 65–70 km |
| stage sep / SES-1 | T+2:24 / T+2:31 | +3 s / +7 s |
| fairing sep | T+3:06 (> 110 km, 500 W/m²) | T+3:00–3:10 |
| booster apogee | T+4:29 · 138 km | |
| entry burn | T+6:37, 20.7 s | ~T+6:20, 15–25 s |
| landing burn | T+8:03 | ~T+8:05 |
| touchdown | T+8:26 · 1.8 m/s · 0.8 m miss | ~T+8:30 |
| SECO | T+8:55 · 215 × 301 km, i 70.2° | T+8:40–8:50 |
| payload deploy | T+15:47 | T+15–60 min |
| fairing splashdown | ~T+26 min | |

## Deviations from the brief / vehicleSpec

* RCS (S1) modelled at 2× the vehicleSpec 450 N per nozzle so flips reach ~5°/s.
* S2 inserts into a 215 × 300 km parking orbit (perigee at insertion) rather than circular 300 km;
  SECO lands ~5–10 s later than the real timeline because of the closed-loop PEG + fairing timing.
* MECO ~6 s and Max-Q ~5 s earlier than the real webcast; booster reserve 29 t.
* Heat flux in `FAIRING_SEP.heatFlux` is the free-molecular proxy ½ρV³ (not physical below ~80 km);
  payload counts as damaged above 1135 W/m².
