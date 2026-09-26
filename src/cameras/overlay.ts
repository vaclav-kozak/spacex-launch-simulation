// Per-viewport HTML overlay: webcast label + telemetry + mode buttons, and pointer input
// (click = maximize, drag = orbit, right-drag = pan, wheel = zoom). OWNER: cameras.
import './cameras.css';
import type { CameraMode } from '../core/context';

export interface OverlayHandlers {
  click(id: string): void;
  dragStart(id: string, button: number): void;
  drag(id: string, dx: number, dy: number, button: number): void;
  wheel(id: string, deltaY: number): void;
  mode(id: string, mode: CameraMode): void;
}

export interface ModeButton { mode: CameraMode; label: string }

export interface LabelState {
  name: string;
  speed: string;
  alt: string;
  phase: string;
  cam: string;
  modes: ModeButton[];
  activeMode: CameraMode;
  compact: boolean;
  single: boolean;
  pip: boolean;
  canMax: boolean;
  isMax: boolean;
  fade: number;
}

class VpElement {
  readonly root: HTMLDivElement;
  private fade: HTMLDivElement;
  private label: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private speedEl: HTMLElement;
  private altEl: HTMLElement;
  private phEl: HTMLSpanElement;
  private camEl: HTMLSpanElement;
  private modesEl: HTMLDivElement;
  private last: Partial<Record<string, string>> = {};
  private modesKey = '';
  private buttons = new Map<CameraMode, HTMLButtonElement>();
  private lastRect = '';

  constructor(readonly id: string, private h: OverlayHandlers) {
    const el = (tag: string, cls: string, parent?: HTMLElement) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      parent?.appendChild(e);
      return e;
    };
    this.root = el('div', 'camvp') as HTMLDivElement;
    this.root.dataset.view = id;
    this.fade = el('div', 'camvp-fade', this.root) as HTMLDivElement;
    el('div', 'camvp-frame', this.root);
    this.label = el('div', 'camvp-label', this.root) as HTMLDivElement;
    const text = el('div', 'camvp-text', this.label);
    this.nameEl = el('div', 'camvp-name', text) as HTMLDivElement;
    const tel = el('div', 'camvp-tel', text);
    const sp = el('span', '', tel);
    this.speedEl = el('b', '', sp);
    el('i', '', sp).textContent = 'KM/H';
    const al = el('span', '', tel);
    this.altEl = el('b', '', al);
    el('i', '', al).textContent = 'KM';
    const sub = el('div', 'camvp-sub', text);
    this.phEl = el('span', 'cam-ph', sub) as HTMLSpanElement;
    el('span', 'cam-sep', sub);
    this.camEl = el('span', 'cam-md', sub) as HTMLSpanElement;
    this.modesEl = el('div', 'camvp-modes', this.label) as HTMLDivElement;
    this.installPointer();
  }

  private installPointer(): void {
    const r = this.root;
    let down: { x: number; y: number; t: number; b: number; id: number } | null = null;
    let dragging = false;
    let lx = 0, ly = 0;
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    r.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (down) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button, id: e.pointerId };
      dragging = false;
      lx = e.clientX; ly = e.clientY;
      try { r.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    r.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
        dragging = true;
        r.classList.add('cam-dragging');
        this.h.dragStart(this.id, down.b);
      }
      if (dragging) this.h.drag(this.id, dx, dy, down.b);
      lx = e.clientX; ly = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      const wasClick = !dragging && down.b === 0 && performance.now() - down.t < 450 && e.type === 'pointerup';
      down = null;
      dragging = false;
      r.classList.remove('cam-dragging');
      try { r.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasClick) this.h.click(this.id);
    };
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', end);
    r.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.h.wheel(this.id, e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY);
    }, { passive: false });
  }

  private setText(key: string, el: HTMLElement, v: string): void {
    if (this.last[key] !== v) { this.last[key] = v; el.textContent = v; }
  }
  private setClass(cls: string, on: boolean): void {
    if (this.root.classList.contains(cls) !== on) this.root.classList.toggle(cls, on);
  }

  setRect(x: number, y: number, w: number, h: number, alpha: number, z: number): void {
    const key = `${x.toFixed(1)}|${y.toFixed(1)}|${w.toFixed(1)}|${h.toFixed(1)}|${z}`;
    if (key !== this.lastRect) {
      this.lastRect = key;
      const s = this.root.style;
      s.transform = `translate(${x}px, ${y}px)`;
      s.width = `${Math.max(0, w)}px`;
      s.height = `${Math.max(0, h)}px`;
      s.zIndex = String(z);
      s.display = w < 2 || h < 2 ? 'none' : '';
    }
    const lo = (alpha < 0.999 ? Math.max(0, (alpha - 0.35) / 0.65) : 1).toFixed(2);
    if (this.last.lo !== lo) { this.last.lo = lo; this.label.style.opacity = lo; }
  }

  update(s: LabelState): void {
    this.setText('name', this.nameEl, s.name);
    this.setText('speed', this.speedEl, s.speed);
    this.setText('alt', this.altEl, s.alt);
    this.setText('ph', this.phEl, s.phase);
    this.setText('cam', this.camEl, s.cam);
    this.setClass('cam-compact', s.compact);
    this.setClass('cam-single', s.single);
    this.setClass('cam-pip', s.pip);
    this.setClass('cam-can-max', s.canMax);
    this.setClass('cam-is-max', s.isMax);
    const fade = (1 - s.fade).toFixed(3);
    if (this.last.fade !== fade) { this.last.fade = fade; this.fade.style.opacity = fade; }
    const mk = s.modes.map((m) => m.mode).join(',');
    if (mk !== this.modesKey) {
      this.modesKey = mk;
      this.modesEl.textContent = '';
      this.buttons.clear();
      for (const m of s.modes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = m.label;
        b.title = `${m.label.toLowerCase()} camera`;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { e.stopPropagation(); this.h.mode(this.id, m.mode); });
        this.modesEl.appendChild(b);
        this.buttons.set(m.mode, b);
      }
      this.last.active = '';
    }
    if (this.last.active !== s.activeMode) {
      this.last.active = s.activeMode;
      for (const [m, b] of this.buttons) b.classList.toggle('on', m === s.activeMode);
    }
  }
}

export class Overlay {
  readonly layer: HTMLDivElement;
  private els = new Map<string, VpElement>();

  constructor(dom: HTMLElement, private h: OverlayHandlers) {
    this.layer = document.createElement('div');
    this.layer.className = 'camlayer';
    // insert right after the canvas so HUD/UI elements (appended later) stay on top
    const canvas = dom.querySelector('canvas');
    if (canvas && canvas.nextSibling) dom.insertBefore(this.layer, canvas.nextSibling);
    else dom.appendChild(this.layer);
  }

  get(id: string): VpElement {
    let e = this.els.get(id);
    if (!e) {
      e = new VpElement(id, this.h);
      this.els.set(id, e);
      this.layer.appendChild(e.root);
    }
    return e;
  }

  remove(id: string): void {
    const e = this.els.get(id);
    if (e) { e.root.remove(); this.els.delete(id); }
  }

  setLabelsHidden(hidden: boolean): void {
    if (this.layer.classList.contains('cam-hidden-labels') !== hidden) this.layer.classList.toggle('cam-hidden-labels', hidden);
  }
}
