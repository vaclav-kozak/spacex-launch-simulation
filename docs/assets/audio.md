# Audio assets

| File(s) | Source | License |
|---|---|---|
| `public/audio/callouts/*.mp3` (151 clips, ~2.5 MB, 24 kHz mono 64 kbps) + `manifest.json` | Generated offline by `tools/audio/gen_callouts.py` with **Kokoro-82M v1.0** TTS (hexgrad/Kokoro-82M, ONNX export `kokoro-v1.0.onnx` + `voices-v1.0.bin` from thewh1teagle/kokoro-onnx release `model-files-v1.0`), run via `kokoro-onnx` 0.6.1. Voices: LC = `am_michael` (radio-treated), host = `af_heart`, net chatter = `am_fenrir`, `am_puck`, `am_echo`, `af_sarah`, `bm_george`, `am_eric`. All DSP (radio band-pass, compression, drive, squelch, loudness normalisation) is our own code. | Model and voices: Apache-2.0. `kokoro-onnx`: MIT. Generated audio is ours; no third-party recordings. |
| Everything else you hear (engine rumble/roar/crackle, ignition pops, shutdown chuffs, RCS puffs, sonic booms, clunks, touchdown, splash, explosion, wind, surf, hull water, diesel, reverb IR) | Procedurally synthesised at runtime: `src/audio/worklet.ts` (AudioWorklet) and `src/audio/synth.ts` (AudioBuffers built on unlock) | Our code; no samples |
| Atmospheric absorption table in `src/audio/propagation.ts` | ISO 9613-1 pure-tone attenuation coefficients at 20 °C and 70 % RH (published standard values) | Facts/data |

The offline tools use `espeak-ng` (through `phonemizer`/`espeakng-loader`, GPL-3.0) for grapheme-to-phoneme conversion. They also use `faster-whisper` base.en (MIT) for the intelligibility check. Both are build-time tools only, and neither is shipped.

## Regenerating the callouts

```bash
python3 -m venv tools/audio/.venv && tools/audio/.venv/bin/pip install -r tools/audio/requirements.txt
mkdir -p tools/audio/.venv/models && cd tools/audio/.venv/models && \
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin && cd -
tools/audio/.venv/bin/python tools/audio/gen_callouts.py          # incremental (TTS cache + source hash)
tools/audio/.venv/bin/python tools/audio/gen_callouts.py --force  # rebuild everything
tools/audio/.venv/bin/python tools/audio/verify_callouts.py       # ASR intelligibility check
```

- Lines come from `CALLOUT_LINES` in `src/sim/callouts.ts`, which is imported with `npx tsx`. Those files are named `<id>.mp3`.
- Extra lines (countdown variants, net chatter, fallbacks) come from `tools/audio/lines.json` and are named by slug.
- `tools/audio/.venv/` holds the venv, the models (~340 MB), the TTS cache and the Whisper weights. It is gitignored.
- Pronunciation fixes live in `RESPELL` and `SPEED_FOR`: MECO→"Meeko", MVac→"Em-vack", max Q→"max cue", "Eight!", "Six!".
- Bump `DSP_VERSION` whenever the processing chain changes.

## Analysis / capture tools

- `tools/audio/capture.py`
  - Uses the system python3 with Playwright.
  - Records the app's post-limiter master bus to a WAV via `AudioEngine.debugCaptureStart/Stop`.
  - Also writes a JSON trace of `AudioEngine.debug` sampled every 0.25 s.
  - Example: `python3 tools/audio/capture.py --secs 12 --out shots/audio/wide.wav "seek=-4&cam=S1:pad:wide"`
  - Use `--eval JS --eval-at S` to script actions during the capture.
- `tools/audio/analyze.py X.wav [--win 0.5] [--png]` reports, per window:
  - level and peak
  - clipping
  - five band levels
  - derivative skewness (a crackle metric)
  - impulse rate
  - L/R correlation
- `tools/audio/vite.audio.config.ts` is a private dev server on :5199 with no HMR and no file watching. Use it so that other people's edits don't reload the page mid-capture.
