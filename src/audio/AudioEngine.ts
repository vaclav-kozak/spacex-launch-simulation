// PLACEHOLDER audio. OWNER: audio agent — replace, keep the public API.
import type { AppContext, ViewInfo } from '../core/context';
import type { SimSnapshot } from '../core/types';

export class AudioEngine {
  unlocked = false;
  constructor(private ctx: AppContext) {}
  async load(): Promise<void> {}
  /** call from a user gesture */
  unlock(): void { this.unlocked = true; }
  setMuted(m: boolean): void {}
  /** listener = the primary (largest / maximized) viewport */
  update(snap: SimSnapshot, listener: ViewInfo | null, dtReal: number): void {}
}
