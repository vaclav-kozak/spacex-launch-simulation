// Vehicle / pad / droneship visuals. OWNER: models.
//
// Public API used by App.ts: new VehicleVisuals(ctx); await load(); update(snap, dt);
// beforeViewRender(view, snap). Extras: object(id), padVisual, shipVisual, materials,
// LAUNCH_MOUNT_HEIGHT (re-exported from ./rig).
//
// Frames: every body group sits in ctx.worldRoot at its true W pose (floating origin handled by
// the app). Body frames follow core/vehicleSpec.ts (origin = nozzle exit / fairing base / payload
// base / deck centre; +Y toward the nose).
import * as THREE from 'three';
import type { AppContext, FrameModule, ViewInfo } from '../../core/context';
import { LAYER_DEFAULT } from '../../core/context';
import type { BodyId, SimSnapshot } from '../../core/types';
import { F9, OCISLY } from '../../core/vehicleSpec';
import { MODEL_URL, loadModel, setMaxAnisotropy } from './assets';
import { VehicleMaterials } from './materials';
import { DEFAULT_RIG, type F9Rig } from './rig';
import { BoosterVisual } from './booster';
import { SecondStageVisual } from './secondStage';
import { FairingHalfVisual } from './fairing';
import { PayloadVisual } from './payload';
import { DroneshipVisual } from './droneship';
import { PadVisual } from './pad';
import { lodBias, pickLod, projectedPx } from './lod';

export { LAUNCH_MOUNT_HEIGHT } from './rig';

const BODY_SIZE: Record<BodyId, number> = {
  S1: F9.s1.length,
  S2: F9.s2.length,
  FAIRING_A: F9.fairing.length,
  FAIRING_B: F9.fairing.length,
  PAYLOAD: 8,
  SHIP: OCISLY.hullLength,
};

export class VehicleVisuals implements FrameModule {
  readonly materials = new VehicleMaterials();
  private groups = new Map<BodyId, THREE.Object3D>();
  private s1: BoosterVisual | null = null;
  private s2: SecondStageVisual | null = null;
  private fairings: FairingHalfVisual[] = [];
  private payload: PayloadVisual | null = null;
  shipVisual: DroneshipVisual | null = null;
  padVisual: PadVisual | null = null;
  private rig: F9Rig = DEFAULT_RIG;
  private lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.35, 0.35, 0.34), transparent: true, opacity: 0.7 });

  constructor(private ctx: AppContext) {
    setMaxAnisotropy(ctx.renderer);
  }

  /** Scene object of a body (its pose is written every update). */
  object(id: BodyId): THREE.Object3D | undefined {
    return this.groups.get(id);
  }

  async load(): Promise<void> {
    const ctx = this.ctx;
    try {
      const r = await fetch(MODEL_URL('falcon9_rig.json'));
      if (r.ok) this.rig = { ...DEFAULT_RIG, ...(await r.json()) } as F9Rig;
    } catch {
      /* keep defaults */
    }
    const [f9] = await Promise.all([loadModel('falcon9.glb')]);
    if (f9) {
      const src = f9.scene;
      this.materials.apply(src);
      this.s1 = new BoosterVisual(src, this.rig);
      this.s2 = new SecondStageVisual(src);
      const pf = src.getObjectByName('PARAFOIL') ?? null;
      pf?.removeFromParent();
      if (pf) pf.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = false)));
      this.fairings = [new FairingHalfVisual(src, 'A', pf, this.lineMat), new FairingHalfVisual(src, 'B', pf, this.lineMat)];
      this.payload = new PayloadVisual(src, this.rig);
      this.groups.set('S1', this.s1.group);
      this.groups.set('S2', this.s2.group);
      this.groups.set('FAIRING_A', this.fairings[0].group);
      this.groups.set('FAIRING_B', this.fairings[1].group);
      this.groups.set('PAYLOAD', this.payload.group);
      for (const f of this.fairings) ctx.worldRoot.add(f.chute);
    } else {
      this.buildFallbackStack();
    }
    this.shipVisual = new DroneshipVisual(ctx, this.materials);
    this.padVisual = new PadVisual(ctx, this.materials);
    await Promise.all([this.shipVisual.load(), this.padVisual.load()]);
    this.groups.set('SHIP', this.shipVisual.group);
    ctx.worldRoot.add(this.padVisual.group);
    for (const g of this.groups.values()) {
      g.matrixAutoUpdate = true;
      ctx.worldRoot.add(g);
    }
    ctx.worldRoot.traverse((o) => {
      if (o.layers.mask === 0) o.layers.set(LAYER_DEFAULT);
    });
    this.materials.setSooty(ctx.settings.sootyBooster);
    ctx.events.on('SETTINGS_CHANGED', (e) => {
      if (!e.data || e.data.key === 'sootyBooster') this.materials.setSooty(this.ctx.settings.sootyBooster);
      if (!e.data || e.data.key === 'timeOfDay') this.padVisual?.setTimeOfDay(this.ctx.settings.timeOfDay);
    });
    this.padVisual.setTimeOfDay(ctx.settings.timeOfDay);
  }

  /** Primitive stand-ins if falcon9.glb failed to load (the app must stay usable). */
  private buildFallbackStack(): void {
    const white = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 });
    const mk = (id: BodyId, geo: THREE.BufferGeometry, y: number) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, white);
      m.position.y = y;
      g.add(m);
      this.groups.set(id, g);
    };
    mk('S1', new THREE.CylinderGeometry(F9.radius, F9.radius, F9.s1.length, 24), F9.s1.length / 2);
    mk('S2', new THREE.CylinderGeometry(F9.radius, F9.radius, F9.s2.length, 24), F9.s2.length / 2);
    mk('FAIRING_A', new THREE.CylinderGeometry(0.3, 2.6, F9.fairing.length, 24, 1, false, 0, Math.PI), F9.fairing.length / 2);
    mk('FAIRING_B', new THREE.CylinderGeometry(0.3, 2.6, F9.fairing.length, 24, 1, false, Math.PI, Math.PI), F9.fairing.length / 2);
    mk('PAYLOAD', new THREE.BoxGeometry(3.9, 7.5, 2.5), 4.5);
  }

  update(snap: SimSnapshot, _dt: number): void {
    const ctx = this.ctx;
    this.materials.setSooty(ctx.settings.sootyBooster);
    this.materials.setEnvMap(ctx.lighting.envMap, !!ctx.scene.environment);
    for (const [id, node] of this.groups) {
      const b = snap.bodies[id];
      if (!b) continue;
      node.visible = b.status !== 'gone';
      node.position.copy(b.pos);
      node.quaternion.copy(b.quat);
    }
    const b = snap.bodies;
    if (this.s1 && b.S1) {
      this.s1.update(b.S1);
      this.materials.setS1Heating(b.S1.heating);
    }
    if (this.s2 && b.S2) this.materials.setMvacGlow(this.s2.update(b.S2, snap));
    if (this.fairings.length) {
      this.fairings[0].update(b.FAIRING_A);
      this.fairings[1].update(b.FAIRING_B);
      this.materials.setFairingHeating(Math.max(b.FAIRING_A.heating, b.FAIRING_B.heating));
    }
    if (this.payload && b.PAYLOAD) {
      this.payload.update(b.PAYLOAD, snap);
      // hidden inside the closed fairing (saves ~22 draws) unless a half is off
      const enclosed = b.FAIRING_A.status === 'stacked' && b.FAIRING_B.status === 'stacked';
      this.payload.group.visible = b.PAYLOAD.status !== 'gone' && !enclosed;
    }
    this.shipVisual?.update(snap);
    this.padVisual?.update(snap);
  }

  beforeViewRender(view: ViewInfo, snap: SimSnapshot): void {
    const bias = lodBias(this.ctx.quality.level);
    for (const [id, node] of this.groups) {
      const b = snap.bodies[id];
      if (!b || b.status === 'gone') continue;
      const px = projectedPx(view, b.pos, BODY_SIZE[id]);
      const lod = pickLod(px, bias, id === 'SHIP' ? 500 : 260, id === 'SHIP' ? 60 : 40, 0.25);
      node.visible = lod >= 0;
      if (lod < 0) continue;
      if (id === 'S1') this.s1?.setLod(lod);
      else if (id === 'S2') this.s2?.setLod(lod);
      else if (id === 'FAIRING_A') this.fairings[0]?.setLod(lod);
      else if (id === 'FAIRING_B') this.fairings[1]?.setLod(lod);
      else if (id === 'SHIP') this.shipVisual?.setLod(lod);
      else if (id === 'PAYLOAD' && this.payload) node.visible = node.visible && lod <= 1 && this.payloadAllowed(snap);
    }
    this.padVisual?.beforeViewRender(view, bias);
  }

  private payloadAllowed(snap: SimSnapshot): boolean {
    const b = snap.bodies;
    return !(b.FAIRING_A.status === 'stacked' && b.FAIRING_B.status === 'stacked');
  }
}
