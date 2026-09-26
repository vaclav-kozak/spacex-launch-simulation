"""SLC-4E launch complex (Vandenberg), stylised but to scale.

  blender -b --python blender/build_slc4e.py

Writes public/models/slc4e.glb. Pad frame (three.js coords) = W frame shifted to (0, PAD_ELEVATION, 0):
+X east, +Y up, +Z south, origin = launch-mount centre on the pad surface. The vehicle's nozzle exit
stands LAUNCH_MOUNT_HEIGHT = 4 m above the origin (sim pre-launch S1.pos).

Layout (headings clockwise from north, distances from the mount):
  flame-duct opening under the mount; the covered duct runs underground toward 200 deg and exits
  through a headwall + wing walls at 42 m (matches src/render/vfx/emitters.ts TRENCH_EXIT)
  transporter-erector (strongback) on the north side, leaning back 3 deg; rails to the hangar
  hangar (horizontal integration facility) north, 130..225 m
  4 lightning towers (88 m) at 300/30 m (the "tower" pad camera sits on it), 30, 120, 215 deg / 48 m,
  catenary wires between their tops
  water tower 250 deg / 150 m; propellant farm (LOX sphere, RP-1, LN2) 110 deg / 105 m
  floodlight masts at (-70,-60), (75,40) (these two carry the night SpotLights in pad.ts), (70,-65), (-65,55)

Nodes: PAD_L0 / PAD_L1 / PAD_L2 (LODs), PAD_COMMON (apron, roads, slabs; always drawn, no shadow cast).
"""
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from bgeo import *  # noqa
from mathutils import Vector, Matrix

D2R = math.pi / 180
Y_AX = Vector((0, 1, 0))
TRENCH_AZ = 200.0
TRENCH_EXIT = 42.0
APRON = 160.0
TE_PIVOT = Vector((0.0, 5.2, -7.4))
TE_LEAN = -3.0 * D2R            # rotation about +X; negative = top leans north (away from the vehicle)
TE_H = 66.0
TOWERS = [(300, 30.0), (30, 48.0), (120, 48.0), (215, 48.0)]
TOWER_H = 88.0
FLOODS = [(-70, -60), (75, 40), (70, -65), (-65, 55)]
FLOOD_H = 38.0

PALETTE.update({
    'Pad_Concrete': ((0.55, 0.54, 0.5), 0.9, 0.0), 'Pad_Apron': ((0.55, 0.54, 0.5), 0.9, 0.0),
    'Pad_Pit': ((0.01, 0.01, 0.01), 1.0, 0.0), 'Pad_TE': ((0.8, 0.8, 0.78), 0.55, 0.3),
    'Pad_Hangar': ((0.75, 0.75, 0.72), 0.55, 0.3), 'Pad_Tank': ((0.85, 0.85, 0.83), 0.45, 0.3),
})


def hd(h, d, y=0.0):
    """heading (deg, clockwise from north) + distance -> pad-frame point"""
    return Vector((d * math.sin(h * D2R), y, -d * math.cos(h * D2R)))


def rot_y_to(dir_xz):
    """3x3 rotation about +Y taking local +Z onto the horizontal direction dir_xz"""
    phi = math.atan2(dir_xz.x, dir_xz.z)
    return Matrix.Rotation(phi, 3, Y_AX)


T_DIR = hd(TRENCH_AZ, 1.0)
M_TR = rot_y_to(T_DIR)            # trench frame: local +Z = along the duct, +X = across


def tr(t, y, s):
    """trench-frame (across, up, along) -> pad frame"""
    return M_TR @ Vector((t, y, s))


def face_out(mb, pts, mat, out, uvs=None):
    """add a planar polygon, flipped so its normal points along `out`"""
    P = [Vector(p) for p in pts]
    n = (P[1] - P[0]).cross(P[2] - P[1])
    if n.dot(Vector(out)) < 0:
        P = P[::-1]
        uvs = uvs[::-1] if uvs else None
    mb.face([mb.vert(p) for p in P], mat, uvs)


def planar_uv(pts, s=0.25):
    return [(p[0] * s, p[2] * s + p[1] * s) for p in pts]


def sph(mb, c, r, mat, seg=12):
    prof = [(r * math.sin(math.pi * i / (seg // 2)), -r * math.cos(math.pi * i / (seg // 2))) for i in range(seg // 2 + 1)]
    prof[0] = (0.0, -r); prof[-1] = (0.0, r)
    mb.lathe(prof, seg, mat, center=tuple(c), uv=None)


def facing(fwd):
    """3x3 with local +Z -> fwd, local +Y ~ up"""
    f = Vector(fwd).normalized()
    r = Y_AX.cross(f).normalized()
    u = f.cross(r).normalized()
    return Matrix((r, u, f)).transposed()


# ================================================================================ common (slabs)
def slab(mb, cx, cz, sx, sz, top, mat, M=None, uv=1 / 8):
    mb.box((cx, top - 0.25, cz), (sx, 0.5, sz), mat, M=M, uv_scale=uv, skip=('-y',))


def build_common():
    root = empty('PAD_COMMON')
    mb = MB()
    # apron: unique albedo (pad_apron_albedo, repeat 1/20 in pad.ts) + tiled concrete detail maps.
    # UV in 8 m tiles: u = (x + 80) / 8, three v = (z + 80) / 8 (-> blender v = 1 - that)
    h = APRON / 2
    y = 0.08
    pts = [(-h, y, -h), (-h, y, h), (h, y, h), (h, y, -h)]
    mb.face([mb.vert(p) for p in pts], 'Pad_Apron', [((p[0] + h) / 8, 1 - (p[2] + h) / 8) for p in pts])
    for (a, b, o) in [((-h, -h), (h, -h), (0, 0, -1)), ((h, -h), (h, h), (1, 0, 0)), ((h, h), (-h, h), (0, 0, 1)), ((-h, h), (-h, -h), (-1, 0, 0))]:
        q = [(a[0], y, a[1]), (b[0], y, b[1]), (b[0], -0.6, b[1]), (a[0], -0.6, a[1])]
        face_out(mb, q, 'Pad_Concrete', o, [(0, 0), (APRON / 8, 0), (APRON / 8, 0.08), (0, 0.08)])
    # rail bed apron -> hangar apron, hangar apron, roads
    slab(mb, 0, -95, 14, 30, 0.07, 'Pad_Concrete')
    slab(mb, 0, -180, 70, 140, 0.075, 'Pad_Concrete')
    slab(mb, 16, -95, 8, 30, 0.06, 'Pad_Asphalt')                       # service road north
    slab(mb, -200, 10, 240, 9, 0.06, 'Pad_Asphalt')                     # access road west
    # propellant farm slab + road
    tf = hd(110, 105)
    slab(mb, tf.x, tf.z, 44, 40, 0.07, 'Pad_Concrete', M=rot_y_to(hd(110, 1)))
    # water tower slab
    wt = hd(250, 150)
    slab(mb, wt.x, wt.z, 26, 26, 0.07, 'Pad_Concrete')
    slab(mb, -104, 45, 50, 7, 0.06, 'Pad_Asphalt')
    ob = mb.build('PAD_COMMON_APRON', parent=root, smooth=30)
    return root


# ================================================================================ launch mount
def launch_mount(mb, lod):
    # flame-duct opening (dark), trench-aligned 6 x 8 m, with a raised curb
    mb.box(tuple(tr(0, 0.05, 0)), (6.0, 0.1, 8.0), 'Pad_Pit', M=M_TR, skip=('-y',))
    for (t, s, w, l) in [(3.3, 0, 0.6, 8.6), (-3.3, 0, 0.6, 8.6), (0, 4.3, 7.2, 0.6), (0, -4.3, 7.2, 0.6)]:
        mb.box(tuple(tr(t, 0.2, s)), (w, 0.4, l), 'Pad_ConcreteDark', M=M_TR, uv_scale=1 / 8)
    # steel launch-mount frame: 4 columns on footings, beams on the west/north/east sides only (the
    # south stays open so the pad "engine" camera at heading 205 deg / 17 m / 1.4 m sees the engines;
    # the "launch mount" camera at 118 deg / 7.8 m sits just outside the SE column)
    c = 4.6
    for sx in (-1, 1):
        for sz in (-1, 1):
            mb.box((sx * c, 0.3, sz * c), (1.8, 0.6, 1.8), 'Pad_Concrete', uv_scale=1 / 8)
            mb.box((sx * c, 2.5, sz * c), (0.9, 3.8, 0.9), 'Pad_SteelDark')
        mb.box((sx * c, 4.3, 0), (0.9, 0.8, 2 * c + 0.9), 'Pad_SteelDark')
        for dz in (-1.2, 1.2):
            mb.box((sx * (c + 3.4) / 2, 4.75, dz), (c - 3.4 + 0.2, 0.9, 0.5), 'Pad_SteelDark')
        if lod == 0:
            # diagonal braces on the east / west faces
            mb.cyl((sx * c, 0.6, c - 0.4), (sx * c, 3.9, -c + 0.4), 0.14, 'Pad_SteelDark', seg=6)
    mb.box((0, 4.3, -c), (2 * c - 0.9, 0.8, 0.9), 'Pad_SteelDark')
    r0, r1 = 2.05, 3.4
    rm = (r0 + r1) / 2
    chord = 2 * rm * math.tan(math.pi / 8) + 0.25
    for k in range(8):
        a = (k + 0.5) * math.pi / 4
        M = Matrix.Rotation(-a, 3, Y_AX)
        mb.box((rm * math.cos(a), 5.02, rm * math.sin(a)), (r1 - r0, 0.46, chord), 'Pad_Steel', M=M)
    # hold-down clamps between the legs (body angles 45/135/225/315, body X = pad X on the pad)
    for k in range(4):
        a = (45 + 90 * k) * D2R
        M = Matrix.Rotation(-a, 3, Y_AX)
        rad = Vector((math.cos(a), 0, math.sin(a)))
        c = lambda r, y: tuple(rad * r + Vector((0, y, 0)))
        mb.box(c(2.55, 5.5, ), (0.9, 0.5, 0.8), 'Pad_SteelDark', M=M)
        if lod == 0:
            mb.box(c(2.02, 5.85), (0.28, 0.95, 0.5), 'Pad_Steel', M=M)
            mb.box(c(1.93, 6.25), (0.2, 0.18, 0.44), 'Pad_Steel', M=M)
            mb.cyl(c(3.1, 5.3), c(2.25, 6.1), 0.11, 'Pad_Pipe', seg=8)
    if lod == 0:
        # deluge ring + risers
        pts = [hd(45 * k, 10.0, 0.45) for k in range(1, 8)]      # open toward the TE rails (north)
        mb.tube(pts, 0.25, 'Pad_Pipe', seg=10)
        for p in pts:
            mb.box((p.x, 0.25, p.z), (0.5, 0.5, 0.5), 'Pad_SteelDark')
        # T-0 umbilical box + cable tray on the TE side
        mb.box((0, 1.6, -5.6), (2.6, 3.2, 1.2), 'Pad_SteelDark')
        mb.box((0, 0.45, -9.0), (1.0, 0.25, 8.0), 'Pad_Cable')


# ================================================================================ trench exit
def trench_exit(mb, lod):
    s0 = TRENCH_EXIT - 2.0          # headwall face
    # headwall pillars + lintel, dark duct mouth
    for t in (-5.6, 5.6):
        mb.box(tuple(tr(t, 1.7, s0 + 0.4)), (1.6, 3.4, 1.2), 'Pad_ConcreteDark', M=M_TR, uv_scale=1 / 8)
    mb.box(tuple(tr(0, 3.1, s0 + 0.4)), (12.8, 0.6, 1.2), 'Pad_ConcreteDark', M=M_TR, uv_scale=1 / 8)
    mb.box(tuple(tr(0, 1.45, s0 - 1.2)), (9.6, 2.9, 3.0), 'Pad_Pit', M=M_TR)
    # flared wing walls
    for side in (-1, 1):
        a = Vector(tr(side * 6.4, 0, s0 + 0.9))
        b = Vector(tr(side * 10.5, 0, s0 + 11))
        U = (b - a); L = U.length; U.normalize()
        V = Y_AX.copy()
        N = U.cross(V)
        poly = [(0, 0), (L, 0), (L, 0.7), (0, 3.3)]
        mb.prism(poly, (a - N * 0.35, U, V, N), 0.7, 'Pad_ConcreteDark', uv_scale=1 / 8)
    # gravel berm over the last part of the covered duct
    prof = [(-12.5, 0.0), (12.5, 0.0), (7.2, 3.4), (-7.2, 3.4)]
    sA, sB, sR = s0 - 11, s0, s0 - 17
    P = lambda i, s: tr(prof[i][0], prof[i][1], s)
    Q = lambda t, y, s: tr(t, y, s)
    up = Vector((0, 1, 0))
    faces = [
        ([P(3, sA), P(2, sA), P(2, sB), P(3, sB)], up),                                   # top
        ([P(1, sA), P(2, sA), P(2, sB), P(1, sB)], tr(1, 0.6, 0)),                        # slopes
        ([P(0, sA), P(3, sA), P(3, sB), P(0, sB)], tr(-1, 0.6, 0)),
        ([Q(-7.2, 0, sR), Q(7.2, 0, sR), P(2, sA), P(3, sA)], tr(0, 1, -0.6)),            # ramp
        ([Q(7.2, 0, sR), P(1, sA), P(2, sA)], tr(1, 0.5, -0.5)),
        ([Q(-7.2, 0, sR), P(3, sA), P(0, sA)], tr(-1, 0.5, -0.5)),
        ([P(0, sB), P(1, sB), P(2, sB), P(3, sB)], tr(0, 0, 1)),                          # end (behind headwall)
    ]
    for pts, out in faces:
        face_out(mb, pts, 'Pad_Ground', out, planar_uv(pts))


# ================================================================================ transporter-erector
def strongback(lod):
    """TE strongback in its own frame: pivot at origin, +Y along the strongback, vehicle side +Z"""
    te = MB()
    hx, hz = 2.3, 1.2
    ch = 0.7 if lod < 2 else 4.6
    if lod == 2:
        te.box((0, TE_H / 2, 0), (4.6 + 0.7, TE_H, 2.4 + 0.7), 'Pad_TE')
        return te
    for sx in (-1, 1):
        for sz in (-1, 1):
            te.box((sx * hx, TE_H / 2, sz * hz), (ch, TE_H, ch), 'Pad_TE')
    nlev = 20
    for i in range(nlev + 1):
        y = 1.0 + i * (TE_H - 2) / nlev
        if lod == 1 and i % 2:
            continue
        for sz in (-1, 1):
            te.box((0, y, sz * hz), (2 * hx, 0.32, 0.32), 'Pad_TE')
        for sx in (-1, 1):
            te.box((sx * hx, y, 0), (0.32, 0.32, 2 * hz), 'Pad_TE')
        if lod == 0 and i < nlev:
            y1 = 1.0 + (i + 1) * (TE_H - 2) / nlev
            sgn = 1 if i % 2 else -1
            for sz in (-1, 1):
                te.cyl((-hx * sgn, y, sz * hz), (hx * sgn, y1, sz * hz), 0.12, 'Pad_TE', seg=6, caps=False)
            for sx in (-1, 1):
                te.cyl((sx * hx, y, -hz * sgn), (sx * hx, y1, hz * sgn), 0.1, 'Pad_TE', seg=6, caps=False)
    # retracted umbilical / clamp arms toward the vehicle
    for (y, L, w) in [(10.5, 2.4, 1.4), (41.5, 2.6, 1.6), (46.5, 2.2, 1.2), (61.0, 2.8, 1.8)]:
        te.box((0, y, hz + 0.35 + L / 2), (w, 0.9, L), 'Pad_TE')
        if lod == 0:
            te.box((0, y - 0.7, hz + 0.35 + L * 0.6), (0.5, 0.5, L * 0.8), 'Pad_Cable')
    # top platform + lightning rod
    te.box((0, TE_H + 0.2, 0), (5.6, 0.4, 3.2), 'Pad_TE')
    if lod == 0:
        te.cyl((0, TE_H + 0.4, 0), (0, TE_H + 5.0, 0), 0.08, 'Pad_Steel', seg=6)
        # cable/plumbing runs up the vehicle-side face
        for x in (-1.0, 0.0, 1.0):
            te.cyl((x, 0.5, hz + 0.45), (x, 60, hz + 0.45), 0.12, 'Pad_Pipe', seg=6, caps=False)
    return te


def transporter_erector(mb, lod):
    M = Matrix.Rotation(TE_LEAN, 3, Vector((1, 0, 0)))
    mb.merge(strongback(lod), xf=(M, TE_PIVOT))
    # pivot supports on the pad
    for sx in (-1, 1):
        mb.box((sx * 2.3, TE_PIVOT.y / 2, TE_PIVOT.z), (1.0, TE_PIVOT.y, 1.6), 'Pad_SteelDark')
    # carriage on the rails (x = +-5) behind the pivot
    z0, z1 = -8.8, -24.0
    zc, zl = (z0 + z1) / 2, z0 - z1
    for sx in (-1, 1):
        mb.box((sx * 5.0, 4.4, zc), (1.1, 1.2, zl), 'Pad_TE')
        if lod < 2:
            for z in (z0 - 1.5, z1 + 1.5):
                mb.box((sx * 5.0, 0.7, z), (1.4, 1.4, 2.6), 'Pad_SteelDark')      # bogies
                mb.box((sx * 5.0, 2.4, z), (0.9, 2.4, 0.9), 'Pad_TE')
    for z in (z0 - 0.5, zc, z1 + 0.5):
        mb.box((0, 4.4, z), (10.0, 1.0, 1.0), 'Pad_TE')
    if lod == 0:
        # erector cylinders
        for sx in (-1, 1):
            a = Vector((sx * 2.3, 4.9, z1 + 2.0))
            b = TE_PIVOT + M @ Vector((sx * 2.3, 24.0, -1.6))
            m = a.lerp(b, 0.58)
            mb.cyl(a, m, 0.5, 'Pad_TE', seg=12)
            mb.cyl(m - (b - a).normalized() * 0.3, b, 0.28, 'Pad_Steel', seg=10)
        # rails to the hangar
        for sx in (-1, 1):
            for dx in (-0.75, 0.75):
                mb.box((sx * 5.0 + dx, 0.2, -69.0), (0.16, 0.24, 124.0), 'Pad_Steel')


# ================================================================================ towers & wires
def lightning_towers(mb, lod):
    tops = []
    for (h, d) in TOWERS:
        p = hd(h, d)
        seg = [16, 10, 6][lod]
        mb.box((p.x, 0.5, p.z), (5.0, 1.0, 5.0), 'Pad_Concrete', uv_scale=1 / 8)
        mb.cyl((p.x, 0.9, p.z), (p.x, 72.0, p.z), 1.35, 'Pad_Tower', seg=seg, r1=0.6)
        # banded upper mast (aviation marking)
        n = 4
        for i in range(n):
            y0 = 72.0 + i * 3.2
            mb.cyl((p.x, y0, p.z), (p.x, y0 + 3.2, p.z), 0.6 - 0.05 * i, 'Pad_TowerRed' if i % 2 == 0 else 'Pad_White', seg=seg,
                   r1=0.55 - 0.05 * i, caps=False)
        mb.cyl((p.x, 84.8, p.z), (p.x, TOWER_H, p.z), 0.18, 'Pad_Steel', seg=max(4, seg // 2))
        if lod < 2:
            sph(mb, (p.x, 72.4, p.z), 0.35, 'Pad_LightRed', 8)
            sph(mb, (p.x, TOWER_H + 0.25, p.z), 0.3, 'Pad_LightRed', 8)
        if lod == 0:
            # climbing ladder cage stand-off + platform
            mb.box((p.x, 40.0, p.z), (3.2, 0.25, 3.2), 'Pad_SteelDark')
        tops.append(Vector((p.x, TOWER_H - 1.2, p.z)))
    if lod < 2:
        order = sorted(range(len(TOWERS)), key=lambda i: TOWERS[i][0])
        for k in range(len(order)):
            a, b = tops[order[k]], tops[order[(k + 1) % len(order)]]
            L = (b - a).length
            sag = 0.05 * L
            n = 24
            pts = [a.lerp(b, i / n) - Vector((0, sag * 4 * (i / n) * (1 - i / n), 0)) for i in range(n + 1)]
            mb.tube(pts, 0.06 if lod == 0 else 0.12, 'Pad_Cable', seg=4, caps=False)


def flood_masts(mb, lod):
    for (x, z) in FLOODS:
        seg = [10, 6, 4][lod]
        mb.box((x, 0.4, z), (3.0, 0.8, 3.0), 'Pad_Concrete', uv_scale=1 / 8)
        mb.cyl((x, 0.8, z), (x, FLOOD_H - 1.0, z), 0.55, 'Pad_Tower', seg=seg, r1=0.3)
        f = Vector((-x, 30 - FLOOD_H, -z)).normalized()
        fh = Vector((f.x, 0, f.z)).normalized()
        M = facing(fh)
        c = Vector((x, FLOOD_H, z))
        mb.box(tuple(c - Vector((0, 1.2, 0))), (5.4, 0.3, 2.0), 'Pad_SteelDark', M=M)
        Mt = facing(f)
        mb.box(tuple(c), (5.0, 2.6, 0.5), 'Pad_SteelDark', M=Mt)
        if lod < 2:
            mb.box(tuple(c + f * 0.27), (4.6, 2.2, 0.05), 'Pad_Flood', M=Mt)
            sph(mb, (x, FLOOD_H + 1.6, z), 0.22, 'Pad_LightRed', 6)


# ================================================================================ buildings
def hangar(mb, lod):
    zc, L, W, H = -178.0, 95.0, 36.0, 22.0
    z0 = zc - L / 2
    poly = [(-W / 2, 0), (W / 2, 0), (W / 2, H), (0, H + 2.6), (-W / 2, H)]
    mb.prism(poly, (Vector((0, 0, z0)), Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))), L, 'Pad_Hangar')
    zf = z0 + L
    mb.box((0, 9.7, zf + 0.2), (18.0, 19.4, 0.4), 'Pad_HangarDoor')
    mb.box((0, 20.2, zf + 0.5), (20.0, 1.4, 1.0), 'Pad_Hangar')
    if lod == 0:
        for i in range(7):
            mb.box((-9.0 + i * 3.0, 9.7, zf + 0.45), (0.25, 19.4, 0.12), 'Pad_Hangar')
        for i in range(17):
            z = z0 + 2.0 + i * (L - 4) / 16
            for sx in (-1, 1):
                mb.box((sx * (W / 2 + 0.2), H / 2, z), (0.4, H, 0.5), 'Pad_HangarDoor')
        # side doors, vents
        for z in (z0 + 20, z0 + 60):
            mb.box((W / 2 + 0.1, 3.0, z), (0.2, 6.0, 6.0), 'Pad_HangarDoor')
        for x in (-10, 0, 10):
            mb.box((x, H + 2.0, zc), (3.0, 1.2, 3.0), 'Pad_Steel')
    # office annex (east) + small utility buildings near the pad
    mb.box((W / 2 + 7.0, 5.0, zc + 10), (14.0, 10.0, 34.0), 'Pad_White')
    if lod < 2:
        mb.box((W / 2 + 7.0, 10.3, zc + 10), (14.4, 0.6, 34.4), 'Pad_SteelDark')
        mb.box((-60.0, 3.0, -40.0), (14.0, 6.0, 10.0), 'Pad_White')
        mb.box((52.0, 2.5, -30.0), (10.0, 5.0, 8.0), 'Pad_White')


def water_tower(mb, lod):
    c = hd(250, 150)
    seg = [24, 14, 8][lod]
    if lod < 2:
        for k in range(6):
            a = k * math.pi / 3
            p0 = c + Vector((7.5 * math.cos(a), 0, 7.5 * math.sin(a)))
            p1 = c + Vector((5.2 * math.cos(a), 34.5, 5.2 * math.sin(a)))
            mb.cyl(p0, p1, 0.45, 'Pad_Steel', seg=8)
        mb.cyl(c, c + Vector((0, 34, 0)), 1.3, 'Pad_Tank', seg=seg // 2)
        if lod == 0:
            for y in (12.0, 24.0):
                rr = 7.5 - 2.3 * y / 34.5
                pts = [c + Vector((rr * math.cos(k * math.pi / 3), y, rr * math.sin(k * math.pi / 3))) for k in range(6)]
                mb.tube(pts, 0.18, 'Pad_Steel', seg=6, closed=True)
            pts = [c + Vector((8.6 * math.cos(k * TAU / 24), 36.2, 8.6 * math.sin(k * TAU / 24))) for k in range(24)]
            mb.tube(pts, 0.05, 'Pad_Steel', seg=4, closed=True)
    else:
        mb.cyl(c, c + Vector((0, 34, 0)), 3.0, 'Pad_Steel', seg=6)
    prof = [(0.0, 33.0), (4.5, 33.8), (8.0, 35.5), (8.0, 47.0), (4.0, 49.5), (0.0, 50.6)]
    mb.lathe(prof, seg, 'Pad_Tank', center=(c.x, 0, c.z), uv=None)


def prop_farm(mb, lod):
    ctr = hd(110, 105)
    M = rot_y_to(hd(110, 1))
    L = lambda x, y, z: ctr + M @ Vector((x, y, z))
    seg = [24, 14, 8][lod]
    # LOX sphere on legs
    sc = L(-10, 9.5, 0)
    sph(mb, sc, 6.5, 'Pad_Tank', seg)
    if lod < 2:
        for k in range(8):
            a = k * math.pi / 4
            d = Vector((math.cos(a), 0, math.sin(a)))
            mb.cyl(sc + d * 6.2 - Vector((0, 9.5, 0)), sc + d * 6.3 + Vector((0, 0.5, 0)), 0.3, 'Pad_Steel', seg=6)
    # RP-1 horizontal tanks on saddles
    for x in (7.0, 12.5):
        mb.cyl(L(x, 3.2, -9), L(x, 3.2, 9), 2.2, 'Pad_Tank', seg=seg)
        if lod < 2:
            for z in (-6, 0, 6):
                mb.box(tuple(L(x, 0.9, z)), (3.2, 1.8, 0.6), 'Pad_Concrete', M=M, uv_scale=1 / 8)
    # LN2 / helium vertical dewars
    for (x, z, r, h) in [(-2, 14, 1.7, 15), (3, 14, 1.2, 11)]:
        mb.cyl(L(x, 0, z), L(x, h, z), r, 'Pad_Tank', seg=max(8, seg // 2))
    mb.box(tuple(L(0, 2.6, -15)), (12, 5.2, 6), 'Pad_White', M=M)
    if lod == 0:
        # pipe run along the covered pipe trench to the mount
        d = hd(110, 1)
        pr = Vector((-d.z, 0, d.x))
        for i, off in enumerate((-0.35, 0.0, 0.35)):
            a = d * 12 + pr * off + Vector((0, 0.5, 0))
            b = d * 86 + pr * off + Vector((0, 0.5, 0))
            mb.cyl(a, b, 0.14 if i != 1 else 0.2, 'Pad_Pipe', seg=8)
        for k in range(10):
            p = d * (14 + k * 8)
            mb.box((p.x, 0.3, p.z), (0.3, 0.45, 1.2), 'Pad_SteelDark', M=M)


# ================================================================================ build
def build(lod):
    root = empty(f'PAD_L{lod}')
    mb = MB()
    launch_mount(mb, lod)
    trench_exit(mb, lod)
    transporter_erector(mb, lod)
    lightning_towers(mb, lod)
    flood_masts(mb, lod)
    hangar(mb, lod)
    water_tower(mb, lod)
    prop_farm(mb, lod)
    mb.build(f'PAD_L{lod}_mesh', parent=root, smooth=35)
    print(f'PAD_L{lod}', len(mb.f), 'faces')
    return root


def main():
    reset_scene()
    build_common()
    for lod in (0, 1, 2):
        build(lod)
    export_glb(os.path.join(ROOT, 'public', 'models', 'slc4e.glb'), draco=True)


main()
