"""Falcon 9 Block 5 + Starlink stack generator.

  blender -b --python blender/build_falcon9.py

Writes public/models/falcon9.glb (all stages, fairing halves, Starlink stack, parafoil; 3 LODs)
and public/models/falcon9_rig.json (pivots / leg + piston geometry used by
src/render/vehicles/booster.ts). Coordinates follow src/core/vehicleSpec.ts (three.js body frame:
+Y toward the nose, origin at each stage's nozzle-exit plane centre).

Node naming (three.js side looks these up):
  S1_L{lod}              root of an S1 level of detail
    S1_L{lod}_static     everything rigid
    S1_L{lod}_eng0       centre engine gimbal pivot (LOD0/1)
    S1_L{lod}_fin{i}     grid fin hinge pivot (deploy about the tangential axis)
      S1_L{lod}_fin{i}_tw  twist pivot (deflection about the fin span axis)
    S1_L{lod}_leg{i}     leg hinge pivot
    S1_L{lod}_leg{i}_p{k}  telescoping piston segment k (origin at its base, along +Y)
  S2_L{lod}, S2_L{lod}_static, S2_L{lod}_mvac (gimbal pivot)
  FA_L{lod}, FB_L{lod}   fairing halves (A: +X, B: -X), origin at fairing base
  SL_SAT, SL_DISPENSER, SL_ROD   Starlink satellite (instanced), dispenser, tension rod
  PARAFOIL               canopy, origin at canopy centre, span along X, chord along Z
"""
import sys, os, math, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from bgeo import *  # noqa
from mathutils import Vector, Matrix

# ---------------------------------------------------------------- spec (vehicleSpec.ts)
R = 1.83
OCTA_Y = 1.35
TANK_TOP = 40.3
IS_TOP = 47.0
ENG_RING = 1.25
NOZ_R = 0.46
FIN_Y = 45.2
FIN_W, FIN_H = 1.5, 1.2
FIN_ANG = [45, 135, 225, 315]
LEG_ANG = [0, 90, 180, 270]
HINGE_Y, HINGE_R = 1.6, 1.85
FOOT_Y, SPAN = -2.0, 18.0
RCS_Y, RCS_ANG = 44.0, [90, 270]
CAM_DOWN = (43.5, 2.05, 20)
RACEWAY_A = 115.0

S2_LEN = 13.8
S2_SKIRT_BOT = IS_TOP - 43.1  # 3.9: S2 skirt bottom sits on the interstage top
MVAC_EXIT_R, MVAC_EXT_L, MVAC_THROAT = 1.65, 2.4, 3.6
FAIR_LEN, FAIR_R = 13.1, 2.6

PALETTE.update({
    'S1_Tank': ((0.8, 0.8, 0.78), 0.4, 0.0),
    'S1_Interstage': ((0.03, 0.03, 0.03), 0.6, 0.0),
    'S1_Black': ((0.025, 0.025, 0.025), 0.55, 0.0),
    'S1_HeatShield': ((0.03, 0.03, 0.03), 0.8, 0.0),
    'S1_Blanket': ((0.05, 0.048, 0.045), 0.9, 0.0),
    'S1_Inner': ((0.1, 0.1, 0.1), 0.7, 0.0),
    'S1_Dome': ((0.5, 0.5, 0.48), 0.5, 0.3),
    'M1D_Bell': ((0.05, 0.045, 0.04), 0.45, 0.8),
    'M1D_Inner': ((0.02, 0.02, 0.02), 0.8, 0.2),
    'GridFin': ((0.25, 0.24, 0.22), 0.55, 1.0),
    'LegCarbon': ((0.02, 0.02, 0.02), 0.45, 0.0),
    'LegMetal': ((0.5, 0.5, 0.5), 0.35, 1.0),
    'Metal_Dark': ((0.12, 0.12, 0.12), 0.5, 0.8),
    'Metal_Bare': ((0.6, 0.6, 0.6), 0.35, 1.0),
    'S2_Tank': ((0.8, 0.8, 0.78), 0.4, 0.0),
    'S2_Inner': ((0.15, 0.15, 0.15), 0.7, 0.0),
    'S2_Dome': ((0.55, 0.55, 0.55), 0.45, 0.6),
    'MVac_Ext': ((0.05, 0.05, 0.055), 0.5, 0.4),
    'MVac_ExtInner': ((0.04, 0.04, 0.04), 0.6, 0.3),
    'MVac_Regen': ((0.35, 0.2, 0.1), 0.4, 1.0),
    'MVac_Parts': ((0.15, 0.15, 0.15), 0.5, 0.8),
    'MVac_Foil': ((0.8, 0.6, 0.2), 0.3, 1.0),
    'Fairing': ((0.82, 0.82, 0.8), 0.45, 0.0),
    'Fairing_Inner': ((0.5, 0.5, 0.5), 0.8, 0.0),
    'Fairing_Edge': ((0.1, 0.1, 0.1), 0.6, 0.0),
    'SL_Bus': ((0.08, 0.08, 0.09), 0.5, 0.5),
    'SL_Solar': ((0.02, 0.025, 0.05), 0.25, 0.3),
    'SL_Antenna': ((0.6, 0.6, 0.6), 0.6, 0.0),
    'SL_Foil': ((0.7, 0.5, 0.15), 0.3, 1.0),
    'Parafoil_Top': ((0.8, 0.8, 0.8), 0.8, 0.0),
    'Parafoil_Bottom': ((0.6, 0.6, 0.6), 0.85, 0.0),
})

D2R = math.pi / 180


def nrm(a):
    return Vector((math.cos(a * D2R), 0, math.sin(a * D2R)))


def hinge_axis(a):
    # k = Y x n : rotating +Y about k by +theta swings it outward toward n
    return Vector((math.sin(a * D2R), 0, -math.cos(a * D2R)))


def rotY(a):
    """rotation (three coords) mapping canonical +X (a=0) to radial direction at angle a"""
    return Matrix.Rotation(-a * D2R, 3, Vector((0, 1, 0)))


def cyl_uv_faces(mb, start, yr):
    """rewrite UVs of faces [start:] with the cylindrical tank mapping (u = 1 - a/2pi, v by y)."""
    for fi in range(start, len(mb.f)):
        f = mb.f[fi]
        us = []
        for k in f:
            x, y, z = mb.v[k]
            a = math.atan2(z, x) % TAU
            us.append([1 - a / TAU, (y - yr[0]) / (yr[1] - yr[0])])
        # fix wrap across the seam within a face
        umax = max(u[0] for u in us)
        for u in us:
            if umax - u[0] > 0.5:
                u[0] += 1
        mb.uv[fi] = [tuple(u) for u in us]


# ================================================================ Merlin 1D
def bell_r(y):
    """Merlin 1D outer radius vs height above the nozzle exit (visible part below the octaweb)."""
    t = min(1.0, max(0.0, y / OCTA_Y))
    return NOZ_R - (NOZ_R - 0.255) * t ** 1.3


def merlin(mb, cx, cz, lod, boot=True):
    seg = [48, 20, 10][lod]
    ys = [0.0, 0.02, 0.06, 0.15, 0.3, 0.5, 0.7, 0.9, 1.05, 1.2, 1.3, 1.42] if lod == 0 else [0.0, 0.3, 0.7, 1.05, 1.42]
    prof = [(bell_r(y) + (0.008 if y < 0.03 else 0.0), y) for y in ys]
    mb.lathe(prof, seg, 'M1D_Bell', center=(cx, 0, cz), uv='strip')
    if lod <= 1:
        th = 0.014
        iprof = [(bell_r(y) - th, y) for y in ys[:-1]] + [(0.2, 1.62), (0.13, 1.85)]
        mb.lathe(iprof, seg, 'M1D_Inner', center=(cx, 0, cz), flip=True, uv=None)
        mb.disk(1.85, 0.13, seg // 2, 'M1D_Inner', down=True, center=(cx, 0, cz))
        # rolled exit lip
        mb.disk(0.0, bell_r(0) + 0.008, seg, 'M1D_Bell', down=True, center=(cx, 0, cz), r_in=bell_r(0) - th)
    else:
        mb.disk(0.0, bell_r(0), seg, 'M1D_Inner', down=True, center=(cx, 0, cz))
    if boot and lod <= 1:
        # flexible thermal blanket boot between the bell and the heat-shield cut-out
        def wr(a, y, r):
            if lod > 0:
                return 0.0
            k = (y - 1.14) / 0.21
            return 0.012 * math.sin(a * 11 + y * 30) * math.sin(math.pi * min(1, max(0, k))) + 0.006 * math.sin(a * 23)
        bp = [(bell_r(1.12) + 0.004, 1.12), (0.335, 1.18), (0.365, 1.26), (0.39, 1.32), (0.405, 1.352)]
        mb.lathe(bp, seg, 'S1_Blanket', center=(cx, 0, cz), uv=None, jitter=wr)


def engine_positions():
    pos = [(0.0, 0.0)]
    for k in range(1, 9):
        a = (k - 1) * 45 * D2R
        pos.append((ENG_RING * math.cos(a), ENG_RING * math.sin(a)))
    return pos


# ================================================================ grid fin (canonical a = 0)
FIN_PIV = Vector((2.06, FIN_Y, 0))
FIN_DEPTH = 0.26


def grid_fin(lod):
    mb = MB()
    px, py = FIN_PIV.x, FIN_PIV.y
    s0, s1 = 0.2, 0.2 + FIN_H  # span range above the hinge (stowed: along +Y)
    hw = FIN_W / 2
    fb = [0.05, 0.07, 0.0][lod]  # frame bar width
    if lod == 2:
        mb.box((px, py + (s0 + s1) / 2, 0), (0.12, s1 - s0, FIN_W), 'GridFin')
        mb.box((px, py + s0 / 2, 0), (0.2, s0 + 0.1, 0.4), 'GridFin')
        return mb
    # frame: root bar, tip bar, two side bars, chamfered tip corners
    ch = 0.16
    mb.box((px, py + s0 + fb / 2, 0), (FIN_DEPTH, fb, FIN_W), 'GridFin')
    mb.box((px, py + s1 - fb / 2, 0), (FIN_DEPTH, fb, FIN_W - 2 * ch), 'GridFin')
    for sgn in (-1, 1):
        mb.box((px, py + (s0 + s1 - ch) / 2, sgn * (hw - fb / 2)), (FIN_DEPTH, s1 - s0 - ch, fb), 'GridFin')
        # chamfer bar
        c = Vector((0, py + s1 - ch / 2 - fb * 0.3, sgn * (hw - ch / 2 - fb * 0.3)))
        L = ch * math.sqrt(2) + fb
        u = Vector((0, 1, sgn * -1)).normalized() if sgn > 0 else Vector((0, 1, 1)).normalized()
        u = Vector((0, 1, -sgn)).normalized()
        dep = Vector((1, 0, 0))
        perp = dep.cross(u)
        M = Matrix((u, perp, dep)).transposed()
        mb.box((px, c.y, c.z), (L, fb, FIN_DEPTH), 'GridFin', M=M)
    # lattice blades at +-45 deg in the (z, y) plane
    pitch = [0.13, 0.26][lod]
    bt = [0.013, 0.02][lod]
    bd = FIN_DEPTH * 0.86
    z0, z1 = -hw + fb * 0.6, hw - fb * 0.6
    y0, y1 = s0 + fb * 0.6, s1 - fb * 0.6
    yc = (y0 + y1) / 2
    dep = Vector((1, 0, 0))
    for fam in (1, -1):
        u = Vector((0, 1, fam)).normalized()  # direction in (y, z)
        perp = dep.cross(u)
        # lines: points p with perp . p = c
        corners = [Vector((0, yy, zz)) for yy in (y0, y1) for zz in (z0, z1)]
        cs = [perp.dot(p) for p in corners]
        cmin, cmax = min(cs), max(cs)
        n = int((cmax - cmin) / pitch)
        off = (cmax - cmin - n * pitch) / 2
        for i in range(n + 1):
            c = cmin + off + i * pitch
            # intersect line {p: perp.p = c} with rectangle
            pts = []
            base = perp * c
            for yy in (y0, y1):
                # p = base + t*u, p.y = yy
                if abs(u.y) > 1e-9:
                    t = (yy - base.y) / u.y
                    p = base + u * t
                    if z0 - 1e-6 <= p.z <= z1 + 1e-6:
                        pts.append(p)
            for zz in (z0, z1):
                if abs(u.z) > 1e-9:
                    t = (zz - base.z) / u.z
                    p = base + u * t
                    if y0 - 1e-6 <= p.y <= y1 + 1e-6:
                        pts.append(p)
            if len(pts) < 2:
                continue
            pts.sort(key=lambda p: p.dot(u))
            a, b = pts[0], pts[-1]
            L = (b - a).length
            if L < 0.03:
                continue
            m = (a + b) / 2
            # chamfer clip at the tip corners: skip blade parts beyond the chamfer
            M = Matrix((u, perp, dep)).transposed()
            mb.box((px, py + m.y, m.z), (L + bt, bt, bd), 'GridFin', M=M, skip=())
    # root spine: from the hinge up to the frame, flared
    mb.box((px, py + s0 / 2 + 0.02, 0), (FIN_DEPTH * 0.9, s0 + 0.08, 0.46), 'GridFin')
    mb.box((px, py + s0 + 0.12, 0), (FIN_DEPTH * 0.7, 0.2, 0.18), 'GridFin')
    # hinge axle (along the tangential axis = -Z at a=0)
    mb.cyl((px, py, -0.34), (px, py, 0.34), 0.075, 'Metal_Dark', seg=[16, 8][lod])
    return mb


def fin_housing(mb, lod):
    """static actuator housing on the interstage below each hinge (canonical a = 0)"""
    mb.box((1.9, FIN_Y - 0.2, 0), (0.2, 0.46, 0.5), 'S1_Black')
    mb.box((1.98, FIN_Y - 0.02, 0), (0.16, 0.14, 0.72), 'Metal_Dark')
    if lod == 0:
        # hydraulic line + small access panel bolts
        mb.cyl((1.88, FIN_Y - 0.6, 0.28), (1.88, FIN_Y - 1.6, 0.34), 0.025, 'Metal_Dark', seg=6)


# ================================================================ landing leg (canonical a = 0)
LEG_H = Vector((HINGE_R, HINGE_Y, 0))
LEG_TIP_DX = 0.14      # tip joint radial offset from the hinge line (leg-local)
PAD_BELOW = 0.28       # footpad bottom below the tip joint when deployed
# solve leg length L and deploy angle so the deployed footpad bottom hits (SPAN/2, FOOT_Y)
_tx, _ty = SPAN / 2 - HINGE_R, (FOOT_Y + PAD_BELOW) - HINGE_Y
LEG_L = math.sqrt(_tx * _tx + _ty * _ty - LEG_TIP_DX ** 2)
_phi0 = math.atan2(LEG_TIP_DX, LEG_L)
LEG_THETA = math.atan2(_tx, _ty) - _phi0  # radians, rotation about k
PISTON_A = Vector((1.99, 5.4, 0))          # body anchor (canonical)
PISTON_P_LOCAL = (0.12, 0.92)              # (radial offset, fraction of L) on the leg
PISTON_R = [0.078, 0.064, 0.05]


def leg_rot(theta):
    return Matrix.Rotation(theta, 3, hinge_axis(0))


def leg_mesh(lod):
    mb = MB()
    H = LEG_H
    L = LEG_L
    x_in = 1.875
    nsec = [20, 10, 4][lod]
    if lod == 2:
        mb.box((x_in + 0.14, H.y + L / 2, 0), (0.28, L, 0.7), 'LegCarbon')
        return mb

    def w_of(s):
        f = s / L
        if f < 0.82:
            return 1.25 - 0.62 * f / 0.82
        return 0.63 * (1 - (f - 0.82) / 0.18) + 0.28 * ((f - 0.82) / 0.18)

    def h_of(s):
        f = s / L
        return 0.27 - 0.08 * f - (0.07 * ((f - 0.85) / 0.15) if f > 0.85 else 0)

    stations = [-0.28, -0.05, 0.3, 1.2, 2.5, 3.8, 5.0, 6.0, 6.5, 6.9, 7.25, 7.55, L - 0.05, L] if lod == 0 else [-0.28, 0.3, 3.0, 6.3, 7.3, L]
    rings = []
    for s in stations:
        ss = max(0.0, s)
        w, h = w_of(ss), h_of(ss)
        if s < 0:
            w *= 0.85
        ring = []
        # outer half-ellipse from +Z via +X to -Z, then flat inner face back (CCW about +Y)
        for i in range(nsec + 1):
            ph = math.pi * i / nsec
            # flat outer face with chamfered sides (superellipse), conforming leg fairing
            ring.append(Vector((x_in + h * math.sin(ph) ** 0.28, H.y + s, (w / 2) * math.cos(ph) * (1 - 0.1 * math.sin(ph) ** 8))))
        for i in range(1, 3):
            ring.append(Vector((x_in, H.y + s, -w / 2 + w * i / 3)))
        rings.append(ring)
    mb.loft(rings, 'LegCarbon')
    # hinge lugs + axle
    mb.cyl((H.x, H.y, -0.5), (H.x, H.y, 0.5), 0.08, 'Metal_Dark', seg=[16, 8][lod])
    # footpad: modelled in the deployed pose, then rotated back into the stowed leg frame
    Rinv = leg_rot(-LEG_THETA)
    tip_st = H + Vector((LEG_TIP_DX, L, 0))
    tip_dep = H + leg_rot(LEG_THETA) @ Vector((LEG_TIP_DX, L, 0))
    pad = MB()
    seg = [24, 12][lod]
    c = tip_dep - Vector((0, PAD_BELOW, 0))
    pad.lathe([(0.0, c.y + 0.0), (0.46, c.y + 0.0), (0.47, c.y + 0.03), (0.45, c.y + 0.12), (0.2, c.y + 0.16), (0.0, c.y + 0.17)],
              seg, 'LegMetal', center=(c.x, 0, c.z), uv=None)
    pad.cyl(c + Vector((0, 0.12, 0)), tip_dep, 0.11, 'LegMetal', seg=[12, 6][lod])
    pad.transform(Rinv, (0, 0, 0))
    # translate: p_st = H + Rinv (p_dep - H)  ->  Rinv p_dep + (H - Rinv H)
    sh = H - Rinv @ H
    for i in range(len(pad.v)):
        p = Vector(pad.v[i]) + sh
        pad.v[i] = (p.x, p.y, p.z)
    mb.merge(pad)
    # piston clevis on the leg
    pl = H + Vector((PISTON_P_LOCAL[0], PISTON_P_LOCAL[1] * L, 0))
    mb.box((pl.x - 0.02, pl.y, 0), (0.16, 0.22, 0.2), 'Metal_Dark')
    return mb


def leg_static(mb, lod):
    """body-side leg hardware (canonical a = 0): hinge bracket, piston anchor, latch fairing."""
    mb.box((1.9, HINGE_Y - 0.02, 0), (0.16, 0.5, 1.14), 'Metal_Dark')
    if lod <= 1:
        mb.box((1.87, PISTON_A.y, 0), (0.1, 0.34, 0.3), 'Metal_Dark')
    # leg-tip latch / aero fairing above the stowed leg tip (pointed)
    ytip = HINGE_Y + LEG_L
    poly = [(-0.2, 0.0), (0.2, 0.0), (0.12, 0.55), (0.0, 0.78), (-0.12, 0.55)]
    fr = (Vector((1.81, ytip + 0.05, 0)), Vector((0, 0, -1)), Vector((0, 1, 0)), Vector((1, 0, 0)))
    # U=-Z, V=+Y -> U x V = (-Z) x Y = +X = N  (CCW about N)
    mb.prism(poly, fr, 0.2, 'S1_Black')


# ================================================================ S1 static
def raceway(mb, lod):
    start = len(mb.f)
    if lod == 2:
        return
    prof = [(-0.15, 1.79), (0.15, 1.79), (0.13, 1.93), (0.09, 1.965), (-0.09, 1.965), (-0.13, 1.93)]
    ys = [2.25, 2.7, 39.6, 40.3]
    hf = [0.15, 1.0, 1.0, 0.35]
    rings = []
    for y, f in zip(ys, hf):
        ring = []
        for (z, x) in prof:
            ring.append(Vector((1.79 + (x - 1.79) * f, y, z)))
        # CCW about +Y: from +Z toward +X  -> order the polygon accordingly
        rings.append(ring)
    mb.loft(rings, 'S1_Tank')
    if lod == 0:
        y = 3.2
        while y < 39.4:
            ring2 = []
            mb.box((1.97, y, 0), (0.02, 0.035, 0.2), 'S1_Tank')
            y += 0.76
        # small secondary conduit
        mb.cyl((1.875, 2.3, 0.26), (1.875, 40.2, 0.26), 0.04, 'S1_Tank', seg=8, caps=True)
    M = rotY(RACEWAY_A)
    mb.transform(M, (0, 0, 0), start=_vstart[0])


_vstart = [0]


def s1_static(lod):
    mb = MB()
    seg = [128, 48, 16][lod]
    # tank shell incl. the black aft skirt band (texture), y 1.35 .. 40.3
    mb.lathe([(R, OCTA_Y), (R, 2.12), (R, 16.3), (R, TANK_TOP)], seg, 'S1_Tank', uv='cyl', yr=(OCTA_Y, TANK_TOP))
    # interstage outer + top ring + inner wall
    mb.lathe([(R, TANK_TOP), (R, 43.4), (R, IS_TOP - 0.06)], seg, 'S1_Interstage', uv='cyl', yr=(TANK_TOP, IS_TOP))
    mb.lathe([(R, IS_TOP - 0.06), (R + 0.004, IS_TOP - 0.03), (R - 0.01, IS_TOP), (R - 0.05, IS_TOP)], seg, 'Metal_Dark', uv=None)
    if lod <= 1:
        mb.lathe([(R - 0.05, 40.55), (R - 0.05, IS_TOP)], seg, 'S1_Inner', flip=True, uv=None)
        # LOX tank forward dome inside the interstage
        dome = [(R - 0.05, 40.55)] + [((R - 0.05) * math.cos(t), 40.55 + 1.05 * math.sin(t)) for t in [0.3, 0.6, 0.9, 1.2, 1.45]] + [(0.0, 41.6)]
        mb.lathe(dome, seg, 'S1_Dome', uv=None)
    else:
        mb.disk(IS_TOP - 0.3, R, seg, 'S1_Inner', down=False)
    # junction ring tank/interstage + aft lip
    mb.lathe([(R, TANK_TOP - 0.07), (R + 0.012, TANK_TOP - 0.05), (R + 0.012, TANK_TOP + 0.05), (R, TANK_TOP + 0.07)], seg, 'Metal_Dark', uv=None)
    mb.lathe([(R, OCTA_Y), (R + 0.015, OCTA_Y + 0.01), (R + 0.015, OCTA_Y + 0.08), (R, OCTA_Y + 0.1)], seg, 'S1_Black', uv=None)
    # octaweb heat shield (bottom face) with engine cut-outs
    hs_seg = [96, 40, 16][lod]
    outer = [(R * math.cos(TAU * j / hs_seg), R * math.sin(TAU * j / hs_seg)) for j in range(hs_seg)]
    holes = []
    hr = 0.405
    for (x, z) in engine_positions():
        n = [40, 16, 8][lod]
        holes.append([(x + hr * math.cos(-TAU * j / n), z + hr * math.sin(-TAU * j / n)) for j in range(n)])
    hs = fill_holes(outer, holes, OCTA_Y, 'S1_HeatShield', down=True, uv_scale=1.0)
    # planar UVs for the heat-shield texture: u,v in [0,1] across the 3.66 m disc
    for fi in range(len(hs.f)):
        hs.uv[fi] = [(0.5 + hs.v[k][0] / (2 * R), 0.5 - hs.v[k][2] / (2 * R)) for k in hs.f[fi]]
    mb.merge(hs)
    if lod <= 1:
        # shallow recess wall from the heat shield up to the skirt lip
        for (x, z) in engine_positions():
            mb.lathe([(hr, OCTA_Y + 0.05), (hr, OCTA_Y)], [40, 16][lod], 'S1_HeatShield', center=(x, 0, z), flip=False, uv=None)
    # outer 8 engines (centre engine is a separate gimbal node)
    for (x, z) in engine_positions()[1:]:
        merlin(mb, x, z, lod)
    # raceway (uses the tank texture through cylindrical UVs)
    global _vstart
    _vstart[0] = len(mb.v)
    fstart = len(mb.f)
    raceway(mb, lod)
    cyl_uv_faces(mb, fstart, (OCTA_Y, TANK_TOP))
    # per-leg / per-fin / RCS hardware (canonical, rotated into place)
    for a in LEG_ANG:
        sub = MB()
        leg_static(sub, lod)
        mb.merge(sub, (rotY(a), (0, 0, 0)))
    for a in FIN_ANG:
        sub = MB()
        fin_housing(sub, lod)
        mb.merge(sub, (rotY(a), (0, 0, 0)))
    for a in RCS_ANG:
        sub = MB()
        sub.box((1.97, RCS_Y, 0), (0.3, 0.84, 0.58), 'S1_Black')
        if lod <= 1:
            sub.box((2.1, RCS_Y, 0), (0.08, 0.64, 0.44), 'S1_Black')
            ns = [8, 6][lod]
            # tangential nozzles (canonical +-Z), outward up/down (canonical (0.866, +-0.5, 0))
            for sz in (-1, 1):
                sub.cyl((1.99, RCS_Y, sz * 0.29), (1.99, RCS_Y, sz * 0.36), 0.03, 'Metal_Dark', seg=ns, r1=0.045)
            for sy in (-1, 1):
                d = Vector((0.866, sy * 0.5, 0))
                p0 = Vector((2.13, RCS_Y + sy * 0.24, 0))
                sub.cyl(p0, p0 + d * 0.08, 0.03, 'Metal_Dark', seg=ns, r1=0.045)
        mb.merge(sub, (rotY(a), (0, 0, 0)))
    if lod <= 1:
        # stage-separation pushers + release collets inside the interstage rim
        for a in (0, 90, 180, 270):
            sub = MB()
            sub.cyl((1.66, IS_TOP - 0.75, 0), (1.66, IS_TOP - 0.02, 0), 0.07, 'Metal_Dark', seg=10)
            sub.cyl((1.66, IS_TOP - 0.02, 0), (1.66, IS_TOP + 0.0, 0), 0.05, 'Metal_Bare', seg=10)
            sub.box((1.74, IS_TOP - 0.5, 0), (0.12, 0.5, 0.3), 'Metal_Dark')
            mb.merge(sub, (rotY(a + 45), (0, 0, 0)))
        for a in (22.5, 112.5, 202.5, 292.5):
            sub = MB()
            sub.box((1.76, IS_TOP - 0.12, 0), (0.1, 0.22, 0.16), 'Metal_Dark')
            mb.merge(sub, (rotY(a), (0, 0, 0)))
        # onboard down-looking camera housing
        y, r, a = CAM_DOWN
        sub = MB()
        sub.box((R + 0.08, y, 0), (0.16, 0.3, 0.2), 'S1_Black')
        sub.cyl((R + 0.12, y - 0.1, 0), (R + 0.12, y - 0.2, 0), 0.05, 'Metal_Dark', seg=10)
        mb.merge(sub, (rotY(a), (0, 0, 0)))
        # hold-down fittings at the aft skirt (between the legs)
        for a in (45, 135, 225, 315):
            sub = MB()
            sub.box((1.75, OCTA_Y + 0.12, 0), (0.22, 0.24, 0.3), 'Metal_Dark')
            mb.merge(sub, (rotY(a), (0, 0, 0)))
    return mb


def build_s1(lod):
    root = empty(f'S1_L{lod}')
    st = s1_static(lod)
    ob = st.build(f'S1_L{lod}_static', parent=root, smooth=40)
    # centre engine
    if lod <= 1:
        piv = Vector((0, 1.9, 0))
        e = empty(f'S1_L{lod}_eng0', piv, parent=root)
        mb = MB()
        merlin(mb, 0, 0, lod)
        mb.build(f'S1_L{lod}_eng0_mesh', parent=e, origin=piv, smooth=40)
    # grid fins
    for i, a in enumerate(FIN_ANG):
        M = rotY(a)
        piv = M @ FIN_PIV
        e = empty(f'S1_L{lod}_fin{i}', piv, parent=root)
        tw = empty(f'S1_L{lod}_fin{i}_tw', piv, parent=e, parent_pos=piv)
        mb = MB().merge(grid_fin(lod), (M, (0, 0, 0)))
        o = mb.build(f'S1_L{lod}_fin{i}_mesh', parent=tw, origin=piv, smooth=30)
    # legs + pistons
    for i, a in enumerate(LEG_ANG):
        M = rotY(a)
        piv = M @ LEG_H
        e = empty(f'S1_L{lod}_leg{i}', piv, parent=root)
        mb = MB().merge(leg_mesh(lod), (M, (0, 0, 0)))
        mb.build(f'S1_L{lod}_leg{i}_mesh', parent=e, origin=piv, smooth=50)
        if lod <= 1:
            A = M @ PISTON_A
            P = M @ (LEG_H + Vector((PISTON_P_LOCAL[0], PISTON_P_LOCAL[1] * LEG_L, 0)))
            ln = (P - A).length
            for k in range(3):
                pm = MB()
                pm.cyl((0, 0, 0), (0, ln, 0), PISTON_R[k], 'Metal_Dark' if k == 0 else 'LegMetal', seg=[14, 8][lod])
                pm.build(f'S1_L{lod}_leg{i}_p{k}', parent=empty(f'S1_L{lod}_leg{i}_p{k}_n', A, parent=root), origin=(0, 0, 0), smooth=50)
    return root


# ================================================================ S2
def mvac_ext_r(y):
    t = min(1.0, max(0.0, y / MVAC_EXT_L))
    return MVAC_EXIT_R - (MVAC_EXIT_R - 0.64) * t ** 1.25


def build_s2(lod):
    root = empty(f'S2_L{lod}')
    seg = [128, 48, 16][lod]
    mb = MB()
    top = S2_LEN
    mb.lathe([(R, S2_SKIRT_BOT), (R, 4.62), (R, top)], seg, 'S2_Tank', uv='cyl', yr=(S2_SKIRT_BOT, top))
    mb.disk(S2_SKIRT_BOT, R, seg, 'Metal_Dark', down=True, r_in=R - 0.04)
    if lod <= 1:
        mb.lathe([(R - 0.04, S2_SKIRT_BOT), (R - 0.04, 5.1)], seg, 'S2_Inner', flip=True, uv=None)
        # aft (LOX) dome, visible from the engine cam / after staging
        dome = [(0.0, 4.4)] + [((R - 0.04) * math.sin(t), 4.4 + 0.72 * (1 - math.cos(t))) for t in [0.35, 0.7, 1.0, 1.25, 1.45, math.pi / 2]]
        mb.lathe(dome, seg, 'S2_Dome', uv=None)
        # thrust structure cone + actuators
        mb.lathe([(0.26, 4.1), (0.62, 4.5)], 24, 'Metal_Dark', uv=None)
        mb.lathe([(0.62, 4.5), (0.26, 4.1)], 24, 'Metal_Dark', uv=None, flip=False)
        for a in (0, 90):
            p0 = Vector((0.85 * math.cos(a * D2R), 4.62, 0.85 * math.sin(a * D2R)))
            p1 = Vector((0.26 * math.cos(a * D2R), 3.95, 0.26 * math.sin(a * D2R)))
            mb.cyl(p0, p1, 0.045, 'Metal_Dark', seg=8)
        # cold-gas thruster pods on the aft skirt
        for a in (45, 225):
            sub = MB()
            sub.box((R + 0.08, 4.25, 0), (0.16, 0.3, 0.36), 'Metal_Dark')
            mb.merge(sub, (rotY(a), (0, 0, 0)))
        # forward dome + payload attach fitting (inside the fairing)
        mb.lathe([(R, top), (1.6, top + 0.16), (1.2, top + 0.38), (1.12, top + 0.42)], seg, 'S2_Dome', uv=None)
        mb.lathe([(1.12, top + 0.42), (1.12, top + 0.5), (1.02, top + 0.52)], seg, 'Metal_Dark', uv=None)
        mb.disk(top + 0.52, 1.02, seg // 2, 'Metal_Dark', down=False)
        # thin raceway on S2
        fs = len(mb.f)
        v0 = len(mb.v)
        sub = MB()
        sub.box((R + 0.05, (4.7 + top) / 2, 0), (0.1, top - 4.7, 0.16), 'S2_Tank')
        mb.merge(sub, (rotY(160), (0, 0, 0)))
        cyl_uv_faces(mb, fs, (S2_SKIRT_BOT, top))
    mb.build(f'S2_L{lod}_static', parent=root, smooth=40)
    # --- MVac (gimbal pivot at the throat/chamber)
    piv = Vector((0, 3.95, 0))
    e = empty(f'S2_L{lod}_mvac', piv, parent=root)
    mv = MB()
    eseg = [96, 40, 16][lod]
    ys = [i * MVAC_EXT_L / 16 for i in range(17)] if lod == 0 else [0, 0.6, 1.2, 1.8, 2.4]
    mv.lathe([(mvac_ext_r(y), y) for y in ys], eseg, 'MVac_Ext', uv='strip')
    if lod <= 1:
        mv.lathe([(mvac_ext_r(y) - 0.012, y) for y in ys], eseg, 'MVac_ExtInner', flip=True, uv='strip')
        mv.disk(0.0, MVAC_EXIT_R + 0.006, eseg, 'MVac_Ext', down=True, r_in=MVAC_EXIT_R - 0.012)
        # regeneratively cooled section: extension joint (y 2.4) up to the throat (3.6)
        rp = []
        for i in range(13):
            t = i / 12
            y = MVAC_EXT_L + (MVAC_THROAT - MVAC_EXT_L) * t
            rp.append((0.14 + 0.5 * (1 - t) ** 0.55 + 0.012, y))
        mv.lathe(rp, [64, 24][lod], 'MVac_Regen', uv='strip')
        mv.lathe([(0.66, MVAC_EXT_L - 0.03), (0.672, MVAC_EXT_L + 0.02)], [64, 24][lod], 'MVac_Parts', uv=None)
        # turbine exhaust manifold torus at the extension joint
        tor = []
        for j in range(49):
            a = TAU * j / 48
            tor.append((0.73 * math.cos(a), MVAC_EXT_L + 0.07, 0.73 * math.sin(a)))
        mv.tube(tor[:-1], 0.065, 'MVac_Parts', seg=[12, 6][lod], closed=True)
        # chamber, injector head, turbopump, GG exhaust duct
        mv.lathe([(0.152, MVAC_THROAT), (0.2, MVAC_THROAT + 0.08), (0.22, MVAC_THROAT + 0.16), (0.22, 3.98), (0.2, 4.04), (0.12, 4.1), (0.0, 4.12)],
                 [32, 12][lod], 'MVac_Parts', uv=None)
        mv.cyl((0.36, 3.7, 0.06), (0.36, 4.22, 0.06), 0.13, 'MVac_Parts', seg=[20, 8][lod])
        mv.cyl((0.36, 3.9, 0.06), (0.36, 3.9, 0.3), 0.1, 'MVac_Parts', seg=[16, 8][lod])
        mv.cyl((0.2, 4.0, -0.1), (0.46, 4.0, -0.18), 0.07, 'MVac_Foil', seg=[12, 6][lod])
        duct = [(0.36, 3.7, 0.06), (0.42, 3.4, 0.1), (0.55, 3.0, 0.1), (0.68, 2.6, 0.06), (0.73, MVAC_EXT_L + 0.12, 0.0)]
        mv.tube(duct, 0.06, 'MVac_Parts', seg=[10, 6][lod])
        mv.cyl((-0.3, 3.75, -0.2), (-0.3, 4.1, -0.2), 0.08, 'MVac_Foil', seg=[12, 6][lod])
    mv.build(f'S2_L{lod}_mvac_mesh', parent=e, origin=piv, smooth=40)
    return root


# ================================================================ fairing
def fairing_profile(lod):
    """(r, y) bottom -> tip, y from the fairing base (S2 y = 13.8). Boat-tail cone, 5.2 m barrel,
    tangent ogive with a spherical nose cap; the ogive length is solved so the tip lands at FAIR_LEN."""
    pts = [(R + 0.015, 0.0), (R + 0.015, 0.14)]
    cone_top = 1.45
    for i in range(1, 5):
        t = i / 4
        pts.append((R + 0.015 + (FAIR_R - R - 0.015) * t, 0.14 + (cone_top - 0.14) * t))
    cyl_top = 6.75
    pts.append((FAIR_R, 3.5))
    pts.append((FAIR_R, cyl_top))
    rn = 0.45

    def geo(Lo):
        rho = (FAIR_R ** 2 + Lo ** 2) / (2 * FAIR_R)
        xo = Lo - math.sqrt((rho - rn) ** 2 - (rho - FAIR_R) ** 2)  # sphere centre, from the sharp tip
        yt = rn * (rho - FAIR_R) / (rho - rn)
        xt = xo - math.sqrt(rn * rn - yt * yt)
        return rho, xo, yt, xt, xo - rn
    Lo = FAIR_LEN - cyl_top
    for _ in range(20):
        rho, xo, yt, xt, xa = geo(Lo)
        Lo = FAIR_LEN - cyl_top + xa
    rho, xo, yt, xt, xa = geo(Lo)
    h = lambda s: cyl_top + Lo - s  # s = distance from the (virtual) sharp tip
    n = [24, 12, 6][lod]
    for i in range(1, n + 1):
        s = Lo - (Lo - xt) * i / n
        r = math.sqrt(rho ** 2 - (Lo - s) ** 2) + FAIR_R - rho
        pts.append((r, h(s)))
    m = [10, 5, 3][lod]
    phit = math.atan2(yt, xo - xt)  # angle from the axis at the tangency point
    for i in range(1, m + 1):
        ph = phit * (1 - i / m)
        pts.append((rn * math.sin(ph) if i < m else 0.0, h(xo - rn * math.cos(ph))))
    return pts


def build_fairing(lod):
    prof = fairing_profile(lod)
    seg = [64, 32, 10][lod]
    out = {}
    for half, (a0, a1) in (('A', (-90.0, 90.0)), ('B', (90.0, 270.0))):
        root = empty(f'F{half}_L{lod}')
        mb = MB()
        mb.lathe(prof, seg, 'Fairing', a0=a0 * D2R, a1=a1 * D2R, uv='arc')
        th = 0.035
        if lod <= 1:
            iprof = [(max(0.0, r - th), y) for (r, y) in prof[:-1]] + [(0.0, prof[-1][1] - th)]
            mb.lathe(iprof, seg, 'Fairing_Inner', a0=a0 * D2R, a1=a1 * D2R, flip=True, uv=None)
            # split-plane edges
            for a, sgn in ((a0, 1), (a1, -1)):
                ca, sa = math.cos(a * D2R), math.sin(a * D2R)
                for i in range(len(prof) - 1):
                    (r0, y0), (r1, y1) = prof[i], prof[i + 1]
                    (q0, _), (q1, _) = iprof[min(i, len(iprof) - 1)], iprof[min(i + 1, len(iprof) - 1)]
                    pa = (r0 * ca, y0, r0 * sa); pb = (r1 * ca, y1, r1 * sa)
                    qa = (q0 * ca, y0, q0 * sa); qb = (q1 * ca, y1, q1 * sa)
                    if sgn > 0:
                        mb.quad(pa, qa, qb, pb, 'Fairing_Edge')
                    else:
                        mb.quad(pa, pb, qb, qa, 'Fairing_Edge')
            # base edge
            mb.lathe([(prof[0][0] - th, 0.0), (prof[0][0], 0.0)], seg, 'Fairing_Edge', a0=a0 * D2R, a1=a1 * D2R, uv=None, flip=False)
            # nitrogen thruster + parafoil canister bulge inside the nose (visible after sep)
            mb.box(((1 if half == 'A' else -1) * 1.2, 10.4, 0), (0.5, 0.9, 1.1), 'Fairing_Inner')
        mb.build(f'F{half}_L{lod}_mesh', parent=root, smooth=40)
        out[half] = root
    return out


# ================================================================ Starlink v2-mini-like stack
SAT_PITCH = 0.335
SAT_W, SAT_D = 3.9, 2.55


def build_starlink():
    # satellite (local origin = centre of the bus mid-plane)
    mb = MB()
    ch = 0.32
    hw, hd = SAT_W / 2, SAT_D / 2
    poly = [(-hw + ch, -hd), (hw - ch, -hd), (hw, -hd + ch), (hw, hd - ch), (hw - ch, hd), (-hw + ch, hd), (-hw, hd - ch), (-hw, -hd + ch)]
    # prism in the (x, z) plane extruded along +Y: U=+X, V=-Z so that U x V = +Y
    fr = (Vector((0, -0.08, 0)), Vector((1, 0, 0)), Vector((0, 0, -1)), Vector((0, 1, 0)))
    poly_uv = [(x, -z) for (x, z) in poly][::-1]
    mb.prism(poly_uv, fr, 0.15, 'SL_Bus')
    # stowed solar array on top (two folded wings), slightly inset
    fr2 = (Vector((0, 0.075, 0)), Vector((1, 0, 0)), Vector((0, 0, -1)), Vector((0, 1, 0)))
    inset = [(x * 0.95, z * 0.93) for (x, z) in poly_uv]
    mb.prism(inset, fr2, 0.06, 'SL_Solar', uv_scale=0.25)
    # array hinge line + gold foil edge strips
    mb.box((0, 0.1, -hd * 0.93 + 0.03), (SAT_W * 0.8, 0.07, 0.05), 'SL_Foil')
    mb.box((hw - 0.05, 0.0, 0), (0.08, 0.14, 1.2), 'SL_Foil')
    # phased-array antennas + backhaul dishes underneath
    for (x, z) in ((-1.0, -0.6), (1.0, -0.6), (-1.0, 0.6), (1.0, 0.6)):
        mb.box((x, -0.1, z), (1.1, 0.04, 0.95), 'SL_Antenna')
    mb.cyl((0.0, -0.09, 0.0), (0.0, -0.15, 0.0), 0.16, 'SL_Antenna', seg=12)
    # Hall thruster + star tracker nubs
    mb.cyl((-hw + 0.25, 0.0, 0.0), (-hw - 0.02, 0.0, 0.0), 0.07, 'Metal_Dark', seg=10)
    mb.box((hw * 0.6, 0.02, hd - 0.06), (0.12, 0.1, 0.1), 'Metal_Dark')
    ob = mb.build('SL_SAT', smooth=30)
    # dispenser plate + posts (payload-local, stack base y = 0 at S2 y 13.8)
    dm = MB()
    dm.lathe([(1.02, 0.52), (1.3, 0.56), (1.3, 0.64), (0.0, 0.66)], 48, 'Metal_Dark', uv=None)
    for (x, z) in ((-1.72, -1.05), (1.72, -1.05), (-1.72, 1.05), (1.72, 1.05)):
        dm.box((x * 0.55, 0.6, z * 0.55), (0.3, 0.1, 0.2), 'Metal_Dark')
        dm.box((x, 0.58, z), (0.18, 0.16, 0.18), 'Metal_Dark')
        dm.cyl((x * 0.55, 0.6, z * 0.55), (x, 0.6, z), 0.05, 'Metal_Dark', seg=8)
    dm.build('SL_DISPENSER', smooth=40)
    rm = MB()
    n = 22
    Lr = 0.7 + n * SAT_PITCH
    rm.cyl((0, 0, 0), (0, Lr, 0), 0.035, 'Metal_Bare', seg=8)
    rm.cyl((0, Lr, 0), (0, Lr + 0.06, 0), 0.06, 'Metal_Dark', seg=8)
    rm.build('SL_ROD', smooth=40)


# ================================================================ parafoil canopy
def build_parafoil():
    span, chord, ncell = 24.0, 9.0, 21
    mb = MB()
    nsp = ncell * 4
    nch = 18
    top_rings = []

    def arch(x):
        # anhedral: span tips droop (canopy is an arc when loaded)
        return -3.2 * (x / (span / 2)) ** 2

    def airfoil(t):
        # t 0..1 leading edge -> trailing edge; thickness distribution (Clark-Y-like upper surface)
        return 0.9 * (1.4845 * math.sqrt(max(t, 1e-6)) - 0.63 * t - 1.758 * t * t + 1.4215 * t ** 3 - 0.5075 * t ** 4) / 1.0

    # upper surface grid (billowing between ribs)
    for i in range(nsp + 1):
        x = -span / 2 + span * i / nsp
        cell_phase = (i % 4) / 4.0
        bil = math.sin(math.pi * cell_phase) * 0.12
        ring = []
        for j in range(nch + 1):
            t = j / nch
            z = chord / 2 - chord * t  # leading edge at +Z
            y = arch(x) + airfoil(t) * (1 + bil) * 0.9
            ring.append((x, y, z))
        top_rings.append(ring)
    # faces: upper surface
    ids = [[mb.vert(p) for p in ring] for ring in top_rings]
    for i in range(nsp):
        for j in range(nch):
            a, b, c, d = ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]
            mb.face([a, b, c, d], 'Parafoil_Top')
    # lower surface (flat-ish, slightly cambered), cell mouths open at the leading edge
    low = [[mb.vert((top_rings[i][j][0], arch(top_rings[i][j][0]) + 0.08 * math.sin(math.pi * j / nch) - 0.02, top_rings[i][j][2])) for j in range(nch + 1)] for i in range(nsp + 1)]
    for i in range(nsp):
        for j in range(1, nch):
            a, b, c, d = low[i][j], low[i + 1][j], low[i + 1][j + 1], low[i][j + 1]
            mb.face([a, d, c, b], 'Parafoil_Bottom')
    # ribs every 4 columns (closed airfoil sections)
    for i in range(0, nsp + 1, 4):
        for j in range(1, nch):
            a, b, c, d = ids[i][j], ids[i][j + 1], low[i][j + 1], low[i][j]
            mb.face([a, b, c, d], 'Parafoil_Bottom')
            mb.face([d, c, b, a], 'Parafoil_Bottom')
    mb.build('PARAFOIL', smooth=60)


# ================================================================ main
def main():
    reset_scene()
    rig = {}
    for lod in (0, 1, 2):
        build_s1(lod)
        build_s2(lod)
        build_fairing(lod)
    build_starlink()
    build_parafoil()
    rig['leg'] = {
        'hinge': [LEG_H.x, LEG_H.y], 'L': LEG_L, 'theta': LEG_THETA, 'tipDx': LEG_TIP_DX, 'padBelow': PAD_BELOW,
        'pistonA': [PISTON_A.x, PISTON_A.y], 'pistonP': list(PISTON_P_LOCAL), 'pistonR': PISTON_R,
        'angles': LEG_ANG,
    }
    rig['fin'] = {'pivot': [FIN_PIV.x, FIN_PIV.y], 'angles': FIN_ANG, 'depth': FIN_DEPTH}
    rig['s2'] = {'mvacPivotY': 3.95}
    rig['starlink'] = {'pitch': SAT_PITCH, 'first': 0.66 + 0.14, 'count': 22, 'rodXZ': [1.72, 1.05]}
    out = os.path.join(ROOT, 'public', 'models')
    with open(os.path.join(out, 'falcon9_rig.json'), 'w') as f:
        json.dump(rig, f, indent=1)
    export_glb(os.path.join(out, 'falcon9.glb'), draco=True)
    if '--blend' in sys.argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'out_falcon9.blend'))


main()
