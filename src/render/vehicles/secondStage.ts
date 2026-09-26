// Falcon 9 second stage + MVac (gimbal, niobium extension glow). OWNER: models.
import * as THREE from 'three';
import type { BodyState, SimSnapshot } from '../../core/types';
import { F9 } from '../../core/vehicleSpec';

/** heating / cooling time constants of the radiatively cooled niobium extension (s) */
const TAU_HEAT = 11;
const TAU_COOL = 22;

export class SecondStageVisual {
  readonly group = new THREE.Group();
  private lods: { root: THREE.Object3D; mvac: THREE.Object3D | null }[] = [];
  private lod = -2;
  /** 0..1 extension temperature proxy */
  heat = 0;
  private lastT = NaN;

  constructor(src: THREE.Object3D) {
    this.group.name = 'S2';
    for (let l = 0; l < 3; l++) {
      const root = src.getObjectByName(`S2_L${l}`);
      if (!root) continue;
      root.removeFromParent();
      this.group.add(root);
      this.lods.push({ root, mvac: root.getObjectByName(`S2_L${l}_mvac`) ?? null });
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

  /**
   * Extension temperature from sim time when possible (seek-safe): heats while the MVac burns with
   * time constant TAU_HEAT, then cools after SECO (timeline marker) with TAU_COOL.
   */
  private computeHeat(b: BodyState, snap: SimSnapshot, dt: number): number {
    const e = b.engines[0];
    if (!e) return 0;
    const t = snap.t;
    if (e.on && Number.isFinite(e.ignitionT) && t >= e.ignitionT) {
      const tOn = t - e.ignitionT;
      const h = 1 - Math.exp(-tOn / TAU_HEAT);
      return h * (0.15 + 0.85 * Math.max(e.spool, e.throttle > 0 ? 1 : 0)) * (0.55 + 0.45 * Math.min(1, e.throttle / 0.8));
    }
    const seco = snap.timeline.find((m) => m.type === 'SECO' && m.done);
    if (seco && Number.isFinite(e.ignitionT) && e.ignitionT < seco.t && t >= seco.t) {
      const h0 = 1 - Math.exp(-(seco.t - e.ignitionT) / TAU_HEAT);
      return h0 * Math.exp(-(t - seco.t) / TAU_COOL);
    }
    // fallback: integrate cooling
    return this.heat * Math.exp(-Math.max(0, dt) / TAU_COOL);
  }

  update(b: BodyState, snap: SimSnapshot): number {
    const dt = Number.isFinite(this.lastT) ? snap.t - this.lastT : 0;
    this.lastT = snap.t;
    this.heat = this.computeHeat(b, snap, dt);
    const e = b.engines[0];
    for (const r of this.lods) if (r.mvac) r.mvac.rotation.set(e?.gimbalX ?? 0, 0, e?.gimbalZ ?? 0, 'ZXY');
    return this.heat;
  }
}
