#!/usr/bin/env python3
"""Headless GPU screenshots of the running dev server.

Usage:
  python3 scripts/shot.py [--url http://127.0.0.1:5173] [--out shots] [--size 1600x900] [--wait 4] \
      NAME "query-string" [NAME "query-string" ...]

Example:
  python3 scripts/shot.py pad "seek=-2&cam=pad" maxq "seek=70&cam=S1:chase" \
      touchdown "seek=505&cam=SHIP:deck&tod=morning"

Every shot opens a fresh page with ?shot=1&<query>, waits until window.__app has rendered
frames, then waits --wait more seconds of real time (sim keeps running unless pause=1), and
saves <out>/<NAME>.png. Console errors are printed. Requires: pip playwright + chromium.
WSL2 GPU: uses Mesa d3d12 (GALLIUM_DRIVER=d3d12).
"""
import argparse, asyncio, os, sys, time
from playwright.async_api import async_playwright

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=os.environ.get('SIM_URL', 'http://127.0.0.1:5173'))
    ap.add_argument('--out', default='shots')
    ap.add_argument('--size', default='1600x900')
    ap.add_argument('--wait', type=float, default=4.0)
    ap.add_argument('--eval', default=None, help='JS to run after load (e.g. "__app.actions.stageSeparation()")')
    ap.add_argument('pairs', nargs='+')
    a = ap.parse_args()
    if len(a.pairs) % 2:
        sys.exit('need NAME QUERY pairs')
    os.makedirs(a.out, exist_ok=True)
    w, h = map(int, a.size.split('x'))
    env = dict(os.environ, GALLIUM_DRIVER='d3d12', MESA_D3D12_DEFAULT_ADAPTER_NAME='NVIDIA',
               LD_LIBRARY_PATH='/usr/lib/wsl/lib:' + os.environ.get('LD_LIBRARY_PATH', ''))
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, env=env,
            args=['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu',
                  '--autoplay-policy=no-user-gesture-required'])
        for i in range(0, len(a.pairs), 2):
            name, q = a.pairs[i], a.pairs[i + 1]
            pg = await b.new_page(viewport={'width': w, 'height': h})
            errs = []
            pg.on('console', lambda m: errs.append(f'[{m.type}] {m.text}') if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
            url = f"{a.url}/?shot=1&{q}"
            t0 = time.time()
            await pg.goto(url, wait_until='load', timeout=120000)
            try:
                await pg.wait_for_function('window.__app && window.__app.frameCount > 5', timeout=120000)
            except Exception as ex:
                errs.append(f'[shot] app never rendered: {ex}')
            if a.eval:
                await pg.evaluate(a.eval)
            await pg.wait_for_timeout(int(a.wait * 1000))
            fps = await pg.evaluate('window.__app ? (1000/window.__app.ctx.quality.frameMs).toFixed(1)+" fps q"+window.__app.ctx.quality.level : "n/a"')
            path = os.path.join(a.out, f'{name}.png')
            await pg.screenshot(path=path)
            print(f'{path}  ({time.time()-t0:.1f}s, {fps})')
            for e in errs[:15]:
                print('   ', e[:400])
            await pg.close()
        await b.close()

asyncio.run(main())
