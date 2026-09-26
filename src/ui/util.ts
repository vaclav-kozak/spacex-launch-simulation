// Small DOM / formatting helpers for the HUD. OWNER: ui.

export const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | null)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.setAttribute('class', String(v));
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Set textContent only when it changed (avoids layout churn at 60 Hz). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
export function setAttr(el: Element, k: string, v: string): void {
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}
export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

/** Mission clock "T+ 00:08:32" / "T− 00:00:42". The sign flips at T-0 exactly like the webcast. */
export function fmtClock(t: number): { sign: string; body: string } {
  // countdown shows the ceiling (T-00:00:01 until the instant of liftoff), count-up the floor
  const neg = t < 0;
  const a = neg ? Math.ceil(-t - 1e-6) : Math.floor(t + 1e-6);
  const hh = Math.floor(a / 3600), mm = Math.floor((a % 3600) / 60), ss = a % 60;
  return { sign: neg ? 'T−' : 'T+', body: `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` };
}

/** m:ss for short durations */
export function fmtMinSec(t: number): string {
  const a = Math.max(0, Math.round(t));
  return `${Math.floor(a / 60)}:${pad2(a % 60)}`;
}

/** Integer with thin-space thousands grouping, as broadcast graphics do. */
export function fmtInt(n: number): string {
  const r = Math.round(n);
  const sgn = r < 0 ? '−' : '';
  const str = String(Math.abs(r));
  return sgn + str.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function fmtFixed(n: number, digits: number): string {
  const s0 = Math.abs(n).toFixed(digits);
  return (n < -0.5 * Math.pow(10, -digits) ? '−' : '') + s0;
}

/**
 * Display smoother: exponential approach in real time, snaps on large discontinuities
 * (seek / restart / replay jumps) so numbers never "count" through a jump.
 */
export class Smoother {
  value = NaN;
  constructor(private tau = 0.12, private snapFrac = 0.35, private snapAbs = Infinity) {}
  update(target: number, dt: number): number {
    if (!Number.isFinite(target)) return this.value;
    if (!Number.isFinite(this.value)) return (this.value = target);
    const d = Math.abs(target - this.value);
    if (d > this.snapAbs || (d > 50 && d > Math.abs(target) * this.snapFrac && d > Math.abs(this.value) * this.snapFrac)) {
      return (this.value = target);
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / this.tau);
    this.value += (target - this.value) * k;
    return this.value;
  }
  reset(): void {
    this.value = NaN;
  }
}

/** Arc path (SVG) on a circle centered at cx,cy; angles in degrees, 0 = up, clockwise positive. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => {
    const rad = (a * Math.PI) / 180;
    return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
  };
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return type !== 'range' && type !== 'checkbox' && type !== 'button';
  }
  return false;
}
