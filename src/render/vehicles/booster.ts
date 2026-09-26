// Falcon 9 first stage: LOD rigs, grid fins, legs + telescoping pistons, centre-engine gimbal.
// OWNER: models.
import * as THREE from 'three';
import type { BodyState } from '../../core/types';
import { type F9Rig, hingeAxis, rotYDeg, D2R } from './rig';

interface LegRig {
  pivot: THREE.Object3D;
  axis: THREE.Vector3;
  pistonNodes: THREE.Object3D[]; // one per segment, at the body anchor A
  pistonSegs: THREE.Object3D[]; // mesh children, offset along local +Y
  a: number;
}

interface LodRig {
  root: THREE.Object3D;
  eng0: THREE.Object3D | null;
  fins: { pivot: THREE.Object3D; tw: THREE.Object3D; axis: THREE.Vector3 }[];
  legs: LegRig[];
}

export interface PoseParams {
  legs: number;
  finDeploy: number;
  finAngles: readonly number[];
  gimbalX: number;
  gimbalZ: number;
}

const _Y = new THREE.Vector3(0, 1, 0);
const _A = new THREE.Vector3();
const _P = new THREE.Vector3();
const _H = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class BoosterVisual {
  readonly group = new THREE.Group();
  readonly lods: LodRig[] = [];
  private lod = -2;
  /** stowed piston segment length (m) */
  private pistonLen = 0;

  constructor(src: THREE.Object3D, private rig: F9Rig) {
    this.group.name = 'S1';
    for (let l = 0; l < 3; l++) {
      const root = src.getObjectByName(`S1_L${l}`);
      if (!root) continue;
      root.removeFromParent();
      root.position.set(0, 0, 0);
      this.group.add(root);
      const r: LodRig = { root, eng0: root.getObjectByName(`S1_L${l}_eng0`) ?? null, fins: [], legs: [] };
      rig.fin.angles.forEach((a, i) => {
        const pivot = root.getObjectByName(`S1_L${l}_fin${i}`);
        const tw = root.getObjectByName(`S1_L${l}_fin${i}_tw`);
        if (pivot && tw) r.fins.push({ pivot, tw, axis: hingeAxis(a) });
      });
      rig.leg.angles.forEach((a, i) => {
        const pivot = root.getObjectByName(`S1_L${l}_leg${i}`);
        if (!pivot) return;
        const pistonNodes: THREE.Object3D[] = [];
        const pistonSegs: THREE.Object3D[] = [];
        for (let k = 0; k < 3; k++) {
          const n = root.getObjectByName(`S1_L${l}_leg${i}_p${k}_n`);
          const s = root.getObjectByName(`S1_L${l}_leg${i}_p${k}`);
          if (n && s) {
            pistonNodes.push(n);
            pistonSegs.push(s);
          }
        }
        r.legs.push({ pivot, axis: hingeAxis(a), pistonNodes, pistonSegs, a });
      });
      this.lods.push(r);
    }
    // stowed piston length (anchor -> leg attach point with the leg folded)
    const L = rig.leg;
    this.pistonLen = Math.hypot(L.hinge[0] + L.pistonP[0] - L.pistonA[0], L.hinge[1] + L.pistonP[1] * L.L - L.pistonA[1]);
    this.setLod(0);
  }

  setLod(l: number): void {
    if (l === this.lod) return;
    this.lod = l;
    this.lods.forEach((r, i) => (r.root.visible = i === l));
  }

  pose(p: PoseParams): void {
    const L = this.rig.leg;
    const legT = Math.max(0, Math.min(1, p.legs));
    // pneumatic deploy: fast swing with a damped end (sim value is already time-shaped; keep linear)
    const theta = legT * L.theta;
    const fin = Math.max(0, Math.min(1, p.finDeploy)) * Math.PI / 2;
    for (const r of this.lods) {
      if (r.eng0) r.eng0.rotation.set(p.gimbalX, 0, p.gimbalZ, 'ZXY');
      r.fins.forEach((f, i) => {
        f.pivot.quaternion.setFromAxisAngle(f.axis, fin);
        f.tw.quaternion.setFromAxisAngle(_Y, p.finAngles[i] ?? 0);
      });
      for (const leg of r.legs) {
        leg.pivot.quaternion.setFromAxisAngle(leg.axis, theta);
        if (!leg.pistonNodes.length) continue;
        // piston: anchor A on the body, attach point P on the leg (rotates with it)
        rotYDeg(leg.a, _m);
        _H.set(L.hinge[0], L.hinge[1], 0).applyMatrix4(_m);
        _A.set(L.pistonA[0], L.pistonA[1], 0).applyMatrix4(_m);
        _P.set(L.hinge[0] + L.pistonP[0], L.hinge[1] + L.pistonP[1] * L.L, 0).applyMatrix4(_m);
        _P.sub(_H).applyQuaternion(leg.pivot.quaternion).add(_H);
        _d.subVectors(_P, _A);
        const len = _d.length();
        _d.divideScalar(len || 1);
        _q.setFromUnitVectors(_Y, _d);
        const ext = Math.max(0, len - this.pistonLen);
        const n = leg.pistonNodes.length;
        for (let k = 0; k < n; k++) {
          leg.pistonNodes[k].quaternion.copy(_q);
          leg.pistonSegs[k].position.set(0, n > 1 ? (ext * k) / (n - 1) : 0, 0);
        }
      }
    }
  }

  update(b: BodyState): void {
    const e0 = b.engines[0];
    this.pose({
      legs: b.legs ?? 0,
      finDeploy: b.gridFins?.deploy ?? 0,
      finAngles: b.gridFins?.angles ?? [0, 0, 0, 0],
      gimbalX: e0?.gimbalX ?? 0,
      gimbalZ: e0?.gimbalZ ?? 0,
    });
  }
}

export { D2R };
