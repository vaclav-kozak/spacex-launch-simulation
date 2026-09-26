import type { QualityState } from '../core/context';
import type { QualityPreset } from '../core/settings';

const SCALE = [0.6, 0.75, 0.9, 1.0];

/** Adaptive quality: drops a level when frames are slow, raises it again when there's headroom. */
export class QualityManager {
  private slowFor = 0;
  private fastFor = 0;
  constructor(public state: QualityState, private preset: () => QualityPreset) {}

  update(dtReal: number): void {
    const s = this.state;
    s.frameMs = s.frameMs * 0.95 + dtReal * 1000 * 0.05;
    const p = this.preset();
    if (p !== 'auto') {
      s.level = ({ low: 0, medium: 1, high: 2, ultra: 3 } as const)[p];
      s.renderScale = SCALE[s.level];
      return;
    }
    if (s.frameMs > 19) { this.slowFor += dtReal; this.fastFor = 0; }
    else if (s.frameMs < 13) { this.fastFor += dtReal; this.slowFor = 0; }
    else { this.slowFor = 0; this.fastFor = 0; }
    if (this.slowFor > 1.5 && s.level > 0) { s.level = (s.level - 1) as QualityState['level']; this.slowFor = 0; s.frameMs = 16; }
    if (this.fastFor > 6 && s.level < 3) { s.level = (s.level + 1) as QualityState['level']; this.fastFor = 0; }
    s.renderScale = SCALE[s.level];
  }
}
