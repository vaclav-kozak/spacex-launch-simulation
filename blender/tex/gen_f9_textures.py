"""Falcon 9 Block 5 procedural textures (python3 blender/tex/gen_f9_textures.py).

Cylindrical layout for every stage texture (matches the UVs written by blender/build_falcon9.py):
  column c  <->  body angle a = 360 * (1 - c / W)   (a measured from body +X toward +Z, i.e. the
                                                     image reads correctly when seen from outside)
  row r     <->  y = yTop - r / H * (yTop - yBot)    (row 0 = top)

Outputs (public/textures/vehicles/):
  s1_tank_{clean,soot}_albedo.jpg   1024x4096, y 1.35..40.3 (S1 body coords)
  s1_tank_{clean,soot}_orm.jpg      AO / roughness / metalness
  s1_tank_normal.jpg
  s1_inter_{clean,soot}_albedo.jpg  1024x640, y 40.3..47.0
  s1_inter_{clean,soot}_orm.jpg, s1_inter_normal.jpg
  s2_tank_albedo.jpg / s2_tank_orm.jpg / s2_tank_normal.jpg   1024x1024, S2 y 3.9..13.8
  fairing_{clean,soot}_albedo.jpg, fairing_orm.jpg, fairing_normal.jpg  2048x1024 (u around, v = profile)
  m1d_bell.jpg                      64x512 heat-tint strip (v along nozzle, row 0 = top)
"""
import math
import numpy as np
from texlib import *  # noqa
from logos import spacex_wordmark, us_flag, stencil_lines

RNG = np.random.default_rng(42)

# ---------------------------------------------------------------- S1 tank
W, H = 1024, 4096
Y_TOP, Y_BOT = 40.3, 1.35
CIRC = 2 * math.pi * 1.83
PX_U = CIRC / W  # m per px around
PX_V = (Y_TOP - Y_BOT) / H


def col_of(a_deg):
    return (W * (1 - (a_deg % 360) / 360.0)) % W


def row_of(y, yt=Y_TOP, yb=Y_BOT, h=H):
    return (yt - y) / (yt - yb) * h


rows = np.arange(H, dtype=np.float32)[:, None]
cols = np.arange(W, dtype=np.float32)[None, :]
Y = Y_TOP - rows / H * (Y_TOP - Y_BOT) + 0 * cols  # (H, W) body y
A = (360.0 * (1 - cols / W)) % 360 + 0 * rows  # body angle deg


def ang_dist(a, b):
    d = (a - b + 180) % 360 - 180
    return np.abs(d)


LEG_ANGLES = [0, 90, 180, 270]
FIN_ANGLES = [45, 135, 225, 315]
RCS_ANGLES = [90, 270]
RACEWAY_A = 115.0
LOGO_A = 45.0

# --- weld seams (circumferential) and a few longitudinal panel seams per barrel
SEAMS = [3.0, 5.65, 8.3, 10.95, 13.6, 16.3, 18.95, 21.6, 24.25, 26.9, 29.55, 32.2, 34.85, 37.5, 40.3]
hgt = np.zeros((H, W), np.float32)
seam_dark = np.zeros((H, W), np.float32)
for i, ys in enumerate(SEAMS):
    r = row_of(ys)
    d = np.abs(rows - r) * PX_V  # meters from seam
    bead = np.exp(-(d / 0.012) ** 2)  # ~2.4 cm weld bead
    groove = np.exp(-(d / 0.004) ** 2)
    strength = 1.6 if ys in (16.3, 3.0) else 1.0
    hgt += (bead * 0.8 - groove * 0.9) * strength + 0 * cols
    seam_dark += (groove * 0.5 + bead * 0.12) * strength + 0 * cols
# longitudinal friction-stir seams, 2 per barrel at staggered angles
for i in range(len(SEAMS) - 1):
    y0, y1 = SEAMS[i], SEAMS[i + 1]
    for k in range(2):
        a = (37 + i * 71 + k * 180) % 360
        c = col_of(a)
        dc = np.minimum(np.abs(cols - c), W - np.abs(cols - c)) * PX_U
        inb = ((Y > y0) & (Y < y1)).astype(np.float32)
        hgt += inb * (np.exp(-(dc / 0.01) ** 2) * 0.35)
        seam_dark += inb * np.exp(-(dc / 0.006) ** 2) * 0.12
# aft skirt / thrust section rivet rows and panel joints (y 1.35 .. 3.0)
for yr in (2.15, 2.9, 39.95, 40.2):
    r = row_of(yr)
    d = np.abs(rows - r) * PX_V
    band = (d < 0.012).astype(np.float32)
    phase = (cols * PX_U / 0.05) % 1.0
    rivet = np.exp(-(((phase - 0.5) * 0.05) / 0.006) ** 2) * np.exp(-(d / 0.006) ** 2)
    hgt += rivet * 1.2 + 0 * band
    seam_dark += rivet * 0.25

# low-frequency skin waviness (oil canning between internal stringers, subtle)
wav = fnoise(H, W, 60, 18, seed=3) * 0.25 + fnoise(H, W, 300, 40, seed=4) * 0.35
hgt += wav

# ---- leg stowage footprints (the clean pentagons on flown boosters) and the fixed leg fairings
leg_mask = np.zeros((H, W), np.float32)
for la in LEG_ANGLES:
    dA = ang_dist(A, la) / 360.0 * CIRC  # tangential meters
    # footprint half-width tapers from 0.55 m at the bottom to a point at y = 10.6
    hw = np.where(Y < 9.2, 0.56, 0.56 * np.clip((10.6 - Y) / 1.4, 0, 1))
    inside = (dA < hw) & (Y > 1.4) & (Y < 10.6)
    edge = np.clip((hw - dA) / 0.03, 0, 1)
    leg_mask = np.maximum(leg_mask, inside * edge)

# ---- raceway shadow strip (the raceway itself is geometry; its sides stay cleaner)
dr = ang_dist(A, RACEWAY_A) / 360 * CIRC
race_shadow = np.exp(-(np.maximum(dr - 0.16, 0) / 0.12) ** 2) * (Y > 2.3)

# ---------------------------------------------------------------- CLEAN albedo
paint = rgb('#e4e4e1')
alb = np.ones((H, W, 3), np.float32) * paint
pv = fnoise(H, W, 200, 90, seed=7) * 0.012 + fnoise(H, W, 30, 12, seed=8) * 0.006
# per-barrel slight tint differences (panels painted/sprayed separately)
for i in range(len(SEAMS) - 1):
    inb = ((Y >= SEAMS[i]) & (Y < SEAMS[i + 1]))[..., None]
    alb = np.where(inb, alb * (1 + (RNG.random() - 0.5) * 0.025), alb)
alb *= (1 + pv)[..., None]
alb *= (1 - seam_dark * 0.25)[..., None]

# faint grime from handling / transport (even new boosters): very light, lower part
grime = np.clip(fnoise(H, W, 80, 40, seed=9) * 0.5 + 0.2, 0, 1) * smoothstep(8, 2, Y) * 0.06
alb *= (1 - grime)[..., None]

# aft skirt band just above the octaweb is black thermal-protection coating (y 1.35 .. 2.1)
skirt = (Y < 2.12).astype(np.float32)
black = rgb('#1b1b1c')
alb = alb * (1 - skirt[..., None]) + black * skirt[..., None]

# ---- markings
ink = np.zeros((H, W), np.float32)
wm = spacex_wordmark(cap=150)  # horizontal
# vertical, reading top->bottom (letters rotated 90deg clockwise)
wm_v = np.rot90(wm, k=-1)
# scale: total logo height ~9.4 m on the tank, letter width ~1.05 m
target_h = int(9.4 / PX_V)
target_w = int(target_h * wm_v.shape[1] / wm_v.shape[0] * (PX_V / PX_U))
wm_v = resize_mask(wm_v, target_h, target_w)
paste_mask(ink, wm_v, row_of(11.2), col_of(LOGO_A))
logo_ink = ink.copy()

# US flag near the top of the tank (same side as the logo)
flag_w = int(1.55 / PX_U)
flag = us_flag(flag_w)
fh = int(flag.shape[0] * PX_U / PX_V)
from PIL import Image as _I
flag = np.stack([resize_mask(flag[..., k], fh, flag_w) for k in range(3)], -1)
fr0 = int(row_of(37.2) - fh / 2)
fc0 = int(col_of(LOGO_A) - flag_w / 2)
flag_mask = np.zeros((H, W), np.float32)
for yy in range(fh):
    xs = (np.arange(flag_w) + fc0) % W
    alb[fr0 + yy, xs] = flag[yy]
    flag_mask[fr0 + yy, xs] = 1

# small stencil placards (hazard / handling labels) - tiny, only visible close up
def placard(y, a, lines, wm=0.42, hm=0.14):
    w = int(wm / PX_U)
    h = int(hm / PX_V)
    m = stencil_lines(w, h, lines, max(4, int(h / (len(lines) * 1.35))))
    paste_mask(ink, m * 0.9, row_of(y), col_of(a))

placard(3.6, 20, ['DANGER', 'HIGH PRESSURE'])
placard(3.6, 200, ['CAUTION', 'NO STEP'])
placard(39.2, 170, ['LOX', 'VENT'])
placard(17.2, 300, ['RP-1 / LOX', 'CMN DOME'])
placard(35.9, LOGO_A, ['FALCON 9'], wm=0.9, hm=0.16)

alb = alb * (1 - ink[..., None]) + rgb('#101012') * ink[..., None]

clean_alb = alb.copy()

# ---------------------------------------------------------------- ORM (clean)
rough = 0.40 + fnoise(H, W, 120, 60, seed=11) * 0.03 + seam_dark * 0.1
rough = np.where(skirt > 0, 0.7, rough)
rough = np.where(ink > 0.5, 0.35, rough)
ao = 1 - race_shadow * 0.18 - np.exp(-((Y - 40.3) / 0.08) ** 2) * 0.25 - np.exp(-((Y - 2.1) / 0.05) ** 2) * 0.3
metal = np.zeros_like(rough)
orm_clean = np.stack([np.clip(ao, 0, 1), np.clip(rough, 0, 1), metal], -1)

# ---------------------------------------------------------------- SOOT (flight-proven)
# base density vs height: heavy below the common dome (16.3 m), clean band, grey upper third
base = np.zeros((H, W), np.float32)
base += smoothstep(17.6, 15.6, Y) * 0.86                  # lower third
base += (smoothstep(22.5, 30, Y) * 0.45 + smoothstep(33, 39.5, Y) * 0.35) * smoothstep(16.5, 22.5, Y)
base += smoothstep(6, 1.6, Y) * 0.12                      # blackened near the octaweb
# ragged soot front at the common dome: fingers streak upward (flow is base->nose during burns)
fing = fnoise(H, W, 220, 5, seed=21) * 0.8 + fnoise(H, W, 60, 12, seed=22) * 0.5
front = 16.3 + np.clip(fing, -1.5, 3.0) * 0.55
base = np.maximum(base, (Y < front) * 0.82 * smoothstep(13.0, 15.5, Y) + 0 * base)

# vertical streaks at several scales (kept moderate: real deposits are mottled, not bar-coded)
st1 = fnoise(H, W, 380, 2.5, seed=31)
st2 = fnoise(H, W, 900, 8.0, seed=32)
st3 = fnoise(H, W, 160, 1.3, seed=33)
blotch = fnoise(H, W, 110, 45, seed=34)
large = fnoise(H, W, 500, 140, seed=36)
streak = st1 * 0.22 + st2 * 0.45 + st3 * 0.10 + blotch * 0.30 + large * 0.30
upper = smoothstep(18.0, 24.0, Y)       # 1 in the upper zone
lower = 1 - smoothstep(15.0, 18.5, Y)
amp = 0.10 + 0.20 * upper * (1 - lower)
D = base + streak * amp
# sparse long dark streaks through the clean band
sparse = np.clip(fnoise(H, W, 1400, 3.0, seed=35) * 1.0 - 1.4, 0, 1) * 0.5
D += sparse * smoothstep(16.0, 18.0, Y) * smoothstep(26, 22, Y)
# leg footprints stay nearly clean, with a dark outline where soot built up against the leg edge
D = D * (1 - leg_mask * 0.93)
outline = np.clip(leg_mask * (1 - leg_mask) * 4, 0, 1)
D += outline * 0.4 * (Y < 10.6)
# raceway lee side slightly cleaner
D -= race_shadow * 0.12
D = np.clip(D, 0, 1)

# soot colour: dark brown-black low down (landing/entry burn plume), lighter grey-brown up high
tone = np.clip(fnoise(H, W, 260, 90, seed=41) * 0.5 + 0.5, 0, 1)[..., None]
soot_low = rgb('#241f1b') * (1 - tone * 0.4) + rgb('#3b342e') * (tone * 0.4)
soot_up = rgb('#5b5650') * (1 - tone * 0.5) + rgb('#3e3934') * (tone * 0.5)
soot_col = soot_low * lower[..., None] + soot_up * (1 - lower[..., None])
# fine streak tint inside the soot (thicker deposit lines)
soot_col *= (1 - np.clip(st1 * 0.12 + st3 * 0.06, -0.2, 0.3))[..., None]
k = np.power(D, 0.9)[..., None]
alb_s = clean_alb * (1 - k) + soot_col * k

# brown heat-scorch / oxidised patches near the top and under the grid fins
sc = np.zeros((H, W), np.float32)
for fa in FIN_ANGLES + RCS_ANGLES:
    dA = ang_dist(A, fa) / 360 * CIRC
    sc += np.exp(-(dA / 0.9) ** 2) * smoothstep(36.0, 39.8, Y) * 0.8
sc *= np.clip(fnoise(H, W, 40, 30, seed=51) * 0.6 + 0.6, 0, 1)
sc = np.clip(sc, 0, 1)
scorch_col = rgb('#5a3a22')
alb_s = alb_s * (1 - sc[..., None] * 0.7) + scorch_col * (sc[..., None] * 0.7)

# markings still visible through soot (black ink stays black, flag darkened)
alb_s = np.where(flag_mask[..., None] > 0, alb_s * 0.55 + clean_alb * 0.2, alb_s)
alb_s = alb_s * (1 - logo_ink[..., None] * 0.6) + rgb('#0d0d0e') * (logo_ink[..., None] * 0.6)

rough_s = np.clip(rough * (1 - D) + (0.82 + fnoise(H, W, 60, 8, seed=61) * 0.05) * D, 0, 1)
orm_soot = np.stack([np.clip(ao, 0, 1), rough_s, metal], -1)

# ---------------------------------------------------------------- normal
nrm = height_to_normal(hgt, strength=0.9)

save_srgb(clean_alb, 's1_tank_clean_albedo.jpg', 88)
save_srgb(alb_s, 's1_tank_soot_albedo.jpg', 88)
save_raw(orm_clean, 's1_tank_clean_orm.jpg', 85)
save_raw(orm_soot, 's1_tank_soot_orm.jpg', 85)
save_raw(nrm, 's1_tank_normal.jpg', 90)

# ---------------------------------------------------------------- S1 interstage (black)
IW, IH = 1024, 640
IY_T, IY_B = 47.0, 40.3
ir = np.arange(IH, dtype=np.float32)[:, None]
ic = np.arange(IW, dtype=np.float32)[None, :]
IY = IY_T - ir / IH * (IY_T - IY_B) + 0 * ic
IA = (360.0 * (1 - ic / IW)) % 360 + 0 * ir
ipx_v = (IY_T - IY_B) / IH
ipx_u = CIRC / IW
ih = np.zeros((IH, IW), np.float32)
# composite panel joints: 12 longitudinal + 2 circumferential, rivet rows
for k in range(12):
    a = k * 30 + 15
    d = ang_dist(IA, a) / 360 * CIRC
    ih += np.exp(-(d / 0.006) ** 2) * -0.8
for yy in (40.45, 43.4, 46.85):
    d = np.abs(IY - yy)
    ih += np.exp(-(d / 0.006) ** 2) * -0.8
    ph = (ic * ipx_u / 0.06) % 1
    ih += np.exp(-(((ph - 0.5) * 0.06) / 0.007) ** 2) * np.exp(-((d - 0.04) / 0.007) ** 2) * 1.2
ih += fnoise(IH, IW, 30, 30, seed=71) * 0.2
ib = rgb('#161617')
ialb = np.ones((IH, IW, 3), np.float32) * ib * (1 + fnoise(IH, IW, 60, 40, seed=72)[..., None] * 0.08)
irough = 0.62 + fnoise(IH, IW, 40, 40, seed=73) * 0.04
# sooty: brownish-grey discolouration + burnt patches around the fins, streaks downward->upward
iD = np.clip(0.45 + fnoise(IH, IW, 120, 3, seed=74) * 0.25 + fnoise(IH, IW, 40, 25, seed=75) * 0.15, 0, 1)
burn = np.zeros((IH, IW), np.float32)
for fa in FIN_ANGLES:
    d = ang_dist(IA, fa) / 360 * CIRC
    burn += np.exp(-(d / 0.8) ** 2) * np.exp(-((IY - 45.6) / 1.2) ** 2)
for ra in RCS_ANGLES:
    d = ang_dist(IA, ra) / 360 * CIRC
    burn += np.exp(-(d / 0.5) ** 2) * np.exp(-((IY - 43.2) / 1.6) ** 2) * 0.8
burn = np.clip(burn * (0.6 + 0.6 * fnoise(IH, IW, 25, 20, seed=76)), 0, 1)
ialb_s = ialb * (1 - iD[..., None] * 0.3) + rgb('#2e2a26') * (iD[..., None] * 0.3)
ialb_s = ialb_s * (1 - burn[..., None] * 0.6) + rgb('#4a3726') * (burn[..., None] * 0.6)
irough_s = np.clip(irough + iD * 0.18 + burn * 0.1, 0, 1)
iao = 1 - np.exp(-((IY - 40.3) / 0.1) ** 2) * 0.3
save_srgb(ialb, 's1_inter_clean_albedo.jpg', 88)
save_srgb(ialb_s, 's1_inter_soot_albedo.jpg', 88)
save_raw(np.stack([iao, irough, 0 * iao], -1), 's1_inter_clean_orm.jpg', 85)
save_raw(np.stack([iao, irough_s, 0 * iao], -1), 's1_inter_soot_orm.jpg', 85)
save_raw(height_to_normal(ih, 0.8), 's1_inter_normal.jpg', 90)

# ---------------------------------------------------------------- S2 tank (white)
SW, SH = 1024, 1024
SY_T, SY_B = 13.8, 3.9
sr = np.arange(SH, dtype=np.float32)[:, None]
sc_ = np.arange(SW, dtype=np.float32)[None, :]
SY = SY_T - sr / SH * (SY_T - SY_B) + 0 * sc_
SA = (360.0 * (1 - sc_ / SW)) % 360 + 0 * sr
spv = (SY_T - SY_B) / SH
sh_ = np.zeros((SH, SW), np.float32)
sdark = np.zeros((SH, SW), np.float32)
for yy in (4.62, 6.9, 9.5, 12.1, 13.55):
    d = np.abs(SY - yy)
    sh_ += np.exp(-(d / 0.012) ** 2) * 0.8 - np.exp(-(d / 0.004) ** 2) * 0.9
    sdark += np.exp(-(d / 0.004) ** 2) * 0.5
sh_ += fnoise(SH, SW, 50, 20, seed=81) * 0.25
salb = np.ones((SH, SW, 3), np.float32) * paint * (1 + fnoise(SH, SW, 80, 40, seed=82)[..., None] * 0.012)
salb *= (1 - sdark * 0.25)[..., None]
# aft skirt band (black/grey) below 4.62 m
sk = (SY < 4.6).astype(np.float32)[..., None]
salb = salb * (1 - sk) + rgb('#2a2a2c') * sk
sink = np.zeros((SH, SW), np.float32)
m = stencil_lines(int(0.5 / (CIRC / SW)), int(0.12 / spv), ['CAUTION', 'PRESSURIZED'], 6)
paste_mask(sink, m, (SY_T - 5.3) / spv, col_of(200) * SW / W)
salb = salb * (1 - sink[..., None]) + rgb('#101012') * sink[..., None]
srough = np.where(sk[..., 0] > 0, 0.6, 0.4 + fnoise(SH, SW, 60, 30, seed=83) * 0.03)
save_srgb(salb, 's2_tank_albedo.jpg', 88)
save_raw(np.stack([np.ones_like(srough), srough, 0 * srough], -1), 's2_tank_orm.jpg', 85)
save_raw(height_to_normal(sh_, 0.8), 's2_tank_normal.jpg', 90)

# ---------------------------------------------------------------- fairing (u around, v = profile arc)
FW, FH = 2048, 1024
fr = np.arange(FH, dtype=np.float32)[:, None]
fc = np.arange(FW, dtype=np.float32)[None, :]
FA = (360.0 * (1 - fc / FW)) % 360 + 0 * fr
FV = 1 - fr / FH + 0 * fc  # 0 at base, 1 at tip (profile arc fraction)
fh_ = fnoise(FH, FW, 60, 60, seed=91) * 0.15
fdark = np.zeros((FH, FW), np.float32)
# separation seam at a = 90 / 270 (the split plane x = 0 lies at body angles 90 and 270)
for sa in (90, 270):
    d = ang_dist(FA, sa)
    fh_ += np.exp(-(d / 0.18) ** 2) * -1.5
    fdark += np.exp(-(d / 0.12) ** 2) * 0.6
# base ring joint + a few composite ply lines / access doors
for vv in (0.012, 0.085, 0.47):
    d = np.abs(FV - vv) * FH
    fh_ += np.exp(-(d / 1.2) ** 2) * -1.0
    fdark += np.exp(-(d / 0.8) ** 2) * 0.25
falb = np.ones((FH, FW, 3), np.float32) * rgb('#ececea') * (1 + fnoise(FH, FW, 90, 90, seed=92)[..., None] * 0.012)
falb *= (1 - fdark * 0.35)[..., None]
# door outlines
def rect_outline(mask, v0, v1, a0, a1, t=1.2):
    c0, c1 = sorted((col_of(a0) * FW / W, col_of(a1) * FW / W))
    r0, r1 = sorted(((1 - v1) * FH, (1 - v0) * FH))
    inside = (fr >= r0) & (fr <= r1) & (fc >= c0) & (fc <= c1)
    inner = (fr >= r0 + t) & (fr <= r1 - t) & (fc >= c0 + t) & (fc <= c1 - t)
    mask += (inside & ~inner).astype(np.float32)

door = np.zeros((FH, FW), np.float32)
rect_outline(door, 0.16, 0.24, 20, 34)
rect_outline(door, 0.16, 0.24, 200, 214)
rect_outline(door, 0.33, 0.37, 150, 156)
falb *= (1 - door * 0.35)[..., None]
fh_ -= door * 0.8
# SpaceX wordmark vertically on half A (+X side, a = 0)
fink = np.zeros((FH, FW), np.float32)
wmf = np.rot90(spacex_wordmark(cap=120), k=-1)
fcirc = math.pi * 5.2
tgt_h = int(0.42 * FH)  # ~5.5 m of the profile
tgt_w = int(tgt_h * wmf.shape[1] / wmf.shape[0] * ((13.1 * 1.03 / FH) / (fcirc / FW)))
paste_mask(fink, resize_mask(wmf, tgt_h, tgt_w), FH * (1 - 0.36), col_of(0) * FW / W)
falb = falb * (1 - fink[..., None]) + rgb('#111113') * fink[..., None]
frough = 0.42 + fnoise(FH, FW, 80, 80, seed=93) * 0.03
# reused-fairing grime: faint streaks + sooty seam
fD = np.clip(fnoise(FH, FW, 200, 4, seed=94) * 0.12 + 0.1 + smoothstep(0.3, 0.0, FV) * 0.15, 0, 1)
fD += np.exp(-(ang_dist(FA, 90) / 3) ** 2) * 0.25 + np.exp(-(ang_dist(FA, 270) / 3) ** 2) * 0.25
fD = np.clip(fD, 0, 1)
falb_s = falb * (1 - fD[..., None]) + rgb('#57524c') * fD[..., None]
save_srgb(falb, 'fairing_clean_albedo.jpg', 88)
save_srgb(falb_s, 'fairing_soot_albedo.jpg', 88)
save_raw(np.stack([np.ones_like(frough), frough, 0 * frough], -1), 'fairing_orm.jpg', 85)
save_raw(height_to_normal(fh_, 0.6), 'fairing_normal.jpg', 90)

# ---------------------------------------------------------------- Merlin 1D bell heat-tint strip
BW, BH = 64, 512
v = np.linspace(0, 1, BH)[:, None] + np.zeros((1, BW))  # 0 = top (near heat shield), 1 = exit lip
# dark charcoal lower bell, iridescent heat tint (straw -> bronze -> blue/purple) near the top band
base_c = rgb('#1f1d1c')
straw = rgb('#8a6a3c')
bronze = rgb('#6b4225')
blue = rgb('#2e3350')
t = v
col = np.zeros((BH, BW, 3), np.float32) + base_c
band = lambda c, w: np.exp(-((t - c) / w) ** 2)[..., None]
col = col * (1 - band(0.05, 0.05) * 0.55) + straw * band(0.05, 0.05) * 0.55
col = col * (1 - band(0.13, 0.05) * 0.5) + bronze * band(0.13, 0.05) * 0.5
col = col * (1 - band(0.23, 0.06) * 0.35) + blue * band(0.23, 0.06) * 0.35
col *= (1 + fnoise(BH, BW, 6, 30, seed=101)[..., None] * 0.08)
# exit lip slightly lighter (bare metal wear)
col = col * (1 - band(0.99, 0.012) * 0.5) + rgb('#5a5552') * band(0.99, 0.012) * 0.5
save_srgb(col, 'm1d_bell.jpg', 90)
print('done')
