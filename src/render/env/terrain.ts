// Local terrain around SLC-4E from real DEM + Sentinel-2 imagery (see tools/prep_assets.py):
//   T1: 40 km square (20 m DEM, ~10 m imagery), dense warped grid around the pad, skirts
//   T2: 400 km regional square (~200 m DEM, ~100 m imagery) with a hole under T1, heights and
//       albedo fade into the globe (Blue Marble) at its border.
// Grids are local azimuthal-equidistant (x east, z south, great-circle distance from the pad), so
// they sit exactly on the sphere; the Earth surface shader draws the sea everywhere inside the T2
// box and the terrain (drawn first) occludes it where land rises above sea level.
// MeshStandardMaterial (three's lights/shadows/IBL) + W-space normal maps; aerial perspective is
// patched in like any other standard material.
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import { EARTH_RADIUS } from '../../core/constants';
import { worldDirToEcef } from '../../core/frames';

const R = EARTH_RADIUS;

interface PatchDef {
  name: 't1' | 't2';
  cx: number;
  cz: number;
  size: number;
  hN: number;
}

interface Meta {
  terrain: Record<string, PatchDef & { iN: number; heightScale: number }>;
  region: { lat0: number; lat1: number; lon0: number; lon1: number };
}

/** local (x east, z south, h) -> W (double precision), relative to a reference W point */
function localToW(x: number, z: number, h: number, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.hypot(x, z);
  const th = s / R;
  const r = R + h;
  const st = Math.sin(th);
  const hx = s > 1e-9 ? x / s : 0, hz = s > 1e-9 ? z / s : 0;
  const sh = Math.sin(th / 2);
  out.set(r * st * hx, h * Math.cos(th) - 2 * R * sh * sh, r * st * hz);
  return out;
}

function upAtLocal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.hypot(x, z);
  const th = s / R;
  const st = Math.sin(th);
  const hx = s > 1e-9 ? x / s : 0, hz = s > 1e-9 ? z / s : 0;
  return out.set(st * hx, Math.cos(th), st * hz);
}

class HeightField {
  constructor(readonly def: PatchDef, readonly data: Int16Array) {}
  /** bilinear height (m) at local x,z (pixel centers at (i+0.5)/n) */
  at(x: number, z: number): number {
    const d = this.def, n = d.hN;
    const half = d.size / 2;
    const fx = ((x - (d.cx - half)) / d.size) * n - 0.5;
    const fz = ((z - (d.cz - half)) / d.size) * n - 0.5;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - x0)), tz = Math.max(0, Math.min(1, fz - z0));
    const D = this.data;
    const a = D[z0 * n + x0], b = D[z0 * n + x0 + 1], c = D[(z0 + 1) * n + x0], e = D[(z0 + 1) * n + x0 + 1];
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz) * 0.1;
  }
}

/** sinh warp of [0,1] onto [lo,hi] concentrating samples around p (strength k) */
function warpAxis(n: number, lo: number, hi: number, p: number, k: number): Float64Array {
  const out = new Float64Array(n);
  const ratio = (p - lo) / (hi - p);
  let a = 0, b = 1;
  for (let i = 0; i < 60; i++) {
    const u0 = (a + b) / 2;
    const r = Math.sinh(k * u0) / Math.sinh(k * (1 - u0));
    if (r < ratio) a = u0; else b = u0;
  }
  const u0 = (a + b) / 2;
  const A = (hi - p) / Math.sinh(k * (1 - u0));
  for (let i = 0; i < n; i++) out[i] = p + A * Math.sinh(k * (i / (n - 1) - u0));
  out[0] = lo; out[n - 1] = hi;
  return out;
}

const TERRAIN_VERT_PARS = /* glsl */ `
attribute float aFade;
varying float vFade;
varying vec2 vDetailUv;
`;
const TERRAIN_FRAG_PARS = /* glsl */ `
uniform sampler2D uDayReg;
uniform float uDetail;
uniform vec2 uDetailOff;
varying float vFade;
varying vec2 vDetailUv;
float tHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
`;

export class Terrain {
  /** local tangent box (x0, z0, x1, z1) covered by terrain meshes (the ocean shader treats it as sea) */
  readonly oceanBox = new THREE.Vector4(0, 0, 0, 0);
  readonly group = new THREE.Group();
  private meta: Meta | null = null;
  private fields: Partial<Record<'t1' | 't2', HeightField>> = {};
  private mats: THREE.MeshStandardMaterial[] = [];
  private detailU = { value: 1 };
  private detailOff1 = { value: new THREE.Vector2() };
  private detailOff2 = { value: new THREE.Vector2() };
  private dayRegU = { value: null as THREE.Texture | null };
  private level = 2;
  private built = -1;
  private albedo: Partial<Record<'t1' | 't2', THREE.Texture>> = {};

  constructor(private ctx: AppContext, _shared: Record<string, THREE.IUniform>) {
    this.group.name = 'env.terrain';
    ctx.worldRoot.add(this.group);
  }

  async load(): Promise<void> {
    const meta = (await (await fetch('/data/env/meta.json')).json()) as Meta;
    this.meta = meta;
    const loader = new THREE.TextureLoader();
    const aniso = this.ctx.renderer.capabilities.getMaxAnisotropy();
    await Promise.all(
      (['t1', 't2'] as const).map(async (name) => {
        const def = meta.terrain[name];
        const [buf, tex] = await Promise.all([
          fetch(`/data/env/${name}_height.bin`).then((r) => {
            if (!r.ok) throw new Error(`${name} height ${r.status}`);
            return r.arrayBuffer();
          }),
          loader.loadAsync(`/textures/env/${name}_albedo.jpg`),
        ]);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = aniso;
        this.albedo[name] = tex;
        this.fields[name] = new HeightField({ name, cx: def.cx, cz: def.cz, size: def.size, hN: def.hN }, new Int16Array(buf));
      }),
    );
    const t2 = meta.terrain.t2;
    this.oceanBox.set(t2.cx - t2.size / 2, t2.cz - t2.size / 2, t2.cx + t2.size / 2, t2.cz + t2.size / 2);
    this.build();
  }

  setQuality(q: number): void {
    this.level = q;
    // rebuild only on big changes (grid density)
    if (this.built >= 0 && Math.abs(q - this.built) >= 2) this.build();
  }

  setGlobalTextures(day: THREE.Texture, night: THREE.Texture): void {
    this.dayRegU.value = day;
    for (const m of this.mats) {
      m.emissiveMap = night;
      if (night) night.channel = 1;
      m.needsUpdate = true;
    }
  }

  /** normal map in W (object space of the meshes = W axes), rows ordered for flipY-style v */
  private normalMap(f: HeightField): THREE.DataTexture {
    const d = f.def, n = d.hN, D = f.data;
    const px = d.size / n;
    const half = d.size / 2;
    const out = new Uint8Array(n * n * 4);
    const up = new THREE.Vector3(), ex = new THREE.Vector3(), ez = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      const z = d.cz - half + (j + 0.5) * px;
      const jm = Math.max(0, j - 1), jp = Math.min(n - 1, j + 1);
      for (let i = 0; i < n; i++) {
        const x = d.cx - half + (i + 0.5) * px;
        const im = Math.max(0, i - 1), ip = Math.min(n - 1, i + 1);
        const dhdx = ((D[j * n + ip] - D[j * n + im]) * 0.1) / ((ip - im) * px);
        const dhdz = ((D[jp * n + i] - D[jm * n + i]) * 0.1) / ((jp - jm) * px);
        upAtLocal(x, z, up);
        ex.set(1 - up.x * up.x, -up.x * up.y, -up.x * up.z).normalize();
        ez.crossVectors(ex, up);
        let nx = -dhdx, ny = 1, nz = -dhdz;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const wx = ex.x * nx + up.x * ny + ez.x * nz;
        const wy = ex.y * nx + up.y * ny + ez.y * nz;
        const wz = ex.z * nx + up.z * ny + ez.z * nz;
        const o = ((n - 1 - j) * n + i) * 4; // row 0 = south edge (v = 0)
        out[o] = Math.round((wx * 0.5 + 0.5) * 255);
        out[o + 1] = Math.round((wy * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round((wz * 0.5 + 0.5) * 255);
        out[o + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(out, n, n);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = this.ctx.renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  }

  private material(name: 't1' | 't2', normal: THREE.Texture): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map: this.albedo[name] ?? null,
      normalMap: normal,
      normalMapType: THREE.ObjectSpaceNormalMap,
      roughness: 0.93,
      metalness: 0,
      color: new THREE.Color(0.92, 0.92, 0.92),
      emissive: new THREE.Color(0, 0, 0),
    });
    const dayReg = this.dayRegU, detail = this.detailU;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uDayReg = dayReg;
      sh.uniforms.uDetail = detail;
      sh.uniforms.uDetailOff = name === 't1' ? this.detailOff1 : this.detailOff2;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFade = aFade;\nvDetailUv = uv * ' + (name === 't1' ? '2048.0' : '4096.0') + ';');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          #ifdef USE_EMISSIVEMAP
            if (vFade < 0.999) diffuseColor.rgb = mix(texture2D(uDayReg, vEmissiveMapUv).rgb * 0.9, diffuseColor.rgb, vFade);
          #endif
          {
            // close-range albedo breakup (sub-texel detail), fades with distance
            vec2 duv = vDetailUv - uDetailOff;
            float dn = tNoise(duv * 3.0) * 0.5 + tNoise(duv * 11.0) * 0.3 + tNoise(duv * 37.0) * 0.2;
            float fw = 1.0 - smoothstep(150.0, 1500.0, length(vViewPosition));
            diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * dn, fw * uDetail);
          }`,
        )
        // Black Marble city lights are a ~500 m blur: only meaningful seen from far away / above.
        // Up close they would make the whole ground glow (lights are point sources there).
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= smoothstep(4000.0, 20000.0, length(vViewPosition));',
        );
    };
    m.customProgramCacheKey = () => 'envTerrain';
    this.mats.push(m);
    return m;
  }

  private build(): void {
    const f1 = this.fields.t1, f2 = this.fields.t2, meta = this.meta;
    if (!f1 || !f2 || !meta) return;
    this.built = this.level;
    for (const c of [...this.group.children]) {
      const mesh = c as THREE.Mesh;
      mesh.geometry.dispose();
      this.group.remove(c);
    }
    const reg = meta.region;
    const ecef = new THREE.Vector3();
    const P = new THREE.Vector3(), U = new THREE.Vector3();
    const regUv = (x: number, z: number, arr: number[]) => {
      upAtLocal(x, z, U);
      worldDirToEcef(U, ecef);
      const lat = (Math.asin(Math.max(-1, Math.min(1, ecef.z))) * 180) / Math.PI;
      const lon = (Math.atan2(ecef.y, ecef.x) * 180) / Math.PI;
      arr.push((lon - reg.lon0) / (reg.lon1 - reg.lon0), (lat - reg.lat0) / (reg.lat1 - reg.lat0));
    };

    // ------------------------------------------------ T1: warped grid around the pad + skirts
    {
      const d = f1.def;
      const half = d.size / 2;
      const N = [192, 288, 384, 512][this.level];
      const xs = warpAxis(N, d.cx - half, d.cx + half, 0, 5.5);
      const zs = warpAxis(N, d.cz - half, d.cz + half, 0, 5.5);
      const ref = localToW(d.cx, d.cz, 0, new THREE.Vector3());
      const pos: number[] = [], nor: number[] = [], uv: number[] = [], uv1: number[] = [], fade: number[] = [];
      const hs = new Float32Array(N * N);
      const push = (x: number, z: number, h: number) => {
        localToW(x, z, h, P).sub(ref);
        pos.push(P.x, P.y, P.z);
        upAtLocal(x, z, U);
        nor.push(U.x, U.y, U.z);
        uv.push((x - (d.cx - half)) / d.size, 1 - (z - (d.cz - half)) / d.size);
        regUv(x, z, uv1);
        fade.push(1);
      };
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const h = f1.at(xs[i], zs[j]);
          hs[j * N + i] = h;
          push(xs[i], zs[j], h);
        }
      const idx: number[] = [];
      for (let j = 0; j < N - 1; j++)
        for (let i = 0; i < N - 1; i++) {
          const a = j * N + i, b = a + 1, c = a + N, e = c + 1;
          if (hs[a] < -2 && hs[b] < -2 && hs[c] < -2 && hs[e] < -2) continue; // open sea: the ocean shader draws it
          idx.push(a, c, b, b, c, e);
        }
      // skirts (hide cracks against T2)
      const skirt = (ids: number[]) => {
        for (let k = 0; k < ids.length - 1; k++) {
          const a = ids[k], b = ids[k + 1];
          if (hs[a] < -2 && hs[b] < -2) continue;
          const base = pos.length / 3;
          for (const v of [a, b]) {
            pos.push(pos[v * 3] - nor[v * 3] * 120, pos[v * 3 + 1] - nor[v * 3 + 1] * 120, pos[v * 3 + 2] - nor[v * 3 + 2] * 120);
            nor.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
            uv.push(uv[v * 2], uv[v * 2 + 1]);
            uv1.push(uv1[v * 2], uv1[v * 2 + 1]);
            fade.push(1);
          }
          idx.push(a, base, b, b, base, base + 1, b, base, a, base + 1, base, b);
        }
      };
      const row = (j: number) => Array.from({ length: N }, (_, i) => j * N + i);
      const col = (i: number) => Array.from({ length: N }, (_, j) => j * N + i);
      skirt(row(0)); skirt(row(N - 1)); skirt(col(0)); skirt(col(N - 1));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
      g.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mat = this.mats.find((m) => m.map === this.albedo.t1) ?? this.material('t1', this.normalMap(f1));
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.copy(ref);
      mesh.receiveShadow = true;
      mesh.renderOrder = 50;
      mesh.name = 'env.terrain.t1';
      this.group.add(mesh);
    }

    // ------------------------------------------------ T2: uniform grid, hole under T1, border fade
    {
      const d = f2.def, t1 = f1.def;
      const half = d.size / 2;
      const N = [160, 224, 288, 384][this.level];
      const ref = localToW(d.cx, d.cz, 0, new THREE.Vector3());
      const x0 = d.cx - half, z0 = d.cz - half, step = d.size / (N - 1);
      const t1x0 = t1.cx - t1.size / 2, t1x1 = t1.cx + t1.size / 2, t1z0 = t1.cz - t1.size / 2, t1z1 = t1.cz + t1.size / 2;
      const pos: number[] = [], nor: number[] = [], uv: number[] = [], uv1: number[] = [], fade: number[] = [];
      const hs = new Float32Array(N * N);
      const inT1 = (x: number, z: number, m: number) => x > t1x0 + m && x < t1x1 - m && z > t1z0 + m && z < t1z1 - m;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const x = x0 + i * step, z = z0 + j * step;
          let h = f2.at(x, z);
          // border fade (last ~8 %): heights -> just above sea level, albedo -> Blue Marble
          const e = Math.min(i, j, N - 1 - i, N - 1 - j) / (N - 1);
          const fd = Math.min(1, e / 0.08);
          const fs = fd * fd * (3 - 2 * fd);
          if (h > 0) h = 4 + (h - 4) * fs;
          // sink under T1 so T1 always wins where they overlap
          if (inT1(x, z, -step)) h -= 60;
          hs[j * N + i] = h;
          localToW(x, z, h, P).sub(ref);
          pos.push(P.x, P.y, P.z);
          upAtLocal(x, z, U);
          nor.push(U.x, U.y, U.z);
          uv.push((x - x0) / d.size, 1 - (z - z0) / d.size);
          regUv(x, z, uv1);
          fade.push(fs);
        }
      const idx: number[] = [];
      for (let j = 0; j < N - 1; j++)
        for (let i = 0; i < N - 1; i++) {
          const a = j * N + i, b = a + 1, c = a + N, e = c + 1;
          if (hs[a] < -2 && hs[b] < -2 && hs[c] < -2 && hs[e] < -2) continue;
          const cx = x0 + (i + 0.5) * step, cz = z0 + (j + 0.5) * step;
          if (inT1(cx, cz, step * 0.75)) continue; // hole
          idx.push(a, c, b, b, c, e);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
      g.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mat = this.mats.find((m) => m.map === this.albedo.t2) ?? this.material('t2', this.normalMap(f2));
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.copy(ref);
      mesh.receiveShadow = true;
      mesh.renderOrder = 51;
      mesh.name = 'env.terrain.t2';
      this.group.add(mesh);
    }
  }

  /** per view: night lights on the terrain, detail strength */
  beforeViewRender(view: ViewInfo, camAlt: number, _pixAng: number, nightLights = 0, nightF = 0): void {
    this.detailU.value = camAlt < 20_000 ? 1 : 0;
    // detail-noise coordinate offset near the camera (keeps the noise argument small)
    const p = view.camWorldPos;
    const s = Math.hypot(p.x, p.z), th = s / R;
    const lx = s > 1e-6 ? (p.x / s) * th * R : 0, lz = s > 1e-6 ? (p.z / s) * th * R : 0;
    for (const [f, off, k] of [[this.fields.t1, this.detailOff1, 2048], [this.fields.t2, this.detailOff2, 4096]] as const) {
      if (!f) continue;
      const d = f.def, half = d.size / 2;
      const u = ((lx - (d.cx - half)) / d.size) * k, v = (1 - (lz - (d.cz - half)) / d.size) * k;
      off.value.set(Math.floor(u / 64) * 64, Math.floor(v / 64) * 64);
    }
    for (const m of this.mats) m.emissive.setScalar(nightLights * nightF);
  }

  /** terrain height (m) at a W point's local grid position, or null outside the patches */
  heightAtLocal(x: number, z: number): number | null {
    const f1 = this.fields.t1, f2 = this.fields.t2;
    for (const f of [f1, f2]) {
      if (!f) continue;
      const d = f.def, half = d.size / 2;
      if (x > d.cx - half && x < d.cx + half && z > d.cz - half && z < d.cz + half) return f.at(x, z);
    }
    return null;
  }
}
