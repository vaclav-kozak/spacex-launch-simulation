#!/usr/bin/env python3
"""Bake tileable cloud noise for src/render/env/clouds.ts (numpy only, deterministic).

Outputs (public/data/env/):
  cloud_shape.bin   128^3 uint8  Perlin-Worley base shape (x fastest, then y, then z)
  cloud_detail.bin   32^3 uint8  Worley fbm erosion noise
  cloud_weather.bin 512^2 RGBA8  R: perlin fbm (coverage variation), G: cumulus cells,
                                 B: perlin fbm (layer height/thickness), A: fine perlin
Run: python3 src/render/env/tools/gen_cloud_noise.py
"""
import os
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '../../../../public/data/env')
rng = np.random.default_rng(1337)


def fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def perlin(coords, period):
    """tileable gradient noise; coords: array (..., D) in lattice units, period in cells"""
    D = coords.shape[-1]
    grads = rng.normal(size=(period,) * D + (D,))
    grads /= np.linalg.norm(grads, axis=-1, keepdims=True)
    i0 = np.floor(coords).astype(np.int64)
    f = coords - i0
    u = fade(f)
    out = np.zeros(coords.shape[:-1])
    for corner in range(1 << D):
        off = np.array([(corner >> k) & 1 for k in range(D)])
        idx = tuple(((i0[..., k] + off[k]) % period) for k in range(D))
        g = grads[idx]
        d = f - off
        dot = np.sum(g * d, axis=-1)
        w = np.ones(coords.shape[:-1])
        for k in range(D):
            w = w * (u[..., k] if off[k] else 1 - u[..., k])
        out += w * dot
    return out  # ~[-0.7, 0.7]


def worley(coords, period):
    """tileable F1 cellular distance (normalized ~[0,1]); coords in cell units"""
    D = coords.shape[-1]
    pts = rng.random(size=(period,) * D + (D,))
    i0 = np.floor(coords).astype(np.int64)
    f = coords - i0
    best = np.full(coords.shape[:-1], 1e9)
    rngs = [range(-1, 2)] * D
    for off in np.array(np.meshgrid(*rngs, indexing='ij')).reshape(D, -1).T:
        idx = tuple(((i0[..., k] + off[k]) % period) for k in range(D))
        p = pts[idx] + off
        d2 = np.sum((p - f) ** 2, axis=-1)
        best = np.minimum(best, d2)
    return np.clip(np.sqrt(best) / np.sqrt(D) * 1.6, 0, 1)


def grid(n, D):
    ax = (np.arange(n) + 0.5) / n
    g = np.meshgrid(*([ax] * D), indexing='ij')
    # index order (z, y, x) for 3D / (y, x) for 2D so that x is fastest in memory
    return np.stack(g[::-1], axis=-1)


def fbm(fn, uv, base, octaves, gain=0.5):
    s, a, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        f = base * (2 ** o)
        s = s + a * fn(uv * f, f)
        tot += a
        a *= gain
    return s / tot


def remap(v, a, b, c, d):
    return c + (v - a) / (b - a) * (d - c)


def norm01(a):
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return np.clip((a - lo) / (hi - lo), 0, 1)


def to_u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    # ---- shape 128^3
    n = 128
    uv = grid(n, 3)
    p = norm01(fbm(perlin, uv, 4, 4))
    w1 = 1 - worley(uv * 6, 6)
    w2 = 1 - worley(uv * 12, 12)
    w3 = 1 - worley(uv * 24, 24)
    wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125
    pw = np.clip(remap(p, wf - 1.0, 1.0, 0.0, 1.0), 0, 1)
    shape = norm01(pw * 0.7 + wf * 0.3)
    to_u8(shape).tofile(os.path.join(OUT, 'cloud_shape.bin'))
    print('shape', shape.mean(), shape.std())

    # ---- detail 32^3
    n = 32
    uv = grid(n, 3)
    d1 = 1 - worley(uv * 4, 4)
    d2 = 1 - worley(uv * 8, 8)
    d3 = 1 - worley(uv * 16, 16)
    det = norm01(d1 * 0.625 + d2 * 0.25 + d3 * 0.125)
    to_u8(det).tofile(os.path.join(OUT, 'cloud_detail.bin'))
    print('detail', det.mean(), det.std())

    # ---- weather 512^2
    n = 512
    uv = grid(n, 2)
    r = norm01(fbm(perlin, uv, 4, 6, 0.55))
    cells = 1 - worley(uv * 32, 32)
    cells = norm01(cells * 0.75 + (1 - worley(uv * 64, 64)) * 0.25)
    b = norm01(fbm(perlin, uv, 3, 5, 0.5))
    a = norm01(fbm(perlin, uv, 16, 4, 0.5))
    rgba = np.stack([to_u8(r), to_u8(cells), to_u8(b), to_u8(a)], axis=-1)
    rgba.tofile(os.path.join(OUT, 'cloud_weather.bin'))
    print('weather', r.mean(), cells.mean(), b.mean())


if __name__ == '__main__':
    main()
