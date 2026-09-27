// Lower-third captions for launch-control callouts + centered event titles. OWNER: ui.

import type { SimEvent } from '../core/types';
import { h } from './util';

interface Cap { el: HTMLDivElement; until: number; }

const VOICE: Record<string, string> = {
  lc: 'LAUNCH CONTROL',
  ld: 'LAUNCH DIRECTOR',
  host: 'HOST',
  flight: 'FLIGHT',
  recovery: 'RECOVERY',
};

/** Key events -> big centered title (+ short explainer line). */
const TITLES: Partial<Record<SimEvent['type'], [string, string]>> = {
  IGNITION_SEQUENCE: ['ENGINE STARTUP', 'TEA-TEB ignition, nine Merlin 1D engines'],
  LIFTOFF: ['LIFTOFF', ''],
  MAX_Q: ['MAX-Q', 'Maximum aerodynamic pressure'],
  MECO: ['MECO', 'Main engine cutoff'],
  STAGE_SEP: ['STAGE SEPARATION', ''],
  SES1: ['SECOND ENGINE START', 'Merlin Vacuum ignition'],
  FAIRING_SEP: ['FAIRING DEPLOY', ''],
  BOOSTER_FLIP: ['BOOSTER FLIP', 'Cold-gas thrusters turn Stage 1 engines-first'],
  ENTRY_BURN_START: ['ENTRY BURN', 'Three engines slow the booster for reentry'],
  LANDING_BURN_START: ['LANDING BURN', 'Single-engine hoverslam'],
  SECO: ['SECO', 'Second engine cutoff'],
  ORBIT: ['ORBIT ACHIEVED', ''],
  PAYLOAD_DEPLOY: ['STARLINK DEPLOY', 'Satellites released'],
};

export function touchdownTitle(e: SimEvent): [string, string, boolean] {
  const o = String(e.data?.outcome ?? 'success');
  switch (o) {
    case 'success': return ['BOOSTER LANDED', 'Of Course I Still Love You', false];
    case 'hard': return ['HARD LANDING', 'Touchdown above leg design limits', true];
    case 'tipped': return ['BOOSTER TIPPED OVER', 'Landed off-balance on the deck', true];
    case 'offdeck': return ['MISSED THE DECK', 'Booster came down beside the droneship', true];
    default: return ['TOUCHDOWN', o, false];
  }
}

export class Captions {
  readonly el: HTMLDivElement;
  readonly titleEl: HTMLDivElement;
  private titleMain: HTMLDivElement;
  private titleSub: HTMLDivElement;
  private caps: Cap[] = [];
  private titleUntil = 0;
  private now = 0;

  constructor() {
    this.el = h('div', { class: 'captions', 'aria-live': 'polite' });
    this.titleMain = h('div', { class: 'evt-main' });
    this.titleSub = h('div', { class: 'evt-sub' });
    this.titleEl = h('div', { class: 'evt-title' }, h('div', { class: 'evt-rule' }), this.titleMain, this.titleSub);
  }

  caption(text: string, speaker = '', alert = false): void {
    const el = h('div', { class: 'cap' + (alert ? ' alert' : '') },
      speaker ? h('div', { class: 'cap-who', text: speaker }) : null,
      h('div', { class: 'cap-text', text }),
    );
    this.el.append(el);
    const words = text.split(/\s+/).length;
    this.caps.push({ el, until: this.now + Math.max(3.2, 1.2 + words * 0.36) });
    requestAnimationFrame(() => el.classList.add('in'));
    while (this.caps.length > 2) this.retire(this.caps.shift()!);
  }

  title(main: string, sub = '', alert = false): void {
    this.titleMain.textContent = main;
    this.titleSub.textContent = sub;
    this.titleEl.classList.toggle('alert', alert);
    this.titleEl.classList.remove('in');
    void this.titleEl.offsetWidth;
    this.titleEl.classList.add('in');
    this.titleUntil = this.now + 4.2;
  }

  private retire(c: Cap): void {
    c.el.classList.remove('in');
    c.el.classList.add('out');
    setTimeout(() => c.el.remove(), 700);
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'CALLOUT') {
      const text = String(e.data?.text ?? '').trim();
      if (!text) return;
      // the clock already shows the final count; don't caption "Ten." ... "Zero."
      if (/^lc_\d+$/.test(String(e.data?.id ?? ''))) return;
      const who = String(e.data?.speaker ?? VOICE[String(e.data?.voice ?? 'lc')] ?? '');
      this.caption(text, who);
      return;
    }
    if (e.type === 'TOUCHDOWN') {
      const [m, sub, alert] = touchdownTitle(e);
      this.title(m, sub, alert);
      return;
    }
    if (e.type === 'RUD') {
      const who = e.body === 'S1' ? 'BOOSTER' : e.body === 'S2' ? 'SECOND STAGE' : e.body ?? 'VEHICLE';
      this.title(`${who} LOST`, String(e.data?.reason ?? 'Rapid unscheduled disassembly'), true);
      return;
    }
    if (e.type === 'SPLASHDOWN' && e.body === 'S1') {
      this.title('BOOSTER SPLASHDOWN', 'Stage 1 came down in the Pacific', true);
      return;
    }
    if (e.type === 'FAIRING_SEP' && e.data?.damaged) {
      this.title('FAIRING DEPLOY', 'Premature: payload exposed to aerodynamic heating', true);
      return;
    }
    if (e.type === 'COUNTDOWN_HOLD' && e.data?.abort) {
      this.title('LAUNCH ABORT', 'Engines shut down on the pad · recycling to T−60', true);
      return;
    }
    if (e.type === 'FLAMEOUT') {
      const who = e.body === 'S2' ? 'STAGE 2' : 'STAGE 1';
      this.caption(`${who} propellant depleted, engine flameout`, 'TELEMETRY', true);
      return;
    }
    const t = TITLES[e.type];
    if (t) this.title(t[0], t[1]);
  }

  update(dtReal: number, hidden: boolean): void {
    this.now += dtReal;
    if (hidden) return;
    while (this.caps.length && this.caps[0].until < this.now) this.retire(this.caps.shift()!);
    if (this.titleUntil && this.now > this.titleUntil) {
      this.titleUntil = 0;
      this.titleEl.classList.remove('in');
    }
  }

  clear(): void {
    for (const c of this.caps) c.el.remove();
    this.caps = [];
    this.titleEl.classList.remove('in');
  }
}
