// Wind model: surface wind (settings, at 10 m) with a marine power-law boundary layer, veering
// toward a westerly jet stream peaking near 12 km, weak stratospheric winds, plus deterministic
// Dryden-like gust turbulence (first-order shaping filters driven by a seeded RNG, advanced once
// per fixed sim step so results are frame-rate independent).

import { Vector3 } from 'three';
import { EARTH_RADIUS } from '../core/constants';
import { EARTH_OMEGA_W } from '../core/frames';
import { Rng } from './rng';

const D2R = Math.PI / 180;
const POLE = EARTH_OMEGA_W.clone().normalize();

/** Local east / north / up at a W position (allocation-free). */
export function localENU(p: Vector3, east: Vector3, north: Vector3, up: Vector3): void {
  up.set(p.x, p.y + EARTH_RADIUS, p.z).normalize();
  east.crossVectors(POLE, up);
  const l = east.length();
  if (l < 1e-9) east.set(1, 0, 0);
  else east.multiplyScalar(1 / l);
  north.crossVectors(up, east);
}

export interface GustState {
  e: number;
  n: number;
  u: number;
  rng: Rng;
}

export class WindModel {
  speed10 = 0;
  fromDeg = 0;
  /** direction the jet stream blows from (deg) */
  jetFromDeg = 285;
  enabled = true;
  private east = new Vector3();
  private north = new Vector3();
  private up = new Vector3();
  private seed: number;

  constructor(speed10: number, fromDeg: number, seed = 20260927) {
    this.seed = seed;
    this.set(speed10, fromDeg);
  }

  set(speed10: number, fromDeg: number): void {
    this.speed10 = Math.max(0, speed10);
    this.fromDeg = fromDeg;
  }

  makeGust(salt: number): GustState {
    return { e: 0, n: 0, u: 0, rng: new Rng(this.seed ^ Math.imul(salt + 1, 0x9e3779b1)) };
  }

  /** Mean horizontal wind (east, north) at geometric altitude h (m). */
  meanEN(h: number, out: { e: number; n: number }): void {
    if (!this.enabled) {
      out.e = 0; out.n = 0;
      return;
    }
    const V10 = this.speed10;
    const hh = Math.max(1, h);
    // marine boundary layer (power law, alpha ≈ 0.12), tapering out above ~2 km
    let vs = V10 * Math.pow(Math.min(hh, 1500) / 10, 0.12);
    if (h > 2000) vs *= Math.exp(-(h - 2000) / 5000);
    // Ekman-like veer of the surface wind with height (up to +25° by 1.5 km)
    const veer = 25 * Math.min(1, hh / 1500);
    const toS = (this.fromDeg + veer + 180) * D2R;
    // jet stream: Gaussian peak at 12 km, strength grows with the surface wind (synoptic scale)
    const jetMax = 16 + 1.3 * V10;
    const dj = (h - 12_000) / 4_500;
    let vj = jetMax * Math.exp(-dj * dj);
    // weak stratospheric easterlies 25–70 km (summer)
    const strat = h > 20_000 && h < 80_000 ? 6 * Math.sin(Math.PI * Math.min(1, (h - 20_000) / 60_000)) : 0;
    // blend the jet up from the boundary layer
    if (h < 3000) vj *= Math.max(0, h / 3000);
    const toJ = (this.jetFromDeg + 180) * D2R;
    const toStrat = (90 + 180) * D2R;
    out.e = vs * Math.sin(toS) + vj * Math.sin(toJ) + strat * Math.sin(toStrat);
    out.n = vs * Math.cos(toS) + vj * Math.cos(toJ) + strat * Math.cos(toStrat);
  }

  private _en = { e: 0, n: 0 };

  /**
   * Wind vector (W, m/s, direction the air moves) at W position p / altitude h, advancing the
   * body's gust filter by dt at airspeed V.
   */
  sample(p: Vector3, h: number, V: number, dt: number, gust: GustState | null, out: Vector3): Vector3 {
    if (!this.enabled || h > 100_000) return out.set(0, 0, 0);
    localENU(p, this.east, this.north, this.up);
    this.meanEN(h, this._en);
    let ge = 0, gn = 0, gu = 0;
    if (gust && dt > 0) {
      this.stepGust(gust, h, V, dt);
      ge = gust.e; gn = gust.n; gu = gust.u;
    }
    const e = this._en.e + ge, n = this._en.n + gn;
    return out
      .copy(this.east).multiplyScalar(e)
      .addScaledVector(this.north, n)
      .addScaledVector(this.up, gu);
  }

  /** Dryden-like first-order shaping (MIL-F-8785C low-altitude model blended to a jet-level CAT floor). */
  stepGust(g: GustState, h: number, V: number, dt: number): void {
    const hh = Math.max(5, h);
    const W20 = this.speed10 * 0.94;
    const hf = hh * 3.28084; // ft
    let sw = 0.1 * W20;
    let su = sw / Math.pow(0.177 + 0.000823 * Math.min(hf, 1000), 0.4);
    let Lu = Math.min(533, (hh / Math.pow(0.177 + 0.000823 * Math.min(hf, 1000), 1.2)));
    let Lw = Math.min(533, hh);
    // medium/high altitude background turbulence, stronger near the jet
    const jet = 1 + 1.4 * Math.exp(-Math.pow((h - 11_000) / 3000, 2));
    let shi = (0.5 + 0.06 * this.speed10) * jet;
    if (h > 18_000) shi *= Math.exp(-(h - 18_000) / 8000);
    if (h > 300) {
      const b = Math.min(1, (h - 300) / 700);
      su = su * (1 - b) + shi * b;
      sw = sw * (1 - b) + shi * 0.8 * b;
      Lu = Lu * (1 - b) + 533 * b;
      Lw = Lw * (1 - b) + 533 * b;
    }
    const Ve = Math.max(3, V);
    const ku = Math.exp((-Ve * dt) / Math.max(10, Lu));
    const kw = Math.exp((-Ve * dt) / Math.max(5, Lw));
    const nu = Math.sqrt(Math.max(0, 1 - ku * ku));
    const nw = Math.sqrt(Math.max(0, 1 - kw * kw));
    g.e = ku * g.e + su * nu * g.rng.gauss();
    g.n = ku * g.n + su * nu * g.rng.gauss();
    g.u = kw * g.u + sw * nw * g.rng.gauss();
  }
}
