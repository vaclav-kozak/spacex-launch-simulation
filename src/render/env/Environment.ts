// PLACEHOLDER environment. OWNER: env agent — replace, keep the public API.
import * as THREE from 'three';
import type { AppContext, FrameModule, ViewInfo } from '../../core/context';
import { SUN_INTENSITY } from '../../core/context';
import type { SimSnapshot } from '../../core/types';

export class Environment implements FrameModule {
  private sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  private hemi = new THREE.HemisphereLight(0x88aaff, 0x334455, 1.2);
  private ground: THREE.Mesh;

  constructor(private ctx: AppContext) {
    ctx.scene.background = new THREE.Color(0x3a5d8f);
    ctx.lighting.sunDir.set(-0.5, 0.35, 0.6).normalize();
    ctx.scene.add(this.sun, this.sun.target, this.hemi);
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(40000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b3550, roughness: 0.3 }));
    ctx.worldRoot.add(this.ground);
  }

  async load(): Promise<void> {}

  update(snap: SimSnapshot, dt: number): void {}

  beforeViewRender(view: ViewInfo, snap: SimSnapshot): void {
    this.sun.position.copy(this.ctx.lighting.sunDir).multiplyScalar(1000);
    this.sun.target.position.set(0, 0, 0);
  }
}
