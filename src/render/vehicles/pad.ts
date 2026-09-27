// SLC-4E launch complex. OWNER: models.
// Pad frame = W frame translated to (0, PAD_ELEVATION, 0): +X east, +Y up, +Z south. The vehicle's
// nozzle exit stands LAUNCH_MOUNT_HEIGHT above the pad deck at the origin (sim pre-launch S1.pos).
// Covered flame duct from the opening under the mount, exiting through a headwall 42 m away at heading
// 200 deg (matches vfx TRENCH_EXIT). Transporter-erector on the north (-Z) side, rails to the hangar
// (north, 130..225 m). Generator: blender/build_slc4e.py.
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';
import type { SimSnapshot } from '../../core/types';
import type { TimeOfDay } from '../../core/settings';
import { PAD_ELEVATION } from '../../core/constants';
import { loadModel, tex } from './assets';
import type { VehicleMaterials } from './materials';
import { projectedPx } from './lod';

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export class PadVisual {
  readonly group = new THREE.Group();
  private lods: THREE.Object3D[] = [];
  private lod = -2;
  private spots: THREE.SpotLight[] = [];
  private floodMats: THREE.MeshStandardMaterial[] = [];
  private obstMat: THREE.MeshStandardMaterial | null = null;
  private night = false;
  /** false = never draw (viewer / debugging) */
  enabled = true;
  private _pos = new THREE.Vector3(0, PAD_ELEVATION, 0);

  constructor(private ctx: AppContext, private mats: VehicleMaterials) {
    this.group.name = 'PAD';
    this.group.position.set(0, PAD_ELEVATION, 0);
  }

  private makeMaterials(): void {
    const m = this.mats.m;
    const std = (name: string, p: THREE.MeshStandardMaterialParameters) => (m[name] = new THREE.MeshStandardMaterial({ name, ...p }));
    const cOrm = tex('pad_concrete_orm.jpg', { repeat: true });
    std('Pad_Concrete', {
      map: tex('pad_concrete_albedo.jpg', { srgb: true, repeat: true }), aoMap: cOrm, roughnessMap: cOrm, metalnessMap: cOrm,
      normalMap: tex('pad_concrete_normal.jpg', { repeat: true }), roughness: 1, metalness: 1,
    });
    // apron: unique 160 m albedo (UVs are in 8 m tiles -> repeat 1/20) + tiled concrete detail maps
    const apronMap = tex('pad_apron_albedo.jpg', { srgb: true });
    apronMap.repeat.set(1 / 20, 1 / 20);
    apronMap.wrapS = apronMap.wrapT = THREE.ClampToEdgeWrapping;
    std('Pad_Apron', {
      map: apronMap, aoMap: cOrm, roughnessMap: cOrm, metalnessMap: cOrm,
      normalMap: tex('pad_concrete_normal.jpg', { repeat: true }), normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0,
    });
    std('Pad_ConcreteDark', { color: lin(0x6c6a66), roughness: 0.9, map: m['Pad_Concrete'].map });
    std('Pad_Pit', { color: lin(0x0a0a09), roughness: 1 });
    std('Pad_Scorch', { color: lin(0x2c2a28), roughness: 0.95 });
    std('Pad_Ground', { map: tex('pad_ground_albedo.jpg', { srgb: true, repeat: true }), roughness: 0.95 });
    std('Pad_Asphalt', { color: lin(0x3a3a3a), roughness: 0.85 });
    // painted / galvanised steel: tiling weathering maps (rain streaks, soot, rust bleed) on the
    // box-projected 4 m UVs from build_slc4e.py (multiplies the base colour / roughness)
    const grime = tex('pad_grime_albedo.jpg', { srgb: true, repeat: true });
    const grimeR = tex('pad_grime_rough.jpg', { repeat: true });
    const steel = (name: string, color: number, roughness: number, metalness: number) =>
      std(name, { color: lin(color), roughness, metalness, map: grime, roughnessMap: grimeR });
    steel('Pad_Steel', 0x8a8c8e, 0.55, 0.8);
    steel('Pad_SteelDark', 0x3c3e40, 0.62, 0.7);
    steel('Pad_SteelSoot', 0x1e1c1a, 0.9, 0.3);       // launch-table ring: exhaust soot
    std('Pad_SteelRust', { color: lin(0x6a4a36), roughness: 0.75, metalness: 0.4 });
    steel('Pad_White', 0xd6d6d2, 0.66, 0.1);
    std('Pad_Hangar', { color: lin(0xcfcfca), roughness: 0.55, metalness: 0.3 });
    std('Pad_HangarDoor', { color: lin(0xb4b4b0), roughness: 0.5, metalness: 0.4 });
    steel('Pad_Tower', 0xb8b8b4, 0.5, 0.7);
    steel('Pad_TowerRed', 0xb03020, 0.66, 0.2);
    std('Pad_Tank', { color: lin(0xe2e2de), roughness: 0.45, metalness: 0.3 });
    steel('Pad_TE', 0xd8d8d4, 0.6, 0.3);
    steel('Pad_Pipe', 0xa8a8a4, 0.5, 0.8);
    steel('Pad_Yellow', 0xd0a018, 0.66, 0);
    // galvanised bar grating (1 m tiles; the map carries the bar / gap pattern)
    std('Pad_Grating', { map: tex('pad_grating_albedo.jpg', { srgb: true, repeat: true }), roughness: 0.6, metalness: 0.55 });
    std('Pad_Cable', { color: lin(0x202020), roughness: 0.7 });
    const fl = std('Pad_Flood', { color: 0x222222, emissive: new THREE.Color(1, 0.9, 0.75), emissiveIntensity: 0 });
    this.floodMats.push(fl);
    // aviation obstruction lights (always on, brighter at night)
    this.obstMat = std('Pad_LightRed', { color: 0x111111, emissive: new THREE.Color(1, 0.06, 0.03), emissiveIntensity: 6 });
  }

  async load(): Promise<void> {
    this.makeMaterials();
    const g = await loadModel('slc4e.glb');
    if (g) {
      this.mats.apply(g.scene);
      for (let l = 0; l < 3; l++) {
        const r = g.scene.getObjectByName(`PAD_L${l}`);
        if (!r) continue;
        r.removeFromParent();
        this.group.add(r);
        this.lods.push(r);
      }
      // ground / terrain: receive only
      g.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && /GROUND|APRON/i.test(o.name)) o.castShadow = false;
      });
      const common = g.scene.getObjectByName('PAD_COMMON');
      if (common) {
        common.removeFromParent();
        this.group.add(common);
        common.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = false;
        });
      }
    }
    if (!this.lods.length) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(80, 90, 2, 48), new THREE.MeshStandardMaterial({ color: 0x8a8883, roughness: 0.9 }));
      m.position.y = -1;
      m.receiveShadow = true;
      this.group.add(m);
      this.lods.push(m);
    }
    // night floodlights: two shadowless spots from the north-west and south-east light masts
    for (const [x, z] of [[-70, -60], [75, 40]] as [number, number][]) {
      const s = new THREE.SpotLight(new THREE.Color(1, 0.9, 0.78), 0, 400, 0.3, 0.6, 2);
      s.position.set(x, 38, z);
      s.target.position.set(0, 35, 0);
      s.castShadow = false;
      s.visible = false;
      this.group.add(s, s.target);
      this.spots.push(s);
    }
    this.setLod(0);
  }

  setTimeOfDay(tod: TimeOfDay): void {
    this.night = tod === 'night';
    const k = tod === 'night' ? 1 : tod === 'twilight' ? 0.5 : 0;
    for (const m of this.floodMats) m.emissiveIntensity = 60 * k;
    if (this.obstMat) this.obstMat.emissiveIntensity = tod === 'night' ? 30 : tod === 'twilight' ? 18 : 6;
    // the floods are on from the end of civil twilight at real launches; at twilight they run at ~0.15 of
    // the night level (the sky-lit pad is ~2 stops darker than the vehicle under the floods, per look-dev)
    const fk = tod === 'night' ? 1 : tod === 'twilight' ? 0.15 : 0;
    for (const s of this.spots) {
      s.visible = fk > 0;
      // candela-ish in the app's radiometric units: ~0.4 irradiance at the vehicle (≈ lit concrete at night)
      s.intensity = 1.6e4 * fk;
    }
  }

  setLod(l: number): void {
    const i = Math.min(l, this.lods.length - 1);
    if (i === this.lod) return;
    this.lod = i;
    this.lods.forEach((r, k) => (r.visible = k === i));
  }

  beforeViewRender(view: ViewInfo, bias: number): void {
    const px = projectedPx(view, this._pos, 120);
    this.group.visible = this.enabled && px > 0.6;
    if (!this.group.visible) return;
    this.setLod(px > 180 * bias ? 0 : px > 25 * bias ? 1 : 2);
  }

  update(_snap: SimSnapshot): void {}
}
