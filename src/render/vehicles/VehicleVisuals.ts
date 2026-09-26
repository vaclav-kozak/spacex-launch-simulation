// PLACEHOLDER vehicle visuals. OWNER: models agent — replace, keep the public API.
import * as THREE from 'three';
import type { AppContext, FrameModule, ViewInfo } from '../../core/context';
import type { BodyId, SimSnapshot } from '../../core/types';
import { F9, OCISLY } from '../../core/vehicleSpec';

export class VehicleVisuals implements FrameModule {
  private nodes = new Map<BodyId, THREE.Object3D>();

  constructor(private ctx: AppContext) {}

  async load(): Promise<void> {
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 });
    const mk = (id: BodyId, geo: THREE.BufferGeometry, y: number, mat: THREE.Material = white) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y;
      g.add(m);
      this.ctx.worldRoot.add(g);
      this.nodes.set(id, g);
    };
    mk('S1', new THREE.CylinderGeometry(F9.radius, F9.radius, F9.s1.length, 24), F9.s1.length / 2);
    mk('S2', new THREE.CylinderGeometry(F9.radius, F9.radius, F9.s2.length, 24), F9.s2.length / 2);
    mk('FAIRING_A', new THREE.CylinderGeometry(0.3, F9.fairing.diameter / 2, F9.fairing.length, 24, 1, false, 0, Math.PI), F9.fairing.length / 2);
    mk('FAIRING_B', new THREE.CylinderGeometry(0.3, F9.fairing.diameter / 2, F9.fairing.length, 24, 1, false, Math.PI, Math.PI), F9.fairing.length / 2);
    mk('SHIP', new THREE.BoxGeometry(OCISLY.deckWidth, 4, OCISLY.deckLength), -2, new THREE.MeshStandardMaterial({ color: 0x333333 }));
  }

  update(snap: SimSnapshot, dt: number): void {
    for (const [id, node] of this.nodes) {
      const b = snap.bodies[id];
      node.visible = b.status !== 'gone';
      node.position.copy(b.pos);
      node.quaternion.copy(b.quat);
    }
  }

  beforeViewRender(view: ViewInfo, snap: SimSnapshot): void {}
}
