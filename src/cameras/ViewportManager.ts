// PLACEHOLDER cameras. OWNER: cameras agent — replace, keep the public API.
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../core/context';
import type { SimSnapshot } from '../core/types';
import { upAt } from '../core/frames';

export class ViewportManager {
  readonly views: ViewInfo[] = [];

  constructor(private ctx: AppContext, private dom: HTMLElement) {
    this.views.push({
      id: 'main', label: 'FALCON 9', camera: new THREE.PerspectiveCamera(40, 1, 0.5, 1e8),
      camWorldPos: new THREE.Vector3(), focus: 'S1', mode: 'chase', rect: { x: 0, y: 0, w: 1, h: 1 },
      alpha: 1, shimmer: 0, shake: 0, onboard: false,
    });
  }

  /** e.g. ?cam=booster:chase — force a camera preset (for screenshots/tests) */
  applyUrlParams(params: URLSearchParams): void {}

  /** UI commands: 'cycle' (next mode on primary view), 'restore' (un-maximize), 'mode:<CameraMode>' */
  command(cmd: string): void {}

  /** the view whose camera the audio listener uses */
  primaryView(): ViewInfo | null { return this.views[0] ?? null; }

  update(snap: SimSnapshot, dtReal: number): void {
    const v = this.views[0];
    v.rect = { x: 0, y: 0, w: this.ctx.width, h: this.ctx.height };
    const b = snap.bodies.S1;
    const up = upAt(b.pos);
    v.camWorldPos.copy(b.pos).addScaledVector(up, 20).add(new THREE.Vector3(120, 0, 60));
    v.camera.position.set(0, 0, 0);
    v.camera.up.copy(up);
    v.camera.lookAt(new THREE.Vector3().copy(b.pos).addScaledVector(up, 30).sub(v.camWorldPos));
  }
}
