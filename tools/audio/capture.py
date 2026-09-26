#!/usr/bin/env python3
"""Record the running app's master audio output (post limiter) to WAV for offline analysis.

Usage:
  python3 tools/audio/capture.py [--url http://127.0.0.1:5173] [--secs 10] [--pre 2] [--eval JS] \
      --out shots/audio/NAME.wav "query-string"

Opens ?shot=1&<query>, unlocks audio (actions.unlockAudio), waits --pre seconds, records --secs
seconds via AudioEngine.debugCaptureStart/Stop (AudioWorklet tap), writes a float32 stereo WAV and
a JSON trace of AudioEngine.debug sampled every 0.25 s next to it.
"""
import argparse, asyncio, base64, json, os, sys, time
from playwright.async_api import async_playwright


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=os.environ.get('SIM_URL', 'http://127.0.0.1:5173'))
    ap.add_argument('--secs', type=float, default=10)
    ap.add_argument('--pre', type=float, default=2)
    ap.add_argument('--eval', default=None)
    ap.add_argument('--eval-at', type=float, default=0, help='seconds into the recording to run --eval')
    ap.add_argument('--out', required=True)
    ap.add_argument('query')
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    env = dict(os.environ, GALLIUM_DRIVER='d3d12', MESA_D3D12_DEFAULT_ADAPTER_NAME='NVIDIA',
               LD_LIBRARY_PATH='/usr/lib/wsl/lib:' + os.environ.get('LD_LIBRARY_PATH', ''))
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, env=env, args=[
            '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu',
            '--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(viewport={'width': 960, 'height': 540})
        errs = []
        pg.on('console', lambda m: errs.append(f'[{m.type}] {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
        await pg.goto(f'{a.url}/?shot=1&{a.query}', wait_until='load', timeout=120000)
        await pg.wait_for_function('window.__app && window.__app.frameCount > 5', timeout=120000)
        await pg.evaluate('__app.actions.unlockAudio()')
        await pg.wait_for_function('__app.audio.ready === true', timeout=30000)
        await pg.wait_for_timeout(int(a.pre * 1000))
        ok = await pg.evaluate('__app.audio.debugCaptureStart()')
        if not ok:
            sys.exit('capture not available')
        trace = []
        t0 = time.time()
        did_eval = False
        while time.time() - t0 < a.secs:
            if a.eval and not did_eval and time.time() - t0 >= a.eval_at:
                await pg.evaluate(a.eval)
                did_eval = True
            d = await pg.evaluate('({...__app.audio.debug, _state: __app.audio.ac && __app.audio.ac.state})')
            d['_real'] = round(time.time() - t0, 3)
            trace.append(d)
            await pg.wait_for_timeout(250)
        b64 = await pg.evaluate('__app.audio.debugCaptureStop()')
        raw = base64.b64decode(b64)
        open(a.out, 'wb').write(raw)
        json.dump(trace, open(a.out.replace('.wav', '.json'), 'w'), indent=0)
        print(f'{a.out}: {(len(raw) - 44) / 8 / int.from_bytes(raw[24:28], "little"):.2f}s captured, {len(trace)} trace samples')
        for e in errs[:12]:
            print('   ', e[:300])
        await b.close()

asyncio.run(main())
