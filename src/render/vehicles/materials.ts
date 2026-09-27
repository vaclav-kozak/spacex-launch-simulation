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

// ------------------------------------------------------------------------------------------------
// Blackbody glow (MVac niobium extension). Planck spectrum x CIE 1931 (Wyman 2013 multi-lobe fit),
// tabulated 500..2000 K: relative luminance and linear-sRGB chromaticity (max channel = 1).

const BB_T0 = 500, BB_DT = 10, BB_N = 151;
const bbLum = new Float32Array(BB_N);
const bbRGB = new Float32Array(BB_N * 3);
(function buildBlackbodyLut() {
  const g = (x: number, mu: number, s1: number, s2: number) => Math.exp(-0.5 * ((x - mu) / (x < mu ? s1 : s2)) ** 2);
  const xb = (l: number) => 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const yb = (l: number) => 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const zb = (l: number) => 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  const c2 = 1.4388e7; // h c / k in nm K
  for (let i = 0; i < BB_N; i++) {
    const T = BB_T0 + i * BB_DT;
    let X = 0, Y = 0, Z = 0;
    for (let l = 380; l <= 780; l += 5) {
      const b = 1 / (l ** 5 * (Math.exp(c2 / (l * T)) - 1));
      X += b * xb(l); Y += b * yb(l); Z += b * zb(l);
    }
    const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    const gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    const bl = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    const m = Math.max(r, gg, bl, 1e-30);
    bbLum[i] = Y;
    bbRGB[i * 3] = Math.max(0, r / m);
    bbRGB[i * 3 + 1] = Math.max(0, gg / m);
    bbRGB[i * 3 + 2] = Math.max(0, bl / m);
  }
})();

/** Blackbody at T (K): writes linear-sRGB chromaticity (max 1) to `out`, returns luminance (arbitrary units). */
export function blackbody(T: number, out: THREE.Color): number {
  const x = Math.max(0, Math.min(BB_N - 1.001, (T - BB_T0) / BB_DT));
  const i = Math.floor(x), f = x - i;
  const j = i + 1;
  out.setRGB(
    bbRGB[i * 3] * (1 - f) + bbRGB[j * 3] * f,
    bbRGB[i * 3 + 1] * (1 - f) + bbRGB[j * 3 + 1] * f,
    bbRGB[i * 3 + 2] * (1 - f) + bbRGB[j * 3 + 2] * f,
  );
  // luminance is ~exponential in T: interpolate in log space
  return Math.exp(Math.log(bbLum[i] + 1e-300) * (1 - f) + Math.log(bbLum[j] + 1e-300) * f);
}

/** MVac extension thermal profile (v = 0 at the regen joint, 1 at the exit rim). */
export const MVAC_T = {
  /** ambient / cold soak (K) */
  amb: 290,
  /** steady-state temperature of the hottest band at full thrust (K) */
  hot: 1480,
  /** steady-state profile along the bell (K) */
  ss(v: number): number {
    // hottest ~8 cm below the joint (the manifold flange sinks heat), radiating fin cools to ~950 K at the lip
    return (1480 - 530 * Math.pow(v, 1.1)) * (1 - 0.09 * Math.exp(-v / 0.03));
  },
};

const GLOW_N = 128;
/** reference luminance (hot band at steady state) and display mapping */
const GLOW_PEAK = 0.35; // emissive radiance of the hottest band (lighting units; see models.md: 4..20 blows out through AgX)
const GLOW_GAMMA = 0.8; // camera response: silicon + log encoding compress the Wien slope

/**
 * Light from the firing engine on the INSIDE of the nozzle, looking up into the bell: the throat window onto
 * the chamber (~3500 K gas) and the wall around it glow yellow-white, fading to orange down the regen
 * section and onto the upper extension. Emissive radiance per unit `gas` (engine spool x throttle drive),
 * blackbody-tinted (camera look: yellow at the throat, orange lower down). Lighting units, ARCHITECTURE
 * scale: the throat sits in the hot-nozzle 4..20 band; the rest stays near the extension's own glow.
 */
export const MVAC_GAS = {
  /** regen inner wall, v = 0 at the extension joint .. 1 at the throat (and the throat disc) */
  regen(v: number): { T: number; I: number } {
    return { T: 1750 + 850 * Math.pow(v, 1.5), I: 0.5 + 5.5 * Math.pow(v, 3) };
  },
  /** extension inner wall, v = 0 at the joint .. 1 at the exit: the throat's light, falling off */
  ext(v: number): { T: number; I: number } {
    return { T: 1650, I: 0.45 * Math.exp(-v / 0.22) };
  },
};

/** Dynamic 1 x 128 HDR emissive ramp for the MVac extension (half float, linear). */
class MvacGlowRamp {
  readonly tex: THREE.DataTexture;
  private data = new Uint16Array(GLOW_N * 4);
  private prof = new Float32Array(GLOW_N);
  private lumRef: number;
  private last = -1;
  private lastGas = -1;
  private c = new THREE.Color();
  private cg = new THREE.Color();
  /** wall: blackbody extension glow along v; gas: optional engine-light term (see MVAC_GAS) */
  constructor(private wall = true, private gasK: ((v: number) => { T: number; I: number }) | null = null) {
    const hot = MVAC_T.hot, amb = MVAC_T.amb;
    let mx = 0;
    for (let i = 0; i < GLOW_N; i++) mx = Math.max(mx, MVAC_T.ss((i + 0.5) / GLOW_N));
    for (let i = 0; i < GLOW_N; i++) this.prof[i] = (MVAC_T.ss((i + 0.5) / GLOW_N) - amb) / (mx - amb);
    this.lumRef = blackbody(hot, this.c);
    this.tex = new THREE.DataTexture(this.data, 1, GLOW_N, THREE.RGBAFormat, THREE.HalfFloatType);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = THREE.ClampToEdgeWrapping;
    this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.generateMipmaps = false;
    this.set(amb);
  }

  /** hottest-band temperature (K); the rest of the bell follows the steady-state profile shape.
   *  gas: engine light drive 0..1 (only for ramps built with a gas term) */
  set(Thot: number, gas = 0): void {
    if (!this.gasK) gas = 0;
    if (Math.abs(Thot - this.last) < 0.5 && Math.abs(gas - this.lastGas) < 0.004) return;
    this.last = Thot;
    this.lastGas = gas;
    const amb = MVAC_T.amb;
    const toH = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < GLOW_N; i++) {
      const T = this.wall ? amb + (Thot - amb) * this.prof[i] : amb;
      let I = 0;
      this.c.setRGB(0, 0, 0);
      if (T > 700) {
        const L = blackbody(T, this.c) / this.lumRef;
        // fade the last (invisible) few hundred K smoothly to black
        const k = Math.min(1, (T - 700) / 180);
        I = GLOW_PEAK * Math.pow(L, GLOW_GAMMA) * k * k;
        // consumer camera: IR-leaky red channel + white balance push dull red toward orange
        this.c.g = Math.min(1, this.c.g * 1.55 + 0.012);
        this.c.b = Math.min(1, this.c.b * 1.3 + 0.002);
      }
      let r = this.c.r * I, g = this.c.g * I, b = this.c.b * I;
      if (gas > 0 && this.gasK) {
        const k = this.gasK((i + 0.5) / GLOW_N);
        blackbody(k.T, this.cg);
        const Ig = k.I * gas;
        r += this.cg.r * Ig;
        g += Math.min(1, this.cg.g * 1.15 + 0.01) * Ig;
        b += Math.min(1, this.cg.b * 1.1) * Ig;
      }
      const o = i * 4;
      this.data[o] = toH(r);
      this.data[o + 1] = toH(g);
      this.data[o + 2] = toH(b);
      this.data[o + 3] = toH(1);
    }
    this.tex.needsUpdate = true;
  }

  get hotT(): number { return this.last; }
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
  /** dull orange-red of ~1100-1200 K steel/Inconel seen by a camera (S1 base heating) */
  readonly heatColor = new THREE.Color(1.0, 0.24, 0.045);
  private mvacRamp = new MvacGlowRamp();
  /** inside of the extension: its own glow + the throat's light near the joint */
  private mvacRampIn = new MvacGlowRamp(true, MVAC_GAS.ext);
  /** inside of the regen section + throat disc (v = joint .. throat): engine light only */
  private mvacRampRegen = new MvacGlowRamp(false, MVAC_GAS.regen);

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
    // niobium C-103 with a dark silicide coating; the emissive map is the live blackbody ramp
    // Matte charcoal (the R512E coating is not a mirror: at grazing angles to the sunlit Earth a
    // glossier setting read as a pale lilac bell after SECO). Surface maps are laid out u = around the
    // bell, v = joint..exit (secondStage.ts fixExtensionUVs): vertical streaks only. The albedo map is a
    // bright ~0.8 multiplier so 8-bit steps stay invisible; the absolute tone lives in `color`.
    // (Round 3: the old tiling noise roughnessMap was sampled along one u column, so its roughness
    // varied with height only and the sunlit bell showed horizontal specular rings.)
    const extAlb = tex('mvac_ext_albedo.jpg', { srgb: true });
    const extRough = tex('mvac_ext_rough.jpg');
    std('MVac_Ext', {
      map: extAlb, color: lin(0x232326).multiplyScalar(1.25), roughness: 1, metalness: 0.35, roughnessMap: extRough,
      emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, emissiveMap: this.mvacRamp.tex,
    });
    std('MVac_ExtInner', {
      map: extAlb, color: lin(0x161616).multiplyScalar(1.25), roughness: 0.85, metalness: 0.3, roughnessMap: extRough,
      emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, emissiveMap: this.mvacRampIn.tex,
    });
    // inside of the regen section and the throat disc (runtime geometry, secondStage.ts addRegenInner):
    // sooty copper, lit by the engine; drawn BackSide so its outward-facing lathe never shows through the
    // outer regen skin 12 mm away
    std('MVac_RegenInner', {
      color: lin(0x2a1d14), roughness: 0.75, metalness: 0.4, side: THREE.BackSide,
      emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, emissiveMap: this.mvacRampRegen.tex,
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

  /**
   * S1 base heating glow (0..1, already thresholded by the caller: entry-burn plume recirculation +
   * hypersonic stagnation only). Octaweb heat shield + blankets strongest, bells faint, grid fins never
   * (titanium at Mach 3 stays well below the ~800 K Draper point).
   */
  setS1Heating(g: number): void {
    const x = Math.max(0, Math.min(1, g));
    const k = x * x;
    this.m['S1_HeatShield'].emissiveIntensity = 2.4 * k;
    this.m['S1_Blanket'].emissiveIntensity = 1.1 * k;
    this.m['M1D_Bell'].emissiveIntensity = 0.35 * k * x;
    this.m['GridFin'].emissiveIntensity = 0;
  }

  /** Fairing glow 0..1 (caller gates it to hypersonic re-entry; a faint dull red at most). */
  setFairingHeating(g: number): void {
    this.m['Fairing'].emissiveIntensity = 0.12 * Math.max(0, Math.min(1, g)) ** 2;
  }

  /** MVac glow: extension hottest-band temperature (K) and the engine-light drive `gas` (0..1, spool x
   *  throttle; lights the inside of the bell: throat, regen wall, upper extension). */
  setMvacTemperature(Thot: number, gas = 0): void {
    this.mvacRamp.set(Thot);
    this.mvacRampIn.set(Thot, gas);
    this.mvacRampRegen.set(Thot, gas);
    const on = Thot > 700 ? 1 : 0;
    this.m['MVac_Ext'].emissiveIntensity = on;
    this.m['MVac_ExtInner'].emissiveIntensity = on || gas > 0.002 ? 1 : 0;
    this.m['MVac_RegenInner'].emissiveIntensity = gas > 0.002 ? 1 : 0;
  }

  /** Legacy 0..1 heat fraction (viewer): 0 = cold, 1 = steady-state full thrust (engine firing). */
  setMvacGlow(heat01: number): void {
    const h = Math.max(0, Math.min(1, heat01));
    this.setMvacTemperature(MVAC_T.amb + (MVAC_T.hot - MVAC_T.amb) * h, h > 0 ? 1 : 0);
  }
}
