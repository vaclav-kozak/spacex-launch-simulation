// Collapsible control panel (top-right). OWNER: ui.

import type { AppActions } from '../app/App';
import type { AppContext } from '../core/context';
import type { QualityPreset, TimeOfDay } from '../core/settings';
import { h, setText, toggleClass } from './util';

export const WARP_LEVELS = [1, 2, 4, 8, 30, 100] as const;

export interface ControlState {
  canLiftoff: boolean;
  held: boolean;
  /** HOLD / RESUME / ABORT (T−3…T−0) / RECYCLING */
  holdLabel: string;
  holdKind: '' | 'active' | 'danger';
  canHold: boolean;
  canStageSep: boolean;
  canFairingSep: boolean;
  paused: boolean;
  warp: number;
  warpAllowed: (w: number) => boolean;
  canReplay: boolean;
  replaying: boolean;
  summaryReady: boolean;
  muted: boolean;
  audioUnlocked: boolean;
  manualLanding: boolean;
  sooty: boolean;
}

interface Seg<T> { el: HTMLDivElement; set(v: T): void; enable(v: T, on: boolean): void; }

function kbd(k: string) { return h('kbd', { text: k }); }

function button(label: string, key: string | null, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `cb ${cls}`, type: 'button' }, h('span', { class: 'cb-l', text: label }), key ? kbd(key) : null);
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the page
  b.addEventListener('click', () => { if (!b.disabled) onClick(); });
  return b;
}

function seg<T extends string | number>(opts: { v: T; label: string; title?: string }[], onSelect: (v: T) => void, cls = ''): Seg<T> {
  const btns = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  for (const o of opts) {
    const b = h('button', { class: 'seg-b', type: 'button', role: 'radio', title: o.title, text: o.label });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { if (!b.disabled) onSelect(o.v); });
    btns.set(o.v, b);
    el.append(b);
  }
  return {
    el,
    set(v) { for (const [k, b] of btns) { toggleClass(b, 'on', k === v); b.setAttribute('aria-checked', String(k === v)); } },
    enable(v, on) { const b = btns.get(v); if (b && b.disabled === on) b.disabled = !on; },
  };
}

function slider(label: string, min: number, max: number, step: number, value: number,
  fmt: (v: number) => string, commit: (v: number) => void) {
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const out = h('output', { text: fmt(value) });
  const fill = () => input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  input.addEventListener('input', () => { setText(out, fmt(Number(input.value))); fill(); });
  input.addEventListener('change', () => { commit(Number(input.value)); input.blur(); });
  input.addEventListener('pointerup', () => input.blur());
  fill();
  const el = h('label', { class: 'sl' }, h('span', { class: 'sl-l', text: label }), input, out);
  return { el, input, set(v: number) { if (document.activeElement !== input) { input.value = String(v); setText(out, fmt(v)); fill(); } } };
}

function toggle(label: string, key: string | null, onChange: (on: boolean) => void) {
  const b = h('button', { class: 'tg', type: 'button', role: 'switch', 'aria-checked': 'false' },
    h('span', { class: 'tg-sw' }), h('span', { class: 'tg-l', text: label }), key ? kbd(key) : null);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => onChange(b.getAttribute('aria-checked') !== 'true'));
  return { el: b, set(on: boolean) { if (b.getAttribute('aria-checked') !== String(on)) b.setAttribute('aria-checked', String(on)); } };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const SPEAKER_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.6 6a8.6 8.6 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" fill="currentColor"/></svg>';
const SLIDERS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="15" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PREF_KEY = 'f9ui.cpanel';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>';

export class Controls {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private toggleBtn: HTMLButtonElement;
  private collapsed = true;
  private bLiftoff: HTMLButtonElement;
  private bHold: HTMLButtonElement;
  private bStage: HTMLButtonElement;
  private bFairing: HTMLButtonElement;
  private bReplay: HTMLButtonElement;
  private bSummary: HTMLButtonElement;
  private hdrPause: HTMLButtonElement;
  private hdrMute: HTMLButtonElement;
  private hdrWarp: HTMLSpanElement;
  private warp: Seg<number>;
  private tod: Seg<TimeOfDay>;
  private quality: Seg<QualityPreset>;
  private sea: ReturnType<typeof slider>;
  private wind: ReturnType<typeof slider>;
  private windDir: ReturnType<typeof slider>;
  private tSoot: ReturnType<typeof toggle>;
  private tManual: ReturnType<typeof toggle>;
  private lastMuted: boolean | null = null;
  private lastPaused: boolean | null = null;

  constructor(private ctx: AppContext, private actions: AppActions, private ui: {
    toggleHelp(): void; openSummary(): void; toggleReplay(): void; toggleMute(): void; setWarp(w: number): void;
  }) {
    const st = ctx.settings;
    const hdrBtn = (html: string, title: string, fn: () => void, cls = '') => {
      const b = h('button', { class: `hb ${cls}`, type: 'button', title, 'aria-label': title, html });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      return b;
    };
    this.hdrWarp = h('span', { class: 'hdr-warp', title: 'Time warp' });
    this.hdrPause = hdrBtn(PAUSE, 'Pause (Space)', () => actions.togglePause());
    this.hdrMute = hdrBtn(SPEAKER_OFF, 'Mute (M)', () => ui.toggleMute(), 'mute');
    const help = hdrBtn('<span>?</span>', 'Keyboard shortcuts (?)', () => ui.toggleHelp(), 'help');
    // the panel title doubles as the show/hide toggle; collapsed it is a compact "CONTROLS" tab
    this.toggleBtn = h('button', { class: 'cp-toggle', type: 'button', 'aria-expanded': 'false', title: 'Show / hide mission controls' },
      h('span', { class: 'cp-ico', html: SLIDERS }),
      h('span', { class: 'cp-title' }, h('span', { class: 'cp-t-full', text: 'MISSION CONTROL' }), h('span', { class: 'cp-t-short', text: 'CONTROLS' })),
      h('span', { class: 'cp-chev', html: CHEVRON }));
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.toggleBtn.addEventListener('click', () => this.setCollapsed(!this.collapsed, true));
    const header = h('div', { class: 'cp-head' }, this.toggleBtn, this.hdrWarp, this.hdrPause, this.hdrMute, help);

    // countdown
    this.bLiftoff = button('LIFTOFF NOW', 'L', () => actions.liftoffNow(), 'primary');
    this.bHold = button('HOLD', 'H', () => actions.toggleHold());
    // manual override
    this.bStage = button('STAGE SEP', 'S', () => actions.stageSeparation(), 'override');
    this.bFairing = button('FAIRING SEP', 'F', () => actions.fairingSeparation(), 'override');
    // time
    this.warp = seg(WARP_LEVELS.map((w) => ({ v: w as number, label: `${w}×`, title: `Time warp ${w}×` })), (w) => ui.setWarp(w), 'warp');
    // conditions
    this.tod = seg<TimeOfDay>([
      { v: 'morning', label: 'MORNING' }, { v: 'twilight', label: 'TWILIGHT' }, { v: 'night', label: 'NIGHT' },
    ], (v) => { actions.setSetting('timeOfDay', v); this.tod.set(v); });
    this.sea = slider('Sea state', 0, 6, 1, st.seaState, (v) => String(v), (v) => actions.setSetting('seaState', v));
    this.wind = slider('Wind', 0, 25, 1, st.windSpeed, (v) => `${v} m/s`, (v) => actions.setSetting('windSpeed', v));
    this.windDir = slider('From', 0, 355, 5, st.windFromDeg, (v) => `${String(v).padStart(3, '0')}° ${compass(v)}`, (v) => actions.setSetting('windFromDeg', v));
    // vehicle
    this.tSoot = toggle('Flight-proven booster', null, (on) => actions.setSetting('sootyBooster', on));
    this.tManual = toggle('Manual landing', 'K', (on) => actions.setSetting('manualLanding', on));
    this.quality = seg<QualityPreset>([
      { v: 'auto', label: 'AUTO' }, { v: 'low', label: 'LOW' }, { v: 'medium', label: 'MED' }, { v: 'high', label: 'HIGH' }, { v: 'ultra', label: 'ULTRA' },
    ], (v) => { actions.setSetting('quality', v); this.quality.set(v); });

    this.bReplay = button('REPLAY', 'R', () => ui.toggleReplay());
    const bPhoto = button('PHOTO', 'P', () => actions.togglePhotoMode());
    this.bSummary = button('SUMMARY', null, () => ui.openSummary());
    const bRestart = button('RESTART', null, () => actions.restart(), 'quiet');

    const sec = (name: string, ...kids: Node[]) => h('section', { class: 'cp-sec' }, h('h3', { text: name }), ...kids);
    this.body = h('div', { class: 'cp-body' },
      sec('COUNTDOWN', h('div', { class: 'row2' }, this.bLiftoff, this.bHold)),
      h('section', { class: 'cp-sec override-sec' }, h('h3', {}, h('span', { text: 'MANUAL OVERRIDE' })),
        h('div', { class: 'row2' }, this.bStage, this.bFairing)),
      sec('TIME WARP', this.warp.el),
      sec('CONDITIONS', this.tod.el, this.sea.el, this.wind.el, this.windDir.el),
      sec('VEHICLE', this.tSoot.el, this.tManual.el),
      sec('RENDER QUALITY', this.quality.el),
      h('section', { class: 'cp-sec cp-actions' }, h('div', { class: 'row2' }, this.bReplay, bPhoto, this.bSummary, bRestart)),
    );
    this.el = h('div', { class: 'cpanel', role: 'region', 'aria-label': 'Simulation controls' }, header, this.body);

    this.tod.set(st.timeOfDay);
    this.quality.set(st.quality);
    // collapsed by default so the picture stays clean; the user's choice is remembered
    let pref: string | null = null;
    try { pref = localStorage.getItem(PREF_KEY); } catch { /* storage blocked */ }
    this.setCollapsed(pref !== 'open');
    if (pref === null) this.el.classList.add('hint'); // one-time attention pulse on the first visit
  }

  setCollapsed(c: boolean, persist = false): void {
    this.collapsed = c;
    toggleClass(this.el, 'collapsed', c);
    this.toggleBtn.setAttribute('aria-expanded', String(!c));
    this.el.classList.remove('hint');
    if (persist) try { localStorage.setItem(PREF_KEY, c ? 'collapsed' : 'open'); } catch { /* ignore */ }
  }
  get isCollapsed(): boolean { return this.collapsed; }

  update(st: ControlState): void {
    const en = (b: HTMLButtonElement, on: boolean) => { if (b.disabled === on) b.disabled = !on; };
    en(this.bLiftoff, st.canLiftoff);
    en(this.bHold, st.canHold);
    setText(this.bHold.firstChild as HTMLElement, st.holdLabel);
    toggleClass(this.bHold, 'active', st.holdKind === 'active');
    toggleClass(this.bHold, 'danger', st.holdKind === 'danger');
    this.bHold.title = st.holdLabel === 'ABORT' ? 'Engines are lit: a hold now aborts the launch and recycles the count' : 'Hold / resume the countdown';
    en(this.bStage, st.canStageSep);
    en(this.bFairing, st.canFairingSep);
    this.warp.set(st.warp);
    for (const w of WARP_LEVELS) this.warp.enable(w, st.warpAllowed(w) || w === st.warp);
    setText(this.hdrWarp, `${st.warp}×`);
    toggleClass(this.hdrWarp, 'hot', st.warp !== 1);
    en(this.bReplay, st.canReplay || st.replaying);
    setText(this.bReplay.firstChild as HTMLElement, st.replaying ? 'END REPLAY' : 'REPLAY');
    this.bReplay.title = st.replaying ? 'Stop the touchdown replay' : 'Slow-motion replay of the touchdown';
    toggleClass(this.bReplay, 'active', st.replaying);
    en(this.bSummary, st.summaryReady);
    const muted = st.muted || !st.audioUnlocked;
    if (muted !== this.lastMuted) {
      this.lastMuted = muted;
      this.hdrMute.innerHTML = muted ? SPEAKER_OFF : SPEAKER_ON;
      toggleClass(this.hdrMute, 'off', muted);
    }
    if (st.paused !== this.lastPaused) {
      this.lastPaused = st.paused;
      this.hdrPause.innerHTML = st.paused ? PLAY : PAUSE;
      toggleClass(this.hdrPause, 'active', st.paused);
    }
    const s = this.ctx.settings;
    this.tod.set(s.timeOfDay);
    this.quality.set(s.quality);
    this.sea.set(s.seaState);
    this.wind.set(s.windSpeed);
    this.windDir.set(s.windFromDeg);
    this.tSoot.set(st.sooty);
    this.tManual.set(st.manualLanding);
  }
}
