#!/usr/bin/env python3
"""Render the shots of a cut list frame by frame, as video takes (no audio).

Usage:
  python3 tools/video/render.py tools/video/cuts/launch.json [--only id,id] [--force] [--out DIR]
      [--scale 2] [--fps 60] [--url http://127.0.0.1:5173]

Each shot is its own take: the page opens with ?step=1 (no rAF loop) at seek = t0 - preroll with the
shot's camera forced, and this script drives App.frame(1/fps) itself. Pre-roll frames are rendered but
not kept, so exposure, smoke and plume history settle before t0. Frame time is exact and independent
of how long a frame takes to render, so a take is perfectly smooth at any resolution or quality.

Timers (setTimeout, performance.now, rAF) run on Playwright's fake clock and CSS animations are
stepped on the same virtual clock, so HUD captions and banners animate at video speed.

Output: <out>/takes/<id>.mkv (x264 yuv444p CRF 10, lossless-looking intermediate) and <id>.json with
the mission time of every kept frame. Existing takes are kept unless --force; shots that reference another
cut's take ("take": "<cut>/<id>") are not rendered here.
"""
import argparse, asyncio, base64, json, os, subprocess, sys, time
from playwright.async_api import async_playwright
from common import GPU_ENV, CHROME_ARGS, HIDE_CSS, load_cut, own_shots, shot_url, out_dir

# Steps every CSS animation/transition on a virtual clock instead of wall time.
VT_JS = """
window.__vt = { now: 0, start: new WeakMap(), sync(dtMs) {
  this.now += dtMs;
  for (const a of document.getAnimations()) {
    let s = this.start.get(a);
    if (s === undefined) { s = this.now - (a.currentTime || 0); this.start.set(a, s); a.pause(); }
    const t = this.now - s, end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
    if (t >= end) a.finish(); else a.currentTime = t;
  }
} };
"""


async def render_take(browser, args, cut, shot, odir):
    fps = args.fps or cut['fps']
    scale = cut['scale']
    w, h = cut['size']
    t0, t1 = shot['t0'], shot['t1']
    pre_n = round(shot['preroll'] * fps)
    keep_n = round((t1 - t0) * fps)
    ctx = await browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=scale)
    pg = await ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(f'[{m.type}] {m.text}') if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
    await pg.clock.install()
    url = shot_url(args.url, cut, shot, t0 - shot['preroll'], 'step=1')
    await pg.goto(url, wait_until='load', timeout=180000)
    await pg.wait_for_function('window.__app && window.__app.ready === true', timeout=180000)
    await pg.add_style_tag(content=HIDE_CSS + cut['css'])
    await pg.evaluate(VT_JS)
    await pg.clock.pause_at(await pg.evaluate('Date.now()') + 1000)
    cdp = await ctx.new_cdp_session(pg)
    # clip.scale = DPR, otherwise CDP returns CSS-pixel size (1080p for a 4K canvas)
    clip = {'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': scale}

    path = os.path.join(odir, 'takes', f"{shot['id']}.mkv")
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', str(fps),
                           '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '10',
                           '-pix_fmt', 'yuv444p', '-r', str(fps), path], stdin=subprocess.PIPE)
    dt = 1.0 / fps
    times = []
    acc = 0.0
    tstart = time.time()
    for i in range(pre_n + keep_n):
        # fake-clock timers advance in whole ms; spread the fraction so they track video time
        acc += 1000.0 / fps
        ms = int(acc)
        acc -= ms
        await pg.clock.run_for(ms)
        t = await pg.evaluate('(dt) => { __app.frame(dt); __vt.sync(dt * 1000); return __app.sim.getSnapshot().t; }', dt)
        if i < pre_n:
            continue
        shot_png = await cdp.send('Page.captureScreenshot', {'format': 'png', 'optimizeForSpeed': True, 'clip': clip})
        ff.stdin.write(base64.b64decode(shot_png['data']))
        times.append(round(t, 4))
        k = i - pre_n + 1
        if k % 60 == 0 or k == keep_n:
            el = time.time() - tstart
            print(f"  {shot['id']}: {k}/{keep_n} frames  t={t:.2f}  {el / (i + 1):.2f} s/frame", flush=True)
    ff.stdin.close()
    ff.wait()
    json.dump({'id': shot['id'], 'fps': fps, 't0': t0, 't1': t1, 'size': [w * scale, h * scale],
               'frames': times}, open(path.replace('.mkv', '.json'), 'w'))
    for e in errs[:8]:
        print('   ', e[:300])
    await ctx.close()
    return path


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cut')
    ap.add_argument('--only', default='')
    ap.add_argument('--out', default=None)
    ap.add_argument('--force', action='store_true', help='re-render takes that already exist')
    ap.add_argument('--scale', type=float, default=None)
    ap.add_argument('--fps', type=int, default=None)
    ap.add_argument('--url', default=os.environ.get('SIM_URL', 'http://127.0.0.1:5173'))
    args = ap.parse_args()
    cut = load_cut(args.cut)
    if args.scale:
        cut['scale'] = args.scale
    odir = out_dir(cut, args.out)
    only = set(filter(None, args.only.split(',')))
    shots = [s for s in own_shots(cut) if (not only or s['id'] in only)
             and (args.force or only or not os.path.exists(os.path.join(odir, 'takes', s['id'] + '.json')))]
    if not shots:
        print('nothing to render (all takes exist; --force to redo)')
        return
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, env=dict(os.environ, **GPU_ENV), args=CHROME_ARGS)
        for s in shots:
            t = time.time()
            path = await render_take(browser, args, cut, s, odir)
            print(f"{path}  ({time.time() - t:.0f} s)", flush=True)
        await browser.close()


asyncio.run(main())
