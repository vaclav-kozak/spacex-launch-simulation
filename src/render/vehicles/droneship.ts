// Droneship OCISLY (Marmac 300 + wings). OWNER: models.
// Ship body frame: origin = deck centre (landing aim point), +Y up, +Z bow, +X port.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { SimSnapshot } from '../../core/types';
import { OCISLY } from '../../core/vehicleSpec';
import { loadModel, tex } from './assets';
import type { VehicleMaterials } from './materials';

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Deck floodlights as built by blender/build_ocisly.py `floodlights()`: heads on 6.5 m poles along the wing
 * edges, aimed at the deck centre (ship frame). */
const FLOODS = [-20, 4, 28].flatMap((z) => [1, -1].map((sx) => new THREE.Vector3(sx * 25.4, 6.6, z)));
const FLOOD_AIM = new THREE.Vector3(0, 0.6, 0);
/** warm-white metal-halide floods (linear) */
const FLOOD_COLOR = new THREE.Color(1, 0.84, 0.64);
/** intensity of one flood head (W/sr-like scene units, irradiance = I cos / d^2) at night. Scene night is
 * ~0.01 (moon), the ship at the twilight preset ~1e-4 (sky): the floodlit booster sits ~3-5 stops over the
 * moonlit deck, the sky keeps its colour at twilight, and the landed-engine smoulder still reads warm. */
const FLOOD_I = 9;
/** beam: exp(-(theta / FLOOD_BEAM)^2) about the aim axis (wide flood, ~65 deg to 1/e) */
const FLOOD_BEAM = 0.58;
/** deck light map texels (u across 52 m, v along 91.4 m: the deck's own UVs, see deck_uv() in the builder) */
const LM_W = 128, LM_H = 224;
const DECK_W = 52, DECK_L = 91.4;

export class DroneshipVisual {
  readonly group = new THREE.Group();
  private lods: THREE.Object3D[] = [];
  private lod = -2;
  private lightMats: THREE.MeshStandardMaterial[] = [];
  /** booster key lights: two spots standing in for the six flood heads, aimed at the landed booster's lower
   * half, above the deck (the deck's own pools are baked into `deckLight`) */
  private spots: THREE.SpotLight[] = [];
  private deckLight: THREE.DataTexture | null = null;
  private deckMat: THREE.MeshStandardMaterial | null = null;
  private floodK = 0;

  constructor(private ctx: AppContext, private mats: VehicleMaterials) {
    this.group.name = 'SHIP';
  }

  private makeMaterials(): void {
    const m = this.mats.m;
    const std = (name: string, p: THREE.MeshStandardMaterialParameters) => (m[name] = new THREE.MeshStandardMaterial({ name, ...p }));
    const dOrm = tex('ocisly_deck_orm.jpg');
    this.deckLight = bakeDeckLight();
    this.deckMat = std('Ship_Deck', {
      map: tex('ocisly_deck_albedo.jpg', { srgb: true }), aoMap: dOrm, roughnessMap: dOrm, metalnessMap: dOrm,
      normalMap: tex('ocisly_deck_normal.jpg'), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 1, metalness: 1,
      lightMap: this.deckLight, lightMapIntensity: 0,
    });
    const hOrm = tex('ocisly_hull_orm.jpg');
    std('Ship_Hull', { map: tex('ocisly_hull_albedo.jpg', { srgb: true }), aoMap: hOrm, roughnessMap: hOrm, metalnessMap: hOrm, roughness: 1, metalness: 1 });
    std('Ship_Wall', { color: lin(0x3b3d40), roughness: 0.75, metalness: 0.3 });
    std('Ship_WallInner', { color: lin(0x55575a), roughness: 0.8, metalness: 0.2 });
    std('Ship_Container', { color: lin(0xdadad6), roughness: 0.6, metalness: 0.2 });
    std('Ship_ContainerDark', { color: lin(0x4a4c50), roughness: 0.6, metalness: 0.3 });
    std('Ship_Metal', { color: lin(0x6a6a68), roughness: 0.55, metalness: 0.8 });
    std('Ship_Yellow', { color: lin(0xd8a520), roughness: 0.55, metalness: 0.2 });
    std('Ship_Rail', { color: lin(0xb8b8b4), roughness: 0.5, metalness: 0.6 });
    std('Ship_Dome', { color: lin(0xf0f0ee), roughness: 0.45 });
    std('Ship_Truss', { color: lin(0x2e3033), roughness: 0.7, metalness: 0.5 });
    std('Ship_Thruster', { color: lin(0x3a3c40), roughness: 0.6, metalness: 0.6 });
    std('Ship_Rust', { color: lin(0x5a3a26), roughness: 0.85, metalness: 0.2 });
    const light = (name: string, c: THREE.Color, I: number) => {
      const mat = std(name, { color: 0x111111, roughness: 0.4, emissive: c, emissiveIntensity: I });
      this.lightMats.push(mat);
      return mat;
    };
    light('Ship_LightRed', new THREE.Color(1, 0.05, 0.03), 40);
    light('Ship_LightGreen', new THREE.Color(0.05, 1, 0.25), 40);
    light('Ship_LightWhite', new THREE.Color(1, 0.95, 0.85), 40);
    light('Ship_LightAmber', new THREE.Color(1, 0.55, 0.12), 25);
    light('Ship_Flood', new THREE.Color(1, 0.92, 0.8), 30);
  }

  async load(): Promise<void> {
    this.makeMaterials();
    const g = await loadModel('ocisly.glb');
    if (g) {
      this.mats.apply(g.scene);
      for (let l = 0; l < 3; l++) {
        const r = g.scene.getObjectByName(`SHIP_L${l}`);
        if (!r) continue;
        r.removeFromParent();
        this.group.add(r);
        this.lods.push(r);
      }
    }
    if (!this.lods.length) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(OCISLY.deckWidth, 6, OCISLY.deckLength), new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 }));
      m.position.y = -3;
      m.receiveShadow = true;
      this.group.add(m);
      this.lods.push(m);
    }
    // diagonal pair (starboard-aft and port-bow poles): every camera around the deck sees a lit 3/4 side
    for (const [x, z] of [[-25.4, -20], [25.4, 28]]) {
      const sp = new THREE.SpotLight(FLOOD_COLOR, 0, 150, 0.62, 0.6, 2);
      sp.position.set(x, 6.9, z);
      sp.target.position.set(0, 17, 0);
      sp.castShadow = false;
      sp.visible = false;
      this.group.add(sp, sp.target);
      this.spots.push(sp);
    }
    this.setLod(0);
  }

  /** Called per view (VehicleVisuals.beforeViewRender) only while the ship is on screen. The two key lights
   * live in the ship group, so they are counted only in views that show the ship, and the pad's two night
   * spots (same condition, twilight/night) are never in such a view: every lit material sees 0 or 2 spot
   * lights, the variants the pad already compiled at liftoff (no new shader programs mid-landing). */
  setLod(l: number): void {
    for (const sp of this.spots) sp.visible = this.floodK > 0;
    const i = Math.min(l, this.lods.length - 1);
    if (i === this.lod) return;
    this.lod = i;
    this.lods.forEach((r, k) => (r.visible = k === i));
  }

  update(snap: SimSnapshot): void {
    // lights: nav lights always lit; slow blink on the amber beacon
    const tod = this.ctx.settings.timeOfDay;
    const k = tod === 'night' ? 1 : tod === 'twilight' ? 0.8 : 0.5;
    const blink = Math.sin(this.ctx.realTime * Math.PI * 1.0) > 0.4 ? 1 : 0.05;
    // deck floods: on at night and at the twilight preset (the ship, ~600 km downrange, is past the end of
    // nautical twilight when the booster lands); off in the morning
    this.floodK = tod === 'night' ? 1 : tod === 'twilight' ? 0.9 : 0;
    for (const m of this.lightMats) {
      m.emissiveIntensity = m.name === 'Ship_Flood' ? 60 * this.floodK : (m.name === 'Ship_LightAmber' ? 25 * blink : 40) * k;
    }
    // three heads' worth each, a little more for the longer throw of the diagonal poles (32 m vs 25 m)
    for (const sp of this.spots) sp.intensity = 4.5 * FLOOD_I * this.floodK;
    if (this.deckMat) this.deckMat.lightMapIntensity = FLOOD_I * this.floodK * (this.deckLight?.userData.peak ?? 0);
  }
}

/**
 * Deck irradiance from the six flood heads (per unit head intensity), baked into the deck's UV space. Stored
 * normalised to the peak (userData.peak) as the material's light map, so the pools under and between the
 * poles cost nothing at run time. The heads only light the deck through their beam; the booster and deck
 * structures above it get the two real spots instead.
 */
function bakeDeckLight(): THREE.DataTexture {
  const E = new Float32Array(LM_W * LM_H);
  const p = new THREE.Vector3(), l = new THREE.Vector3(), ax = new THREE.Vector3();
  let peak = 0;
  for (let j = 0; j < LM_H; j++) {
    const z = DECK_L / 2 - ((j + 0.5) / LM_H) * DECK_L; // three v = (45.7 - z) / 91.4
    for (let i = 0; i < LM_W; i++) {
      const x = DECK_W / 2 - ((i + 0.5) / LM_W) * DECK_W; // u = (26 - x) / 52
      p.set(x, 0, z);
      let e = 0;
      for (const f of FLOODS) {
        l.copy(f).sub(p);
        const d2 = Math.max(l.lengthSq(), 4);
        l.normalize();
        const cosI = l.y; // deck normal +Y
        if (cosI <= 0) continue;
        ax.copy(FLOOD_AIM).sub(f).normalize();
        const th = Math.acos(THREE.MathUtils.clamp(-l.dot(ax), -1, 1));
        e += (Math.exp(-((th / FLOOD_BEAM) ** 2)) * cosI) / d2;
      }
      E[j * LM_W + i] = e;
      peak = Math.max(peak, e);
    }
  }
  // sRGB-encoded 8 bits (the dim pool edges keep their precision); the sampler decodes to linear
  const data = new Uint8Array(LM_W * LM_H * 4);
  const enc = (v: number) => Math.round(255 * THREE.MathUtils.clamp(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055, 0, 1));
  for (let k = 0; k < LM_W * LM_H; k++) {
    const v = E[k] / peak;
    data[k * 4] = enc(v * FLOOD_COLOR.r);
    data[k * 4 + 1] = enc(v * FLOOD_COLOR.g);
    data[k * 4 + 2] = enc(v * FLOOD_COLOR.b);
    data[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, LM_W, LM_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.channel = 0;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  t.userData.peak = peak;
  return t;
}
