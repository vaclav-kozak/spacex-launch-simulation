// Webcast mission timeline: a large dome-shaped arc with the current time at the apex, event
// markers sliding right→left as the mission advances, radial labels, and the T± clock beneath.
// OWNER: ui.

import type { SimSnapshot, TimelineMarker } from '../core/types';
import { MISSION_NAME } from '../core/constants';
import { arcPath, clamp, fmtClock, h, s, setAttr, setText, toggleClass } from './util';

interface MarkerEl {
  g: SVGGElement;
  dot: SVGCircleElement;
  label: SVGTextElement;
  leader: SVGLineElement;
  done: boolean;
  seen: number;
}

/** Webcast timeline vocabulary: only these events get a marker, with these labels. The sim may
 * publish more markers (used for the warp auto-drop); they stay off the arc to keep it legible. */
const DISPLAY: Partial<Record<TimelineMarker['type'], string>> = {
  LIFTOFF: 'LIFTOFF',
  MAX_Q: 'MAX-Q',
  MECO: 'MECO',
  STAGE_SEP: 'STAGE SEP',
  SES1: 'SES-1',
  FAIRING_SEP: 'FAIRING',
  ENTRY_BURN_START: 'ENTRY BURN',
  LANDING_BURN_START: 'LANDING BURN',
  TOUCHDOWN: 'LANDING',
  SECO: 'SECO',
  PAYLOAD_DEPLOY: 'DEPLOY',
};

/** time -> angle compression: near events spread out, far ones bunch toward the ends */
const TAU = 42; // s
const WINDOW = 700; // s mapped to the arc end
/** done markers older than this lose their label (dot stays) */
const OLD_LABEL_AGE = 200; // s
/** narrow (phone portrait) arc: fewer labels so the short arc stays legible */
const NARROW_OLD_LABEL_AGE = 30; // s
const NARROW_NEXT_LABELS = 3;

export class Timeline {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private past: SVGPathElement;
  private future: SVGPathElement;
  private markersG: SVGGElement;
  private nowDot: SVGCircleElement;
  private markers = new Map<string, MarkerEl>();
  private clockSign: HTMLSpanElement;
  private clockBody: HTMLSpanElement;
  private clockEl: HTMLDivElement;
  private missionEl: HTMLDivElement;
  private stateEl: HTMLDivElement;
  private warpEl: HTMLDivElement;
  private gradId = `tlfade${Math.random().toString(36).slice(2, 7)}`;

  // geometry (CSS px in the band's unzoomed design space)
  private W = 760;
  private R = 800;
  private cx = 380;
  private cy = 0;
  private apexY = 104;
  private half = 28; // deg
  private frame = 0;
  private lastWarp = 1;
  private narrow = false;

  constructor() {
    const defs = s('defs', {},
      s('linearGradient', { id: this.gradId, x1: 0, y1: 0, x2: 1, y2: 0 },
        s('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': 0 }),
        s('stop', { offset: '0.14', 'stop-color': '#fff', 'stop-opacity': 1 }),
        s('stop', { offset: '0.86', 'stop-color': '#fff', 'stop-opacity': 1 }),
        s('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': 0 }),
      ),
    );
    this.past = s('path', { class: 'tl-past', stroke: `url(#${this.gradId})` });
    this.future = s('path', { class: 'tl-future', stroke: `url(#${this.gradId})` });
    this.markersG = s('g', { class: 'tl-markers' });
    this.nowDot = s('circle', { r: 2.2, class: 'tl-now' });
    this.svg = s('svg', { class: 'tl-svg' }, defs, this.future, this.past, this.markersG, this.nowDot);

    this.clockSign = h('span', { class: 'clk-sign' });
    this.clockBody = h('span', { class: 'clk-body' });
    this.clockEl = h('div', { class: 'clock' }, this.clockSign, this.clockBody);
    this.missionEl = h('div', { class: 'mission', text: MISSION_NAME });
    this.stateEl = h('div', { class: 'clk-state' });
    this.warpEl = h('div', { class: 'clk-warp' });
    this.el = h('div', { class: 'timeline' }, this.svg,
      h('div', { class: 'tl-center' }, h('div', { class: 'clock-row' }, this.clockEl, this.warpEl), this.missionEl, this.stateEl));
    this.layout(760);
  }

  /** width of the timeline block in design px; narrow: phone portrait (rounder arc, the clock block
   * sets the height, fewer labels) */
  layout(W: number, narrow = false): void {
    this.W = W;
    this.narrow = narrow;
    this.R = W * (narrow ? 0.94 : 1.08);
    this.cx = W / 2;
    this.half = (Math.asin((W / 2 - 6) / this.R) * 180) / Math.PI;
    const sag = this.R * (1 - Math.cos((this.half * Math.PI) / 180));
    this.apexY = narrow ? 94 : 104;
    this.cy = this.apexY + this.R;
    // narrow: clock (top: apexY + 14, see .narrow .tl-center) + mission + state line must fit above the stage rows
    const H = Math.ceil(narrow ? Math.max(this.apexY + sag + 8, this.apexY + 14 + 70) : this.apexY + sag + 8);
    setAttr(this.svg, 'viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('width', String(W));
    this.svg.setAttribute('height', String(H));
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.future.setAttribute('d', arcPath(this.cx, this.cy, this.R, 0, this.half));
    this.past.setAttribute('d', arcPath(this.cx, this.cy, this.R, -this.half, 0));
    // gradient spans the full chord for both halves
    const grad = this.svg.querySelector('linearGradient')!;
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '0'); grad.setAttribute('x2', String(W));
    grad.setAttribute('y1', '0'); grad.setAttribute('y2', '0');
    this.nowDot.setAttribute('cx', String(this.cx));
    this.nowDot.setAttribute('cy', String(this.apexY));
  }

  private angleOf(dt: number): number {
    const lim = this.half - 1.5;
    return (lim * Math.asinh(dt / TAU)) / Math.asinh(WINDOW / TAU);
  }

  private pt(aDeg: number, r: number): [number, number] {
    const a = (aDeg * Math.PI) / 180;
    return [this.cx + r * Math.sin(a), this.cy - r * Math.cos(a)];
  }

  private markerEl(key: string, m: TimelineMarker): MarkerEl {
    let me = this.markers.get(key);
    if (!me) {
      const leader = s('line', { class: 'tl-leader' });
      const dot = s('circle', { r: 4.6, class: 'tl-dot' });
      const label = s('text', { class: 'tl-label', text: m.label });
      const g = s('g', { class: 'tl-m' }, leader, dot, label);
      this.markersG.append(g);
      me = { g, dot, label, leader, done: m.done, seen: this.frame };
      this.markers.set(key, me);
    }
    setText(me.label, m.label);
    return me;
  }

  update(snap: SimSnapshot, opts: { held: boolean; alert: boolean; state: string; paused: boolean; warp: number }): void {
    this.frame++;
    const t = snap.t;
    const { sign, body } = fmtClock(t);
    setText(this.clockSign, sign);
    setText(this.clockBody, body);
    toggleClass(this.clockEl, 'held', opts.held);
    toggleClass(this.clockEl, 'alert', opts.alert);
    if (opts.state) setText(this.stateEl, opts.state); // keep the old text while it fades out
    toggleClass(this.stateEl, 'show', !!opts.state);
    toggleClass(this.stateEl, 'alert', opts.alert);
    setText(this.warpEl, opts.warp !== 1 ? `${opts.warp}×` : '');
    toggleClass(this.warpEl, 'show', opts.warp !== 1);
    if (opts.warp !== this.lastWarp) {
      // warp changed (user or the sim's auto-drop before a key event): flash the chip / clock
      const target = opts.warp !== 1 ? this.warpEl : this.clockEl;
      target.classList.remove('bump');
      void target.offsetWidth;
      target.classList.add('bump');
      this.lastWarp = opts.warp;
    }

    // --- markers ---
    const lim = this.half - 0.5;
    const items: { key: string; m: TimelineMarker; a: number; la: number; me: MarkerEl }[] = [];
    const dupes = new Map<string, number>();
    for (const m0 of snap.timeline) {
      const lab = DISPLAY[m0.type];
      if (!lab) continue;
      const m = lab === m0.label ? m0 : { ...m0, label: lab };
      const k0 = m.type;
      const n = dupes.get(k0) ?? 0;
      dupes.set(k0, n + 1);
      const key = n ? `${k0}#${n}` : k0;
      const a = this.angleOf(m.t - t);
      const me = this.markerEl(key, m);
      me.seen = this.frame;
      items.push({ key, m, a, la: a, me });
    }
    for (const [k, me] of this.markers) if (me.seen !== this.frame) { me.g.remove(); this.markers.delete(k); }

    // 1-D label relaxation so close events (MECO / STAGE SEP / SES-1) fan out instead of overlapping
    items.sort((p, q) => p.a - q.a);
    // narrow: label only the next few events and the ones just passed (the others keep their dots
    // and stay out of the relaxation); wide: every marker takes part, long-past labels just fade
    const oldAge = this.narrow ? NARROW_OLD_LABEL_AGE : OLD_LABEL_AGE;
    let upcoming = 0;
    const noLabel = new Set<MarkerEl>();
    for (const it of items) {
      if (it.m.done && t - it.m.t > oldAge) noLabel.add(it.me);
      else if (!it.m.done && !it.m.cancelled && ++upcoming > NARROW_NEXT_LABELS && this.narrow) noLabel.add(it.me);
    }
    const labeled = this.narrow ? items.filter((it) => !noLabel.has(it.me)) : items;
    const labelR = this.R + 13;
    const gap = (16 / labelR) * (180 / Math.PI);
    const maxNudge = 9;
    for (let it = 0; it < 80; it++) {
      let moved = false;
      for (let i = 0; i + 1 < labeled.length; i++) {
        const p = labeled[i], q = labeled[i + 1];
        const d = q.la - p.la;
        if (d < gap) {
          const push = (gap - d) / 2 + 1e-4;
          p.la = clamp(p.la - push, p.a - maxNudge, p.a + maxNudge);
          q.la = clamp(q.la + push, q.a - maxNudge, q.a + maxNudge);
          moved = true;
        }
      }
      if (!moved) break;
    }

    for (const it of items) {
      const { m, a, la, me } = it;
      const vis = Math.abs(a) <= lim;
      const edge = clamp((lim - Math.abs(a)) / 4, 0, 1); // fade over the last 4° at each end
      const op = vis ? edge : 0;
      me.g.style.opacity = op.toFixed(3);
      if (op <= 0) continue;
      const [x, y] = this.pt(a, this.R);
      me.dot.setAttribute('cx', x.toFixed(2));
      me.dot.setAttribute('cy', y.toFixed(2));
      const [lx, ly] = this.pt(la, labelR);
      me.label.setAttribute('x', lx.toFixed(2));
      me.label.setAttribute('y', ly.toFixed(2));
      me.label.setAttribute('transform', `rotate(${(la - 90).toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)})`);
      const nud = Math.abs(la - a) > 0.35;
      if (nud) {
        const [x0, y0] = this.pt(a, this.R + 6);
        const [x1, y1] = this.pt(la, labelR - 3);
        me.leader.setAttribute('x1', x0.toFixed(2)); me.leader.setAttribute('y1', y0.toFixed(2));
        me.leader.setAttribute('x2', x1.toFixed(2)); me.leader.setAttribute('y2', y1.toFixed(2));
      }
      toggleClass(me.leader, 'show', nud);
      if (m.done && !me.done) {
        // just passed the apex: pulse
        me.g.classList.remove('pulse');
        void me.g.getBoundingClientRect();
        me.g.classList.add('pulse');
      }
      me.done = m.done;
      toggleClass(me.g, 'done', m.done);
      toggleClass(me.g, 'cancelled', !!m.cancelled && !m.done);
      toggleClass(me.g, 'near', !m.done && !m.cancelled && m.t - t < 12 && m.t - t > -2);
      // long-past events bunch up at the left end: keep their dots, drop the labels
      toggleClass(me.g, 'old', noLabel.has(me));
    }
  }
}
