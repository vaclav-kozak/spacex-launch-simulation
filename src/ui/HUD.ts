// PLACEHOLDER HUD. OWNER: ui agent — replace, keep the public API.
import type { AppContext, ViewInfo } from '../core/context';
import type { SimSnapshot } from '../core/types';
import type { AppActions } from '../app/App';

export class HUD {
  private el: HTMLDivElement;
  constructor(private ctx: AppContext, private actions: AppActions, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);color:#fff;font:600 28px system-ui;text-shadow:0 1px 4px #000';
    root.appendChild(this.el);
  }
  update(snap: SimSnapshot, views: ViewInfo[], dtReal: number): void {
    const t = snap.t, s = Math.abs(t);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    this.el.textContent = `T${t < 0 ? '-' : '+'} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
}
