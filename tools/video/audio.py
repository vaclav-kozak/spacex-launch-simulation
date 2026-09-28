#!/usr/bin/env python3
"""Record the audio of each shot of a cut list, aligned sample-accurately to mission time.

Usage:
  python3 tools/video/audio.py tools/video/cuts/launch.json [--only id,id] [--force] [--out DIR]

Audio cannot be frame-stepped (the engine runs on a real-time AudioContext), so each shot is played
once in real time at low render quality with the same camera, and the master bus is recorded with the
AudioWorklet tap. The page runs with ?step=1 and this script's rAF loop drives the sim from the audio
clock itself (mission t = t_start + (ac.currentTime - ac_start)), so a render hitch can delay a
parameter update but can never drift the sim against the recording. The tap reports the audio-clock
frame of its first sample, so the output WAV starts exactly at t0 and lasts t1 - t0 (float stereo at
the context's native rate): <out>/takes/<id>.wav. Every callout clip that plays is logged with its
audio-clock start, converted to mission time and saved as <id>.subs.json for the subtitles.
"""
import argparse, asyncio, base64, json, os, re, struct, sys, time
import numpy as np
from playwright.async_api import async_playwright
from common import GPU_ENV, CHROME_ARGS, load_cut, own_shots, shot_url, out_dir

DRIVE_JS = """
window.__drive = { on: false, ac0: 0, t0: 0, warm: 0, lag: [] };
const loop = () => {
  requestAnimationFrame(loop);
  const d = __drive;
  // before the drive starts, render frames with a negligible dt: compiles shaders and uploads textures,
  // otherwise the first real frames take seconds and the sim falls behind the audio clock
  if (!d.on) { if (d.warm > 0) { d.warm--; __app.frame(1e-5); } return; }
  const target = d.t0 + (__app.audio.ac.currentTime - d.ac0);
  const dt = target - __app.sim.getSnapshot().t;
  d.lag.push(dt);
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
    # same aspect as the video (camera rigs frame by aspect, and sound depends on camera position)
    w, h = cut['size']
    k = 960 / max(w, h)
    ctx = await browser.new_context(viewport={'width': round(w * k), 'height': round(h * k)})
    pg = await ctx.new_page()
    # the audio does not depend on render quality; keep the page at full speed
    lowcut = dict(cut, query=re.sub(r'(^|&)quality=[^&]*', '', cut['query']), scale=1)
    url = shot_url(args.url, lowcut, shot, t0 - apre, 'step=1&quality=low')
    await pg.goto(url, wait_until='load', timeout=180000)
    await pg.wait_for_function('window.__app && window.__app.ready === true', timeout=180000)
    await pg.evaluate('__app.actions.unlockAudio()')
    await pg.wait_for_function('__app.audio.ready === true', timeout=60000)
    # callout clips decode in the background after unlock; a clip that is not ready yet plays late
    try:
        await pg.wait_for_function('(() => { const [a, b] = __app.audio.debugCalloutsDecoded(); return b > 0 && a >= b; })()', timeout=30000)
    except Exception:
        print(f"  {shot['id']}: not all callout clips decoded: {await pg.evaluate('__app.audio.debugCalloutsDecoded()')}", flush=True)
    await pg.evaluate('__app.audio.ac.resume()')
    # dry run through the shot so every shader, VFX system and one-shot sound is built, then seek back:
    # a first-use hitch during the recording would let the sim fall behind the audio clock
    await pg.evaluate('''([a, b]) => { let t = __app.sim.getSnapshot().t;
      while (t < b) { __app.frame(1 / 30); t = __app.sim.getSnapshot().t; } __app.sim.seek(a); }''', [t0 - apre, t1 + 0.5])
    await pg.evaluate(DRIVE_JS)
    await pg.evaluate('__drive.warm = 90')
    await pg.wait_for_function('__drive.warm === 0', timeout=120000)
    if not await pg.evaluate('__app.audio.debugCaptureStart()'):
        sys.exit('audio capture not available')
    await pg.wait_for_function('__app.audio.captureStartFrame !== null', timeout=10000)
    drive = await pg.evaluate('(() => { const d = __drive; d.ac0 = __app.audio.ac.currentTime; d.t0 = __app.sim.getSnapshot().t; d.on = true; return {ac0: d.ac0, t0: d.t0}; })()')
    while await pg.evaluate('__app.sim.getSnapshot().t') < t1 + 0.5:
        await pg.wait_for_timeout(100)
    lag = await pg.evaluate('__drive.lag.slice(30)')  # sim behind the audio clock, per rAF (s)
    b64 = await pg.evaluate('__app.audio.debugCaptureStop()')
    start = await pg.evaluate('__app.audio.captureStartFrame')
    spoken = await pg.evaluate('__app.audio.debugSpoken()')
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
    subs = []
    for c in spoken:
        m0 = drive['t0'] + (c['at'] - drive['ac0'])
        if m0 < t1 and m0 + c['dur'] > t0:
            subs.append({'text': c['text'], 'voice': c['voice'], 'm0': round(m0, 3), 'm1': round(m0 + c['dur'], 3)})
    json.dump(subs, open(path.replace('.wav', '.subs.json'), 'w'), indent=1)
    peak = 20 * np.log10(max(1e-9, np.abs(y).max()))
    rms = 20 * np.log10(max(1e-9, np.sqrt((y ** 2).mean())))
    print(f"{path}: {n / sr:.2f}s @ {sr} Hz  peak {peak:.1f} dBFS  rms {rms:.1f} dBFS  {len(subs)} lines  max lag {max(lag) * 1000:.0f} ms", flush=True)
    if max(lag) > 0.1:
        print(f"  WARNING {shot['id']}: the sim fell {max(lag):.2f} s behind the audio clock; callouts may play late", flush=True)
    return path


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cut')
    ap.add_argument('--only', default='')
    ap.add_argument('--out', default=None)
    ap.add_argument('--force', action='store_true', help='re-record takes that already exist')
    ap.add_argument('--url', default=os.environ.get('SIM_URL', 'http://127.0.0.1:5173'))
    args = ap.parse_args()
    cut = load_cut(args.cut)
    odir = out_dir(cut, args.out)
    only = set(filter(None, args.only.split(',')))
    shots = [s for s in own_shots(cut) if (not only or s['id'] in only)
             and (args.force or only or not os.path.exists(os.path.join(odir, 'takes', s['id'] + '.subs.json')))]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, env=dict(os.environ, **GPU_ENV), args=CHROME_ARGS)
        for s in shots:
            await record_take(browser, args, cut, s, odir)
        await browser.close()


asyncio.run(main())
