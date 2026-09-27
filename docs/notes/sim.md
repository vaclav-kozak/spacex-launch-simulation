# Simulation notes (owner: sim)

Headless flight simulation + GNC in `src/sim/**`. `src/sim/Simulation.ts` is the real-time
wrapper used by the app (public API unchanged); `FlightSim.ts` is the deterministic core.
Test: `npm run simtest` (all scenarios), `npm run simtest -- nominal --trace --callouts`,
`npm run simtest -- manual-landing-pilot --pilot-log` (prints the scripted pilot's state and inputs once per second during the burn).

## Files

| file | contents |
|---|---|
| `Simulation.ts` | accumulator + warp/pause/hold, warp ceiling (`maxWarp`), render-time interpolation, history, seek, summary, nominal pre-sim (`runNominal`, `resetNominalCache`) |
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
  or held. `snapshot.maxWarp`: see *Time warp* below.
* Deterministic: everything (gusts, waves, ship) is a pure function of settings + time; `seek(t)`
  forward fast-forwards, backwards rebuilds from T−60.
* The nominal pre-sim (places the droneship) runs without gusts; its cache key includes the wind
  (`v2|speed|fromDeg`). `resetNominalCache()` drops it (tuning tools that change `GNC` at runtime).
* `Simulation.flight` (FlightSim), `nominalMs`, `setAutoFairing(on)` are extra (tests/tools).

## Time warp (`snapshot.maxWarp`)

Warp ladder `[1, 2, 4, 8, 30, 100]`; the HUD allows `w ≤ maxWarp` (1× always). `maxWarp` is
recomputed every `advance()` and a running warp above it is clamped immediately, so the sim itself
drops warp in front of events — the UI does not have to:

| condition (checked in order) | maxWarp |
|---|---|
| next key timeline event ≤ 5 mission-seconds away | **1** |
| before release / any engine burning | 8 |
| next key event > 45 s away | 30 |
| … and > 150 s away and "quiet" (every live vehicle passive/kinematic, ballistic fairing halves allowed) | 100 |
| otherwise | 8 |

Key events = the timeline markers (LIFTOFF, MAX-Q, MECO, STAGE SEP, SES-1, FAIRING, ENTRY BURN,
LANDING BURN, TOUCHDOWN, SECO, DEPLOY) using live predictions (SECO = PEG `tUpd + T`, frozen when
PEG freezes in the last 8 s, so it no longer slides). Checked: greedy max warp from T−10 in node →
every key event happens at 1×; browser at 100× from T+9:00 → 100× until T+13:23, 30× until
T+15:06, 8× until T+15:46, 1× from T+15:46 → PAYLOAD_DEPLOY (T+15:51) plays at 1×.

## Manual landing (`setManualInput`)

Active while `settings.manualLanding` and S1 phase AERO / LANDING_BURN (the autopilot flies flip,
boost-back, entry burn and the grid-fin phase down to AERO; the pilot owns the landing).
* `throttle` lever: 0 = landing engine off, > 0 = lit (spool-up per Merlin model); commanded
  throttle = max(40 % minimum, lever). Lever → 0 shuts the engine down; lever > 0 again relights
  (max 3 starts in total, TEA-TEB). No lever input → no landing burn → booster hits the ocean
  (`manual-landing-zero-input`: 266 m/s, 308 m from the ship, which also drifts because nobody steers).
  The HUD ignition cue is `snapshot.landing.burnStartT` (autopilot's predicted ignition).
* `pitch` / `yaw` −1..1 in the ship frame (pitch+ → bow, yaw+ → starboard/+X). The assist is
  fly-by-wire (the pilot never commands the gimbal) but the resulting thrust vector and body lift
  come from the normal 6-DOF physics, so bad inputs still crash.
  - AERO (engine off): stick commands up to 6 m/s² lateral acceleration toward bow/starboard from
    body + grid-fin lift (the controller picks the engines-first AoA, normal-load limited).
  - LANDING_BURN, **high** (> ~250 m above the deck, blended out 250 → 150 m): neutral = lean against
    the deck-relative drift by `atan(v_hor / max(15, v_down))` ≤ 35° (retrograde while fast; cancels
    drift like the autopilot's gravity turn). |stick| = 1 adds 14° of thrust tilt toward the
    commanded direction. The sign follows the physics: `lateralSlope()` = thrust side component +
    aero side force of a 3°-tilted booster (computeAero with retro-propulsion shielding); at high
    dynamic pressure the body lift dominates, so the assist tilts the engines *away* from the
    target (same as the autopilot's divert), with reduced authority near the cross-over.
  - LANDING_BURN, **low** (< 150 m): velocity command — |stick| = 1 asks for 8 m/s of drift over the
    deck, neutral = hold station over the deck (kills relative drift, time constant 1.6 s). The
    assist leans ≤ 20° above ~40 m, tapering to 3.5° below ~8 m (touchdown tips at 8°), to produce
    that horizontal acceleration — position errors must be fixed above ~20 m.
  - Height is measured to the deck plane; > deckLength/2 + 25 m off the ship it is the sea surface.
  - Legs deploy automatically ~7 s before predicted contact.
* Scripted "reasonable human" pilot (`scripts/simtest.ts`, `makeHumanPilot`): sees only what the
  HUD shows (deck-relative height/descent rate/position/drift, predicted impact point, the HUD
  required-throttle estimate, the IGNITE cue), with 0.3 s reaction delay, lever slewed at 0.7/s and
  stick at 6/s. It presses W at the cue (+ lateness offset), holds throttle ≈ 1.08 × the HUD required
  throttle, feathers to minimum in the last 12 m, cuts at contact; steers toward the predicted
  impact point high up and toward the deck centre below 200 m. Results (calm: sea 2, wind 4):

  | pilot | touchdown | result |
  |---|---|---|
  | on cue | T+8:32.6 · 1.82 m/s · 0.05 m/s hor · 2.7° · 1.2 m | landed |
  | 1.5 s late | T+8:29.4 · 0.85 m/s · 0.76 m/s hor · 2.7° · 0.9 m | landed |
  | 2 s early | T+8:34.6 · 4.40 m/s · 0.64 m/s hor · 1.5° · 1.1 m | landed (stopped 1.2 m up, cut, dropped) |
  | sea 4, wind 10, 0.45 s delay | T+8:34.7 · 4.74 m/s · 1.9 m/s hor · 2.9° · 2.5 m | landed |
  | 4 s late | T+8:19.0 · 72 m/s | hard landing → RUD |
  | no input | ocean impact 266 m/s | lost |

  UI suggestion (ui owner): the HUD required-throttle under-estimates at part throttle — Merlin
  thrust is `thr·F_vac − p·A_exit` (not `thr·F_SL`) and the requirement should be divided by
  cos(tilt). The scripted pilot's 1.08 margin covers it.

## Booster recovery GNC (summary)

Flip → boost-back only if needed (early staging) → coast → entry burn (3 engines, ignition at
q ≈ 200 Pa ≈ 70 km on the ~130 km lob, cut when the predicted impact point along-track error is
nulled within 750–1300 m/s (nominal ≈ 900) or when only 6 t remain) → aero phase: engines-first
AoA steering of the predicted impact point (rollout every 0.5 s, adaptive lift-slope estimate) →
landing burn (1 engine) lit when the predicted stop height at 72 % planning throttle reaches the deck.
Landing-burn law (identical in the predictor and the 6-DOF): vertical constant deceleration to
3.5 m/s at 5 m then to 1.6 m/s at contact; thrust along the gravity turn (air-relative at high q,
Earth-relative below) + a lateral correction 5·e_IP/t_go² from a 4 Hz rollout. The divert is
**aero-aware**: `lateralSlope()` (thrust + aero side force per rad of tilt) decides the tilt sign
and size, so at high q the engines tilt away from the target and body lift does the work.
Below 30 m ZEM/ZEV position hold relative to the moving deck with tilt ≤ 10°→3°.
Touchdown outcome (feet vs moving deck): centre off deck → `offdeck` (slides off → ocean);
legs < 0.9 or v_vert > 12 m/s → `hard` + RUD; v_vert > 6 → `hard` (legs crushed, topples);
tilt > 8°, v_hor > 2 m/s or a foot off the deck → `tipped` (topples, RUD at 84°); else `success`.
S2 after SECO: once passive (> 120 km) it is held kinematically, slewing to prograde at ≤ 1.5°/s
(no RCS puffs, no tumbling in orbit).

## Events (data fields)

`TOUCHDOWN {outcome, vVert, vHor, tilt, miss, prop, legs}` · `SONIC_BOOM body:S1 {pos, alt, t}` at the
Mach-1 crossing on descent · `SPLASHDOWN {speed, dist}` · `RUD {reason, members, q?, aoa?, normal?}`
(`q/aoa/normal` on aerodynamic breakups) · `MECO/STAGE_SEP {manual, …}` ·
`FAIRING_SEP body:FAIRING_A {bodies:['FAIRING_A','FAIRING_B'], manual, q, heatFlux, damaged}` —
**one event for the pair** (`body` stays FAIRING_A for older consumers) ·
`THROTTLE_DOWN / THROTTLE_UP {q}` (throttle bucket) · `MAX_Q {q, alt, mach}`: event.t = peak
of the gust-free q trend ½ρ|v − mean wind|² (alt/mach at that time), emitted 1.0 s later (armed once
Mach > 1.1 and past the throttle bucket); `q` = highest gusty q seen (the value the HUD showed) ·
`PARAFOIL_DEPLOY` twice per half: `{stage:'drogue', alt≈11 km}` then `{stage:'parafoil', alt≈2.5 km}`
(`BodyState.parafoil` ramps 0→1 over 14 s after the second) · `SECO {flameout, perigee, apogee, inc, prop}` ·
`ORBIT {a, e, perigee, apogee, incDeg}` · `PAYLOAD_DEPLOY {damaged}` · `FLAMEOUT` ·
`MISSION_END {outcome}` once the booster outcome and the S2 orbit/deploy (or failure) are resolved ·
`CALLOUT {id, text, voice}` (ids from `callouts.ts`).

RUD `reason` texts (shown as caption subtitle) for aerodynamic breakups:
* `second stage separated in thick air (X kPa), pitched Y° off the airflow and broke up`
* `booster tumbled out of control (cold-gas thrusters too weak for N t in thick air) and broke up at X kPa`
* `{booster|second stage|vehicle} tumbling at Y° angle of attack broke up (X kPa)`
* `structural failure: aerodynamic side load at X kPa, Y° angle of attack[ during the burn]`
Others unchanged: `hard landing`, `toppled on deck`, `ocean impact`, …

## Callouts / audio

All 71 `CALLOUT_LINES` (ids + texts) match `public/audio/callouts/manifest.json` (re-checked after
round 2) — no new or changed lines, no clip regeneration needed. Countdown hold: `lc_hold`
immediately, `lc_holding` 2.2 s later (timed on envT, since the mission clock is frozen while held;
dropped if the count resumes first), `lc_resume` on resume. If lines change later, rerun
`tools/audio/gen_callouts.py` (it imports `CALLOUT_LINES` directly).

## Nominal timeline (simtest, sea 3, wind 6 m/s from 300°)

| event | sim | target / real |
|---|---|---|
| throttle down / up | T+0:41 / T+1:04 | bucket through max-Q |
| supersonic | T+1:00 | ~T+1:00 |
| Max-Q | T+1:12.6 · 27.1 kPa (callout T+1:13.6) | ~T+1:10 |
| MECO | T+2:24.8 · 2.32 km/s inertial · 63 km · fpa 30° · 26 t reserve | ~T+2:27 |
| stage sep / SES-1 | T+2:27.8 / T+2:34.8 | +3 s / +7 s |
| fairing sep | T+3:15 (> 110 km, 553 W/m²) | T+3:00–3:30 |
| booster apogee | T+4:28 · 130 km | |
| entry burn | T+6:24.3 at 69.6 km, 20.9 s, cut at 890 m/s, 7.2 t left | ~T+6:20, 55–70 km, 15–25 s |
| landing burn | T+8:03.5 (1 engine) | ~T+8:05 |
| touchdown | T+8:26.7 · 1.84 m/s · 0.48 m/s hor · 2.9° · 0.6 m miss · 2.2 t left | ~T+8:30 |
| SECO | T+8:58.6 · 215 × 301 km, i 70.2°, 1.4 t S2 residual | T+8:40–8:50 |
| payload deploy | T+15:51 | T+15–60 min |
| fairing drogues | T+12:08 / T+12:10 | |

## Off-nominal outcomes (simtest)

| scenario | outcome |
|---|---|
| staging T+60 | S2 separates at 17 kPa, pitched 22° off the airflow → breaks up T+1:03; the 279 t booster can't be held by cold gas → tumbles, breaks up T+1:10 (8 kPa, 59° AoA). MISSION FAILURE |
| staging T+100 | S2 breaks up T+1:44 (9.4 kPa, 31°); booster (172 t) flips in thick air, tumbles, breaks up broadside T+3:34 (5.4 kPa, 76°). MISSION FAILURE |
| staging T+130 | S2 stages 15 s early, ~520 m/s slower; it runs dry at T+8:45 suborbital (215 km apogee). Booster (66 t prop) boosts back, entry burn T+6:02–6:35, lands T+8:15 but 3.9 m/s lateral → tips → RUD. MISSION FAILURE |
| staging T+145 | identical to nominal (auto-MECO fires at T+2:24.8 first) |
| sea 6, wind 15 | landed, 0.9 m/s, 2.4 m miss, 4.9° |
| sea 6, wind 20 | touchdown 13.3 m off centre with 2.2 m/s lateral on a rolling deck → tips → RUD. PAYLOAD DEPLOYED · BOOSTER LOST |
| fairing never | S2 carries the 1.9 t fairing pair to orbit → flameout T+9:03.5 into 186 × 215 km (below target). Booster lands. BOOSTER LANDED · MISSION FAILURE |
| fairing T+120 | 3.8 kPa, 5.1 MW/m² free-molecular proxy → payload damaged; orbit nominal, booster lands (0.5 m/s, 1.0 m). BOOSTER LANDED · MISSION FAILURE |
| manual, zero input | ocean impact 266 m/s, 308 m from the ship |

## Performance

* `seek(900)` from T−60: ≈ 0.6 s node / 0.7 s browser; `seek(500)` backwards ≈ 0.46 s / 0.5 s.
  Full `npm run simtest` (15 scenarios) ≈ 7.5 s.
* Browser `sim.advance` per frame: 1× avg 0.13–0.20 ms (max 1.5); 100× avg 0.25–0.43 ms
  (p90 ≤ 0.9 ms, max ≈ 4.6 ms). Coast phases step at `dtCoast` 0.05 s; passive/kinematic bodies skip
  the 6-DOF.
* `scripts/perf.py`: App frame CPU (sim + render) warp100 @ T+9:20 1.93 ms (p90 2.30);
  1× @ T+7:58 with 2 views 3.83 ms.

## Deviations from the brief / vehicleSpec

* RCS (S1) modelled at 2× the vehicleSpec 450 N per nozzle so flips reach ~5°/s.
* **SECO T+8:59**, 9–19 s later than the T+8:40–8:50 target: with the published S2 figures
  (111.5 t prop, MVac 981 kN / 348 s → 287 kg/s) the S2 burn is ≈ 383 s, so SECO ≈ MECO + 10 s + 383 s
  regardless of guidance. Insertion into a 215 × 300 km parking orbit (perigee at insertion).
  Hitting 8:45 would need a higher S2 mass flow than vehicleSpec allows.
* MECO T+2:24.8 (~2 s early). The 26 t booster reserve (entry + landing + ~2 t margin) sets it;
  moving MECO later would cut the landing margins.
* Max-Q 27 kPa (real webcasts ~30–35 kPa); the q-limiter (`bucketQ` 34 kPa) is a safety net only.
  Max-Q (trend peak) T+1:12–1:13; the gusty raw q is flat-topped from ~1:08 to ~1:18.
* Entry burn → touchdown ≈ 122 s (real ≈ 130 s). Tuning: `gammaScale` 1.025 (booster apogee
  ~130 km), `entryIgnQ` 200 Pa, entry cut window 750–1300 m/s (nominal ≈ 900), `landingReserve` 6 t,
  landing-burn planning throttle 0.72.
* Payload deploy at T+15:51 (`s2DeployDelay` 412 s after SECO).
* Heat flux in `FAIRING_SEP.heatFlux` is the free-molecular proxy ½ρV³ (not physical below ~80 km);
  payload counts as damaged above 1135 W/m².
