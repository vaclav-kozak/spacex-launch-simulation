// PBR material library for the vehicles. OWNER: models.
//
// GLB meshes carry material NAMES only (Blender preview colours); `VehicleMaterials.apply()` swaps
// every mesh material for the runtime material with the same name. Textures follow the ORM
// convention (R = AO, G = roughness, B = metalness) so one JPEG feeds aoMap/roughnessMap/metalnessMap.
//
// Radiometric scale (core/context.ts): sun 6, sky ambient 1..2, MVac glow 4..20. Emissive values
// here are in those units (emissiveIntensity multiplies emissive colour, NoToneMapping until post).
import * as THREE from 'three';
import { tex } from './assets';

type Std = THREE.MeshStandardMaterial;

export interface MatSet {
  [name: string]: THREE.MeshStandardMaterial;
}

/** 1D vertical ramp used as the MVac emissive map (v = 0 at the extension top, 1 at the exit). */
function mvacGlowRamp(): THREE.DataTexture {
  const h = 64;
  const d = new Uint8Array(h * 4);
  for (let i = 0; i < h; i++) {
    const v = i / (h - 1);
    // hottest just below the regen joint, radiating fin cools toward the exit; slight exit-lip rise
    const k = Math.pow(1 - v, 0.9) * 0.85 + 0.15 * Math.exp(-((v - 0.03) ** 2) / 0.002);
    const g = Math.max(0.12, Math.min(1, k + 0.08));
    d.set([Math.round(255 * g), Math.round(255 * g), Math.round(255 * g), 255], i * 4);
  }
  const t = new THREE.DataTexture(d, 1, h, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** Radial falloff for the octaweb heat-shield glow (planar UV over the 3.66 m disc). */
function radialGlow(): THREE.DataTexture {
  const n = 128;
  const d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n - 0.5;
      const r = Math.hypot(u, v) * 2;
      // hottest around the centre engine cluster, blotchy toward the rim
      const n1 = Math.sin(u * 37 + v * 11) * Math.sin(v * 29 - u * 7) * 0.12;
      const g = Math.max(0, Math.min(1, 1 - Math.pow(r, 2.2) * 0.75 + n1));
      const o = (y * n + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = Math.round(g * 255);
      d[o + 3] = 255;
    }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Soft noisy "weathering" map for materials without authored textures (roughness variation). */
function noiseTex(size = 128, seed = 1, lo = 0.75, hi = 1.0): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const base = new Float32Array(size * size).map(() => rnd());
  // two box-blur passes for a cloudy look (wrapping)
  const blur = (a: Float32Array, r: number) => {
    const o = new Float32Array(a.length);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += a[y * size + ((x + k + size) % size)];
        o[y * size + x] = acc / (2 * r + 1);
      }
    const o2 = new Float32Array(a.length);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += o[((y + k + size) % size) * size + x];
        o2[y * size + x] = acc / (2 * r + 1);
      }
    return o2;
  };
  const a = blur(blur(base, 3), 2);
  let mn = 1, mx = 0;
  for (const v of a) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  for (let i = 0; i < a.length; i++) {
    const g = lo + (hi - lo) * ((a[i] - mn) / (mx - mn + 1e-6));
    d[i * 4] = 255; // AO
    d[i * 4 + 1] = Math.round(g * 255); // roughness
    d[i * 4 + 2] = 255; // metalness (scaled by material.metalness)
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export class VehicleMaterials {
  readonly m: MatSet = {};
  private sooty = -1;
  private envMap: THREE.Texture | null = null;
  readonly heatColor = new THREE.Color(1.0, 0.33, 0.08);

  // texture sets for the soot swap
  private t = {
    tankClean: tex('s1_tank_clean_albedo.jpg', { srgb: true }),
    tankSoot: tex('s1_tank_soot_albedo.jpg', { srgb: true }),
    tankOrmClean: tex('s1_tank_clean_orm.jpg'),
    tankOrmSoot: tex('s1_tank_soot_orm.jpg'),
    interClean: tex('s1_inter_clean_albedo.jpg', { srgb: true }),
    interSoot: tex('s1_inter_soot_albedo.jpg', { srgb: true }),
    interOrmClean: tex('s1_inter_clean_orm.jpg'),
    interOrmSoot: tex('s1_inter_soot_orm.jpg'),
    fairClean: tex('fairing_clean_albedo.jpg', { srgb: true }),
    fairSoot: tex('fairing_soot_albedo.jpg', { srgb: true }),
  };

  constructor() {
    const std = (name: string, p: THREE.MeshStandardMaterialParameters) => {
      const mat = new THREE.MeshStandardMaterial({ name, ...p });
      this.m[name] = mat;
      return mat;
    };
    const ormTank = this.t.tankOrmClean;
    std('S1_Tank', {
      map: this.t.tankClean, aoMap: ormTank, roughnessMap: ormTank, metalnessMap: ormTank,
      normalMap: tex('s1_tank_normal.jpg'), normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 1, metalness: 1, aoMapIntensity: 0.8,
    });
    const ormInter = this.t.interOrmClean;
    std('S1_Interstage', {
      map: this.t.interClean, aoMap: ormInter, roughnessMap: ormInter, metalnessMap: ormInter,
      normalMap: tex('s1_inter_normal.jpg'), normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 1, metalness: 1, aoMapIntensity: 0.8,
    });
    const rough1 = noiseTex(128, 3, 0.7, 1.0);
    const rough2 = noiseTex(128, 7, 0.55, 1.0);
    std('S1_Black', { color: lin(0x1a1a1a), roughness: 0.62, roughnessMap: rough2 });
    std('S1_Inner', { color: lin(0x2a2a2a), roughness: 0.8 });
    std('S1_Dome', { color: lin(0x8c8c88), roughness: 0.45, metalness: 0.4, roughnessMap: rough2 });
    std('S1_HeatShield', {
      color: lin(0x1b1a19), roughness: 0.9, roughnessMap: rough1,
      emissive: this.heatColor, emissiveIntensity: 0, emissiveMap: radialGlow(),
    });
    std('S1_Blanket', { color: lin(0x262422), roughness: 0.95, roughnessMap: rough1, emissive: this.heatColor, emissiveIntensity: 0 });
    std('M1D_Bell', {
      map: tex('m1d_bell.jpg', { srgb: true }), color: 0xffffff, roughness: 0.5, metalness: 0.85, roughnessMap: rough2,
      emissive: this.heatColor, emissiveIntensity: 0,
    });
    std('M1D_Inner', { color: lin(0x121110), roughness: 0.85, metalness: 0.2, side: THREE.DoubleSide });
    std('GridFin', {
      color: lin(0x6e6a64), roughness: 0.5, metalness: 1.0, roughnessMap: rough2,
      emissive: this.heatColor, emissiveIntensity: 0,
    });
    std('LegCarbon', { color: lin(0x121212), roughness: 0.42, metalness: 0.0, roughnessMap: rough2 });
    std('LegMetal', { color: lin(0x9a9a98), roughness: 0.35, metalness: 1.0 });
    std('Metal_Dark', { color: lin(0x3a3a3a), roughness: 0.5, metalness: 0.7 });
    std('Metal_Bare', { color: lin(0xb0b0ae), roughness: 0.3, metalness: 1.0 });

    const orm2 = tex('s2_tank_orm.jpg');
    std('S2_Tank', {
      map: tex('s2_tank_albedo.jpg', { srgb: true }), aoMap: orm2, roughnessMap: orm2, metalnessMap: orm2,
      normalMap: tex('s2_tank_normal.jpg'), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 1, aoMapIntensity: 0.8,
    });
    std('S2_Inner', { color: lin(0x303030), roughness: 0.8, side: THREE.DoubleSide });
    std('S2_Dome', { color: lin(0x9a9a98), roughness: 0.4, metalness: 0.7, roughnessMap: rough2 });
    std('MVac_Ext', {
      color: lin(0x1c1c1f), roughness: 0.42, metalness: 0.55, roughnessMap: rough2,
      emissive: new THREE.Color(1, 0.2, 0.04), emissiveIntensity: 0, emissiveMap: mvacGlowRamp(),
    });
    std('MVac_ExtInner', {
      color: lin(0x141414), roughness: 0.6, metalness: 0.3,
      emissive: new THREE.Color(1, 0.2, 0.04), emissiveIntensity: 0, emissiveMap: this.m['MVac_Ext'].emissiveMap,
    });
    std('MVac_Regen', { color: lin(0x6b4a33), roughness: 0.38, metalness: 1.0, roughnessMap: rough2 });
    std('MVac_Parts', { color: lin(0x505050), roughness: 0.45, metalness: 0.85 });
    std('MVac_Foil', { color: lin(0xc9a04a), roughness: 0.3, metalness: 1.0 });

    const ormF = tex('fairing_orm.jpg');
    std('Fairing', {
      map: this.t.fairClean, aoMap: ormF, roughnessMap: ormF, metalnessMap: ormF,
      normalMap: tex('fairing_normal.jpg'), normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, metalness: 1, aoMapIntensity: 0.8,
      emissive: this.heatColor, emissiveIntensity: 0,
    });
    std('Fairing_Inner', { color: lin(0x9c9c98), roughness: 0.85, roughnessMap: rough1 });
    std('Fairing_Edge', { color: lin(0x2a2a2a), roughness: 0.7 });

    std('SL_Bus', { color: lin(0x2a2b2e), roughness: 0.45, metalness: 0.6 });
    std('SL_Solar', { color: lin(0x0b1024), roughness: 0.22, metalness: 0.4 });
    std('SL_Antenna', { color: lin(0xd8d8d4), roughness: 0.6 });
    std('SL_Foil', { color: lin(0xcaa050), roughness: 0.28, metalness: 1.0 });

    std('Parafoil_Top', { color: lin(0xe8e8e6), roughness: 0.85, side: THREE.DoubleSide });
    std('Parafoil_Bottom', { color: lin(0xb8b8b4), roughness: 0.9, side: THREE.DoubleSide });
    std('Parafoil_Lines', { color: lin(0x7a7a78), roughness: 0.8 });
  }

  /** Replace GLB materials by name. Unknown names keep a neutral standard material. */
  apply(root: THREE.Object3D, shadows = true): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (mat: THREE.Material): THREE.Material => {
        const r = this.m[mat.name];
        if (r) return r;
        const s = mat as Std;
        const n = new THREE.MeshStandardMaterial({ name: mat.name, color: s.color ?? 0x888888, roughness: s.roughness ?? 0.6, metalness: s.metalness ?? 0 });
        this.m[mat.name] = n;
        return n;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
    });
  }

  /** Swap albedo/ORM sets for the flight-proven sooty booster. Cheap; only runs on change. */
  setSooty(on: boolean): void {
    const v = on ? 1 : 0;
    if (v === this.sooty) return;
    this.sooty = v;
    const t = this.t;
    const tank = this.m['S1_Tank'];
    tank.map = on ? t.tankSoot : t.tankClean;
    const orm = on ? t.tankOrmSoot : t.tankOrmClean;
    tank.aoMap = tank.roughnessMap = tank.metalnessMap = orm;
    const inter = this.m['S1_Interstage'];
    inter.map = on ? t.interSoot : t.interClean;
    const ormI = on ? t.interOrmSoot : t.interOrmClean;
    inter.aoMap = inter.roughnessMap = inter.metalnessMap = ormI;
    this.m['Fairing'].map = on ? t.fairSoot : t.fairClean;
    // re-flown titanium fins are darker / heat-tinted, legs dusty
    this.m['GridFin'].color.copy(lin(on ? 0x3e3a35 : 0x6e6a64));
    this.m['GridFin'].roughness = on ? 0.62 : 0.5;
    this.m['LegCarbon'].color.copy(lin(on ? 0x1a1917 : 0x121212));
    this.m['LegCarbon'].roughness = on ? 0.6 : 0.42;
    this.m['S1_Black'].color.copy(lin(on ? 0x151412 : 0x1a1a1a));
    this.m['M1D_Bell'].color.copy(lin(on ? 0xb8b0a8 : 0xffffff));
    for (const k of ['S1_Tank', 'S1_Interstage', 'Fairing']) this.m[k].needsUpdate = true;
  }

  /** Assign the sky PMREM to every material when the scene itself has no environment. */
  setEnvMap(env: THREE.Texture | null, sceneHasEnv: boolean): void {
    const want = sceneHasEnv ? null : env;
    if (want === this.envMap) return;
    this.envMap = want;
    for (const k in this.m) {
      this.m[k].envMap = want;
      this.m[k].needsUpdate = true;
    }
  }

  /** S1 aerothermal glow (0..1): octaweb + blankets strongest, bells and fins weaker. */
  setS1Heating(h: number): void {
    const x = Math.max(0, Math.min(1, h));
    const k = x * x;
    this.m['S1_HeatShield'].emissiveIntensity = 6 * k;
    this.m['S1_Blanket'].emissiveIntensity = 3.5 * k;
    this.m['M1D_Bell'].emissiveIntensity = 1.6 * k;
    this.m['GridFin'].emissiveIntensity = 0.8 * k;
  }

  setFairingHeating(h: number): void {
    this.m['Fairing'].emissiveIntensity = 0.6 * Math.max(0, Math.min(1, h)) ** 2;
  }

  /** MVac nozzle-extension glow, heat01 0..1 (radiative equilibrium ≈ 1). */
  setMvacGlow(heat01: number): void {
    const h = Math.max(0, Math.min(1, heat01));
    // dull cherry red -> orange-red as the niobium approaches ~1300 K, radiance ∝ T^4-ish
    const e = this.m['MVac_Ext'];
    const ei = this.m['MVac_ExtInner'];
    const r = 1, g = 0.1 + 0.26 * h, b = 0.02 + 0.06 * h;
    e.emissive.setRGB(r, g, b);
    ei.emissive.setRGB(r, g * 1.1, b * 1.1);
    const I = h < 0.02 ? 0 : 20 * Math.pow(h, 2.4) + 0.6 * h;
    e.emissiveIntensity = I;
    ei.emissiveIntensity = I * 1.15;
  }
}
