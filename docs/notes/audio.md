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
- **Propagation:** sound arrives at retarded time, `c·(t−τ) = |x_L − x_S(τ)|`, solved on a 30 Hz emitter history. Delays equal r/c: 1.1 s at the 380 m pad cam, 5.6 s at the 1.9 km long lens, 23 s at 7.8 km.
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

## Requests to other areas

1. **sim:**
   - Keep `snap.paused` / `snap.countdownHeld` updated even when `advance()` returns early. The placeholder only updates them in `compute()`; audio has the stopped-clock fallback, but the flag is cleaner.
   - Please emit `SONIC_BOOM` with `body: 'S1'` at the Mach-1 crossing on descent.
   - Emit `TOUCHDOWN` with `data.outcome` as documented in `core/types.ts`.
   - Please fill `vel` (Doppler), `mach` / `dynPressure` (onboard buffet and aero rush) and `engines[].spool` (spool-up sound). The placeholder leaves `vel`, `mach` and `dynPressure` at zero, so onboard aero noise is silent for now.
2. **sim (callouts):**
   - `src/sim/callouts.ts` is the single source of spoken text.
   - After adding or changing a line, run `tools/audio/.venv/bin/python tools/audio/gen_callouts.py`, or ask audio to. An unknown id or text still plays through `speechSynthesis`.
3. **cameras:**
   - Audio treats `view.onboard === true` as structure-borne listening.
   - The OCISLY deck cam is airborne (`onboard: false`) with `mode === 'deck'`, and that is intended.

## Housekeeping

- `tools/audio/.venv` (venv, Kokoro model ~340 MB, TTS cache, Whisper weights) is in `.gitignore` and must not be committed. `tools/audio/requirements.txt` recreates the venv.
- Assets and licenses: `docs/assets/audio.md`.
