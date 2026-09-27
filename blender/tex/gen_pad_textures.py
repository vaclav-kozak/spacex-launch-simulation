"""SLC-4E pad textures (python3 blender/tex/gen_pad_textures.py).

pad_concrete_albedo/orm/normal.jpg  1024^2 tileable, 1 tile = 8 m, saw-cut slab joints every 4 m.
pad_apron_albedo.jpg                2048^2 unique map of the 160 x 160 m apron around the launch mount
                                    (u = (x + 80) / 160 east, row 0 = north edge z = -80): slab tones,
                                    exhaust scorch around the flame-duct opening and the trench exit
                                    (azimuth 200 deg, 42 m), deluge water stains, rail beds, markings.
pad_ground_albedo.jpg               512^2 tileable gravel, 1 tile = 4 m.
pad_grime_albedo/rough.jpg          1024^2 tileable weathering for painted steel (multiplies the material
                                    colour), 1 tile = 4 m (box-projected UVs, v = height): vertical rain /
                                    run-off streaks, soot and salt-air blotches, rust spots and bleed.
pad_grating_albedo.jpg              512^2 tileable galvanised bar grating, 1 tile = 1 m (30 mm bearing-bar
                                    pitch, 100 mm cross bars), dark see-through gaps.
"""
import math
import numpy as np
from texlib import *  # noqa

# ------------------------------------------------------------------ concrete tile
N, M = 1024, 8.0
yy, xx = np.mgrid[0:N, 0:N].astype(np.float32) + 0.5
X, Y = xx / N * M, yy / N * M
n_big = fbm(N, N, 200, 200, 4, seed=1)
n_mid = fbm(N, N, 26, 26, 4, seed=2)
n_fine = fnoise(N, N, 1.2, 1.2, seed=3)
base = np.zeros((N, N, 3), np.float32) + rgb('#a29f98')
base *= (1 + 0.07 * n_big + 0.04 * n_mid + 0.035 * n_fine)[..., None]
si, sj = np.floor(X / 4), np.floor(Y / 4)
sh = (np.sin(si * 12.9898 + sj * 78.233) * 43758.5453) % 1.0
base *= (0.93 + 0.12 * sh)[..., None]
stain = smoothstep(0.5, 1.6, fbm(N, N, 70, 110, 4, seed=4))
base = lerp(base, rgb('#77726a'), stain[..., None] * 0.35)
pores = smoothstep(2.4, 3.2, white(N, N, 5))
base *= (1 - 0.35 * pores)[..., None]
fx, fy = X % 4.0, Y % 4.0
dj = np.minimum(np.minimum(fx, 4 - fx), np.minimum(fy, 4 - fy))
joint = np.exp(-(dj / 0.014) ** 2)
base = lerp(base, rgb('#3c3a36'), joint[..., None] * 0.85)
save_srgb(base, 'pad_concrete_albedo.jpg', 86)
rough = np.clip(0.88 + 0.05 * n_mid - 0.08 * stain + 0.05 * pores, 0.4, 1)
ao = np.clip(1 - 0.5 * joint - 0.3 * pores, 0, 1)
save_raw(np.stack([ao, rough, np.zeros_like(ao)], -1), 'pad_concrete_orm.jpg', 85)
hgt = -3.0 * joint - 0.8 * pores + 0.35 * n_fine + 0.6 * n_mid
save_raw(height_to_normal(hgt, 0.6), 'pad_concrete_normal.jpg', 88)

# ------------------------------------------------------------------ apron (unique)
A, S = 2048, 160.0
yy, xx = np.mgrid[0:A, 0:A].astype(np.float32) + 0.5
X = xx / A * S - S / 2          # east
Z = yy / A * S - S / 2          # south
R = np.hypot(X, Z)
n1 = fbm(A, A, 300, 300, 5, seed=11)
n2 = fbm(A, A, 40, 40, 4, seed=12)
n3 = fnoise(A, A, 2, 2, seed=13)
ap = np.zeros((A, A, 3), np.float32) + rgb('#a6a39c')
ap *= (1 + 0.06 * n1 + 0.04 * n2 + 0.02 * n3)[..., None]
# 6 m slabs with tone variation + 1 px joints
si, sj = np.floor(X / 6), np.floor(Z / 6)
sh = (np.sin(si * 12.9898 + sj * 78.233) * 43758.5453) % 1.0
ap *= (0.92 + 0.14 * sh)[..., None]
fx, fz = (X / 6) % 1.0, (Z / 6) % 1.0
dj = np.minimum(np.minimum(fx, 1 - fx), np.minimum(fz, 1 - fz)) * 6
jt = np.exp(-(dj / 0.05) ** 2)
ap = lerp(ap, rgb('#4a4843'), jt[..., None] * 0.6)
# deluge water / run-off stains (darker, streaky, radiating from the mount)
th = np.arctan2(Z, X)
wet = smoothstep(0.4, 1.4, fbm(A, A, 22, 22, 4, seed=14) + 0.9 * np.exp(-((R - 14) / 10) ** 2))
ap = lerp(ap, rgb('#6c6962'), wet[..., None] * 0.15)

# scorch around the flame-duct opening (7 x 9 m, long axis along the trench) + rays
az = math.radians(200.0)
dx, dz = math.sin(az), -math.cos(az)      # trench direction (W: x east, z south)
s_ = X * dx + Z * dz                      # along the trench
t_ = X * -dz + Z * dx                     # across
box_d = np.maximum(np.abs(s_) - 4.5, 0) ** 2 + np.maximum(np.abs(t_) - 3.5, 0) ** 2
dbox = np.sqrt(box_d)
# broad irregular scorch lobes (low-order angular harmonics + 2D edge noise)
ang_n = 0.5 * np.sin(3 * th + 1.0) + 0.3 * np.sin(7 * th + 2.0) + 0.2 * np.sin(13 * th + 0.5) + 0.12 * np.sin(29 * th)
scorch = np.exp(-(dbox / np.maximum(2.5, 8 + 3.5 * ang_n + 2.5 * n2)) ** 2)
scorch *= 0.75 + 0.25 * smoothstep(-0.6, 0.6, n2)
# exit fan: beyond 36 m along the trench, spreading
fan_s = s_ - 38
fan = smoothstep(-6, 2, fan_s) * np.exp(-(np.maximum(fan_s, 0) / 42) ** 1.3) * np.exp(-(t_ / (8 + 0.7 * np.maximum(fan_s, 0))) ** 2)
fan *= 0.7 + 0.3 * smoothstep(-0.5, 0.8, n2 + 0.5 * n1)
sc = np.clip(scorch * 0.9 + fan * 0.85, 0, 1)
ap = lerp(ap, rgb('#2c2926') * (0.8 + 0.4 * smoothstep(-1, 1, n2))[..., None], sc[..., None] * 0.9)
# brown heat halo at the scorch edge
halo = np.exp(-((dbox - 9) / 4) ** 2) * 0.25
ap = lerp(ap, rgb('#6a5440'), halo[..., None])

# TE rail beds going north (x = +-5 m) + darker hangar-road wear strip
rail = np.exp(-((np.abs(X) - 5.0) / 0.9) ** 2) * (Z < -6)
ap = lerp(ap, rgb('#5d5a54'), rail[..., None] * 0.5)
# painted markings: yellow safety line around the mount area (radius 22 m, dashed) and a few
# pipe-trench covers (dark steel plates) from the tank farm (east-south-east)
ring = np.exp(-((R - 22) / 0.12) ** 2) * (np.sin(th * 40) > -0.2)
ap = lerp(ap, rgb('#c8a02a'), ring[..., None] * 0.85)
pt_az = math.radians(110)
pdx, pdz = math.sin(pt_az), -math.cos(pt_az)
ps = X * pdx + Z * pdz
pt = X * -pdz + Z * pdx
cover = (np.abs(pt) < 0.7) * (ps > 8) * (ps < 80)
cover_j = np.abs(((ps / 1.5) % 1.0) - 0.5) > 0.46
ap = lerp(ap, rgb('#4c4b48'), (cover * (1 - 0.6 * cover_j))[..., None] * 0.9)
save_srgb(ap, 'pad_apron_albedo.jpg', 85)

# ------------------------------------------------------------------ gravel tile (4 m)
G = 512
g1 = fnoise(G, G, 1.0, 1.0, seed=21)
g2 = fnoise(G, G, 3.0, 3.0, seed=22)
g3 = fbm(G, G, 60, 60, 3, seed=23)
gr = np.zeros((G, G, 3), np.float32) + rgb('#8d8577')
gr *= (1 + 0.18 * g1 + 0.1 * g2 + 0.08 * g3)[..., None]
tint = smoothstep(-0.5, 1.5, fnoise(G, G, 2.0, 2.0, seed=24))
gr = lerp(gr, rgb('#a59a86'), tint[..., None] * 0.4)
dry = smoothstep(0.3, 1.2, g3)
gr = lerp(gr, rgb('#7a7560'), dry[..., None] * 0.3)
save_srgb(gr, 'pad_ground_albedo.jpg', 84)

# ------------------------------------------------------------------ steel weathering (4 m tile)
W = 1024
streak = fnoise(W, W, 70, 2.2, seed=31)             # long vertical run-off streaks
streak2 = fnoise(W, W, 160, 5, seed=32)
blot = fbm(W, W, 90, 90, 4, seed=33)                 # large soot / dirt blotches
fine = fnoise(W, W, 1.0, 1.0, seed=34)
mid = fbm(W, W, 12, 12, 3, seed=35)
dirt = np.clip(0.55 * smoothstep(0.2, 2.2, streak) + 0.35 * smoothstep(0.0, 2.0, streak2)
               + 0.45 * smoothstep(0.1, 1.6, blot), 0, 1)
g = np.zeros((W, W, 3), np.float32) + 1.0
g *= (1 - 0.06 * fine[..., None] * 0.5 - 0.05 * mid[..., None])
g = lerp(g, rgb('#6f6a62'), dirt[..., None] * 0.55)
# rust: sparse spots with short bleed streaks underneath
spots = smoothstep(2.3, 3.0, fnoise(W, W, 3.0, 3.0, seed=36))
bleed = np.clip(gauss(spots, 22, 1.5) * 9, 0, 1)
rust = np.clip(spots + 0.6 * bleed * smoothstep(-0.5, 1.0, streak), 0, 1)
g = lerp(g, rgb('#7a4a2c'), rust[..., None] * 0.6)
g = np.clip(g, 0, 1)
save_srgb(g, 'pad_grime_albedo.jpg', 86)
rgh = np.clip(0.8 + 0.25 * dirt + 0.2 * rust + 0.04 * mid, 0, 1)
save_raw(np.stack([np.ones_like(rgh), rgh, np.ones_like(rgh)], -1), 'pad_grime_rough.jpg', 84)

# ------------------------------------------------------------------ bar grating (1 m tile)
Gt = 512
yy, xx = np.mgrid[0:Gt, 0:Gt].astype(np.float32) + 0.5
u, v = xx / Gt, yy / Gt
bb = np.abs(((u / (1 / 32)) % 1.0) - 0.5) * (1 / 32)       # bearing bars: 32 per metre, 5 mm thick
cb = np.abs(((v / (1 / 10)) % 1.0) - 0.5) * (1 / 10)       # cross bars: 10 per metre, twisted 6 mm
# bars are 30-40 mm deep: at the grazing angles the pad cameras see, they hide most of the gap, so the
# map uses a wider apparent bar than the 5 mm plan-view one
bar = smoothstep(0.0078, 0.0092, bb)      # distance from gap centre -> bar
cross = smoothstep(0.05 - 0.009, 0.05 - 0.007, cb)
solid = np.clip(bar + cross, 0, 1)
gn = fbm(Gt, Gt, 40, 40, 3, seed=41)
gal = np.zeros((Gt, Gt, 3), np.float32) + rgb('#b9bab5')
gal *= (1 + 0.08 * gn)[..., None]
gal = lerp(gal, rgb('#6b6254'), smoothstep(0.4, 1.8, fbm(Gt, Gt, 60, 60, 3, seed=42))[..., None] * 0.5)
gap = rgb('#22211e')
img = lerp(gap + np.zeros_like(gal), gal, solid[..., None])
save_srgb(img, 'pad_grating_albedo.jpg', 88)
print('done')
