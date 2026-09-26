"""Droneship "Of Course I Still Love You" (Marmac 300 barge + wing extensions).

  blender -b --python blender/build_ocisly.py

Writes public/models/ocisly.glb. Ship frame (three.js coords, matches src/core/vehicleSpec.ts OCISLY
and src/sim/ship.ts): origin = deck centre (landing aim point) at deck level, +Y up, +Z bow,
+X port. Deck 3.2 m above the waterline, hull 91.4 x 30.5 x 6.1 m, deck with wings 52 m wide.

Nodes: SHIP_L0 (full), SHIP_L1 (no railings / trusses / small parts), SHIP_L2 (boxes).
Materials by name (src/render/vehicles/droneship.ts): Ship_Deck, Ship_Hull, Ship_Wall,
Ship_WallInner, Ship_Container, Ship_ContainerDark, Ship_Metal, Ship_Yellow, Ship_Rail, Ship_Dome,
Ship_Truss, Ship_Thruster, Ship_Rust, Ship_LightRed/Green/White/Amber, Ship_Flood.
"""
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from bgeo import *  # noqa
from mathutils import Vector, Matrix

L, BEAM, DEPTH = 91.4, 30.5, 6.1
HL, HB = L / 2, BEAM / 2
DECK_W = 52.0
WX = DECK_W / 2
WING_Z0, WING_Z1 = -30.0, 38.0
WING_T = 1.2
RAKE_Z = 39.0      # bottom starts rising toward the ends
RAKE_Y = -2.3      # bottom height at the transoms
WALL_Z = -30.6     # aft blast wall
BOW_WALL_Z = 38.6

PALETTE.update({
    'Ship_Deck': ((0.05, 0.05, 0.05), 0.8, 0.0), 'Ship_Hull': ((0.03, 0.035, 0.04), 0.7, 0.2),
    'Ship_Wall': ((0.06, 0.06, 0.065), 0.75, 0.3), 'Ship_Container': ((0.7, 0.7, 0.68), 0.6, 0.2),
    'Ship_ContainerDark': ((0.1, 0.1, 0.11), 0.6, 0.3), 'Ship_Yellow': ((0.7, 0.45, 0.02), 0.55, 0.2),
    'Ship_Rail': ((0.5, 0.5, 0.48), 0.5, 0.6), 'Ship_Dome': ((0.9, 0.9, 0.9), 0.45, 0.0),
})


def deck_uv(p):
    # u = (26 - x)/52 ; three v = (45.7 - z)/91.4 -> blender v = 1 - that
    return ((WX - p[0]) / DECK_W, (p[2] + HL) / L)


def hull(mb, lod):
    """hull shell: sides (strip texture), transoms, rakes, bottom."""
    st = [(-HL, RAKE_Y), (-RAKE_Z, -DEPTH), (RAKE_Z, -DEPTH), (HL, RAKE_Y)]
    for side in (1, -1):
        x = side * HB
        for i in range(3):
            (z0, b0), (z1, b1) = st[i], st[i + 1]
            if side > 0:  # port (+X): seen from outside the bow is on the left -> u runs bow->stern
                u0, u1 = (HL - z0) / L, (HL - z1) / L
                pts = [(x, 0, z1), (x, 0, z0), (x, b0, z0), (x, b1, z1)]
                uvs = [(u1, 1), (u0, 1), (u0, 1 + b0 / DEPTH), (u1, 1 + b1 / DEPTH)]
            else:
                u0, u1 = (z0 + HL) / L, (z1 + HL) / L
                pts = [(x, 0, z0), (x, 0, z1), (x, b1, z1), (x, b0, z0)]
                uvs = [(u0, 1), (u1, 1), (u1, 1 + b1 / DEPTH), (u0, 1 + b0 / DEPTH)]
            # both orderings above wind inward -> reverse for an outward (+X*side) normal
            ids = [mb.vert(p) for p in pts][::-1]
            uvs = uvs[::-1]
            mb.face(ids, 'Ship_Hull', uvs)
    # transoms (vertical ends) and rake panels, bottom
    for e in (1, -1):
        z = e * HL
        pts = [(-HB, 0, z), (HB, 0, z), (HB, RAKE_Y, z), (-HB, RAKE_Y, z)]
        uvs = [(0.0, 1), (BEAM / L, 1), (BEAM / L, 1 + RAKE_Y / DEPTH), (0.0, 1 + RAKE_Y / DEPTH)]
        ids = [mb.vert(p) for p in pts]
        if e > 0:
            ids = ids[::-1]; uvs = uvs[::-1]
        mb.face(ids, 'Ship_Hull', uvs)
        zr = e * RAKE_Z
        pts = [(-HB, RAKE_Y, z), (HB, RAKE_Y, z), (HB, -DEPTH, zr), (-HB, -DEPTH, zr)]
        ids = [mb.vert(p) for p in pts]
        if e > 0:
            ids = ids[::-1]
        mb.face(ids, 'Ship_Hull', [(0, 0.3)] * 4)
    ids = [mb.vert(p) for p in [(-HB, -DEPTH, -RAKE_Z), (HB, -DEPTH, -RAKE_Z), (HB, -DEPTH, RAKE_Z), (-HB, -DEPTH, RAKE_Z)]]
    mb.face(ids, 'Ship_Hull', [(0, 0.1)] * 4)
    # rubbing strake / deck-edge coaming along the hull sides
    if lod <= 1:
        for side in (1, -1):
            mb.box((side * (HB + 0.1), -0.35, 0), (0.2, 0.3, L - 0.4), 'Ship_Metal')


def deck(mb):
    s = len(mb.f)
    # main deck + wings, top at y = 0 (up-facing quads: CCW seen from +Y = x->z ... use [a, d, c, b])
    def up_quad(x0, x1, z0, z1):
        ids = [mb.vert(p) for p in [(x0, 0, z0), (x0, 0, z1), (x1, 0, z1), (x1, 0, z0)]]
        mb.face(ids, 'Ship_Deck')
    # split the hull deck at the wing ends so vertices line up
    up_quad(-HB, HB, -HL, WING_Z0)
    up_quad(-HB, HB, WING_Z0, WING_Z1)
    up_quad(-HB, HB, WING_Z1, HL)
    up_quad(HB, WX, WING_Z0, WING_Z1)
    up_quad(-WX, -HB, WING_Z0, WING_Z1)
    for fi in range(s, len(mb.f)):
        mb.uv[fi] = [deck_uv(mb.v[k]) for k in mb.f[fi]]


def wings(mb, lod):
    for side in (1, -1):
        xin, xout = side * HB, side * WX
        xc = (xin + xout) / 2
        w = WX - HB
        zc = (WING_Z0 + WING_Z1) / 2
        # thick slab below the deck plane (top face provided by deck())
        mb.box((xc, -WING_T / 2 - 0.01, zc), (w, WING_T - 0.02, WING_Z1 - WING_Z0), 'Ship_Truss',
               skip=('+y', '+x' if side > 0 else '-x'))
        # outer fascia uses the hull strip (same u/v as the hull sides) -> hull name visible here
        y0, y1 = -WING_T, 0.0
        if side > 0:
            pts = [(xout, y1, WING_Z1), (xout, y0, WING_Z1), (xout, y0, WING_Z0), (xout, y1, WING_Z0)]
            u = lambda z: (HL - z) / L
        else:
            pts = [(xout, y1, WING_Z0), (xout, y0, WING_Z0), (xout, y0, WING_Z1), (xout, y1, WING_Z1)]
            u = lambda z: (z + HL) / L
        uvs = [(u(p[2]), 1 + p[1] / DEPTH) for p in pts]
        ids = [mb.vert(p) for p in pts]
        mb.face(ids, 'Ship_Hull', uvs)
        if lod == 0:
            # underside girders + diagonal braces to the hull side
            for z in [WING_Z0 + 1 + i * (WING_Z1 - WING_Z0 - 2) / 11 for i in range(12)]:
                mb.box((xc, -WING_T - 0.35, z), (w, 0.7, 0.25), 'Ship_Truss')
                mb.cyl((side * HB, -3.0, z), (side * (WX - 2.5), -WING_T - 0.4, z), 0.16, 'Ship_Truss', seg=8)
            # outer edge coaming (yellow top) + railings
            mb.box((xout - side * 0.1, 0.18, zc), (0.2, 0.36, WING_Z1 - WING_Z0), 'Ship_Yellow')
        elif lod == 1:
            mb.box((xout - side * 0.1, 0.18, zc), (0.2, 0.36, WING_Z1 - WING_Z0), 'Ship_Yellow')


def railing(mb, p0, p1, h=1.1, spacing=2.0, r=0.028, seg=6):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    n = max(1, int(d.length / spacing))
    for i in range(n + 1):
        p = p0 + d * (i / n)
        mb.cyl(p, p + Vector((0, h, 0)), r, 'Ship_Rail', seg=seg, caps=False)
    for hh in (h * 0.5, h):
        mb.cyl(p0 + Vector((0, hh, 0)), p1 + Vector((0, hh, 0)), r * 1.1, 'Ship_Rail', seg=seg, caps=False)


def container(mb, c, length=12.19, rot=0.0, mat='Ship_Container', lod=0):
    w, h = 2.44, 2.59
    M = Matrix.Rotation(rot, 3, Vector((0, 1, 0)))
    mb.box((c[0], c[1] + h / 2, c[2]), (length, h, w), mat, M=M)
    if lod == 0:
        # corrugation ribs on the long sides + door frame
        n = int(length / 0.6)
        for i in range(n):
            x = -length / 2 + (i + 0.5) * length / n
            for sz in (-1, 1):
                p = M @ Vector((x, 0, sz * (w / 2 + 0.02)))
                mb.box((c[0] + p.x, c[1] + h / 2, c[2] + p.z), (0.12, h * 0.9, 0.04), mat, M=M)
        p = M @ Vector((length / 2 + 0.03, 0, 0))
        mb.box((c[0] + p.x, c[1] + h / 2, c[2] + p.z), (0.06, h, w), 'Ship_Metal', M=M)


def blast_wall(mb, lod):
    hgt, t = 5.5, 0.45
    mb.box((0, hgt / 2, WALL_Z - t / 2), (BEAM - 0.4, hgt, t), 'Ship_Wall')
    if lod == 0:
        for x in [-HB + 1 + i * 2.0 for i in range(15)]:
            mb.box((x, hgt / 2, WALL_Z + 0.15), (0.22, hgt, 0.3), 'Ship_WallInner')
        mb.box((0, hgt + 0.1, WALL_Z - t / 2), (BEAM - 0.3, 0.2, t + 0.25), 'Ship_Yellow')
    # bow: lower wall
    mb.box((0, 1.0, BOW_WALL_Z + 0.2), (BEAM - 0.4, 2.0, 0.35), 'Ship_Wall')
    if lod == 0:
        mb.box((0, 2.05, BOW_WALL_Z + 0.2), (BEAM - 0.3, 0.12, 0.5), 'Ship_Yellow')


def aft_equipment(mb, lod):
    # stern: containers (generators, thruster power, control), in two rows behind the wall
    container(mb, (-8.2, 0, -34.2), rot=0, mat='Ship_Container', lod=lod)
    container(mb, (-8.2, 2.59, -34.2), rot=0, mat='Ship_ContainerDark', lod=lod)
    container(mb, (5.5, 0, -34.2), length=6.06, mat='Ship_Container', lod=lod)
    container(mb, (5.5, 0, -37.4), length=6.06, mat='Ship_Yellow', lod=lod)
    container(mb, (-9.0, 0, -39.6), length=6.06, mat='Ship_ContainerDark', lod=lod)
    container(mb, (-2.5, 0, -39.6), length=6.06, mat='Ship_Container', lod=lod)
    # "Octagrabber" garage / deckhouse
    mb.box((6.0, 1.6, -42.3), (6.0, 3.2, 5.0), 'Ship_Container')
    if lod == 0:
        mb.box((6.0, 1.4, -39.77), (4.0, 2.8, 0.06), 'Ship_Metal')
        # fuel/water tanks
        for x in (-7.0, -9.2):
            mb.cyl((x, 0.0, -44.0), (x, 2.4, -44.0), 0.9, 'Ship_Metal', seg=16)
        # bollards
        for x in (-13.8, 13.8):
            for z in (-45.0, 45.0):
                mb.cyl((x, 0, z), (x, 0.7, z), 0.22, 'Ship_Metal', seg=10)
    # bow equipment
    container(mb, (-7.5, 0, 42.2), length=6.06, mat='Ship_Container', lod=lod)
    container(mb, (-0.5, 0, 42.2), length=6.06, mat='Ship_Yellow', lod=lod)
    container(mb, (6.5, 0, 42.2), length=6.06, mat='Ship_Container', lod=lod)


def thrusters(mb, lod):
    for sx in (1, -1):
        for sz in (1, -1):
            x, z = sx * 11.8, sz * 42.3
            seg = [20, 12, 8][lod]
            mb.cyl((x, 0, z), (x, 2.3, z), 1.35, 'Ship_Thruster', seg=seg)
            if lod <= 1:
                mb.cyl((x, 2.3, z), (x, 2.5, z), 1.45, 'Ship_Metal', seg=seg)
                mb.box((x + sx * 1.6, 1.0, z), (1.2, 2.0, 1.6), 'Ship_Thruster')
            if lod == 0:
                # underwater azimuth pod (column + nacelle + Kort nozzle); pods sit under the flat bottom
                zp = sz * 36.5
                mb.cyl((x, -DEPTH, zp), (x, -DEPTH - 1.6, zp), 0.45, 'Ship_Thruster', seg=12)
                mb.cyl((x, -DEPTH - 2.1, zp - sz * 1.2), (x, -DEPTH - 2.1, zp + sz * 1.0), 0.55, 'Ship_Thruster', seg=12)
                # Kort nozzle shroud: lathe about local Y rotated onto the ship Z axis
                Mz = Matrix.Rotation(math.pi / 2, 3, Vector((1, 0, 0)))
                mb.lathe([(1.05, -0.8), (1.15, -0.2), (1.1, 0.6)], 16, 'Ship_Thruster',
                         center=(x, -DEPTH - 2.1, zp), uv=None, axis_m=Mz)


def mast(mb, lod, lights):
    """stern lattice mast with satcom domes + nav lights; small bow mast"""
    bx, bz, H = -4.5, -44.2, 11.0
    if lod <= 1:
        a = 0.45
        for dx in (-a, a):
            for dz in (-a, a):
                mb.cyl((bx + dx, 0, bz + dz), (bx + dx * 0.5, H, bz + dz * 0.5), 0.07, 'Ship_Rail', seg=6)
        if lod == 0:
            for i in range(8):
                y0, y1 = i * H / 8, (i + 1) * H / 8
                s0, s1 = a * (1 - 0.5 * y0 / H), a * (1 - 0.5 * y1 / H)
                for (p, q) in [((-s0, -s0), (s1, -s1)), ((s0, -s0), (s1, s1)), ((s0, s0), (-s1, s1)), ((-s0, s0), (-s1, -s1))]:
                    mb.cyl((bx + p[0], y0, bz + p[1]), (bx + q[0], y1, bz + q[1]), 0.035, 'Ship_Rail', seg=5)
        # platform + crossarm
        mb.box((bx, H - 2.5, bz), (4.2, 0.15, 1.2), 'Ship_Metal')
        mb.box((bx, H, bz), (0.8, 0.15, 0.8), 'Ship_Metal')
        # satcom radomes on the platform
        for dx in (-1.6, 1.6):
            mb.cyl((bx + dx, H - 2.45, bz), (bx + dx, H - 1.9, bz), 0.15, 'Ship_Metal', seg=8)
            sph(mb, (bx + dx, H - 1.3, bz), 0.72, 'Ship_Dome', [16, 10][lod])
        # nav lights: masthead white, port red (+X), starboard green (-X), amber beacon
        sph(mb, (bx, H + 0.3, bz), 0.16, 'Ship_LightWhite', 8)
        sph(mb, (bx + 2.0, H - 2.3, bz), 0.14, 'Ship_LightRed', 8)
        sph(mb, (bx - 2.0, H - 2.3, bz), 0.14, 'Ship_LightGreen', 8)
        sph(mb, (bx, H + 0.75, bz), 0.12, 'Ship_LightAmber', 8)
        # bow mast with anchor light + small dome
        mb.cyl((-4.0, 0, 44.8), (-4.0, 6.0, 44.8), 0.12, 'Ship_Rail', seg=8)
        sph(mb, (-4.0, 6.2, 44.8), 0.16, 'Ship_LightWhite', 8)
        sph(mb, (-4.0, 5.2, 44.8), 0.45, 'Ship_Dome', 10)
    else:
        mb.cyl((bx, 0, bz), (bx, H, bz), 0.35, 'Ship_Rail', seg=6)
        mb.box((bx, H - 1.3, bz), (4.6, 1.3, 1.4), 'Ship_Dome')
    # corner running lights on the wing tips (visible at night from the chase/deck cams)
    for sx, mat in ((1, 'Ship_LightRed'), (-1, 'Ship_LightGreen')):
        for z in (WING_Z0 + 0.5, WING_Z1 - 0.5):
            mb.box((sx * (WX - 0.3), 0.55, z), (0.25, 0.25, 0.25), mat)


def sph(mb, c, r, mat, seg=12):
    prof = [(r * math.sin(t), r * -math.cos(t)) for t in [math.pi * i / (seg // 2) for i in range(seg // 2 + 1)]]
    prof[0] = (0.0, -r); prof[-1] = (0.0, r)
    mb.lathe(prof, seg, mat, center=c, uv=None)


def floodlights(mb, lod):
    """deck floodlight poles along the wing edges, heads aimed at the deck centre"""
    for sx in (1, -1):
        for z in (-20.0, 4.0, 28.0):
            x = sx * (WX - 0.6)
            mb.cyl((x, 0, z), (x, 6.5, z), 0.1, 'Ship_Rail', seg=[8, 6, 4][lod])
            d = Vector((-x, -6.0, -z)).normalized()
            up = Vector((0, 1, 0))
            rgt = up.cross(d).normalized()
            upp = d.cross(rgt).normalized()
            M = Matrix((rgt, upp, d)).transposed()
            c = Vector((x, 6.6, z))
            mb.box(c, (0.7, 0.45, 0.35), 'Ship_Metal', M=M)
            f = c + d * 0.18
            mb.box(f, (0.6, 0.36, 0.02), 'Ship_Flood', M=M)


def railings(mb):
    for sx in (1, -1):
        railing(mb, (sx * (WX - 0.15), 0.36, WING_Z0 + 0.3), (sx * (WX - 0.15), 0.36, WING_Z1 - 0.3))
        railing(mb, (sx * (HB - 0.15), 0, WING_Z1 + 0.4), (sx * (HB - 0.15), 0, HL - 0.4))
        railing(mb, (sx * (HB - 0.15), 0, -HL + 0.4), (sx * (HB - 0.15), 0, WING_Z0 - 0.6))
    railing(mb, (-HB + 0.3, 0, HL - 0.2), (HB - 0.3, 0, HL - 0.2))
    railing(mb, (-HB + 0.3, 0, -HL + 0.2), (HB - 0.3, 0, -HL + 0.2))


def build(lod):
    root = empty(f'SHIP_L{lod}')
    mb = MB()
    hull(mb, lod)
    deck(mb)
    wings(mb, lod)
    blast_wall(mb, lod)
    aft_equipment(mb, lod)
    thrusters(mb, lod)
    mast(mb, lod, True)
    if lod <= 1:
        floodlights(mb, lod)
    if lod == 0:
        railings(mb)
    mb.build(f'SHIP_L{lod}_mesh', parent=root, smooth=30)
    return root


def main():
    reset_scene()
    for lod in (0, 1, 2):
        build(lod)
    export_glb(os.path.join(ROOT, 'public', 'models', 'ocisly.glb'), draco=True)


main()
