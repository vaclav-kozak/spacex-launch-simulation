// `?hud=min`: minimal broadcast overlay for vertical social video and small screens. OWNER: ui.
// A top-centre lockup: the T± clock, a hairline with the focused stage's tag, and its speed | altitude
// around a fixed centre axis (numbers grow outward, so nothing jitters). The event titles are
// re-parented under it by HUD, so the whole overlay is one stack inside the platform safe zone.

import type { ViewInfo } from '../core/context';
import type { BodyId, SimSnapshot } from '../core/types';
import { displaySpeed } from '../core/frames';
import { Smoother, fmtClock, fmtFixed, fmtInt, h, setText, toggleClass } from './util';

export interface MinHudState { held: boolean; alert: boolean; state: string }

/** the stage the picture is about: the largest visible view's focus (S2 for its own cameras and the
 * fairing / payload, S1 for everything else incl. the droneship) */
export function focusedStage(snap: SimSnapshot, views: ViewInfo[]): 'S1' | 'S2' {
  let best: ViewInfo | null = null, bestA = 0;
  for (const v of views) {
    const a = v.rect.w * v.rect.h * v.alpha;
    if (a > bestA * 1.02) { best = v; bestA = a; } // ties keep the first view (S1 in the split layout)
  }
  const f: BodyId | null = best?.focus ?? null;
  const st: 'S1' | 'S2' = f === 'S2' || f === 'FAIRING_A' || f === 'FAIRING_B' || f === 'PAYLOAD' ? 'S2' : 'S1';
  const s1 = snap.bodies.S1.status;
  return st === 'S1' && (s1 === 'gone' || s1 === 'destroyed') && snap.bodies.S2.status !== 'gone' ? 'S2' : st;
}

export class MinHud {
  readonly el: HTMLDivElement;
  /** inner zoomed column; HUD appends the event title here */
  readonly col: HTMLDivElement;
  private clock: HTMLDivElement;
  private sign: HTMLSpanElement;
  private body: HTMLSpanElement;
  private tag: HTMLSpanElement;
  private spd: HTMLSpanElement;
  private alt: HTMLSpanElement;
  private stateEl: HTMLDivElement;
  private smSpd = new Smoother(0.14);
  private smAlt = new Smoother(0.14);
  private stage: 'S1' | 'S2' | null = null;

  constructor() {
    this.sign = h('span', { class: 'mh-sign' });
    this.body = h('span', { class: 'mh-body' });
    this.clock = h('div', { class: 'mh-clock' }, this.sign, this.body);
    this.tag = h('span', { class: 'mh-tag' });
    this.spd = h('span', { class: 'mh-num' });
    this.alt = h('span', { class: 'mh-num' });
    this.stateEl = h('div', { class: 'mh-state' });
    this.col = h('div', { class: 'mh-col' },
      this.clock,
      h('div', { class: 'mh-rule' }, this.tag),
      h('div', { class: 'mh-read' },
        h('span', { class: 'mh-cell mh-l' }, this.spd, h('span', { class: 'mh-unit', text: 'KM/H' })),
        h('span', { class: 'mh-div' }),
        h('span', { class: 'mh-cell mh-r' }, this.alt, h('span', { class: 'mh-unit', text: 'KM' }))),
      this.stateEl);
    this.el = h('div', { class: 'minhud' }, this.col);
  }

  update(snap: SimSnapshot, views: ViewInfo[], st: MinHudState, dt: number): void {
    const { sign, body } = fmtClock(snap.t);
    setText(this.sign, sign);
    setText(this.body, body);
    toggleClass(this.clock, 'held', st.held);
    toggleClass(this.clock, 'alert', st.alert);
    if (st.state) setText(this.stateEl, st.state); // keep the old text while it fades out
    toggleClass(this.stateEl, 'show', !!st.state);
    toggleClass(this.stateEl, 'alert', st.alert);

    const id = focusedStage(snap, views);
    if (id !== this.stage) {
      // a cut to the other stage: snap the numbers instead of counting across
      this.stage = id;
      this.smSpd.reset();
      this.smAlt.reset();
      setText(this.tag, id === 'S1' ? 'STAGE 1' : 'STAGE 2');
    }
    const b = snap.bodies[id];
    const ok = b.status !== 'destroyed' && b.status !== 'gone';
    const v = this.smSpd.update(displaySpeed(b) * 3.6, dt);
    const a = this.smAlt.update(Math.max(0, b.altitude) / 1000, dt);
    setText(this.spd, ok && Number.isFinite(v) ? fmtInt(Math.max(0, v)) : '–');
    setText(this.alt, ok && Number.isFinite(a) ? (a < 99.95 ? fmtFixed(Math.max(0, a), 1) : fmtInt(a)) : '–');
  }
}
