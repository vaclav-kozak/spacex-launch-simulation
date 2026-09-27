// Falcon 9 second stage + MVac (gimbal, niobium extension glow). OWNER: models.
import * as THREE from 'three';
import type { BodyState, SimSnapshot } from '../../core/types';
import { F9 } from '../../core/vehicleSpec';
import { MVAC_T } from './materials';

/**
 * Thermal model of the radiatively cooled niobium extension (hottest band, K). Seek-safe: a pure
 * function of mission time, the MVac ignition time and the SECO marker.
 *  - burn: first-order approach to the steady state (tau 7 s -> dull red after ~6 s, orange by ~15 s,
 *    full by ~30 s); the steady state scales with throttle^0.25 (T ~ q^1/4, q ~ chamber pressure)
 *  - after cutoff: thin radiating sheet, dT/dt = -a T^4  =>  T = (T0^-3 + 3 a t)^(-1/3)
 *    (1480 K -> ~1000 K in 12 s, below visible ~800 K after ~30 s)
 */
const TAU_HEAT = 7;
const RAD_A = 2.0e-11;

function heatUp(tOn: number, thr: number): number {
  const Tss = MVAC_T.hot * Math.pow(Math.max(0.3, Math.min(1, thr)), 0.25);
  return Tss - (Tss - MVAC_T.amb) * Math.exp(-Math.max(0, tOn) / TAU_HEAT);
}

function coolDown(T0: number, t: number): number {
  if (t <= 0) return T0;
  return Math.max(MVAC_T.amb, Math.pow(Math.pow(T0, -3) + 3 * RAD_A * t, -1 / 3));
}

export class SecondStageVisual {
  readonly group = new THREE.Group();
  private lods: { root: THREE.Object3D; mvac: THREE.Object3D | null }[] = [];
  private lod = -2;
  /** hottest-band temperature of the extension (K) */
  temp = MVAC_T.amb;
  /** live cutoff bookkeeping when no SECO marker exists (e.g. flameout / manual shutdown) */
  private offT = NaN;
  private offTemp = MVAC_T.amb;

  constructor(src: THREE.Object3D) {
    this.group.name = 'S2';
    for (let l = 0; l < 3; l++) {
      const root = src.getObjectByName(`S2_L${l}`);
      if (!root) continue;
      root.removeFromParent();
      this.group.add(root);
      const mvac = root.getObjectByName(`S2_L${l}_mvac`) ?? null;
      if (mvac) fixExtensionUVs(mvac);
      this.lods.push({ root, mvac });
    }
    // dispenser stays on S2 after deploy
    const disp = src.getObjectByName('SL_DISPENSER');
    if (disp) {
      disp.removeFromParent();
      disp.position.set(0, F9.payload.baseY, 0);
      this.group.add(disp);
    }
    this.setLod(0);
  }

  setLod(l: number): void {
    if (l === this.lod) return;
    this.lod = l;
    this.lods.forEach((r, i) => (r.root.visible = i === l));
  }

  private computeTemp(b: BodyState, snap: SimSnapshot): number {
    const e = b.engines[0];
    if (!e || b.status === 'stacked' || !Number.isFinite(e.ignitionT)) return MVAC_T.amb;
    const t = snap.t;
    if (t < e.ignitionT) return MVAC_T.amb;
    const thr = e.throttle > 0 ? e.throttle : 1;
    if (e.on && e.spool > 0.05) {
      this.offT = NaN;
      return heatUp(t - e.ignitionT, thr);
    }
    const seco = snap.timeline.find((m) => m.type === 'SECO' && m.done);
    if (seco && seco.t > e.ignitionT && t >= seco.t) {
      return coolDown(heatUp(seco.t - e.ignitionT, 1), t - seco.t);
    }
    // engine off without a SECO marker (flameout, RUD, manual): cool from the last live value
    if (!Number.isFinite(this.offT) || this.offT > t) { this.offT = t; this.offTemp = this.temp; }
    return coolDown(this.offTemp, t - this.offT);
  }

  /** Updates the gimbal and returns the extension's hottest-band temperature (K). */
  update(b: BodyState, snap: SimSnapshot): number {
    this.temp = this.computeTemp(b, snap);
    const e = b.engines[0];
    for (const r of this.lods) if (r.mvac) r.mvac.rotation.set(e?.gimbalX ?? 0, 0, e?.gimbalZ ?? 0, 'ZXY');
    return this.temp;
  }
}

/**
 * The glow ramp is indexed by v = 0 at the regen joint .. 1 at the exit. The GLB's lathe strips use an
 * arc-length v and the exit-lip ring has planar UVs; re-derive v from height for every extension mesh
 * so the lip samples the (coolest) exit end. u stays the GLB's (around the bell) for the streak maps.
 */
function fixExtensionUVs(mvac: THREE.Object3D): void {
  mvac.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (Array.isArray(m.material) ? m.material[0] : m.material)?.name ?? '';
    if (!name.startsWith('MVac_Ext')) return;
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const hasU = !!uv && uv.itemSize === 2;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // extension spans 0..MVAC_EXT_L (2.4 m) above the exit plane; the joint is the top of this mesh
    const span = Math.max(1e-3, y1 - y0);
    const out = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      // keep the lathe's around-the-bell u (seam vertices are duplicated in the strip UVs) so the surface
      // maps stay 2D; a constant u collapsed any 2D map into horizontal rings
      out[i * 2] = hasU ? uv!.getX(i) : 0.5 + Math.atan2(pos.getZ(i), pos.getX(i)) / (2 * Math.PI);
      out[i * 2 + 1] = Math.max(0, Math.min(1, (y1 - pos.getY(i)) / span));
    }
    g.setAttribute('uv', new THREE.BufferAttribute(out, 2));
  });
}
