// Manual landing HUD + input handling (throttle lever, fly-by-wire steering). OWNER: ui.
//
// Input scheme (shown on screen), semantics per docs/notes/sim.md "Manual landing":
//   W / S       throttle lever up / down (persistent, 0.7/s); X = cut to 0 (engine off)
//               lever 0 = off, > 0 = lit at max(40 %, lever); at most 3 starts (TEA-TEB)
//   ← → / A D   steer toward ship −X / +X (right on the deck map)
//   ↑ ↓         steer toward the bow / stern (up / down on the deck map)
// The sim flies the attitude: AERO → lateral acceleration from body/grid-fin lift; landing burn
// high → up to 14° extra thrust tilt; below ~150 m → velocity command (8 m/s full stick,
// neutral = hold station over the deck).

import { Quaternion, Vector3 } from 'three';
import type { AppActions } from '../app/App';
import type { SimSnapshot } from '../core/types';
import { OCISLY, F9, MERLIN_1D } from '../core/vehicleSpec';
import { Smoother, clamp, fmtFixed, fmtInt, h, s, setAttr, setText, toggleClass } from './util';

/** deck-map half-extents (m): auto-ranges so the predicted impact point stays on the map */
const MAP_RANGES = [55, 150, 400, 1000, 2500, 6000, 15000];
const LEAN_FULL = Math.tan((20 * Math.PI) / 180); // steering ring edge = 20° lean
const G = 9.81;
/** Merlin 1D nozzle exit area implied by the SL / vac thrust pair (same as the sim) */
const EXIT_AREA = (MERLIN_1D.thrustVac - MERLIN_1D.thrustSL) / 101_325;
const MAX_STARTS = 3; // sim: the landing engine can be started at most 3 times (TEA-TEB)
const _q = new Quaternion(), _v = new Vector3(), _w = new Vector3(), _ax = new Vector3();

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
  private thrReq: HTMLDivElement;
  private mapRange = MAP_RANGES[0];
  private prevT = NaN;
  private prevVs = 0;
  private aDrag = 0;
  private starts = 0;
  private wasLit = false;
  private mapLbl: HTMLDivElement;
  private mapDeckG: SVGGElement;
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
        h('span', {}, h('kbd', { text: '←' }), h('kbd', { text: '↑' }), h('kbd', { text: '↓' }), h('kbd', { text: '→' }), ' steer'),
        h('span', {}, h('kbd', { text: 'X' }), ' cut'),
        h('span', {}, h('kbd', { text: 'K' }), ' autopilot'),
      ));

    this.thrFill = h('div', { class: 'thr-fill' });
    this.thrAct = h('div', { class: 'thr-act', title: 'Actual engine throttle' });
    this.thrReq = h('div', { class: 'thr-req', title: 'Throttle needed to stop at the deck (constant deceleration)' }, h('span', { text: 'REQ' }));
    this.thrNum = h('span', { class: 'thr-num' });
    const minLine = h('div', { class: 'thr-min', style: `bottom:${MERLIN_1D.minThrottle * 100}%` });
    const thr = h('div', { class: 'mc-thr' },
      h('div', { class: 'mc-lbl', text: 'THROTTLE' }),
      h('div', { class: 'thr-track' }, this.thrFill, this.thrAct, this.thrReq, minLine),
      this.thrNum);

    this.gimCmd = s('circle', { r: 3.4, class: 'gim-cmd' });
    this.gimAct = s('circle', { r: 5.5, class: 'gim-act' });
    const gim = h('div', { class: 'mc-gim' },
      h('div', { class: 'mc-lbl', text: 'STEER · LEAN' }),
      s('svg', { viewBox: '-30 -30 60 60' },
        s('circle', { r: 27, class: 'gim-ring' }), s('circle', { r: 13.5, class: 'gim-ring2' }),
        s('line', { x1: -27, y1: 0, x2: 27, y2: 0, class: 'gim-x' }), s('line', { x1: 0, y1: -27, x2: 0, y2: 27, class: 'gim-x' }),
        this.gimAct, this.gimCmd));

    // deck map (ship frame, top-down: +X right, +Z (bow) up); drawn at the 55 m range, the group
    // is scaled down when the map zooms out
    const sc = 50 / MAP_RANGES[0];
    const dw = (OCISLY.deckWidth / 2) * sc, dl = (OCISLY.deckLength / 2) * sc, xr = OCISLY.xMarkRadius * sc;
    this.mapBooster = s('g', { class: 'map-b' }, s('circle', { r: 2.6 }), s('circle', { r: 5.5, class: 'map-b-ring' }));
    this.mapImpact = s('g', { class: 'map-i' }, s('path', { d: 'M-3.5 -3.5L3.5 3.5M3.5 -3.5L-3.5 3.5' }));
    this.mapVel = s('line', { class: 'map-v' });
    this.mapDeckG = s('g', { class: 'map-deck-g' },
      s('rect', { x: -dw, y: -dl, width: 2 * dw, height: 2 * dl, class: 'map-deck' }),
      s('circle', { r: xr, class: 'map-ring' }),
      s('path', { d: `M${-xr * 0.6} ${-xr * 0.6}L${xr * 0.6} ${xr * 0.6}M${xr * 0.6} ${-xr * 0.6}L${-xr * 0.6} ${xr * 0.6}`, class: 'map-x' }),
      s('path', { d: `M0 ${-dl - 6}l-3 4h6z`, class: 'map-bow' }));
    this.mapLbl = h('div', { class: 'mc-lbl', text: 'OCISLY DECK' });
    const map = h('div', { class: 'mc-map' },
      this.mapLbl,
      s('svg', { viewBox: '-52 -52 104 104' },
        s('rect', { x: -50, y: -50, width: 100, height: 100, class: 'map-frame' }),
        this.mapDeckG, this.mapVel, this.mapImpact, this.mapBooster));

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
      if (act) {
        this.throttle = s1.engines[0]?.on ? s1.engines[0].throttle : 0; this.pitch = this.yaw = 0;
        this.wasLit = !!s1.engines[0]?.on; this.starts = ph === 'LANDING_BURN' ? 1 : 0;
      }
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

    const e0 = s1.engines[0];
    const lit = !!e0?.on;
    if (lit && !this.wasLit && (ph === 'LANDING_BURN' || ph === 'AERO')) this.starts++;
    this.wasLit = lit;
    const ship = snap.bodies.SHIP;
    _q.copy(ship.quat).invert();
    const toMap = (w: Vector3, out: Vector3) => out.copy(w).sub(ship.pos).applyQuaternion(_q);
    toMap(s1.pos, _v);
    const legs = s1.legs ?? 0;
    // height of the lowest point above the deck (above the sea when well off the ship, as the sim does)
    const offShip = Math.abs(_v.x) > OCISLY.deckWidth / 2 + 25 || Math.abs(_v.z) > OCISLY.deckLength / 2 + 25;
    const height = _v.y + legs * F9.s1.leg.footY - (offShip ? 0 : OCISLY.deckHeight);
    const bxW = _v.x, bzW = _v.z;

    // --- throttle: lever, actual, and the throttle needed to stop at the deck ---
    const actual = lit ? e0.throttle : 0;
    this.thrFill.style.transform = `scaleY(${this.throttle.toFixed(3)})`;
    this.thrAct.style.bottom = `${(actual * 100).toFixed(1)}%`;
    setText(this.thrNum, `${Math.round(this.throttle * 100)}`);
    toggleClass(this.thrAct, 'lit', lit);
    const vDown = -(s1.verticalSpeed - ship.verticalSpeed);
    // drag deceleration from the measured vertical acceleration minus gravity and thrust; drag ∝ v²
    // falls off during a constant-deceleration stop, so on average ~half of it helps
    const dts = snap.t - this.prevT;
    if (dts > 0.02 && dts < 1) {
      const aVert = (s1.verticalSpeed - this.prevVs) / dts;
      _ax.set(0, 1, 0).applyQuaternion(s1.quat).applyQuaternion(_q);
      const aThrust = (s1.thrust ?? 0) / Math.max(1, s1.mass) * _ax.y;
      this.aDrag += (clamp(aVert + G - aThrust, 0, 60) - this.aDrag) * Math.min(1, dts / 0.4);
    } else if (!(dts >= 0 && dts <= 0.02)) this.aDrag = 0; // first frame, seek or a long gap
    if (!(dts >= 0 && dts <= 0.02)) { this.prevT = snap.t; this.prevVs = s1.verticalSpeed; }
    let req = NaN, tStop = NaN;
    if (vDown > 1 && height > 0.5 && ph !== 'LANDED') {
      const aNeed = (vDown * vDown) / (2 * Math.max(1, height)) + G - 0.5 * this.aDrag;
      _ax.set(0, 1, 0).applyQuaternion(s1.quat).applyQuaternion(_q); // thrust axis in the deck frame
      // Merlin thrust at throttle x: x·F_vac − p·A_exit  →  x = (F_needed + p·A_exit) / F_vac
      const fNeed = (s1.mass * Math.max(0, aNeed)) / Math.max(0.5, _ax.y);
      req = (fNeed + (s1.ambientPressure ?? 101_325) * EXIT_AREA) / MERLIN_1D.thrustVac;
      tStop = (2 * height) / vDown;
    }
    // burn time left at the current (or required) throttle vs. time to stop → propellant warning
    const mdotFull = MERLIN_1D.thrustVac / (MERLIN_1D.ispVac * 9.80665);
    const thrUse = clamp(lit ? Math.max(actual, req || 0) : req || 0.8, MERLIN_1D.minThrottle, 1);
    const burnLeft = s1.propMass / (mdotFull * thrUse);
    const showReq = Number.isFinite(req) && height < 8_000 && (lit || req > 0.3);
    toggleClass(this.thrReq, 'show', showReq);
    if (showReq) {
      this.thrReq.style.bottom = `${(clamp(req, 0, 1.06) * 100).toFixed(1)}%`;
      toggleClass(this.thrReq, 'over', req > 1);
    }

    // --- steering: stick (amber) vs. the booster's lean in the deck frame (white ring, burn only).
    // The sim flies the attitude (fly-by-wire): high up the stick adds up to 14° of thrust tilt to
    // the drift-cancelling lean, low down it commands up to 8 m/s of drift over the deck.
    setAttr(this.gimCmd, 'cx', (this.yaw * 24).toFixed(1));
    setAttr(this.gimCmd, 'cy', (-this.pitch * 24).toFixed(1));
    _ax.set(0, 1, 0).applyQuaternion(s1.quat).applyQuaternion(_q);
    const lx = _ax.x / Math.max(0.2, _ax.y), lz = _ax.z / Math.max(0.2, _ax.y);
    setAttr(this.gimAct, 'cx', (clamp(lx / LEAN_FULL, -1.1, 1.1) * 24).toFixed(1));
    setAttr(this.gimAct, 'cy', (-clamp(lz / LEAN_FULL, -1.1, 1.1) * 24).toFixed(1));
    toggleClass(this.gimAct, 'hide', !lit || ph !== 'LANDING_BURN');

    // --- deck map (auto-ranging) ---
    const L = snap.landing;
    let miss = NaN, ix = bxW, iz = bzW;
    if (L && L.valid !== false) {
      toMap(L.impactPoint, _w);
      ix = _w.x; iz = _w.z;
      miss = L.missDistance;
    } else miss = Math.hypot(bxW, bzW);
    const extent = Math.max(Math.hypot(ix, iz), Math.min(Math.hypot(bxW, bzW), 20_000), 20);
    let R = this.mapRange;
    if (extent > 0.9 * R || extent < 0.4 * R) R = MAP_RANGES.find((r) => extent <= 0.75 * r) ?? MAP_RANGES[MAP_RANGES.length - 1];
    if (R !== this.mapRange) {
      this.mapRange = R;
      const k = Math.max(0.09, MAP_RANGES[0] / R);
      setAttr(this.mapDeckG, 'transform', `scale(${k.toFixed(4)})`);
      setText(this.mapLbl, R === MAP_RANGES[0] ? 'OCISLY DECK' : `OCISLY  ·  ±${R >= 1000 ? `${R / 1000} km` : `${R} m`}`);
    }
    const sc = 50 / R;
    const place = (g: SVGGElement, x: number, z: number) => {
      const cx = clamp(x * sc, -50, 50), cy = clamp(-z * sc, -50, 50);
      setAttr(g, 'transform', `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
      return [cx, cy];
    };
    const [bx, by] = place(this.mapBooster, bxW, bzW);
    place(this.mapImpact, ix, iz);
    _w.copy(s1.vel).sub(ship.vel).applyQuaternion(_q);
    const horizon = Math.min(20, (1.5 * R) / MAP_RANGES[0]);
    setAttr(this.mapVel, 'x1', bx.toFixed(1)); setAttr(this.mapVel, 'y1', by.toFixed(1));
    setAttr(this.mapVel, 'x2', (bx + _w.x * sc * horizon).toFixed(1)); setAttr(this.mapVel, 'y2', (by - _w.z * sc * horizon).toFixed(1));
    const hs = Math.hypot(_w.x, _w.z); // deck-relative horizontal speed
    setText(this.rAlt, fmtInt(Math.max(0, this.smAlt.update(height, dtReal))));
    setText(this.rVs, fmtFixed(this.smVs.update(s1.verticalSpeed, dtReal), 1));
    setText(this.rHs, fmtFixed(this.smHs.update(hs, dtReal), 1));
    setText(this.rMiss, Number.isFinite(miss) ? fmtFixed(miss, miss < 100 ? 1 : 0) : '–');
    const prop = s1.propCapacity > 0 ? (100 * s1.propMass) / s1.propCapacity : 0;
    setText(this.rProp, fmtFixed(prop, 1));
    toggleClass(this.rMiss.parentElement!, 'bad', miss > OCISLY.xMarkRadius * 1.5);
    toggleClass(this.rProp.parentElement!, 'bad', ph !== 'LANDED' && (s1.propMass < 150 || (lit && Number.isFinite(tStop) && burnLeft < 1.05 * tStop)));
    toggleClass(this.rVs.parentElement!, 'bad', height < 40 && s1.verticalSpeed < -8);

    // --- cue ---
    let cue = '';
    if (ph === 'LANDED') cue = s1.status === 'landed' ? 'TOUCHDOWN' : s1.status === 'tipped' ? 'TOUCHDOWN · VEHICLE TIPPED OVER' : 'TOUCHDOWN · VEHICLE LOST';
    else if (ph === 'ENTRY_BURN') cue = 'ENTRY BURN IN PROGRESS · STAND BY';
    else if (!lit && s1.propMass <= 1) cue = 'FLAMEOUT · NO PROPELLANT';
    else if (!lit && this.starts >= MAX_STARTS) cue = 'ENGINE OFF · NO RELIGHTS LEFT';
    else if (!lit && this.starts > 0) {
      const left = MAX_STARTS - this.starts;
      cue = `${showReq && req > 0.7 ? 'RELIGHT NOW' : 'ENGINE OFF'} · W TO RELIGHT (${left} LEFT)`;
    } else if (lit && vDown < -1.5 && height > 3) cue = 'CLIMBING · THROTTLE DOWN OR X TO CUT';
    else if (!lit && L && Number.isFinite(L.burnStartT) && L.burnStartT > snap.t - 30) {
      const dt = L.burnStartT - snap.t;
      cue = dt > 0.05 ? `IGNITION IN ${fmtFixed(dt, 1)} s · PRESS W`
        : showReq && req > 1 ? 'LATE · IGNITE NOW, FULL THROTTLE' : 'IGNITE NOW · PRESS W';
    } else if (!lit) cue = showReq && req > 0.75 ? 'IGNITE NOW · PRESS W' : 'ENGINE OFF · W TO IGNITE';
    else if (showReq) {
      const r = Math.round(req * 100);
      cue = req > 1 ? 'SINK RATE · FULL THROTTLE' : this.throttle + 0.04 < req ? `THROTTLE UP · NEED ${r} %`
        : req < MERLIN_1D.minThrottle - 0.05 ? `NEED ${r} % · BELOW MINIMUM` : `NEED ${r} %`;
      if (L && Number.isFinite(L.touchdownT) && L.touchdownT > snap.t) cue += `  ·  TOUCHDOWN ${fmtFixed(L.touchdownT - snap.t, 1)} s`;
    } else if (L && Number.isFinite(L.touchdownT)) cue = `TOUCHDOWN IN ${fmtFixed(Math.max(0, L.touchdownT - snap.t), 1)} s`;
    setText(this.cue, cue);
    const w: string[] = [];
    const lowProp = ph !== 'LANDED' && ph !== 'ENTRY_BURN' && (s1.propMass < 150 || (lit && Number.isFinite(tStop) && burnLeft < 1.05 * tStop));
    if (lowProp) w.push('LOW PROPELLANT');
    if (height < 40 && s1.verticalSpeed < -8 && ph !== 'LANDED') w.push('SINK RATE');
    if (Number.isFinite(miss) && miss > OCISLY.deckWidth / 2 && ph !== 'LANDED') w.push('OFF DECK');
    setText(this.warn, w.join('  '));
    toggleClass(this.warn, 'show', w.length > 0);
  }
}
