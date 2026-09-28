#!/usr/bin/env python3
"""Generate procedural VFX textures (all original / CC0 — nothing downloaded).

  python3 src/render/vfx/tools/gen_textures.py

Outputs (public/textures/vfx/):
  noise3d_64.bin  64^3 RGBA8 tileable volume
                  R = perlin fBm (4 oct), G = inverted worley fBm (billowy), B = perlin (hi freq), A = curl-ish perlin
  puffs.png       1024x512 atlas, 4x2 cells of 256^2.
                  Row 0: billowy cumulus-like puffs (steam / smoke).  Row 1: soft wispy gas puffs.
                  RGB = sprite-space normal (xy encoded 0.5+0.5n) + cavity AO (billowy) / thickness (wispy) in B, A = density.
"""
import os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '../../../../public/textures/vfx')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def perlin3(N, cells, seed):
    """Tileable 3D gradient noise sampled on an N^3 grid with `cells` lattice cells per axis."""
    r = np.random.default_rng(seed)
    g = r.normal(size=(cells, cells, cells, 3))
    g /= np.linalg.norm(g, axis=-1, keepdims=True)
    c = np.arange(N) * cells / N
    x, y, z = np.meshgrid(c, c, c, indexing='ij')
    xi, yi, zi = np.floor(x).astype(int), np.floor(y).astype(int), np.floor(z).astype(int)
    xf, yf, zf = x - xi, y - yi, z - zi

    def fade(t):
        return t * t * t * (t * (t * 6 - 15) + 10)

    u, v, w = fade(xf), fade(yf), fade(zf)
    out = 0
    acc = {}
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                gg = g[(xi + dx) % cells, (yi + dy) % cells, (zi + dz) % cells]
                d = gg[..., 0] * (xf - dx) + gg[..., 1] * (yf - dy) + gg[..., 2] * (zf - dz)
                acc[(dx, dy, dz)] = d
    lerp = lambda a, b, t: a + (b - a) * t
    x00 = lerp(acc[(0, 0, 0)], acc[(1, 0, 0)], u)
    x10 = lerp(acc[(0, 1, 0)], acc[(1, 1, 0)], u)
    x01 = lerp(acc[(0, 0, 1)], acc[(1, 0, 1)], u)
    x11 = lerp(acc[(0, 1, 1)], acc[(1, 1, 1)], u)
    y0 = lerp(x00, x10, v)
    y1 = lerp(x01, x11, v)
    out = lerp(y0, y1, w)
    return out  # ~[-0.7, 0.7]


def worley3(N, cells, seed):
    r = np.random.default_rng(seed)
    pts = r.random((cells, cells, cells, 3))
    c = np.arange(N) * cells / N
    x, y, z = np.meshgrid(c, c, c, indexing='ij')
    xi, yi, zi = np.floor(x).astype(int), np.floor(y).astype(int), np.floor(z).astype(int)
    best = np.full(x.shape, 10.0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cx, cy, cz = xi + dx, yi + dy, zi + dz
                p = pts[cx % cells, cy % cells, cz % cells]
                d = (cx + p[..., 0] - x) ** 2 + (cy + p[..., 1] - y) ** 2 + (cz + p[..., 2] - z) ** 2
                best = np.minimum(best, d)
    return np.sqrt(best)  # 0..~1


def norm01(a):
    a = a - a.min()
    return a / max(a.max(), 1e-9)


def gen_noise3d(N=64):
    fbm = sum(perlin3(N, 4 * 2 ** o, 11 + o) * 0.5 ** o for o in range(4))
    wor = sum((1 - worley3(N, 4 * 2 ** o, 31 + o)) * 0.55 ** o for o in range(3))
    hi = sum(perlin3(N, 16 * 2 ** o, 51 + o) * 0.5 ** o for o in range(2))
    cu = sum(perlin3(N, 8 * 2 ** o, 71 + o) * 0.5 ** o for o in range(3))
    vol = np.stack([norm01(fbm), norm01(wor), norm01(hi), norm01(cu)], axis=-1)
    # contrast-stretch around mean so the full range is used
    vol = (np.clip(vol, 0, 1) * 255 + 0.5).astype(np.uint8)
    # WebGL Data3DTexture layout: x fastest, then y, then z -> array index [z][y][x]
    vol = np.transpose(vol, (2, 1, 0, 3)).copy()
    vol.tofile(os.path.join(OUT, 'noise3d_64.bin'))
    print('noise3d_64.bin', vol.shape)


def fbm2(S, cells, octaves, seed):
    """Tileable-ish 2D fBm via slices of 3D perlin (cheap enough at 256^2)."""
    total = np.zeros((S, S))
    amp = 1.0
    for o in range(octaves):
        c = cells * 2 ** o
        r = np.random.default_rng(seed + o)
        g = r.normal(size=(c + 1, c + 1, 2))
        g /= np.linalg.norm(g, axis=-1, keepdims=True)
        t = np.arange(S) * c / S
        x, y = np.meshgrid(t, t, indexing='xy')
        xi, yi = np.floor(x).astype(int), np.floor(y).astype(int)
        xf, yf = x - xi, y - yi
        fade = lambda t: t * t * t * (t * (t * 6 - 15) + 10)
        u, v = fade(xf), fade(yf)
        def dot(dx, dy):
            gg = g[yi + dy, xi + dx]
            return gg[..., 0] * (xf - dx) + gg[..., 1] * (yf - dy)
        n = (dot(0, 0) * (1 - u) + dot(1, 0) * u) * (1 - v) + (dot(0, 1) * (1 - u) + dot(1, 1) * u) * v
        total += n * amp
        amp *= 0.5
    return total


def blur(a, k=2):
    for _ in range(k):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return a


def billow_puff(S, seed):
    """Billowing puff: Gaussian lobes in 2 hierarchical levels (broad lobes only).
    Normals from a soft-max relief of the lobes, projected density, broad cavity AO in B.
    (Round 5: the third level of small spheres and the fBm bump were dropped. Magnified to 500+ px at
    4K they drew a network of dark creases ("cotton balls"); the fine turbulent detail now comes
    from the 3D noise in the particle shader, which does not repeat between puffs.)"""
    r = np.random.default_rng(seed)
    t = ((np.arange(S) + 0.5) / S * 2 - 1) * 0.66  # zoom so the puff fills the cell
    x, y = np.meshgrid(t, -t, indexing='xy')
    spheres = []

    def rand_dir(zmin, yb):
        while True:
            v = r.normal(size=3)
            v[1] += yb
            v /= np.linalg.norm(v)
            if v[2] >= zmin:
                return v

    c0 = np.array([0.0, -0.08, 0.0])
    r0 = 0.38
    spheres.append((c0, r0))
    lvl = [(c0, r0)]
    for depth, (nmin, nmax, kmin, kmax, out) in enumerate([(7, 10, 0.5, 0.72, 0.74), (3, 5, 0.42, 0.6, 0.78)]):
        nxt = []
        for (c, rr) in lvl:
            n = int(r.integers(nmin, nmax + 1))
            for _ in range(n):
                d = rand_dir(-0.35 if depth == 0 else -0.05, 0.3 if depth == 0 else 0.2)
                cr = rr * (kmin + (kmax - kmin) * r.random())
                cc = c + d * rr * out
                if np.hypot(cc[0], cc[1]) + cr > 0.64:
                    continue
                spheres.append((cc, cr))
                nxt.append((cc, cr))
        lvl = nxt
    # Relief: soft max (p-norm) of Gaussian domes, one per lobe. Smooth everywhere: no creases between
    # lobes and no normal flip at the silhouette. (Round 5: a metaball z-sweep with hard-surface normals
    # still drew a ring around every small lobe and a dark outline inside each puff's soft edge,
    # visible as circles all over the cloud at 4K.)
    P = 2.0
    Hh = np.zeros((S, S))
    for (c, rr) in spheres:
        Hh += (rr * np.exp(-((x - c[0]) ** 2 + (y - c[1]) ** 2) / (rr * rr))) ** P
    hs = blur(Hh ** (1 / P), 3) * 1.1
    gy, gx = np.gradient(hs)
    px = 2.0 * 0.66 / S
    nx, ny = -gx / px, gy / px
    ln = np.sqrt(nx * nx + ny * ny + 1)
    nx, ny = nx / ln, ny / ln
    # broad cavity AO (between lobes only)
    hb = blur(hs, 20)
    ao = np.clip(1 - np.clip(hb - hs, 0, None) * 3.0, 0.65, 1.0)
    # density: projected Gaussian lobes (a soft volume, not a solid disc: overlapping puffs blend into
    # one cloud and the outer edge fades out; the shader erodes the fade with 3D noise)
    D = np.zeros((S, S))
    for (c, rr) in spheres:
        D += rr * np.exp(-1.25 * ((x - c[0]) ** 2 + (y - c[1]) ** 2) / (rr * rr))
    D /= np.percentile(D, 99.5)
    dens = 1 - np.exp(-3.2 * D)
    dens *= np.clip(1 - (x * x + y * y) / (0.66 * 0.66), 0, 1) ** 0.5
    dens = blur(dens, 2)
    return nx, ny, ao, np.clip(dens, 0, 1)


def wispy_puff(S, seed):
    t = (np.arange(S) + 0.5) / S * 2 - 1
    x, y = np.meshgrid(t, -t, indexing='xy')
    d2 = x * x + y * y
    warp1 = fbm2(S, 3, 4, seed * 5 + 11)
    warp2 = fbm2(S, 3, 4, seed * 5 + 12)
    xw, yw = x + warp1 * 0.35, y + warp2 * 0.35
    dw2 = xw * xw + yw * yw
    base = np.exp(-dw2 * 3.2)
    streak = fbm2(S, 5, 5, seed * 3 + 5)
    dens = np.clip(base * (0.75 + 0.9 * streak), 0, 1) * np.clip(1 - np.sqrt(d2), 0, 1) ** 0.7
    dens = blur(dens, 1)
    h = np.sqrt(np.clip(1 - dw2, 0, 1)) * 0.5 + streak * 0.1
    gy, gx = np.gradient(h * 3.0)
    nx, ny = -gx * S / 64, gy * S / 64
    nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / ln, ny / ln, np.clip(h, 0, 1), dens


def gen_puffs(S=256):
    atlas = np.zeros((2 * S, 4 * S, 4), dtype=np.float64)
    for i in range(4):
        nx, ny, th, d = billow_puff(S, 100 + i)
        atlas[0:S, i * S:(i + 1) * S] = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, th, d], -1)
        nx, ny, th, d = wispy_puff(S, 200 + i)
        atlas[S:2 * S, i * S:(i + 1) * S] = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, th, d], -1)
    img = (np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(img, 'RGBA').save(os.path.join(OUT, 'puffs.png'), optimize=True)
    print('puffs.png', img.shape)


if __name__ == '__main__':
    import sys
    # (`puffs` regenerates only the atlas: the noise volume is shared with the plume shaders)
    if 'puffs' not in sys.argv[1:]:
        gen_noise3d()
    gen_puffs()
