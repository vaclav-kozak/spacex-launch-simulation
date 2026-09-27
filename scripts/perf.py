#!/usr/bin/env python3
"""GPU/CPU frame-cost probe.  python3 scripts/perf.py NAME "query" [NAME "query"...]
Prints per-frame CPU ms (App.frame), GPU ms for 'scene' (opaque+VFX) and 'post' summed over views."""
import argparse, asyncio, os, sys, json
from playwright.async_api import async_playwright

JS_SETUP = """async () => {
  const { GpuTimer } = await import('/src/render/post/GpuTimer.ts');
  const app = window.__app;
  const PostPipeline = app.posts.values().next().value.constructor;
  const t = new GpuTimer(app.ctx.renderer);
  PostPipeline.profiler = t;
  window.__gpu = t;
  const orig = app.frame.bind(app);
  window.__cpu = [];
  app.frame = (dt) => { const a = performance.now(); orig(dt); window.__cpu.push(performance.now() - a); t.tick(); };
  return t.supported;
}"""
JS_READ = """() => {
  const c = window.__cpu.slice(-120); c.sort((a,b)=>a-b);
  const avg = c.reduce((a,b)=>a+b,0)/Math.max(1,c.length);
  const g = Object.fromEntries(window.__gpu.ms);
  const r = window.__app.ctx.renderer.info.render;
  return { cpu: avg.toFixed(2), cpuP90: (c[Math.floor(c.length*0.9)]||0).toFixed(2), gpu: g, calls: r.calls, tris: r.triangles, views: window.__app.views.views.length, q: window.__app.ctx.quality.level };
}"""

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:5173')
    ap.add_argument('--size', default='1920x1080')
    ap.add_argument('--wait', type=float, default=6)
    ap.add_argument('pairs', nargs='+')
    a = ap.parse_args()
    w, h = map(int, a.size.split('x'))
    env = dict(os.environ, GALLIUM_DRIVER='d3d12', MESA_D3D12_DEFAULT_ADAPTER_NAME='NVIDIA',
               LD_LIBRARY_PATH='/usr/lib/wsl/lib:' + os.environ.get('LD_LIBRARY_PATH', ''))
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, env=env, args=['--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist','--enable-gpu'])
        for i in range(0, len(a.pairs), 2):
            name, q = a.pairs[i], a.pairs[i+1]
            pg = await b.new_page(viewport={'width': w, 'height': h})
            await pg.goto(f"{a.url}/?{q}", wait_until='load')
            await pg.wait_for_function('window.__app && window.__app.frameCount > 5', timeout=120000)
            ok = await pg.evaluate(JS_SETUP)
            await pg.wait_for_timeout(int(a.wait*1000))
            r = await pg.evaluate(JS_READ)
            gpu = ' '.join(f"{k}={v:.2f}" for k, v in r['gpu'].items())
            print(f"{name:14s} q{r['q']} views={r['views']} cpu={r['cpu']}ms (p90 {r['cpuP90']}) gpu[{gpu}] calls={r['calls']} tris={r['tris']} timer={ok}")
            await pg.close()
        await b.close()
asyncio.run(main())
