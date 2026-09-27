# Audio notes / contract requests (owner: audio, `src/audio/**`, `public/audio/**`, `tools/audio/**`)

## Public API (App.ts contract, unchanged)

`new AudioEngine(ctx)` has these members:

| Member | Notes |
|---|---|
| `load()` | Fetches `audio/callouts/manifest.json` and prefetches the clips (~2.5 MB) |
| `unlock()` | Creates and resumes the AudioContext; call it on a user gesture |
| `setMuted(m)` | Mute |
| `update(snap, primaryView, dtReal)` | Per frame |
| `unlocked` | |

Extras:

- `ready`: the graph is built and the worklet is loaded.
- `ac`: the AudioContext.
- `debug`: a live diagnostics record. `S1_r`, `S1_delay`, `S1_heardDb`, `S1_cutoff`, `agcDb`, `listener`, `callout` and so on.
- `debugCaptureStart()` / `debugCaptureStop()`: returns the post-limiter output as a base64 float32 WAV. Used by `tools/audio/capture.py`.

### Behaviour the rest of the app can rely on

- **Auto-unlock:** the first `pointerdown`/`keydown` anywhere, in the capture phase, also creates or resumes the context. Mute still follows `settings.muted` through `setMuted`.
- **Listener:** position comes from `view.camWorldPos`, orientation from `view.camera.matrixWorld`.
  - Onboard is `view.onboard`; the focus body is `view.focus`.
  - Mode-specific beds: `pad` → pad bed and reverb; `deck` or near the ship → ship bed.
  - On a camera switch (view id, mode or focus change, or a position jump), the mix dips for about 100 ms, then snaps.
- **Propagation:** sound arrives at retarded time, `c·(t−τ) = |x_L − x_S(τ)|`, solved on a 30 Hz emitter history. Delays equal r/c: 1.1 s at the 380 m pad cam, 2.65 s at the 0.9 km long lens, 23 s at 7.8 km.
  - **Fixed listeners** (pad, long lens, deck/ship, cinematic flyby and ship_orbit) use air at rest in W. They keep true delay, Mach-cone silence and sonic booms.
  - **Co-moving listeners** are cameras rigidly following their focus body: `chase`, `orbit`, `onboard_*`, and a `cinematic` move whose velocity is within 20 % of the body's (the dolly). They solve in an air frame moving with the body: an emission at P(τ) sits at P(τ) + v_body·(t − τ). The chase cam therefore hears its vehicle at the real ~100 m range with about 0.3 s delay and no Doppler, thinning with ambient pressure, and there is no Mach-cone dropout. Cinematic licence. Ground booms are skipped for them, and one-shot clunks ride the same frame.
  - **Chase and orbit above Mach 1** also get up to 45 % of the onboard bed (structure-borne rumble and aero rush, darker), `CHASE_ONBOARD_MIX`.
  - **Root choice:** the solver takes the most recent root, which is the nearer one when a Mach cone gives two. When no root exists, the oldest-record fallback applies only to a freshly (re)started history, for example after a seek. Once a root has existed, a missing root means silence, never a jump to a km-scale stale emission (`S1_lost` in `debug`).
- **Pause:** `snap.paused` silences the output and suspends the context.
- **Stopped clock fallback:** if the mission clock stops advancing for 0.35 s, audio treats it as a pause. This does not apply during a countdown hold (tracked through `snap.countdownHeld` and the `COUNTDOWN_HOLD`/`COUNTDOWN_RESUME` events) or in replay.
- **Warp:**
  - `warp > 4` ducks the engines and structure-borne sound to silence (ambience stays).
  - Delayed one-shots more than 1.2 s late are skipped.
  - Callouts lagging more than 2.5 s are dropped.
- **Replay** (`ctx.replay`): replay audio is pitched down (×0.55) with darker filtering. Callouts are cleared, and one-shots newer than the replay start are re-armed.

## Events consumed

| Event | Uses |
|---|---|
| `CALLOUT` | `data.id` (manifest lookup), otherwise `data.text` + `data.voice` (`'lc' \| 'host'`), with a `speechSynthesis` fallback. Plays in order with no overlap; stale items are dropped: a count >1.3 s late or superseded, lc >5.5 s, host >9 s. |
| `SONIC_BOOM` | `body` (default S1) at event time. The triple N-wave arrives r/c later at every listener; beyond 80 km it is inaudible. |
| `TOUCHDOWN` | `data.outcome` `success`/`hard`/`tipped` → thump plus structure-borne sound on S1 and SHIP onboard cams; `offdeck` → splash |
| `STAGE_SEP`, `FAIRING_SEP`, `LEGS_DEPLOY`, `GRIDFINS_DEPLOY`, `PAYLOAD_DEPLOY` | Clunks. Structure-borne (immediate) on attached onboard cams, airborne (delayed) elsewhere. |
| `SPLASHDOWN`, `RUD` | `body` |
| `COUNTDOWN_HOLD`, `COUNTDOWN_RESUME` | Hold state for the stopped-clock pause fallback |

Engine sound needs no events. It comes from the snapshot:

- per engine: `engines[].on`, `thrust`, `spool`, `throttle`
- per body: `rcs[]`, `ambientPressure`, `density`, `altitude`, `mach`, `dynPressure`, `vel`, `quat`

A change in the number of running engines (after the sound's travel delay) produces a TEA-TEB pop or a shutdown chuff. If no `SONIC_BOOM` event arrives within 30 s of S1 decelerating through Mach 1, audio synthesises the boom itself.

## Verified against the real sim (round 2)

Captures (`tools/audio/capture.py`) are in `shots/audio/r2_*.wav`. Each has a `.json` trace of `audio.debug` and an `.events.json`. The `.events.json` holds the sim events with real time (`wav@ = t − cap0`) and the CalloutPlayer log (`audio.callouts.log`: play/drop, event time, lag, clip duration).

| Window | Capture | Result |
|---|---|---|
| Countdown + ignition, pad cam | `r2_cd_pad` | Callouts strictly sequential, no overlaps. Ignition heard 1.12 s after the event at 381 m (r/c). Peak 0.89, RMS −16 dBFS, no clipping. `lc_2` starts 0.5 s late because `lc_ignition` (1.7 s) is still playing (accepted). |
| Liftoff, long lens (fixed) | `r2_lo_long` | Not co-moving. The rig sits at 7.8 km until T+8.7, then moves to 0.9 km. From then the engine is heard with a 2.65 s delay at 907 m (r/c) and the AGC settles at +14 dB. |
| Max-Q, S1 chase (co-moving) | `r2_maxq_chase` (seek 60) | r stays 95–104 m, delay 0.32 s, Doppler 1.00–1.01, no lost root. The airborne engine thins from −18.5 dB to −28 dB (ambient pressure) and the AGC makes up +0.4 → +9 dB, so output holds at −13…−16 dBFS with a strong 15–60 Hz band. The onboard bed blends in above Mach 1. `MAX_Q` now arrives 1 s after its peak. The earlier `r2_maxq` (−44 dB at "2460 m") was the retarded-time fallback jumping to a stale emission, not a trailing camera. |
| Supersonic S1 onboard | `r2_onb_super` | Onboard bed at −12…−14 dBFS. Airborne engine at 58 m in the co-moving frame is −39…−52 dB (forward of the plume, thin air). No clipping. |
| Stage sep, S1 onboard | `r2_sep_onb` | MECO cuts the structure-borne sound with a chuff, then the stage-sep clunk. S2's MVac is not heard on the S1 onboard cam (correct: vacuum, different body). |
| Entry burn, S1 onboard | `r2_entry_onb` | Structure-borne `onboardS` 0.60 = 3 engines (2.74 MN). Level −13…−17 dBFS, strong 15–60 Hz. Callouts `lc_entry_start` → `host_entry` → `lc_entry_end` in order with 0.02 s lag. Quiet RCS puffs in the coast before the burn. |
| Boom → landing burn → touchdown, deck cam | `r2_deck2` | `SONIC_BOOM` at t 480.64 is heard at t 493.17: r 4151 m, delay 12.52 s = r/c, gain 0.82, peak 0.88, no clipping. The landing burn is 1 engine (650 kN), heard 8 s after `LANDING_BURN_START` at 2.7 km, with the camera AGC lifting it (+25 dB → +5 dB). Touchdown thump lands on `TOUCHDOWN`, and `lc_landed` / `host_landed` follow without overlap. |
| SECO, S2 onboard_engine | `r2_seco` | MVac is structure-borne only: onboard rumble until SECO, chuff, then silence apart from callouts (the external S2 emitter is at −250 dB in vacuum). |

**Fixed in round 2**
- **Silence at orbital speed.** The listener cut detector (a position jump larger than the expected motion) reset the listener velocity on every cut. A camera riding S2 at 7.5 km/s moves about 120 m per frame, so every frame read as a camera cut and the dip-crossfade muted everything. S2 onboard went silent from about T+8:50. The jump budget now includes the focus body's speed.
- **Capture tooling.** `capture.py` logs events and the callout play/drop log, so callout timing can be checked against the `CALLOUT` stream.

**Checked, no change needed**
- **`FAIRING_SEP` as a single event** (`data.bodies`) gives one clunk, structure-borne on the S2 stack.
- **"Fairing" pronunciation.** `lc_fairing_sep` and `lc_manual_fairing` transcribe as "Fearing" with Whisper base.en. With small.en they transcribe as "faring", a homophone of "fairing". Kokoro's phonemes are correct (`fˈɛɹɪŋ`), and no respelling changes base.en's guess; only adding context ("payload fairing") does. So there is no respell.
- **Capture length.** A single `debugCaptureStart/Stop` returns at most about 30 s.

## Requests to other areas

1. **sim (callouts):**
   - `src/sim/callouts.ts` is the single source of spoken text.
   - After adding or changing a line, run `tools/audio/.venv/bin/python tools/audio/gen_callouts.py`, or ask audio to. An unknown id or text still plays through `speechSynthesis`.
   - Round 2 (4b8799d) fixed the earlier `MAX_Q` latency and `lc_holding` requests.
2. **cameras:**
   - Audio treats `view.onboard === true` as structure-borne listening.
   - `chase` / `orbit` / `onboard_*` are assumed rigidly attached to `view.focus` (co-moving). A `cinematic` preset counts as co-moving only while it tracks its body's velocity.
   - The OCISLY deck cam is airborne (`onboard: false`) with `mode === 'deck'`, and that is intended.
   - The long lens moves from 7.8 km to 0.9 km at about T+8.7. Audio handles it as a position jump (dip, then snap). If the move is intended, fine; at 7.8 km the ignition is heard only at T+20.

## Housekeeping

- `tools/audio/.venv` (venv, Kokoro model ~340 MB, TTS cache, Whisper weights) is in `.gitignore` and must not be committed. `tools/audio/requirements.txt` recreates the venv.
- Assets and licenses: `docs/assets/audio.md`.
