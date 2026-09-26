"""Procedural mesh building for the Falcon 9 / OCISLY / SLC-4E generators (Blender 4.5, headless).

All builder coordinates are in the THREE.JS frame (x, y up, z) so the numbers match
src/core/vehicleSpec.ts directly; conversion to Blender's Z-up happens when a mesh is built
(three (x, y, z) -> blender (x, -z, y)); the glTF exporter (+Y up) converts back.
"""
import math
import os
import bpy
import bmesh
from mathutils import Vector, Matrix, Quaternion

TAU = 2 * math.pi
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def B(p):
    return (p[0], -p[2], p[1])


def v3(x, y, z):
    return Vector((x, y, z))


def rot_axis(axis, ang):
    """3x3 rotation matrix (three coords) about a unit axis."""
    return Matrix.Rotation(ang, 3, Vector(axis))


# ------------------------------------------------------------------------------------------------
# materials (Blender-side preview only; three.js replaces them by NAME)
PALETTE = {}


def get_mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    col, rough, metal = PALETTE.get(name, ((0.6, 0.6, 0.6), 0.5, 0.0))
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*col, 1)
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
    return m


# ------------------------------------------------------------------------------------------------
class MB:
    """Accumulating mesh builder (three.js coordinates)."""

    def __init__(self):
        self.v = []
        self.f = []
        self.uv = []
        self.mi = []
        self.mats = []

    # -- basics
    def _m(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def vert(self, p):
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.v) - 1

    def face(self, idx, mat, uvs=None):
        self.f.append(tuple(idx))
        self.uv.append(uvs if uvs is not None else [(0.0, 0.0)] * len(idx))
        self.mi.append(self._m(mat))

    def merge(self, other, xf=None):
        """append another builder, optionally transformed by (M3, t) or a callable p->p"""
        base = len(self.v)
        for p in other.v:
            if xf is None:
                self.v.append(p)
            elif callable(xf):
                self.v.append(tuple(xf(Vector(p))))
            else:
                M, t = xf
                q = M @ Vector(p) + Vector(t)
                self.v.append((q.x, q.y, q.z))
        for f, uv, mi in zip(other.f, other.uv, other.mi):
            self.f.append(tuple(i + base for i in f))
            self.uv.append(uv)
            self.mi.append(self._m(other.mats[mi]))
        return self

    def transform(self, M, t=(0, 0, 0), start=0):
        for i in range(start, len(self.v)):
            q = M @ Vector(self.v[i]) + Vector(t)
            self.v[i] = (q.x, q.y, q.z)
        return self

    # -- lathe (surface of revolution about the axis through `center` parallel to +Y)
    def lathe(self, prof, seg, mat, a0=0.0, a1=TAU, center=(0, 0, 0), uv='cyl', yr=(0.0, 1.0),
              flip=False, jitter=None, axis_m=None):
        """prof: [(r, y)] bottom->top. uv: 'cyl' (u = 1 - a/TAU, v = (y-y0)/(y1-y0)),
        'arc' (v = arc-length fraction), None. jitter(a, y, r) -> dr for wrinkles.
        axis_m: optional 3x3 matrix applied to local (x, y, z) before adding center (tilted lathes)."""
        cx, cy, cz = center
        n = len(prof)
        full = abs((a1 - a0) - TAU) < 1e-6
        cols = seg + 1
        arc = [0.0]
        for i in range(1, n):
            arc.append(arc[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))
        L = arc[-1] or 1.0
        base = len(self.v)
        for i, (r, y) in enumerate(prof):
            for j in range(cols):
                a = a0 + (a1 - a0) * j / seg
                rr = r + (jitter(a, y, r) if jitter else 0.0)
                p = Vector((rr * math.cos(a), y, rr * math.sin(a)))
                if axis_m is not None:
                    p = axis_m @ p
                self.vert((p.x + cx, p.y + cy, p.z + cz))
        mi = self._m(mat)
        for i in range(n - 1):
            for j in range(seg):
                a = base + i * cols + j
                b = a + 1
                c = a + cols + 1
                d = a + cols
                if prof[i][0] < 1e-9 and prof[i + 1][0] < 1e-9:
                    continue
                q = [a, d, c, b] if not flip else [a, b, c, d]
                if uv == 'cyl':
                    def U(jj, ii):
                        aa = a0 + (a1 - a0) * jj / seg
                        return (1 - aa / TAU, (prof[ii][1] - yr[0]) / (yr[1] - yr[0]))
                elif uv == 'arc':
                    def U(jj, ii):
                        aa = a0 + (a1 - a0) * jj / seg
                        return (1 - aa / TAU, arc[ii] / L)
                elif uv == 'strip':
                    # v_blender = arc fraction; the glTF export flips v, so in three.js v = 0 at the
                    # END of the profile (top) -> image row 0 (flipY = false).
                    def U(jj, ii):
                        return (jj / seg, arc[ii] / L)
                else:
                    def U(jj, ii):
                        return (0.0, 0.0)
                uvs = {a: U(j, i), b: U(j + 1, i), c: U(j + 1, i + 1), d: U(j, i + 1)}
                # drop degenerate apex triangles
                if prof[i][0] < 1e-9:  # apex at ring i: a == b
                    tri = [a, d, c] if not flip else [a, c, d]
                    self.f.append(tuple(tri)); self.uv.append([uvs[k] for k in tri]); self.mi.append(mi)
                    continue
                if prof[i + 1][0] < 1e-9:  # apex at ring i+1: d == c
                    tri = [a, d, b] if not flip else [a, b, d]
                    self.f.append(tuple(tri)); self.uv.append([uvs[k] for k in tri]); self.mi.append(mi)
                    continue
                self.f.append(tuple(q))
                self.uv.append([uvs[k] for k in q])
                self.mi.append(mi)
        return self

    def disk(self, y, r, seg, mat, down=True, center=(0, 0, 0), r_in=0.0, uv='planar', uvs_scale=1.0):
        cx, cy, cz = center
        mi = self._m(mat)
        base = len(self.v)
        if r_in <= 0:
            c = self.vert((cx, y, cz))
            ring = [self.vert((cx + r * math.cos(TAU * j / seg), y, cz + r * math.sin(TAU * j / seg))) for j in range(seg)]
            for j in range(seg):
                a, b = ring[j], ring[(j + 1) % seg]
                tri = [c, a, b] if down else [c, b, a]
                self.f.append(tuple(tri))
                self.uv.append([self._puv(self.v[k], uvs_scale) for k in tri])
                self.mi.append(mi)
        else:
            outer = [self.vert((cx + r * math.cos(TAU * j / seg), y, cz + r * math.sin(TAU * j / seg))) for j in range(seg)]
            inner = [self.vert((cx + r_in * math.cos(TAU * j / seg), y, cz + r_in * math.sin(TAU * j / seg))) for j in range(seg)]
            for j in range(seg):
                a, b = outer[j], outer[(j + 1) % seg]
                c, d = inner[(j + 1) % seg], inner[j]
                q = [a, b, c, d] if down else [a, d, c, b]
                self.f.append(tuple(q))
                self.uv.append([self._puv(self.v[k], uvs_scale) for k in q])
                self.mi.append(mi)
        return self

    def _puv(self, p, s):
        return (p[0] * s, p[2] * s)

    # -- boxes / prisms
    def box(self, center, size, mat, M=None, uv_scale=None, skip=()):
        """axis-aligned box (size = full extents) optionally rotated by M (3x3) about its center.
        skip: faces to omit ('+x','-x','+y','-y','+z','-z')."""
        cx, cy, cz = center
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        corners = []
        for dx in (-1, 1):
            for dy in (-1, 1):
                for dz in (-1, 1):
                    p = Vector((dx * sx, dy * sy, dz * sz))
                    if M is not None:
                        p = M @ p
                    corners.append(self.vert((cx + p.x, cy + p.y, cz + p.z)))
        idx = lambda dx, dy, dz: corners[(dx > 0) * 4 + (dy > 0) * 2 + (dz > 0)]
        faces = {
            '+x': [idx(1, -1, -1), idx(1, 1, -1), idx(1, 1, 1), idx(1, -1, 1)],
            '-x': [idx(-1, -1, -1), idx(-1, -1, 1), idx(-1, 1, 1), idx(-1, 1, -1)],
            '+y': [idx(-1, 1, -1), idx(-1, 1, 1), idx(1, 1, 1), idx(1, 1, -1)],
            '-y': [idx(-1, -1, -1), idx(1, -1, -1), idx(1, -1, 1), idx(-1, -1, 1)],
            '+z': [idx(-1, -1, 1), idx(1, -1, 1), idx(1, 1, 1), idx(-1, 1, 1)],
            '-z': [idx(-1, -1, -1), idx(-1, 1, -1), idx(1, 1, -1), idx(1, -1, -1)],
        }
        full = {'+x': (2 * sz, 2 * sy), '-x': (2 * sz, 2 * sy), '+y': (2 * sx, 2 * sz), '-y': (2 * sx, 2 * sz),
                '+z': (2 * sx, 2 * sy), '-z': (2 * sx, 2 * sy)}
        for k, q in faces.items():
            if k in skip:
                continue
            if uv_scale:
                w, h = full[k]
                uvs = [(0, 0), (w * uv_scale, 0), (w * uv_scale, h * uv_scale), (0, h * uv_scale)]
            else:
                uvs = None
            self.face(q, mat, uvs)
        return self

    def prism(self, poly2d, frame, depth, mat, cap=True, uv_scale=None):
        """Extrude a 2D polygon (CCW in the (u,v) plane of frame) by `depth` along frame normal.
        frame = (origin, u_axis, v_axis, n_axis) as Vectors (three coords)."""
        o, U, V, N = frame
        n = len(poly2d)
        bot = [self.vert(o + U * p[0] + V * p[1]) for p in poly2d]
        top = [self.vert(o + U * p[0] + V * p[1] + N * depth) for p in poly2d]
        per = 0.0
        for i in range(n):
            a, b = i, (i + 1) % n
            q = [bot[a], bot[b], top[b], top[a]]
            if uv_scale:
                l = math.hypot(poly2d[b][0] - poly2d[a][0], poly2d[b][1] - poly2d[a][1])
                uvs = [(per * uv_scale, 0), ((per + l) * uv_scale, 0), ((per + l) * uv_scale, depth * uv_scale), (per * uv_scale, depth * uv_scale)]
                per += l
            else:
                uvs = None
            self.face(q, mat, uvs)
        if cap:
            cu = [(p[0] * (uv_scale or 0), p[1] * (uv_scale or 0)) for p in poly2d]
            self.face(list(reversed(bot)), mat, list(reversed(cu)))
            self.face(top, mat, cu)
        return self

    def cyl(self, p0, p1, r0, mat, seg=12, r1=None, caps=True, uv=None):
        """cylinder/frustum between two points"""
        p0, p1 = Vector(p0), Vector(p1)
        r1 = r0 if r1 is None else r1
        ax = p1 - p0
        L = ax.length
        if L < 1e-9:
            return self
        z = ax / L
        tmp = Vector((1, 0, 0)) if abs(z.x) < 0.9 else Vector((0, 1, 0))
        x = z.cross(tmp).normalized()
        y = z.cross(x)
        r0i, r1i = [], []
        for j in range(seg):
            a = TAU * j / seg
            d = x * math.cos(a) + y * math.sin(a)
            r0i.append(self.vert(p0 + d * r0))
            r1i.append(self.vert(p1 + d * r1))
        for j in range(seg):
            a, b = j, (j + 1) % seg
            q = [r0i[a], r0i[b], r1i[b], r1i[a]]
            uvs = [(j / seg, 0), ((j + 1) / seg, 0), ((j + 1) / seg, L), (j / seg, L)] if uv else None
            self.face(q, mat, uvs)
        if caps:
            self.face(list(reversed(r0i)), mat)
            self.face(r1i, mat)
        return self

    def tube(self, pts, r, mat, seg=8, caps=True, closed=False):
        """tube along a polyline (parallel-transport frames)"""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rings = []
        prev_x = None
        for i in range(n):
            if closed:
                t = (pts[(i + 1) % n] - pts[i - 1]).normalized()
            elif i == 0:
                t = (pts[1] - pts[0]).normalized()
            elif i == n - 1:
                t = (pts[-1] - pts[-2]).normalized()
            else:
                t = (pts[i + 1] - pts[i - 1]).normalized()
            if prev_x is None:
                tmp = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
                x = t.cross(tmp).normalized()
            else:
                x = (prev_x - t * prev_x.dot(t)).normalized()
            y = t.cross(x)
            prev_x = x
            rings.append([self.vert(pts[i] + (x * math.cos(TAU * j / seg) + y * math.sin(TAU * j / seg)) * r) for j in range(seg)])
        last = n if closed else n - 1
        for i in range(last):
            A, Bn = rings[i], rings[(i + 1) % n]
            for j in range(seg):
                a, b = j, (j + 1) % seg
                self.face([A[a], A[b], Bn[b], Bn[a]], mat)
        if caps and not closed:
            self.face(list(reversed(rings[0])), mat)
            self.face(rings[-1], mat)
        return self

    def loft(self, rings, mat, closed_ring=True, cap0=True, cap1=True, uvs=None):
        """rings: list of equal-length point lists, each ring counter-clockwise about the loft
        direction (right-hand rule, first ring -> last ring). Faces point outward."""
        R = [[self.vert(p) for p in ring] for ring in rings]
        m = len(rings[0])
        for i in range(len(R) - 1):
            for j in range(m if closed_ring else m - 1):
                a, b = j, (j + 1) % m
                self.face([R[i][a], R[i][b], R[i + 1][b], R[i + 1][a]], mat)
        if cap0:
            self.face(list(reversed(R[0])), mat)
        if cap1:
            self.face(R[-1], mat)
        return self

    def quad(self, a, b, c, d, mat, uvs=None, double=False):
        ids = [self.vert(a), self.vert(b), self.vert(c), self.vert(d)]
        self.face(ids, mat, uvs)
        if double:
            self.face(list(reversed(ids)), mat, list(reversed(uvs)) if uvs else None)
        return self

    # -- build
    def build(self, name, parent=None, origin=(0, 0, 0), smooth=35.0, collection=None, uv_fn=None):
        """Create a Blender object. Vertex positions are made relative to `origin` (three coords),
        which should equal the parent's (three) position so the child sits correctly."""
        if not self.f:
            return None
        ox, oy, oz = origin
        verts = [B((p[0] - ox, p[1] - oy, p[2] - oz)) for p in self.v]
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], [list(f) for f in self.f])
        uvl = me.uv_layers.new(name='UVMap')
        flat = []
        for fi, f in enumerate(self.f):
            uvs = self.uv[fi]
            if uv_fn is not None:
                uvs = [uv_fn(self.v[k]) for k in f]
            for u in uvs:
                flat.extend((float(u[0]), float(u[1])))
        uvl.data.foreach_set('uv', flat)
        for m in self.mats:
            me.materials.append(get_mat(m))
        me.polygons.foreach_set('material_index', self.mi)
        me.validate(clean_customdata=False)
        me.update()
        if smooth is not None and smooth is not False:
            me.shade_smooth()
            if smooth < 180:
                me.set_sharp_from_angle(angle=math.radians(smooth))
        else:
            me.shade_flat()
        ob = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob


def empty(name, pos=(0, 0, 0), parent=None, parent_pos=(0, 0, 0), collection=None):
    """Empty at three-coords `pos` (world); stored relative to parent_pos."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.3
    (collection or bpy.context.scene.collection).objects.link(e)
    e.location = B((pos[0] - parent_pos[0], pos[1] - parent_pos[1], pos[2] - parent_pos[2]))
    if parent is not None:
        e.parent = parent
    return e


def add_bevel(ob, width=0.01, segments=2, angle=40):
    if ob is None:
        return
    m = ob.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    m.harden_normals = False
    m.use_clamp_overlap = True


def add_weighted_normals(ob):
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
    m.keep_sharp = True


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)


def export_glb(path, draco=True, selected=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', export_apply=True, export_yup=True,
              export_texcoords=True, export_normals=True, export_tangents=False,
              export_materials='EXPORT', export_image_format='NONE', export_extras=True,
              export_animations=False, export_vertex_color='NONE', export_attributes=True)
    if draco:
        kw.update(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                  export_draco_position_quantization=16, export_draco_normal_quantization=10,
                  export_draco_texcoord_quantization=14, export_draco_generic_quantization=12)
    if selected is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in selected:
            o.select_set(True)
        kw['use_selection'] = True
    bpy.ops.export_scene.gltf(**kw)
    print('exported', path, os.path.getsize(path) // 1024, 'KB')


def fill_holes(outer, holes, y, mat, down=True, uv_scale=1.0):
    """Planar polygon with holes at height y (three coords, horizontal). outer/holes: 2D lists (x,z).
    Returns an MB with triangulated faces (via bmesh triangle_fill)."""
    bm = bmesh.new()
    edges = []
    for loop in [outer] + holes:
        vs = [bm.verts.new((p[0], p[1], 0)) for p in loop]
        for i in range(len(vs)):
            edges.append(bm.edges.new((vs[i], vs[(i + 1) % len(vs)])))
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    mb = MB()
    vid = {}
    for v in bm.verts:
        vid[v.index] = mb.vert((v.co.x, y, v.co.y))
    bm.verts.index_update()
    vid = {v.index: i for i, v in enumerate(bm.verts)}
    for f in bm.faces:
        ids = [vid[v.index] for v in f.verts]
        # orientation: bmesh xy plane -> three (x, z). Normal +z(bm) -> three: y? we mapped (x,z)->(x,y=?)
        # compute normal in three coords and flip to requested
        p0, p1, p2 = [Vector(mb.v[i]) for i in ids[:3]]
        nrm = (p1 - p0).cross(p2 - p0)
        if (nrm.y > 0) == down:
            ids = list(reversed(ids))
        mb.face(ids, mat, [(mb.v[i][0] * uv_scale, mb.v[i][2] * uv_scale) for i in ids])
    bm.free()
    return mb
