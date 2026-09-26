// Starlink stack (InstancedMesh) + deterministic post-deploy drift. OWNER: models.
import * as THREE from 'three';
import type { BodyState, SimSnapshot } from '../../core/types';
import type { F9Rig } from './rig';

function hash(i: number, k: number): number {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface SatMotion {
  p0: THREE.Vector3;
  v: THREE.Vector3;
  axis: THREE.Vector3;
  w: number;
}

export class PayloadVisual {
  readonly group = new THREE.Group();
  private sats: THREE.InstancedMesh[] = [];
  private rods: THREE.Object3D[] = [];
  private motion: SatMotion[] = [];
  private rodMotion: SatMotion[] = [];
  private deployT: number | null = null;
  private lastDrift = -1;
  readonly count: number;

  constructor(src: THREE.Object3D, rig: F9Rig) {
    this.group.name = 'PAYLOAD';
    const sl = rig.starlink;
    this.count = sl.count;
    const sat = src.getObjectByName('SL_SAT');
    const meshes: THREE.Mesh[] = [];
    sat?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const m of meshes) {
      const im = new THREE.InstancedMesh(m.geometry, m.material, sl.count);
      im.name = 'SL_SAT_inst';
      im.castShadow = im.receiveShadow = true;
      im.frustumCulled = false;
      this.sats.push(im);
      this.group.add(im);
    }
    for (let i = 0; i < sl.count; i++) {
      const y = sl.first + i * sl.pitch;
      // separation: slow radial spread + along-stack spread (stack spins slowly at release),
      // small random tumble. Speeds ~1..6 cm/s like real deployments.
      const a = hash(i, 1) * Math.PI * 2;
      const vr = 0.012 + 0.03 * hash(i, 2);
      const va = (i - sl.count / 2) * 0.0035 + (hash(i, 3) - 0.5) * 0.01;
      this.motion.push({
        p0: new THREE.Vector3(0, y, 0),
        v: new THREE.Vector3(Math.cos(a) * vr, va + 0.018, Math.sin(a) * vr),
        axis: new THREE.Vector3(hash(i, 4) - 0.5, hash(i, 5) - 0.5, hash(i, 6) - 0.5).normalize(),
        w: (0.04 + 0.3 * hash(i, 7)) * (Math.PI / 180),
      });
    }
    const rod = src.getObjectByName('SL_ROD');
    if (rod) {
      const [rx, rz] = sl.rodXZ;
      const corners: [number, number][] = [[rx, rz], [-rx, rz], [rx, -rz], [-rx, -rz]];
      corners.forEach(([x, z], k) => {
        const r = k === 0 ? rod : rod.clone();
        r.removeFromParent();
        r.position.set(x, 0.6, z);
        this.group.add(r);
        this.rods.push(r);
        this.rodMotion.push({
          p0: new THREE.Vector3(x, 0.6, z),
          v: new THREE.Vector3(x * 0.03, 0.01, z * 0.03),
          axis: new THREE.Vector3(z, 0, -x).normalize(),
          w: (3 + 2 * hash(k, 9)) * (Math.PI / 180),
        });
      });
    }
    this.layout(0);
  }

  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _p = new THREE.Vector3();
  private _s = new THREE.Vector3(1, 1, 1);

  private layout(tau: number): void {
    for (let i = 0; i < this.motion.length; i++) {
      const s = this.motion[i];
      this._p.copy(s.p0).addScaledVector(s.v, tau);
      this._q.setFromAxisAngle(s.axis, s.w * tau);
      this._m.compose(this._p, this._q, this._s);
      for (const im of this.sats) im.setMatrixAt(i, this._m);
    }
    for (const im of this.sats) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    this.rods.forEach((r, k) => {
      const s = this.rodMotion[k];
      r.position.copy(s.p0).addScaledVector(s.v, tau);
      r.quaternion.setFromAxisAngle(s.axis, s.w * tau);
    });
  }

  update(b: BodyState, snap: SimSnapshot): void {
    const deployed = b.status === 'deployed';
    let tau = 0;
    if (deployed) {
      const mk = snap.timeline.find((m) => m.type === 'PAYLOAD_DEPLOY' && m.done);
      if (mk) this.deployT = mk.t;
      else if (this.deployT === null) this.deployT = snap.t;
      tau = Math.max(0, snap.t - this.deployT);
    } else {
      this.deployT = null;
    }
    // quantise to 1/30 s of drift to avoid rewriting the instance buffer when paused
    const q = Math.round(tau * 30) / 30;
    if (q !== this.lastDrift) {
      this.lastDrift = q;
      this.layout(q);
    }
  }
}
