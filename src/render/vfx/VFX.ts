// PLACEHOLDER VFX. OWNER: vfx agent — replace, keep the public API.
import type { AppContext, FrameModule, ViewInfo } from '../../core/context';
import type { SimSnapshot } from '../../core/types';

export class VFX implements FrameModule {
  constructor(private ctx: AppContext) {}
  async load(): Promise<void> {}
  update(snap: SimSnapshot, dt: number): void {
    this.ctx.hazeSources.length = 0;
    this.ctx.plumeLights.length = 0;
  }
  beforeViewRender(view: ViewInfo, snap: SimSnapshot): void {}
}
