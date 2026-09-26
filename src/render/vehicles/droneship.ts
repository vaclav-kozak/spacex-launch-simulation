// Droneship OCISLY (Marmac 300 + wings). OWNER: models.
// Ship body frame: origin = deck centre (landing aim point), +Y up, +Z bow, +X port.
import * as THREE from 'three';
import type { AppContext } from '../../core/context';
import type { SimSnapshot } from '../../core/types';
import { OCISLY } from '../../core/vehicleSpec';
import { loadModel, tex } from './assets';
import type { VehicleMaterials } from './materials';

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export class DroneshipVisual {
  readonly group = new THREE.Group();
  private lods: THREE.Object3D[] = [];
  private lod = -2;
  private lightMats: THREE.MeshStandardMaterial[] = [];

  constructor(private ctx: AppContext, private mats: VehicleMaterials) {
    this.group.name = 'SHIP';
  }

  private makeMaterials(): void {
    const m = this.mats.m;
    const std = (name: string, p: THREE.MeshStandardMaterialParameters) => (m[name] = new THREE.MeshStandardMaterial({ name, ...p }));
    const dOrm = tex('ocisly_deck_orm.jpg');
    std('Ship_Deck', {
      map: tex('ocisly_deck_albedo.jpg', { srgb: true }), aoMap: dOrm, roughnessMap: dOrm, metalnessMap: dOrm,
      normalMap: tex('ocisly_deck_normal.jpg'), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 1, metalness: 1,
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
    this.setLod(0);
  }

  setLod(l: number): void {
    const i = Math.min(l, this.lods.length - 1);
    if (i === this.lod) return;
    this.lod = i;
    this.lods.forEach((r, k) => (r.visible = k === i));
  }

  update(_snap: SimSnapshot): void {
    // lights: nav lights always lit; slow blink on the amber beacon
    const tod = this.ctx.settings.timeOfDay;
    const k = tod === 'night' ? 1 : tod === 'twilight' ? 0.8 : 0.5;
    const blink = Math.sin(this.ctx.realTime * Math.PI * 1.0) > 0.4 ? 1 : 0.05;
    for (const m of this.lightMats) {
      const base = m.name === 'Ship_Flood' ? (tod === 'morning' ? 0 : 30) : m.name === 'Ship_LightAmber' ? 25 * blink : 40;
      m.emissiveIntensity = base * k;
    }
  }
}
