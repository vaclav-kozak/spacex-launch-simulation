// Modal-ish overlays: click-for-sound prompt, keyboard help, mission summary, photo mode panel,
// replay / pause badges. OWNER: ui.

import type { AppActions } from '../app/App';
import type { AppContext, ViewInfo } from '../core/context';
import { fmtFixed, h, setText, toggleClass } from './util';

export class SoundPrompt {
  readonly el: HTMLDivElement;
  constructor(onUnlock: () => void) {
    this.el = h('button', { class: 'sound-prompt', type: 'button', 'aria-label': 'Click for sound' },
      h('span', { class: 'sp-icon', html:
        '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M9 19h7l10-8v26l-10-8H9z" fill="currentColor"/>' +
        '<path class="w1" d="M31 18.5a8 8 0 0 1 0 11"/><path class="w2" d="M35.5 14a14.5 14.5 0 0 1 0 20"/></svg>' }),
      h('span', { class: 'sp-text' }, h('span', { class: 'sp-main', text: 'CLICK FOR SOUND' }),
        h('span', { class: 'sp-sub', text: 'Engines, sonic booms and launch control' })),
    ) as unknown as HTMLDivElement;
    this.el.addEventListener('click', onUnlock);
  }
  hide(): void {
    this.el.classList.add('gone');
    setTimeout(() => this.el.remove(), 900);
  }
}

const HELP: [string[], string][][] = [
  [
    [['Space'], 'Pause / resume'],
    [['L'], 'Liftoff now (skip countdown)'],
    [['H'], 'Hold / resume countdown (T\u22123\u20260: abort)'],
    [['S'], 'Stage separation (manual)'],
    [['F'], 'Fairing separation (manual)'],
    [['1', '\u2013', '6'], 'Time warp 1\u00d7 2\u00d7 4\u00d7 8\u00d7 30\u00d7 100\u00d7'],
    [['[', ']'], 'Warp down / up'],
    [['M'], 'Mute / unmute'],
    [['?'], 'This help'],
  ],
  [
    [['C'], 'Cycle camera'],
    [['Esc'], 'Restore viewport, close, exit'],
    [['P'], 'Photo mode'],
    [['R'], 'Replay touchdown'],
    [['K'], 'Manual landing on / off'],
    [['W', 'S'], 'Manual: throttle lever (lit 40\u2013100 %, 3 starts)'],
    [['\u2190', '\u2191', '\u2193', '\u2192'], 'Manual: steer over the deck map (A / D = \u2190 \u2192)'],
    [['X'], 'Manual: engine off (lever to 0)'],
  ],
];

export class HelpOverlay {
  readonly el: HTMLDivElement;
  constructor(onClose: () => void, credits: [string, string][] = [], byline: Node | null = null) {
    const cols = HELP.map((col) => h('dl', {}, ...col.flatMap(([k, d]) => [
      h('dt', {}, ...k.map((x) => (x === '\u2013' ? h('span', { class: 'to', text: x }) : h('kbd', { text: x })))),
      h('dd', { text: d }),
    ])));
    const close = h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close', text: '×' });
    close.addEventListener('click', onClose);
    const cred = credits.length
      ? h('div', { class: 'help-credits' }, h('h3', { text: 'CREDITS' }),
        h('dl', {}, ...credits.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])), byline)
      : null;
    this.el = h('div', { class: 'dlg-wrap help', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
      h('div', { class: 'dlg' }, close, h('h2', { text: 'KEYBOARD' }), h('div', { class: 'help-cols' }, ...cols), cred));
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) onClose(); });
  }
  set open(v: boolean) { toggleClass(this.el, 'open', v); }
  get open(): boolean { return this.el.classList.contains('open'); }
}

export class SummaryModal {
  readonly el: HTMLDivElement;
  private head: HTMLHeadingElement;
  private sub: HTMLDivElement;
  private list: HTMLDListElement;
  private bReplay: HTMLButtonElement;
  constructor(private actions: AppActions, credit: string, private ui: { replay(): void; close(): void }) {
    this.head = h('h2', { class: 'sum-head' });
    this.sub = h('div', { class: 'sum-sub' });
    this.list = h('dl', { class: 'sum-list' });
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = h('button', { class: `cb ${cls}`, type: 'button', text: label });
      b.addEventListener('click', fn);
      return b;
    };
    this.bReplay = btn('REPLAY TOUCHDOWN', () => ui.replay(), 'primary');
    this.el = h('div', { class: 'dlg-wrap summary', role: 'dialog', 'aria-label': 'Mission summary' },
      h('div', { class: 'dlg' },
        h('div', { class: 'sum-kicker', text: 'MISSION SUMMARY' }), this.head, this.sub, this.list,
        h('div', { class: 'sum-btns' }, this.bReplay, btn('RESTART', () => actions.restart()), btn('CLOSE', () => ui.close(), 'quiet')),
        h('div', { class: 'sum-credit', text: credit })));
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) ui.close(); });
  }
  show(headline: string, sub: string, lines: { label: string; value: string }[], canReplay: boolean, bad: boolean): void {
    setText(this.head, headline);
    setText(this.sub, sub);
    toggleClass(this.head, 'bad', bad);
    this.list.replaceChildren(...lines.flatMap((l) => [h('dt', { text: l.label }), h('dd', { text: l.value })]));
    this.bReplay.disabled = !canReplay;
    this.el.classList.add('open');
  }
  set open(v: boolean) { toggleClass(this.el, 'open', v); }
  get open(): boolean { return this.el.classList.contains('open'); }
}

export class PhotoPanel {
  readonly el: HTMLDivElement;
  private ev: HTMLInputElement;
  private evOut: HTMLOutputElement;
  private fovOut: HTMLOutputElement;
  private flash: HTMLDivElement;
  bias = 0;
  private busy = false;
  constructor(private ctx: AppContext, private actions: AppActions) {
    this.ev = h('input', { type: 'range', min: -3, max: 3, step: 0.1, value: 0, 'aria-label': 'Exposure' });
    this.evOut = h('output', { text: '0.0 EV' });
    this.ev.addEventListener('input', () => {
      this.bias = Number(this.ev.value);
      setText(this.evOut, `${this.bias > 0 ? '+' : ''}${fmtFixed(this.bias, 1)} EV`);
      this.ev.style.setProperty('--p', `${((this.bias + 3) / 6) * 100}%`);
    });
    this.ev.addEventListener('pointerup', () => this.ev.blur());
    this.ev.style.setProperty('--p', '50%');
    this.fovOut = h('output', { text: '' });
    const b = (label: string, fn: () => void, cls = '', title = '') => {
      const x = h('button', { class: `cb ${cls}`, type: 'button', text: label, title: title || undefined });
      x.addEventListener('mousedown', (e) => e.preventDefault());
      x.addEventListener('click', fn);
      return x;
    };
    this.flash = h('div', { class: 'photo-flash' });
    this.el = h('div', { class: 'photo-panel', role: 'toolbar', 'aria-label': 'Photo mode' },
      h('div', { class: 'ph-title', text: 'PHOTO MODE' }),
      h('label', { class: 'sl' }, h('span', { class: 'sl-l', text: 'Exposure' }), this.ev, this.evOut),
      h('div', { class: 'ph-fov' }, h('span', { class: 'sl-l', text: 'Field of view' }),
        b('−', () => actions.cameraCommand('fov:+5'), 'sq', 'Wider'), this.fovOut, b('+', () => actions.cameraCommand('fov:-5'), 'sq', 'Narrower'),
        b('C', () => actions.cameraCommand('cycle'), 'sq', 'Cycle camera (C)')),
      h('div', { class: 'row2' }, b('CAPTURE', () => this.capture(), 'primary', 'Save PNG (Enter)'), b('EXIT', () => actions.togglePhotoMode(), '', 'Esc')),
    );
  }

  async capture(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const root = this.el.closest('.f9ui') as HTMLElement | null;
    try {
      const blob = await this.actions.capturePhoto();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `falcon9-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      root?.append(this.flash);
      this.flash.classList.remove('go');
      void this.flash.offsetWidth;
      this.flash.classList.add('go');
    } finally {
      this.busy = false;
    }
  }

  update(views: ViewInfo[]): void {
    const cam = views[0]?.camera;
    if (cam) setText(this.fovOut, `${Math.round(cam.fov)}°`);
    // keep the exposure override applied (env publishes lighting every frame)
    this.ctx.lighting.exposureBias = this.bias;
  }
}
