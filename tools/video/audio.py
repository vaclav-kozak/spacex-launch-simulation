#!/usr/bin/env python3
"""Record the audio of each shot of a cut list, aligned sample-accurately to mission time.

Usage:
  python3 tools/video/audio.py tools/video/cuts/launch.json [--only id,id] [--out DIR]

Audio cannot be frame-stepped (the engine runs on a real-time AudioContext), so each shot is played
once in real time at low render quality with the same camera, and the master bus is recorded with the
AudioWorklet tap. The page runs with ?step=1 and this script's rAF loop drives the sim from the audio
clock itself (mission t = t_start + (ac.currentTime - ac_start)), so a render hitch can delay a
parameter update but can never drift the sim against the recording. The tap reports the audio-clock
frame of its first sample, so the output WAV starts exactly at t0 and lasts t1 - t0 (float stereo at
the context's native rate): <out>/takes/<id>.wav.
"""
import argparse, asyncio, base64, json, os, re, struct, sys, time
import numpy as np
from playwright.async_api import async_playwright
from common import GPU_ENV, CHROME_ARGS, load_cut, shot_url, out_dir

DRIVE_JS = """
window.__drive = { on: false, ac0: 0, t0: 0 };
const loop = () => {
  requestAnimationFrame(loop);
  const d = __drive;
  if (!d.on) return;
  const target = d.t0 + (__app.audio.ac.currentTime - d.ac0);
  const dt = target - __app.sim.getSnapshot().t;
  if (dt > 1e-4) __app.frame(dt);
};
requestAnimationFrame(loop);
"""


def read_wav_f32(raw):
    ch = struct.unpack_from('<H', raw, 22)[0]
    sr = struct.unpack_from('<I', raw, 24)[0]
    data = np.frombuffer(raw, dtype='<f4', offset=44)
    return data.reshape(-1, ch), sr


def write_wav_f32(path, x, sr):
    x = np.ascontiguousarray(x, dtype='<f4')
    n, ch = x.shape
    hdr = b'RIFF' + struct.pack('<I', 36 + x.nbytes) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 3, ch, sr, sr * 4 * ch, 4 * ch, 32) \
        + b'data' + struct.pack('<I', x.nbytes)
    open(path, 'wb').write(hdr + x.tobytes())


async def record_take(browser, args, cut, shot, odir):
    t0, t1 = shot['t0'], shot['t1']
    apre = shot.get('apre', max(3.0, shot['preroll']))
    ctx = await browser.new_context(viewport={'width': 960, 'height': 540})
    pg = await ctx.new_page()
    # the audio does not depend on render quality; keep the page at full speed
    lowcut = dict(cut, query=re.sub(r'(^|&)quality=[^&]*', '', cut['query']))
    url = shot_url(args.url, lowcut, shot, t0 - apre, 'step=1&quality=low')
    await pg.goto(url, wait_until='load', timeout=180000)
    await pg.wait_for_function('window.__app && window.__app.ready === true', timeout=180000)
    await pg.evaluate('__app.actions.unlockAudio()')
    await pg.wait_for_function('__app.audio.ready === true', timeout=60000)
    await pg.evaluate('__app.audio.ac.resume()')
    await pg.evaluate(DRIVE_JS)
    if not await pg.evaluate('__app.audio.debugCaptureStart()'):
        sys.exit('audio capture not available')
    await pg.wait_for_function('__app.audio.captureStartFrame !== null', timeout=10000)
    drive = await pg.evaluate('(() => { const d = __drive; d.ac0 = __app.audio.ac.currentTime; d.t0 = __app.sim.getSnapshot().t; d.on = true; return {ac0: d.ac0, t0: d.t0}; })()')
    while await pg.evaluate('__app.sim.getSnapshot().t') < t1 + 0.5:
        await pg.wait_for_timeout(100)
    b64 = await pg.evaluate('__app.audio.debugCaptureStop()')
    start = await pg.evaluate('__app.audio.captureStartFrame')
    await ctx.close()

    x, sr = read_wav_f32(base64.b64decode(b64))
    # mission time m plays at audio-clock time ac0 + (m - t_start)
    i0 = round((drive['ac0'] + (t0 - drive['t0'])) * sr) - start
    n = round((t1 - t0) * sr)
    if i0 < 0 or i0 + n > len(x):
        sys.exit(f"{shot['id']}: capture does not cover the shot ({i0}..{i0 + n} of {len(x)})")
    y = x[i0:i0 + n]
    path = os.path.join(odir, 'takes', f"{shot['id']}.wav")
    write_wav_f32(path, y, sr)
    peak = 20 * np.log10(max(1e-9, np.abs(y).max()))
    rms = 20 * np.log10(max(1e-9, np.sqrt((y ** 2).mean())))
    print(f"{path}: {n / sr:.2f}s @ {sr} Hz  peak {peak:.1f} dBFS  rms {rms:.1f} dBFS", flush=True)
    return path


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cut')
    ap.add_argument('--only', default='')
    ap.add_argument('--out', default=None)
    ap.add_argument('--url', default=os.environ.get('SIM_URL', 'http://127.0.0.1:5173'))
    args = ap.parse_args()
    cut = load_cut(args.cut)
    odir = out_dir(args.cut, args.out)
    only = set(filter(None, args.only.split(',')))
    shots = [s for s in cut['shots'] if not only or s['id'] in only]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, env=dict(os.environ, **GPU_ENV), args=CHROME_ARGS)
        for s in shots:
            await record_take(browser, args, cut, s, odir)
        await browser.close()


asyncio.run(main())
