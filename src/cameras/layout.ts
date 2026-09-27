// Viewport tiling layouts + animated rect/alpha tweens. OWNER: cameras.
import { clamp, easeInOutCubic, lerp } from './util';

export interface Rect { x: number; y: number; w: number; h: number }

/** bottom band reserved for the HUD (T-clock, gauges, timeline arc), in UI design px (x uiZoom) */
export const HUD_BAND = 250;
/** PiPs keep clear of the HUD's gauges (which extend a little above the band), design px */
const PIP_BOTTOM_CLEAR = 272;

/** the webcast overlay's --z scale (mirror of src/ui/HUD.ts layout(): design size 1600 x 900) */
export function uiZoom(W: number, H: number): number {
  return clamp(Math.min(W / 1600, H / 900), 0.74, 1.5);
}
const GAP = 2;

/** Tile rects for n views (order = priority / reading order). */
export function tileRects(n: number, W: number, H: number): Rect[] {
  const g = GAP / 2;
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) {
    const hw = W / 2;
    return [{ x: 0, y: 0, w: hw - g, h: H }, { x: hw + g, y: 0, w: W - hw - g, h: H }];
  }
  if (n === 3) {
    const hw = W / 2, hh = H / 2;
    return [
      { x: 0, y: 0, w: hw - g, h: H },
      { x: hw + g, y: 0, w: W - hw - g, h: hh - g },
      { x: hw + g, y: hh + g, w: W - hw - g, h: H - hh - g },
    ];
  }
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x0 = (W * c) / cols, x1 = (W * (c + 1)) / cols;
    const y0 = (H * r) / rows, y1 = (H * (r + 1)) / rows;
    out.push({ x: x0 + (c ? g : 0), y: y0 + (r ? g : 0), w: x1 - x0 - (c ? g : 0) - (c < cols - 1 ? g : 0), h: y1 - y0 - (r ? g : 0) - (r < rows - 1 ? g : 0) });
  }
  return out;
}

/** Picture-in-picture thumbnails: bottom-left, stacked upward from just above the HUD band (scaled
 * by the overlay's --z, so they never cover the telemetry / captions band; the captions shift right
 * of them). Top-right belongs to the UI control panel, top-left to the main view's label. */
export function pipRects(n: number, W: number, H: number): Rect[] {
  const w = clamp(W * 0.2, 180, 380);
  const h = (w * 9) / 16;
  const m = 20;
  const out: Rect[] = [];
  const bottom = H - PIP_BOTTOM_CLEAR * uiZoom(W, H);
  for (let i = 0; i < n; i++) {
    const y = bottom - (i + 1) * h - i * 10;
    out.push({ x: m, y: Math.max(m + 90, y), w, h });
  }
  return out;
}

/** Collapsed version of a rect (spawn origin / merge destination): shrinks toward its outer edge. */
export function collapsedRect(r: Rect, W: number, H: number, pip: boolean): Rect {
  if (pip || (r.w >= W - 4 && r.h >= H - 4)) {
    const s = pip ? 0.6 : 1;
    return { x: r.x + (r.w * (1 - s)) / 2, y: r.y + (r.h * (1 - s)) / 2, w: r.w * s, h: r.h * s };
  }
  if (r.y > 2 && r.x > 2) return { x: r.x, y: r.y + r.h, w: r.w, h: 0 };
  if (r.y > 2) return { x: r.x, y: r.y + r.h, w: r.w, h: 0 };
  if (r.x > 2) return { x: r.x + r.w, y: r.y, w: 0, h: r.h };
  if (r.x + r.w < W - 2) return { x: r.x, y: r.y, w: 0, h: r.h };
  return { x: r.x, y: r.y + r.h, w: r.w, h: 0 };
}

export class RectTween {
  from: Rect = { x: 0, y: 0, w: 0, h: 0 };
  to: Rect = { x: 0, y: 0, w: 0, h: 0 };
  t0 = 0;
  dur = 1;
  /** growing rects lead (ease-out), shrinking ones follow (ease-in-out) so no black gaps open up */
  private grow = false;
  set(now: number, current: Rect, to: Rect, dur: number): void {
    this.from = { ...current };
    this.to = { ...to };
    this.t0 = now;
    this.dur = dur;
    this.grow = to.w * to.h > current.w * current.h * 1.02;
  }
  jump(to: Rect): void { this.from = { ...to }; this.to = { ...to }; this.dur = 0; }
  sameTarget(r: Rect): boolean {
    const a = this.to;
    return Math.abs(a.x - r.x) < 0.5 && Math.abs(a.y - r.y) < 0.5 && Math.abs(a.w - r.w) < 0.5 && Math.abs(a.h - r.h) < 0.5;
  }
  done(now: number): boolean { return this.dur <= 0 || now - this.t0 >= this.dur; }
  eval(now: number, out: Rect): Rect {
    const x = this.dur <= 0 ? 1 : clamp((now - this.t0) / this.dur, 0, 1);
    const k = this.grow ? 1 - Math.pow(1 - x, 3) : easeInOutCubic(x);
    out.x = lerp(this.from.x, this.to.x, k);
    out.y = lerp(this.from.y, this.to.y, k);
    out.w = lerp(this.from.w, this.to.w, k);
    out.h = lerp(this.from.h, this.to.h, k);
    return out;
  }
}

export class ScalarTween {
  from = 0; to = 0; t0 = 0; dur = 0;
  set(now: number, current: number, to: number, dur: number): void { this.from = current; this.to = to; this.t0 = now; this.dur = dur; }
  eval(now: number): number {
    const k = this.dur <= 0 ? 1 : clamp((now - this.t0) / this.dur, 0, 1);
    const e = k * k * (3 - 2 * k);
    return lerp(this.from, this.to, e);
  }
  done(now: number): boolean { return this.dur <= 0 || now - this.t0 >= this.dur; }
}
