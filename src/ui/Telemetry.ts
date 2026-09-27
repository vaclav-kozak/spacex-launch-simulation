// Per-stage webcast telemetry block: SPEED / ALTITUDE ring gauges, propellant bars,
// octaweb engine map and attitude silhouette. OWNER: ui.

import { Vector3 } from 'three';
import type { BodyState } from '../core/types';
import { LAUNCH_AZIMUTH_DEG } from '../core/constants';
import { padHeadingDir, upAt } from '../core/frames';
import { F9 } from '../core/vehicleSpec';
import { Smoother, arcPath, clamp, fmtFixed, fmtInt, h, s, setAttr, setText, toggleClass } from './util';
import { displaySpeed } from '../core/frames';

const GAUGE_SWEEP = 135; // arc from -135° to +135° (gap at the bottom)

class Gauge {
  readonly el: HTMLDivElement;
  private val: SVGPathElement;
  private cap: SVGCircleElement;
  private num: HTMLDivElement;
  private sm = new Smoother(0.14);
  private lastFrac = -1;

  constructor(label: string, unit: string, private max: number, private fmt: (v: number) => string) {
    const track = s('path', { d: arcPath(50, 50, 44, -GAUGE_SWEEP, GAUGE_SWEEP), class: 'g-track', pathLength: 1 });
    // minor ticks every 10 % of the sweep
    const ticks = s('g', { class: 'g-ticks' });
    for (let i = 0; i <= 10; i++) {
      const a = ((-GAUGE_SWEEP + (2 * GAUGE_SWEEP * i) / 10) * Math.PI) / 180;
      const r0 = i % 5 === 0 ? 37.5 : 39, r1 = 40.5;
      ticks.append(s('line', {
        x1: 50 + r0 * Math.sin(a), y1: 50 - r0 * Math.cos(a), x2: 50 + r1 * Math.sin(a), y2: 50 - r1 * Math.cos(a),
      }));
    }
    this.val = s('path', { d: arcPath(50, 50, 44, -GAUGE_SWEEP, GAUGE_SWEEP), class: 'g-val', pathLength: 1 });
    this.cap = s('circle', { r: 2.6, class: 'g-cap', cx: 50, cy: 94 });
    const svg = s('svg', { viewBox: '0 0 100 100', class: 'g-svg' }, track, ticks, this.val, this.cap);
    this.num = h('div', { class: 'g-num', text: '0' });
    this.el = h('div', { class: 'gauge' },
      svg,
      h('div', { class: 'g-read' }, this.num, h('div', { class: 'g-unit', text: unit })),
      h('div', { class: 'g-label', text: label }),
    );
  }

  update(v: number, dt: number, valid: boolean): void {
    const sv = this.sm.update(v, dt);
    setText(this.num, valid && Number.isFinite(sv) ? this.fmt(sv) : '–');
    const frac = valid && Number.isFinite(sv) ? clamp(sv / this.max, 0, 1) : 0;
    if (Math.abs(frac - this.lastFrac) > 0.0005) {
      this.lastFrac = frac;
      this.val.style.strokeDasharray = `${frac.toFixed(4)} 1`;
      const a = ((-GAUGE_SWEEP + 2 * GAUGE_SWEEP * frac) * Math.PI) / 180;
      this.cap.setAttribute('cx', (50 + 44 * Math.sin(a)).toFixed(2));
      this.cap.setAttribute('cy', (50 - 44 * Math.cos(a)).toFixed(2));
    }
  }
  reset(): void { this.sm.reset(); }
}

/** Octaweb (9 × Merlin 1D) or single MVac, seen from below. */
class EngineMap {
  readonly el: SVGSVGElement;
  private dots: SVGCircleElement[] = [];
  constructor(count: number) {
    const ring = s('circle', { cx: 0, cy: 0, r: 18.5, class: 'em-ring' });
    this.el = s('svg', { viewBox: '-21 -21 42 42', class: 'engmap' }, ring);
    if (count === 1) {
      const d = s('circle', { cx: 0, cy: 0, r: 11, class: 'em-eng' });
      this.dots.push(d);
      this.el.append(s('circle', { cx: 0, cy: 0, r: 5.2, class: 'em-throat' }), d);
    } else {
      const rr = (F9.s1.engineRingRadius / F9.radius) * 18.5;
      const er = (F9.s1.nozzleExitRadius / F9.radius) * 18.5 * 0.78;
      for (let k = 0; k < count; k++) {
        const a = k === 0 ? 0 : (F9.s1.engineAngleDeg(k) * Math.PI) / 180;
        const r = k === 0 ? 0 : rr;
        const d = s('circle', { cx: (r * Math.cos(a)).toFixed(2), cy: (r * Math.sin(a)).toFixed(2), r: er.toFixed(2), class: 'em-eng' });
        this.dots.push(d);
        this.el.append(d);
      }
    }
  }
  update(b: BodyState | null): void {
    for (let i = 0; i < this.dots.length; i++) {
      const e = b?.engines[i];
      const lit = !!e && e.on;
      const k = lit ? clamp(e!.spool > 0 ? e!.spool : 1, 0, 1) : 0;
      toggleClass(this.dots[i], 'on', lit);
      const op = lit ? (0.35 + 0.65 * k).toFixed(2) : '';
      if (this.dots[i].style.opacity !== op) this.dots[i].style.opacity = op;
    }
  }
}

type Silhouette = 'stack' | 'stackNoFairing' | 'booster' | 's2' | 's2NoFairing';

function silhouettePath(kind: Silhouette): string {
  // drawn in a 20 × 64 box, nozzle at bottom (y=60), centered on x=0
  const w = 3.1;
  const booster = `M${-w} 60 L${-w} 14 L${w} 14 L${w} 60 Z`;
  const fins = `M${-w} 17 L${-w - 2.4} 16.2 L${-w - 2.4} 19.2 L${-w} 19.6 Z M${w} 17 L${w + 2.4} 16.2 L${w + 2.4} 19.2 L${w} 19.6 Z`;
  const eng = `M-2.4 60 L-3 62.4 L3 62.4 L2.4 60 Z`;
  const fairing = `M-4.3 10 L-4.3 0.8 C-4.3 -3.6 -1.6 -6.2 0 -6.6 C1.6 -6.2 4.3 -3.6 4.3 0.8 L4.3 10 Z`;
  const s2body = `M${-w} 14 L${-w} 10 L${w} 10 L${w} 14 Z`;
  const s2only = `M${-w} 30 L${-w} 10 L${w} 10 L${w} 30 Z M-2.2 30 L-3.4 35 L3.4 35 L2.2 30 Z`;
  const payload = `M-2.6 10 L-2.6 3 L2.6 3 L2.6 10 Z`;
  switch (kind) {
    case 'stack': return booster + s2body + fairing + eng;
    case 'stackNoFairing': return booster + s2body + payload + eng;
    case 'booster': return booster + fins + eng;
    case 's2': return s2only + fairing;
    case 's2NoFairing': return s2only + payload;
  }
}

const _up = new Vector3(), _ax = new Vector3(), _hd = new Vector3(), _hd0 = new Vector3();
padHeadingDir(LAUNCH_AZIMUTH_DEG, _hd0);

/** signed pitch-from-vertical (deg): 0 = nose up, +90 = nose pointing downrange, ±180 = nose down */
export function attitudeDeg(b: BodyState): number {
  upAt(b.pos, _up);
  _ax.set(0, 1, 0).applyQuaternion(b.quat);
  _hd.copy(_hd0).addScaledVector(_up, -_hd0.dot(_up)).normalize();
  return (Math.atan2(_ax.dot(_hd), _ax.dot(_up)) * 180) / Math.PI;
}

class AttitudeIcon {
  readonly el: SVGSVGElement;
  private g: SVGGElement;
  private path: SVGPathElement;
  private kind: Silhouette | null = null;
  private sm = new Smoother(0.08, 10, 60);
  constructor() {
    this.path = s('path', { class: 'att-body' });
    this.g = s('g', {}, this.path);
    this.el = s('svg', { viewBox: '-26 -26 52 52', class: 'att' },
      s('line', { x1: -24, y1: 0, x2: -15, y2: 0, class: 'att-hz' }),
      s('line', { x1: 15, y1: 0, x2: 24, y2: 0, class: 'att-hz' }),
      s('line', { x1: 0, y1: -25, x2: 0, y2: -21, class: 'att-hz' }),
      this.g,
    );
  }
  update(b: BodyState | null, kind: Silhouette, dt: number): void {
    if (kind !== this.kind) {
      this.kind = kind;
      this.path.setAttribute('d', silhouettePath(kind));
      this.sm.reset();
    }
    if (!b) return;
    let a = attitudeDeg(b);
    // unwrap toward the smoothed value so ±180 crossings don't spin the icon
    const prev = this.sm.value;
    if (Number.isFinite(prev)) { while (a - prev > 180) a -= 360; while (a - prev < -180) a += 360; }
    const v = this.sm.update(a, dt);
    const cy = kind === 's2' || kind === 's2NoFairing' ? 14 : 28; // rotate about the silhouette's middle
    setAttr(this.g, 'transform', `rotate(${v.toFixed(1)}) scale(0.72) translate(0 ${-cy})`);
  }
}

class PropBars {
  readonly el: HTMLDivElement;
  private fills: HTMLDivElement[] = [];
  private sm = [new Smoother(0.2), new Smoother(0.2)];
  constructor() {
    const bar = (label: string) => {
      const f = h('div', { class: 'pb-fill' });
      this.fills.push(f);
      return h('div', { class: 'pb' }, h('div', { class: 'pb-track' }, f), h('div', { class: 'pb-label', text: label }));
    };
    this.el = h('div', { class: 'props' }, bar('LOX'), bar('RP-1'));
  }
  update(lox: number, rp1: number, dt: number): void {
    [lox, rp1].forEach((v, i) => {
      const x = clamp(this.sm[i].update(v, dt), 0, 1);
      const tf = `scaleY(${x.toFixed(4)})`;
      if (this.fills[i].style.transform !== tf) this.fills[i].style.transform = tf;
      toggleClass(this.fills[i], 'low', x < 0.08);
    });
  }
}

export interface StageView {
  title: string;
  status: string;
  body: BodyState | null;
  silhouette: Silhouette;
  /** telemetry lost (RUD etc.) */
  lost: boolean;
}

export class StageTelemetry {
  readonly el: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private statusEl: HTMLSpanElement;
  private speed: Gauge;
  private alt: Gauge;
  private engines: EngineMap;
  private att = new AttitudeIcon();
  private props = new PropBars();

  constructor(side: 'left' | 'right', engineCount: number, speedMax: number, altMax: number) {
    this.speed = new Gauge('SPEED', 'KM/H', speedMax, (v) => fmtInt(Math.max(0, v)));
    this.alt = new Gauge('ALTITUDE', 'KM', altMax, (v) => (v < 99.95 ? fmtFixed(Math.max(0, v), 1) : fmtInt(v)));
    this.engines = new EngineMap(engineCount);
    this.titleEl = h('span', { class: 'st-title' });
    this.statusEl = h('span', { class: 'st-status' });
    const extras = h('div', { class: 'st-icons' }, this.att.el, this.engines.el);
    const row = side === 'left'
      ? h('div', { class: 'st-row' }, extras, this.speed.el, this.alt.el, this.props.el)
      : h('div', { class: 'st-row' }, this.props.el, this.speed.el, this.alt.el, extras);
    this.el = h('div', { class: `stage stage-${side}` }, h('div', { class: 'st-head' }, this.titleEl, this.statusEl), row);
  }

  update(v: StageView, dt: number): void {
    setText(this.titleEl, v.title);
    setText(this.statusEl, v.status);
    toggleClass(this.el, 'lost', v.lost);
    const b = v.body;
    const ok = !!b && !v.lost;
    this.speed.update(b ? displaySpeed(b) * 3.6 : NaN, dt, ok);
    this.alt.update(b ? Math.max(0, b.altitude) / 1000 : NaN, dt, ok);
    this.engines.update(ok ? b : null);
    this.att.update(b, v.silhouette, dt);
    const f = b && b.propCapacity > 0 ? b.propMass / b.propCapacity : 0;
    // LOX and RP-1 drain together at O/F ≈ 2.36; show both from the same total (sim has no split)
    this.props.update(ok ? f : 0, ok ? f : 0, dt);
  }
}
