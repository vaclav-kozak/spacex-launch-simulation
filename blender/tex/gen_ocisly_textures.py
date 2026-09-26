"""OCISLY droneship textures (python3 blender/tex/gen_ocisly_textures.py).

Deck (planar, seen from above, bow up):
  u = (26 - x) / 52        x in ship frame (+X = port), deck incl. wings is 52 m wide
  row r <-> z = 45.7 - r / H * 91.4   (row 0 = bow)
Hull side strip (both sides share it; text reads correctly from outside on each side):
  u = along the hull from stern to bow (starboard) / bow to stern (port), 91.4 m
  row r <-> y = -r / H * 6.1 (row 0 = deck edge, bottom row = keel)

Outputs (public/textures/vehicles/):
  ocisly_deck_albedo.jpg / _orm.jpg / _normal.jpg   1024x1800
  ocisly_hull_albedo.jpg / _orm.jpg                  2048x192
"""
import math
import numpy as np
from PIL import Image, ImageDraw
from texlib import *  # noqa

rng = np.random.default_rng(7)

# ---------------------------------------------------------------- deck
DW, DL = 52.0, 91.4
W, H = 1024, 1800
mpx_u, mpx_v = DW / W, DL / H
cols = np.arange(W, dtype=np.float32)[None, :] + 0.5
rows = np.arange(H, dtype=np.float32)[:, None] + 0.5
X = 26.0 - cols * mpx_u + 0 * rows  # ship x (port +)
Z = DL / 2 - rows * mpx_v + 0 * cols  # ship z (bow +)
R = np.sqrt(X * X + Z * Z)

HULL_HALF = 15.25
WING_Z0, WING_Z1 = -30.0, 38.0
on_wing = (np.abs(X) > HULL_HALF)

base = np.zeros((H, W, 3), np.float32) + rgb('#2a2c2e')
# plate-to-plate tone variation (deck plates 2.4 m x 9 m, staggered)
plate_w, plate_l = 2.4, 9.0
pi = np.floor((X + 26) / plate_w)
pj = np.floor((Z + 45.7 + (pi % 2) * plate_l / 2) / plate_l)
ph = (np.sin(pi * 12.9898 + pj * 78.233) * 43758.5453) % 1.0
base *= (0.9 + 0.2 * ph)[..., None]
# wings: lighter galvanised grating-like steel
base = np.where(on_wing[..., None], rgb('#444648') * (0.92 + 0.16 * ph)[..., None], base)

# large-scale grime + wear
n1 = fbm(H, W, 90, 90, 5, seed=1)
n2 = fbm(H, W, 18, 18, 4, seed=2)
base *= (1 + 0.08 * n1 + 0.04 * n2)[..., None]

# weld seams between plates (slightly lighter lines) -> also height
fx = ((X + 26) / plate_w) % 1.0
fz = ((Z + 45.7 + (pi % 2) * plate_l / 2) / plate_l) % 1.0
seam = np.maximum(np.exp(-((np.minimum(fx, 1 - fx) * plate_w) / 0.025) ** 2),
                  np.exp(-((np.minimum(fz, 1 - fz) * plate_l) / 0.025) ** 2))
base = base * (1 - 0.35 * seam[..., None]) + rgb('#555555') * 0.35 * seam[..., None]

# rust patches + streaks toward the edges
rustm = smoothstep(0.78, 1.05, fbm(H, W, 30, 30, 4, seed=3) * 0.5 + 0.5 + 0.18 * smoothstep(20, 26, np.abs(X)))
base = lerp(base, rgb('#4a3322') * (0.8 + 0.4 * n2[..., None] ** 2), rustm[..., None] * 0.22)

# ---------------------------------------------------------------- markings
def draw_mask(fn):
    return mask_from_draw(H, W, fn, 2)


def px(x, z):
    return ((26.0 - x) / mpx_u, (DL / 2 - z) / mpx_v)


R_OUT, R_W = 17.5, 0.8
X_R = 12.0


def marks(d, s):
    # outer white circle ring
    cx, cy = px(0, 0)
    for rr, ww in ((R_OUT, R_W),):
        ro, ri = rr / mpx_u, (rr - ww) / mpx_u
        d.ellipse([(cx - ro) * s, (cy - ro * mpx_u / mpx_v) * s, (cx + ro) * s, (cy + ro * mpx_u / mpx_v) * s], fill=255)
        d.ellipse([(cx - ri) * s, (cy - ri * mpx_u / mpx_v) * s, (cx + ri) * s, (cy + ri * mpx_u / mpx_v) * s], fill=0)
    # X: two thick strokes at +-45 deg spanning the X_R radius
    hw = 1.1
    for sgn in (1, -1):
        a = math.radians(45) * sgn
        dx, dz = math.cos(a), math.sin(a)
        nx, nz = -dz, dx
        pts = [(X_R * dx + hw * nx, X_R * dz + hw * nz), (X_R * dx - hw * nx, X_R * dz - hw * nz),
               (-X_R * dx - hw * nx, -X_R * dz - hw * nz), (-X_R * dx + hw * nx, -X_R * dz + hw * nz)]
        d.polygon([(px(x, z)[0] * s, px(x, z)[1] * s) for x, z in pts], fill=255)


white = draw_mask(marks)


def yellow_fn(d, s):
    # yellow safety band along the landing-area perimeter (hull edges at the ends, wing edges)
    t = 0.35
    for (x0, z0, x1, z1) in [(-26, WING_Z1 - t, 26, WING_Z1), (-26, WING_Z0, 26, WING_Z0 + t),
                             (26 - t, WING_Z0, 26, WING_Z1), (-26, WING_Z0, -26 + t, WING_Z1),
                             (HULL_HALF - t, -45.7, HULL_HALF, 45.7), (-HULL_HALF, -45.7, -HULL_HALF + t, 45.7)]:
        a, b = px(x1, z1), px(x0, z0)
        d.rectangle([min(a[0], b[0]) * s, min(a[1], b[1]) * s, max(a[0], b[0]) * s, max(a[1], b[1]) * s], fill=255)
    # dashed walkway lines along the hull edges outside the wings
    for z in np.arange(-45, -30, 2.0):
        for xx in (HULL_HALF - 1.2, -HULL_HALF + 1.2):
            a, b = px(xx - 0.12, z), px(xx + 0.12, z + 1.0)
            d.rectangle([min(a[0], b[0]) * s, min(a[1], b[1]) * s, max(a[0], b[0]) * s, max(a[1], b[1]) * s], fill=255)


yellow = draw_mask(yellow_fn)
# paint wear
wear = smoothstep(-0.9, 0.3, fbm(H, W, 3, 3, 4, seed=11) + 0.3 * n1)
white *= 0.7 + 0.3 * wear
yellow *= 0.6 + 0.4 * wear
base = lerp(base, rgb('#cfcfca') * (0.85 + 0.15 * n2[..., None]), white[..., None] * 0.92)
base = lerp(base, rgb('#c89a1c'), yellow[..., None] * 0.9)

# ---------------------------------------------------------------- scorch from landings
ang = np.arctan2(Z, X)
streak = fnoise(H, W, 2, 2, seed=21)  # used via polar lookup below
rays = 0.5 + 0.5 * np.sin(ang * 23 + 3 * np.sin(ang * 7)) * np.sin(ang * 37 + 1.3)
rays = rays ** 2
core = 1 - smoothstep(2.5, 9.0, R + 1.5 * n2)
halo = (1 - smoothstep(6, 20, R + 3 * n1)) * (0.4 + 0.6 * rays)
# several offset landings (booster never lands dead centre)
blot = np.zeros_like(R)
for (ox, oz, rr) in [(1.5, -2.0, 7.0), (-3.0, 2.5, 6.0), (4.0, 3.5, 5.0), (-1.0, -4.5, 5.5)]:
    rr2 = np.sqrt((X - ox) ** 2 + (Z - oz) ** 2)
    blot = np.maximum(blot, (1 - smoothstep(rr * 0.4, rr, rr2 + 1.2 * n2)) * 0.7)
scorch = np.clip(np.maximum(core, blot) * 0.95 + halo * 0.6, 0, 1) * (0.75 + 0.25 * smoothstep(-0.5, 0.5, n2))
scorch_col = rgb('#0e0d0c') * (0.8 + 0.4 * (n2[..., None] * 0.5 + 0.5))
base = lerp(base, scorch_col, scorch[..., None] * 0.9)
# brownish heat discolouration ring
ring = np.exp(-((R - 10.5 - 1.5 * n1) / 2.5) ** 2) * 0.35
base = lerp(base, rgb('#3d2c20'), ring[..., None])
# oil / hydraulic stains
oil = smoothstep(0.86, 1.0, fbm(H, W, 10, 10, 3, seed=31) * 0.5 + 0.5) * 0.35
base = lerp(base, rgb('#141312'), oil[..., None])

# tie-down / pad-eye grid (small dots every 3 m inside the landing area)
dots = np.zeros_like(R)
gx = ((X + 1.5) % 3.0) - 1.5
gz = ((Z + 1.5) % 3.0) - 1.5
dots = np.exp(-(gx * gx + gz * gz) / (0.06 ** 2)) * (np.abs(X) < 24) * (Z > WING_Z0 + 1) * (Z < WING_Z1 - 1)
base = lerp(base, rgb('#161616'), dots[..., None] * 0.8)

save_srgb(base, 'ocisly_deck_albedo.jpg', 86)

rough = np.clip(0.8 + 0.04 * n2 - 0.18 * white - 0.12 * yellow + 0.1 * scorch - 0.25 * oil + 0.08 * rustm, 0.3, 1)
ao = np.clip(1 - 0.35 * seam - 0.4 * dots, 0, 1)
save_raw(np.stack([ao, rough, 0.15 * (1 - white - yellow).clip(0, 1) * (1 - rustm)], -1), 'ocisly_deck_orm.jpg', 85)
hgt = -seam * 2.0 + 0.8 * fbm(H, W, 3, 3, 3, seed=41) + 0.5 * white + 0.5 * yellow - 1.5 * dots
save_raw(height_to_normal(hgt, 0.5), 'ocisly_deck_normal.jpg', 88)

# ---------------------------------------------------------------- hull side strip
HW, HH = 2048, 192
L, D = 91.4, 6.1
cols = np.arange(HW, dtype=np.float32)[None, :] + 0.5
rows = np.arange(HH, dtype=np.float32)[:, None] + 0.5
U = cols / HW * L + 0 * rows  # m along hull
Yh = -rows / HH * D + 0 * cols  # 0 deck edge .. -6.1 keel
hb = np.zeros((HH, HW, 3), np.float32) + rgb('#23272b')
hn = fbm(HH, HW, 20, 60, 4, seed=51)
hb *= (1 + 0.12 * hn)[..., None]
# vertical rust streaks running down from the deck edge and scupper holes
st = np.clip(fnoise(HH, HW, 60, 1.5, seed=52), 0, None) * smoothstep(-5.5, -0.2, Yh)
st = smoothstep(0.8, 2.2, st + 0.6 * hn)
hb = lerp(hb, rgb('#5b3a24'), st[..., None] * 0.7)
# waterline: anti-fouling red below -3.2 with a rusty scum line, faded
wl = -3.2
below = smoothstep(wl + 0.05, wl - 0.05, Yh)
hb = lerp(hb, rgb('#5c231c') * (0.8 + 0.3 * hn[..., None]), below[..., None] * 0.9)
scum = np.exp(-((Yh - wl - 0.15 - 0.08 * hn) / 0.25) ** 2)
hb = lerp(hb, rgb('#6a4a30'), scum[..., None] * 0.7)
# deck-edge rubbing strip
edge = smoothstep(-0.35, -0.25, Yh)
hb = lerp(hb, rgb('#3a3c3e'), edge[..., None] * 0.8)
# hull name + builder marking (white, weathered)
nm = np.zeros((HH, HW), np.float32)
f = font('NimbusSans-Bold', 64)
txt = text_mask('OF COURSE I STILL LOVE YOU', f, pad=4, spacing=6)
# top 1.2 m band: this part of the strip is also mapped onto the wing-extension fascia
# (y -1.2..0, z -30..38), where the name is visible from the side
txt = resize_mask(txt, int(0.85 / D * HH), int(txt.shape[1] / txt.shape[0] * 0.85 / (L / HW)))
paste_mask(nm, txt, int(0.62 / D * HH), int(HW * 0.5), wrap_x=False)
f2 = font('NimbusSans-Bold', 48)
t2 = text_mask('MARMAC 300', f2, pad=4, spacing=4)
t2 = resize_mask(t2, int(0.8 / D * HH), int(t2.shape[1] / t2.shape[0] * 0.8 / (L / HW)))
paste_mask(nm, t2, int(1.5 / D * HH), int(HW * 0.9), wrap_x=False)
nm *= 0.75 + 0.25 * smoothstep(-0.5, 0.5, fbm(HH, HW, 3, 3, 3, seed=53))
hb = lerp(hb, rgb('#d8d8d4'), nm[..., None])
# draft marks near both ends
for u0 in (0.01, 0.985):
    c = int(HW * u0)
    for k, yy in enumerate(np.arange(-5.5, -1.5, 0.5)):
        r0 = int(-yy / D * HH)
        hb[r0 - 1:r0 + 2, c - 3:c + 3] = rgb('#d8d8d4')
save_srgb(hb, 'ocisly_hull_albedo.jpg', 86)
hr = np.clip(0.7 + 0.1 * hn + 0.15 * st - 0.2 * nm, 0.3, 1)
save_raw(np.stack([np.ones_like(hr), hr, 0.2 * np.ones_like(hr)], -1), 'ocisly_hull_orm.jpg', 85)
print('done')
