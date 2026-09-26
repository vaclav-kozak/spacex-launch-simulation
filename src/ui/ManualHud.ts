// Manual landing HUD + input handling (throttle lever, gimbal). OWNER: ui.
//
// Input scheme (shown on screen):
//   W / S       throttle lever up / down (persistent, like a real throttle); X = cut to 0
//   ← → / A D   gimbal: translate the booster left / right on the deck map (yaw)
//   ↑ ↓         gimbal: translate toward bow / stern on the deck map (pitch)
// The lever starts at 0 (landing engine not lit). Anything above 0 asks the sim to ignite /
// throttle; the sim clamps to the Merlin's 40 % minimum when lit.

import { Quaternion, Vector3 } from 'three';
import type { AppActions } from '../app/App';
import type { SimSnapshot } from '../core/types';
import { OCISLY, F9, MERLIN_1D } from '../core/vehicleSpec';
import { Smoother, clamp, fmtFixed, fmtInt, h, s, setAttr, setText, toggleClass } from './util';

const MAP_RANGE = 55; // m, half-extent of the deck map
const _q = new Quaternion(), _v = new Vector3(), _w = new Vector3();

export class ManualHud {
  readonly panel: HTMLDivElement;
  private banner: HTMLDivElement;
  private active = false;
  private keys = new Set<string>();
  throttle = 0;
  private pitch = 0;
  private yaw = 0;

  private thrFill: HTMLDivElement;
  private thrAct: HTMLDivElement;
  private thrNum: HTMLSpanElement;
  private gimCmd: SVGCircleElement;
  private gimAct: SVGCircleElement;
  private mapBooster: SVGGElement;
  private mapImpact: SVGGElement;
  private mapVel: SVGLineElement;
  private rAlt: HTMLSpanElement;
  private rVs: HTMLSpanElement;
  private rHs: HTMLSpanElement;
  private rMiss: HTMLSpanElement;
  private rProp: HTMLSpanElement;
  private cue: HTMLDivElement;
  private warn: HTMLDivElement;
  private smAlt = new Smoother(0.08);
  private smVs = new Smoother(0.1);
  private smHs = new Smoother(0.1);

  constructor(private actions: AppActions) {
    this.banner = h('div', { class: 'mc-banner' },
      h('div', { class: 'mc-title', text: 'MANUAL CONTROL' }),
      h('div', { class: 'mc-keys' },
        h('span', {}, h('kbd', { text: 'W' }), h('kbd', { text: 'S' }), ' throttle'),
        h('span', {}, h('kbd', { text: '←' }), h('kbd', { text: '↑' }), h('kbd', { text: '↓' }), h('kbd', { text: '→' }), ' gimbal'),
        h('span', {}, h('kbd', { text: 'X' }), ' cut'),
        h('span', {}, h('kbd', { text: 'K' }), ' autopilot'),
      ));

    this.thrFill = h('div', { class: 'thr-fill' });
    this.thrAct = h('div', { class: 'thr-act' });
    this.thrNum = h('span', { class: 'thr-num' });
    const minLine = h('div', { class: 'thr-min', style: `bottom:${MERLIN_1D.minThrottle * 100}%` });
    const thr = h('div', { class: 'mc-thr' },
      h('div', { class: 'mc-lbl', text: 'THROTTLE' }),
      h('div', { class: 'thr-track' }, this.thrFill, this.thrAct, minLine),
      this.thrNum);

    this.gimCmd = s('circle', { r: 3.4, class: 'gim-cmd' });
    this.gimAct = s('circle', { r: 5.5, class: 'gim-act' });
    const gim = h('div', { class: 'mc-gim' },
      h('div', { class: 'mc-lbl', text: 'GIMBAL' }),
      s('svg', { viewBox: '-30 -30 60 60' },
        s('circle', { r: 27, class: 'gim-ring' }), s('circle', { r: 13.5, class: 'gim-ring2' }),
        s('line', { x1: -27, y1: 0, x2: 27, y2: 0, class: 'gim-x' }), s('line', { x1: 0, y1: -27, x2: 0, y2: 27, class: 'gim-x' }),
        this.gimAct, this.gimCmd));

    // deck map (ship frame, top-down: +X right, +Z (bow) up)
    const sc = 50 / MAP_RANGE;
    const dw = (OCISLY.deckWidth / 2) * sc, dl = (OCISLY.deckLength / 2) * sc, xr = OCISLY.xMarkRadius * sc;
    this.mapBooster = s('g', { class: 'map-b' }, s('circle', { r: 2.6 }), s('circle', { r: 5.5, class: 'map-b-ring' }));
    this.mapImpact = s('g', { class: 'map-i' }, s('path', { d: 'M-3.5 -3.5L3.5 3.5M3.5 -3.5L-3.5 3.5' }));
    this.mapVel = s('line', { class: 'map-v' });
    const map = h('div', { class: 'mc-map' },
      h('div', { class: 'mc-lbl', text: 'OCISLY DECK' }),
      s('svg', { viewBox: '-52 -52 104 104' },
        s('rect', { x: -dw, y: -dl, width: 2 * dw, height: 2 * dl, class: 'map-deck' }),
        s('circle', { r: xr, class: 'map-ring' }),
        s('path', { d: `M${-xr * 0.6} ${-xr * 0.6}L${xr * 0.6} ${xr * 0.6}M${xr * 0.6} ${-xr * 0.6}L${-xr * 0.6} ${xr * 0.6}`, class: 'map-x' }),
        s('path', { d: `M0 ${-dl - 6}l-3 4h6z`, class: 'map-bow' }),
        this.mapVel, this.mapImpact, this.mapBooster));

    const read = (label: string, unit: string) => {
      const v = h('span', { class: 'rd-v' });
      return [h('div', { class: 'rd' }, h('span', { class: 'rd-l', text: label }), v, h('span', { class: 'rd-u', text: unit })), v] as const;
    };
    const [eAlt, rAlt] = read('HEIGHT', 'm'), [eVs, rVs] = read('V-SPEED', 'm/s'), [eHs, rHs] = read('H-SPEED', 'm/s');
    const [eMiss, rMiss] = read('MISS', 'm'), [eProp, rProp] = read('PROP', '%');
    this.rAlt = rAlt; this.rVs = rVs; this.rHs = rHs; this.rMiss = rMiss; this.rProp = rProp;
    this.cue = h('div', { class: 'mc-cue' });
    this.warn = h('div', { class: 'mc-warn' });
    this.panel = h('div', { class: 'mc-panel' },
      this.banner,
      h('div', { class: 'mc-top' }, thr, gim, map),
      h('div', { class: 'mc-reads' }, eAlt, eVs, eHs, eMiss, eProp),
      this.cue, this.warn);
  }

  get isActive(): boolean { return this.active; }

  /** returns true if the key was consumed */
  key(e: KeyboardEvent, down: boolean): boolean {
    if (!this.active) return false;
    const k = e.code;
    const handled = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k);
    if (!handled) return false;
    if (down) {
      this.keys.add(k);
      if (k === 'KeyX') this.throttle = 0;
    } else this.keys.delete(k);
    return true;
  }

  releaseAll(): void { this.keys.clear(); }

  update(snap: SimSnapshot, enabled: boolean, dtReal: number): void {
    const s1 = snap.bodies.S1;
    const ph = s1.phase;
    const inFlight = s1.status === 'free' && (ph === 'AERO' || ph === 'LANDING_BURN' || ph === 'ENTRY_BURN');
    const act = enabled && inFlight && !snap.paused;
    const show = enabled && (inFlight || ph === 'LANDED');
    if (act !== this.active) {
      this.active = act;
      if (act) { this.throttle = s1.engines[0]?.on ? s1.engines[0].throttle : 0; this.pitch = this.yaw = 0; }
      else this.keys.clear();
    }
    toggleClass(this.banner, 'landed', ph === 'LANDED');
    toggleClass(this.panel, 'show', show);
    if (!show) return;

    // --- input integration (real time: the player reacts in wall-clock time) ---
    if (this.active) {
      const k = this.keys;
      const dt = Math.min(0.05, dtReal);
      if (k.has('KeyW')) this.throttle = clamp(this.throttle + 0.7 * dt, 0, 1);
      if (k.has('KeyS')) this.throttle = clamp(this.throttle - 0.7 * dt, 0, 1);
      const ty = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
      const tp = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
      const rate = 6 * dt;
      this.yaw += clamp(ty - this.yaw, -rate, rate);
      this.pitch += clamp(tp - this.pitch, -rate, rate);
      if (ph !== 'ENTRY_BURN') this.actions.setManualInput({ throttle: this.throttle, pitch: this.pitch, yaw: this.yaw });
    }

    // --- throttle ---
    const e0 = s1.engines[0];
    const actual = e0?.on ? e0.throttle : 0;
    this.thrFill.style.transform = `scaleY(${this.throttle.toFixed(3)})`;
    this.thrAct.style.bottom = `${(actual * 100).toFixed(1)}%`;
    setText(this.thrNum, `${Math.round(this.throttle * 100)}`);
    toggleClass(this.thrAct, 'lit', !!e0?.on);

    // --- gimbal ---
    setAttr(this.gimCmd, 'cx', (this.yaw * 24).toFixed(1));
    setAttr(this.gimCmd, 'cy', (-this.pitch * 24).toFixed(1));
    const lim = (MERLIN_1D.gimbalLimitDeg * Math.PI) / 180;
    setAttr(this.gimAct, 'cx', (clamp((e0?.gimbalZ ?? 0) / lim, -1, 1) * 24).toFixed(1));
    setAttr(this.gimAct, 'cy', (-clamp((e0?.gimbalX ?? 0) / lim, -1, 1) * 24).toFixed(1));

    // --- deck-relative geometry ---
    const ship = snap.bodies.SHIP;
    _q.copy(ship.quat).invert();
    const sc = 50 / MAP_RANGE;
    const toMap = (w: Vector3, out: Vector3) => out.copy(w).sub(ship.pos).applyQuaternion(_q);
    toMap(s1.pos, _v);
    const legs = s1.legs ?? 0;
    const height = _v.y + legs * F9.s1.leg.footY;
    const place = (g: SVGGElement, x: number, z: number) => {
      const cx = clamp(x * sc, -50, 50), cy = clamp(-z * sc, -50, 50);
      setAttr(g, 'transform', `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
      return [cx, cy];
    };
    const [bx, by] = place(this.mapBooster, _v.x, _v.z);
    _w.copy(s1.vel).applyQuaternion(_q);
    setAttr(this.mapVel, 'x1', bx.toFixed(1)); setAttr(this.mapVel, 'y1', by.toFixed(1));
    setAttr(this.mapVel, 'x2', (bx + _w.x * sc * 1.5).toFixed(1)); setAttr(this.mapVel, 'y2', (by - _w.z * sc * 1.5).toFixed(1));
    const L = snap.landing;
    let miss = NaN;
    if (L) {
      toMap(L.impactPoint, _w);
      place(this.mapImpact, _w.x, _w.z);
      miss = L.missDistance;
    } else {
      miss = Math.hypot(_v.x, _v.z);
      place(this.mapImpact, _v.x, _v.z);
    }
    const hs = Math.hypot(_w.set(s1.vel.x, s1.vel.y, s1.vel.z).applyQuaternion(_q).x, _w.z);
    setText(this.rAlt, fmtInt(Math.max(0, this.smAlt.update(height, dtReal))));
    setText(this.rVs, fmtFixed(this.smVs.update(s1.verticalSpeed, dtReal), 1));
    setText(this.rHs, fmtFixed(this.smHs.update(hs, dtReal), 1));
    setText(this.rMiss, Number.isFinite(miss) ? fmtFixed(miss, miss < 100 ? 1 : 0) : '–');
    const prop = s1.propCapacity > 0 ? (100 * s1.propMass) / s1.propCapacity : 0;
    setText(this.rProp, fmtFixed(prop, 1));
    toggleClass(this.rMiss.parentElement!, 'bad', miss > OCISLY.xMarkRadius * 1.5);
    toggleClass(this.rProp.parentElement!, 'bad', prop < 1.5);
    toggleClass(this.rVs.parentElement!, 'bad', height < 40 && s1.verticalSpeed < -8);

    // --- cue ---
    let cue = '';
    if (ph === 'LANDED') cue = s1.status === 'landed' ? 'TOUCHDOWN' : 'TOUCHDOWN · CHECK VEHICLE';
    else if (ph === 'ENTRY_BURN') cue = 'ENTRY BURN IN PROGRESS · STAND BY';
    else if (!e0?.on && L && Number.isFinite(L.burnStartT)) {
      const dt = L.burnStartT - snap.t;
      cue = dt > 0 ? `IGNITION IN ${fmtFixed(dt, 1)} s · PRESS W` : 'IGNITE NOW · PRESS W';
    } else if (!e0?.on) cue = 'ENGINE OFF · W TO IGNITE';
    else if (L && Number.isFinite(L.touchdownT)) cue = `TOUCHDOWN IN ${fmtFixed(Math.max(0, L.touchdownT - snap.t), 1)} s`;
    setText(this.cue, cue);
    const w: string[] = [];
    if (prop < 1.5 && ph !== 'LANDED') w.push('LOW PROPELLANT');
    if (height < 40 && s1.verticalSpeed < -8 && ph !== 'LANDED') w.push('SINK RATE');
    if (Number.isFinite(miss) && miss > OCISLY.deckWidth / 2 && ph !== 'LANDED') w.push('OFF DECK');
    setText(this.warn, w.join('  '));
    toggleClass(this.warn, 'show', w.length > 0);
  }
}
