// Fairing halves + ram-air parafoil (canopy ~45 m above the half, lines to the nose). OWNER: models.
import * as THREE from 'three';
import type { BodyState } from '../../core/types';
import { upAt } from '../../core/frames';

const CANOPY_HEIGHT = 45;
/** riser attach point on the half, fairing-local (near the nose) */
const ATTACH_LOCAL = new THREE.Vector3(0, 10.6, 0);

export class FairingHalfVisual {
  readonly group = new THREE.Group();
  /** canopy + lines live in W (sibling of the half), not in its body frame */
  readonly chute = new THREE.Group();
  private lods: THREE.Object3D[] = [];
  private lod = -2;
  private canopy: THREE.Object3D | null = null;
  private lines: THREE.LineSegments;
  private lineAnchors: THREE.Vector3[] = [];
  private linePos: Float32Array;

  constructor(src: THREE.Object3D, readonly half: 'A' | 'B', parafoilSrc: THREE.Object3D | null, lineMat: THREE.Material) {
    this.group.name = `FAIRING_${half}`;
    for (let l = 0; l < 3; l++) {
      const r = src.getObjectByName(`F${half}_L${l}`);
      if (!r) continue;
      r.removeFromParent();
      this.group.add(r);
      this.lods.push(r);
    }
    this.chute.name = `PARAFOIL_${half}`;
    this.chute.visible = false;
    if (parafoilSrc) {
      this.canopy = parafoilSrc.clone();
      // thin double-skinned canopy: self-shadowing only produces acne stripes
      this.canopy.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false;
      });
      this.chute.add(this.canopy);
      // suspension line anchors on the canopy underside: 11 spanwise x 3 chordwise (canopy-local)
      const box = new THREE.Box3().setFromObject(parafoilSrc);
      const span = box.max.x - box.min.x;
      const chord = box.max.z - box.min.z;
      for (let i = 0; i <= 10; i++) {
        const x = -span / 2 + (span * i) / 10;
        const droop = -3.2 * (x / (span / 2)) ** 2;
        for (const cz of [0.35, 0.05, -0.3]) this.lineAnchors.push(new THREE.Vector3(x * 0.98, droop - 0.05, cz * chord));
      }
    }
    const n = this.lineAnchors.length;
    this.linePos = new Float32Array(n * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lines = new THREE.LineSegments(g, lineMat);
    this.lines.frustumCulled = false;
    this.chute.add(this.lines);
    this.setLod(0);
  }

  setLod(l: number): void {
    if (l === this.lod) return;
    this.lod = l;
    this.lods.forEach((r, i) => (r.visible = i === l));
  }

  private _up = new THREE.Vector3();
  private _att = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _m = new THREE.Matrix4();
  private _inv = new THREE.Matrix4();
  private _l = new THREE.Vector3();
  private _c = new THREE.Vector3();

  update(b: BodyState): void {
    const p = b.parafoil ?? 0;
    const show = p > 0.001 && b.status !== 'gone' && !!this.canopy;
    this.chute.visible = show;
    if (!show || !this.canopy) return;
    upAt(b.pos, this._up);
    // attach point in W
    this._att.copy(ATTACH_LOCAL).applyQuaternion(b.quat).add(b.pos);
    // canopy frame: up = local vertical, forward = half's body +X projected horizontal (glide dir)
    this._fwd.set(this.half === 'A' ? 1 : -1, 0, 0).applyQuaternion(b.quat);
    this._fwd.addScaledVector(this._up, -this._fwd.dot(this._up));
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(1, 0, 0);
    this._fwd.normalize();
    this._right.crossVectors(this._up, this._fwd).normalize();
    this._m.makeBasis(this._right, this._up, this._fwd);
    // inflation: span unfurls first, then the cells pressurise (thickness)
    const sSpan = 0.25 + 0.75 * THREE.MathUtils.smoothstep(p, 0, 0.6);
    const sChord = 0.35 + 0.65 * THREE.MathUtils.smoothstep(p, 0.1, 0.8);
    const sThick = 0.15 + 0.85 * THREE.MathUtils.smoothstep(p, 0.3, 1.0);
    const h = CANOPY_HEIGHT * (0.4 + 0.6 * THREE.MathUtils.smoothstep(p, 0, 0.5));
    this._c.copy(b.pos).addScaledVector(this._up, h);
    this.chute.position.copy(this._c);
    this.chute.quaternion.setFromRotationMatrix(this._m);
    this.canopy.scale.set(sSpan, sThick, sChord);
    // lines from canopy anchors (chute-local) to the attach point (converted into chute-local)
    this.chute.updateMatrix();
    this._inv.copy(this.chute.matrix).invert();
    this._l.copy(this._att).applyMatrix4(this._inv);
    const lp = this.linePos;
    this.lineAnchors.forEach((a, i) => {
      lp[i * 6] = a.x * sSpan;
      lp[i * 6 + 1] = a.y * sThick;
      lp[i * 6 + 2] = a.z * sChord;
      lp[i * 6 + 3] = this._l.x;
      lp[i * 6 + 4] = this._l.y;
      lp[i * 6 + 5] = this._l.z;
    });
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
