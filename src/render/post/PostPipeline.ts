// PLACEHOLDER post pipeline (plain render into the viewport rect). OWNER: post agent — replace,
// keep the public API: one PostPipeline per viewport; render(view) draws that viewport into
// its rect on the default framebuffer (canvas).
import * as THREE from 'three';
import type { AppContext, ViewInfo } from '../../core/context';

export class PostPipeline {
  constructor(private ctx: AppContext) {}

  render(view: ViewInfo): void {
    const r = this.ctx.renderer;
    const { x, y, w, h } = view.rect;
    const H = this.ctx.height;
    r.toneMapping = THREE.AgXToneMapping;
    r.setRenderTarget(null);
    r.setViewport(x, H - y - h, w, h);
    r.setScissor(x, H - y - h, w, h);
    r.setScissorTest(true);
    view.camera.aspect = w / h;
    view.camera.updateProjectionMatrix();
    r.render(this.ctx.scene, view.camera);
  }

  dispose(): void {}
}
