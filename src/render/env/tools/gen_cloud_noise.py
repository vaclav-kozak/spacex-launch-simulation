#!/usr/bin/env python3
"""Bake tileable cloud noise for src/render/env/clouds.ts (numpy only, deterministic).

Outputs (public/data/env/):
  cloud_shape.bin   128^3 uint8  Perlin-Worley base shape (x fastest, then y, then z)
  cloud_detail.bin   32^3 uint8  Worley fbm erosion noise
  cloud_weather.bin 1024^2 RGBA8 (tileable; sampled at several scales/rotations by cloudWeather.ts)
                    R: domain-warped fbm (coverage variation), histogram-equalised
                    G: closed-cell field: inhomogeneous-Poisson Voronoi (cell size varies ~3x),
                       domain-warped edges, per-cell strength; 0 on the rifts, 1 in strong cell cores;
                       equalised so thresholding at 1-c covers a fraction ~c
                    B: smooth fbm (layer height / thickness / warp)
                    A: open-cell walls: coarse warped Voronoi (cell size ~2x), broken beaded walls (1 on a
                       wall), per-cell clear-centre size, equalised
Run: python3 src/render/env/tools/gen_cloud_noise.py [weather]   ("weather" = only the weather map)
"""
import os
import numpy as np

OUT = os.environ.get('CLOUD_NOISE_OUT') or os.path.join(os.path.dirname(__file__), '../../../../public/data/env')
rng = np.random.default_rng(1337)


def fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def perlin(coords, period, rng=rng):
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


def fbm(fn, uv, base, octaves, gain=0.5, **kw):
    s, a, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        f = base * (2 ** o)
        s = s + a * fn(uv * f, f, **kw)
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

    weather()


def equalize(a):
    """histogram equalisation to a uniform [0,1] distribution (rank transform)"""
    f = a.ravel()
    r = np.empty(f.size)
    r[np.argsort(f, kind='stable')] = (np.arange(f.size) + 0.5) / f.size
    return r.reshape(a.shape)


def poisson_points(n_mean, dens, rng, kmin=0.6):
    """tileable inhomogeneous point set in [0,1)^2 with ~n_mean points; dens = relative density grid.
    Thinned Poisson candidates, then dart throwing with a minimum distance of kmin x the local mean
    spacing (pure Poisson clusters seeds, which makes sliver cells: thin rifts through a cell)."""
    g = dens.shape[0]
    dmean = dens.mean()
    n_c = rng.poisson(1.6 * n_mean / dmean)
    p = rng.random((n_c, 2))
    ij = np.minimum((p * g).astype(int), g - 1)
    dl = dens[ij[:, 1], ij[:, 0]]
    p = p[rng.random(n_c) < dl / dens.max()]
    dl = dens[np.minimum((p[:, 1] * g).astype(int), g - 1), np.minimum((p[:, 0] * g).astype(int), g - 1)]
    rmin = kmin / np.sqrt(n_mean * dl / dmean)
    acc = np.zeros((0, 2))
    for q, r in zip(p, rmin):
        if len(acc):
            d = acc - q
            d -= np.round(d)
            if np.min(d[:, 0] ** 2 + d[:, 1] ** 2) < r * r:
                continue
        acc = np.vstack([acc, q])
        if len(acc) >= n_mean:
            break
    return acc


def _hash_bins(pts, nb):
    M = len(pts)
    b = np.minimum((pts * nb).astype(int), nb - 1)
    key = b[:, 1] * nb + b[:, 0]
    order = np.argsort(key, kind='stable')
    counts = np.bincount(key, minlength=nb * nb)
    starts = np.cumsum(counts) - counts
    table = np.full((nb * nb, counts.max()), -1, dtype=np.int64)
    sk = key[order]
    table[sk, np.arange(M) - starts[sk]] = order
    return table


def _candidates(Q, table, nb, R):
    """yield (sel, pi, delta) for every seed in the (2R+1)^2 bins around each query (periodic)"""
    gx = np.minimum((Q[:, 0] * nb).astype(int), nb - 1)
    gy = np.minimum((Q[:, 1] * nb).astype(int), nb - 1)
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            cell = ((gy + dy) % nb) * nb + (gx + dx) % nb
            for k in range(table.shape[1]):
                idx = table[cell, k]
                sel = np.flatnonzero(idx >= 0)
                if sel.size:
                    yield sel, idx[sel]


def cell_edge(P, pts, nb, R=3):
    """periodic Voronoi of the query positions P (..., 2) (tile units) against the seeds pts (M, 2) in
    [0,1) via a spatial hash (nb bins per axis, (2R+1)^2 bins searched). Returns the normalised
    distance to the cell wall (exact: min over the neighbours of the bisector distance; 0 on the wall,
    1 at the seed, continuous inside the cell) and the nearest / second-nearest seed ids."""
    shp = P.shape[:-1]
    Q = (P % 1.0).reshape(-1, 2)
    n = len(Q)
    table = _hash_bins(pts, nb)
    d1 = np.full(n, np.inf); d2 = np.full(n, np.inf)
    i1 = np.zeros(n, np.int64); i2 = np.zeros(n, np.int64)
    for sel, pi in _candidates(Q, table, nb, R):
        d = pts[pi] - Q[sel]
        d -= np.round(d)
        dd = d[:, 0] ** 2 + d[:, 1] ** 2
        a1, a2, b1, b2 = d1[sel], d2[sel], i1[sel], i2[sel]
        bet1 = dd < a1
        bet2 = ~bet1 & (dd < a2)
        d2[sel] = np.where(bet1, a1, np.where(bet2, dd, a2))
        i2[sel] = np.where(bet1, b1, np.where(bet2, pi, b2))
        d1[sel] = np.where(bet1, dd, a1)
        i1[sel] = np.where(bet1, pi, b1)
    # pass 2: exact wall distance
    e = np.full(n, np.inf)
    for sel, pi in _candidates(Q, table, nb, R):
        own = i1[sel]
        m = pi != own
        sel, pi, own = sel[m], pi[m], own[m]
        d = pts[pi] - Q[sel]
        d -= np.round(d)
        s = pts[pi] - pts[own]
        s -= np.round(s)
        sl = np.sqrt(s[:, 0] ** 2 + s[:, 1] ** 2) + 1e-9
        ej = (d[:, 0] ** 2 + d[:, 1] ** 2 - d1[sel]) / (2 * sl)
        e[sel] = np.minimum(e[sel], ej)
    # per seed: half the nearest-neighbour distance (= wall distance at the seed)
    nn = np.full(len(pts), np.inf)
    for sel, pi in _candidates(pts, table, nb, R):
        m = pi != sel
        d = pts[pi[m]] - pts[sel[m]]
        d -= np.round(d)
        np.minimum.at(nn, sel[m], np.sqrt(d[:, 0] ** 2 + d[:, 1] ** 2))
    en = np.clip(e / (0.5 * nn[i1]), 0, 1)
    rn = np.sqrt(d1) / nn[i1]  # distance from the own seed / nearest-neighbour spacing
    return en.reshape(shp), i1.reshape(shp), i2.reshape(shp), rn.reshape(shp)


def weather():
    """1024^2 weather map (see the module docstring); own RNG so shape/detail stay unchanged"""
    wr = np.random.default_rng(4242)
    n = 1024
    uv = grid(n, 2)
    P = lambda *a, **k: perlin(*a, rng=wr, **k)

    # R: domain-warped coverage fbm
    wx = fbm(P, uv, 2, 3, 0.5)
    wy = fbm(P, uv + 0.37, 2, 3, 0.5)
    q = uv + 0.22 * np.stack([wx, wy], -1)
    r = equalize(fbm(P, q, 3, 7, 0.55))
    print('  R done')

    # B: smooth fbm (height / thickness / warp)
    b = norm01(fbm(P, uv, 2, 4, 0.45))

    # G: closed cells. Poisson seeds whose density varies ~8x (cell size ~2.8x) with a low-frequency
    # field; lookup positions domain-warped so the cell walls wiggle
    dg = 64
    dens = np.exp2(3.0 * (norm01(fbm(P, grid(dg, 2), 2, 3, 0.5)) - 1.0))
    pts = poisson_points(36 * 36, dens, wr)
    amp = 0.3 + 0.7 * wr.random(len(pts)) ** 0.6
    warp = np.stack([fbm(P, uv, 12, 3, 0.5), fbm(P, uv + 0.51, 12, 3, 0.5)], -1) * 0.02
    warp += np.stack([fbm(P, uv, 48, 2, 0.5), fbm(P, uv + 0.29, 48, 2, 0.5)], -1) * 0.006
    en, i1, _, rn = cell_edge(uv + warp, pts, 32)
    fine = fbm(P, uv, 48, 3, 0.5)
    # soft domes (no flat polygon tops) + turbulent texture, so a partial cover breaks the cells into
    # irregular clumps with ragged edges instead of cut-out polygons
    tex = norm01(fbm(P, uv, 20, 5, 0.6)) - 0.5
    # rounded dome: saturating wall distance (no medial-axis ridges) x radial falloff from the seed
    dome = (1 - np.exp(-3.0 * en)) * (0.5 + 0.5 * np.exp(-(rn / 0.75) ** 2))
    g = amp[i1] * dome + 0.6 * tex
    g = equalize(g)
    print('  G done', len(pts), 'cells')

    # A: open cells. Coarse seeds (~11 per tile; density varies ~4x, so cell size ~2x, and a looser
    # minimum distance than G), strongly warped; walls of varying width, broken into beads (cumulus
    # rings around clear cell centres). Each cell gets its own clear-centre size and a ~1-2 cell
    # fbm shifts the ramp, so under a mostly closed deck the holes differ in size and outline (some
    # close up) instead of a lattice of similar ovals toward the horizon
    dA = np.exp2(2.0 * (norm01(fbm(P, grid(16, 2), 3, 2, 0.5)) - 1.0))
    pts2 = poisson_points(11 * 11, dA, wr, kmin=0.55)
    warp2 = np.stack([fbm(P, uv, 4, 4, 0.5), fbm(P, uv + 0.23, 4, 4, 0.5)], -1) * 0.035
    en2, j1, j2, _ = cell_edge(uv + warp2, pts2, 10)
    wid = 0.16 + 0.22 * wr.random(len(pts2))
    ww = 0.5 * (wid[j1] + wid[j2])
    wall = np.exp(-(en2 / ww) ** 2)
    brk = norm01(fbm(P, uv, 24, 3, 0.5))
    beads = norm01(fbm(P, uv, 64, 2, 0.5))
    hs = 0.55 + 1.1 * wr.random(len(pts2))  # per-cell clear-centre scale (> 1: flat clear core)
    hv = norm01(fbm(P, uv, 6, 3, 0.5))
    # walls broken into beads; a gentle ramp toward the wall inside the cell so a higher coverage
    # threshold thickens the walls (cells close up) instead of speckling the clear centres. The ramp
    # is monotonic in the wall distance (no ring-shaped holes) and 0.3 on every wall (continuous)
    ramp = 0.3 * (1 - np.minimum(en2 * hs[j1], 1)) ** 2 + 0.07 * hv
    a = wall * (0.35 + 0.65 * np.clip((brk - 0.25) / 0.5, 0, 1)) * (0.55 + 0.45 * beads) + ramp
    a = equalize(a)
    print('  A done', len(pts2), 'cells')

    rgba = np.stack([to_u8(r), to_u8(g), to_u8(b), to_u8(a)], axis=-1)
    rgba.tofile(os.path.join(OUT, 'cloud_weather.bin'))
    print('weather', rgba.shape, r.mean(), g.mean(), b.mean(), a.mean())


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['weather']:
        os.makedirs(OUT, exist_ok=True)
        weather()
    else:
        main()
