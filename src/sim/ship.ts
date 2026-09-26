// Droneship OCISLY: holds station (slow thruster drift) with bow into the seas; heave / pitch /
// roll from the shared Gerstner wave set (core/waves.ts) sampled over the hull footprint, which
// low-passes waves shorter than the hull. Pure function of environment time => deterministic.

import { Vector3, Quaternion, Matrix4 } from 'three';
import { OCISLY } from '../core/vehicleSpec';
import { getWaveSet, sampleWaves, type WaveSample, type WaveSet } from '../core/waves';
import { EARTH_RADIUS } from '../core/constants';
import { localENU } from './wind';

const D2R = Math.PI / 180;
const NX = 3, NZ = 5;

export interface ShipPose {
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  up: Vector3; // deck normal
  bow: Vector3; // +Z
  /** ship +X (= up × bow, the PORT side) */
  starboard: Vector3;
  heave: number;
  pitch: number;
  roll: number;
}

export function makeShipPose(): ShipPose {
  return {
    pos: new Vector3(), quat: new Quaternion(), vel: new Vector3(), up: new Vector3(0, 1, 0),
    bow: new Vector3(0, 0, 1), starboard: new Vector3(1, 0, 0), heave: 0, pitch: 0, roll: 0,
  };
}

export class ShipModel {
  /** station: sea-level point (W) */
  readonly station = new Vector3();
  private east = new Vector3();
  private north = new Vector3();
  private up = new Vector3();
  private bow0 = new Vector3();
  private stbd0 = new Vector3();
  private waves!: WaveSet;
  private ws: WaveSample = { height: 0, dx: 0, dz: 0, nx: 0, ny: 1, nz: 0 };
  private m = new Matrix4();
  private _a = makeShipPose();
  private _b = makeShipPose();

  constructor(station: Vector3, seaState: number, windFromDeg: number) {
    this.setStation(station);
    this.setSea(seaState, windFromDeg);
  }

  setStation(p: Vector3): void {
    // project to sea level
    const r = Math.hypot(p.x, p.y + EARTH_RADIUS, p.z);
    this.station.set(p.x, p.y + EARTH_RADIUS, p.z).multiplyScalar(EARTH_RADIUS / r);
    this.station.y -= EARTH_RADIUS;
    localENU(this.station, this.east, this.north, this.up);
  }

  setSea(seaState: number, windFromDeg: number): void {
    this.waves = getWaveSet(seaState, windFromDeg);
    // bow into the seas: toward the direction the wind/waves come from, in W x/z (as the shader)
    const az = windFromDeg * D2R;
    this.bow0.set(Math.sin(az), 0, -Math.cos(az)).addScaledVector(this.up, -this.up.y * 0);
    this.bow0.addScaledVector(this.up, -this.bow0.dot(this.up)).normalize();
    this.stbd0.crossVectors(this.up, this.bow0).normalize();
  }

  /** Ship pose at environment time t (s). */
  pose(t: number, out: ShipPose): ShipPose {
    this.poseRaw(t, out);
    // velocity by central difference
    const a = this.poseRaw(t - 0.05, this._a), b = this.poseRaw(t + 0.05, this._b);
    out.vel.copy(b.pos).sub(a.pos).multiplyScalar(10);
    return out;
  }

  private poseRaw(t: number, out: ShipPose): ShipPose {
    // station keeping drift (m) in the local horizontal plane
    const de = 2.2 * Math.sin((2 * Math.PI * t) / 97) + 0.8 * Math.sin((2 * Math.PI * t) / 41 + 1.3);
    const dn = 1.6 * Math.sin((2 * Math.PI * t) / 131 + 0.7) + 0.6 * Math.sin((2 * Math.PI * t) / 53 + 2.1);
    const cx = this.station.x + this.east.x * de + this.north.x * dn;
    const cy = this.station.y + this.east.y * de + this.north.y * dn;
    const cz = this.station.z + this.east.z * de + this.north.z * dn;
    // least-squares plane over the hull footprint (ship-local s = starboard, f = forward)
    const L = OCISLY.hullLength, B = OCISLY.hullBeam;
    let sh = 0, ssx = 0, ssz = 0, sxx = 0, szz = 0, sdx = 0, sdz = 0;
    const bx = this.bow0.x, bz = this.bow0.z, sx = this.stbd0.x, sz = this.stbd0.z;
    for (let i = 0; i < NX; i++) {
      const s = (i / (NX - 1) - 0.5) * B;
      for (let j = 0; j < NZ; j++) {
        const f = (j / (NZ - 1) - 0.5) * L;
        const x = cx + sx * s + bx * f, z = cz + sz * s + bz * f;
        sampleWaves(this.waves, x, z, t, this.ws);
        const h = this.ws.height;
        sh += h; ssx += h * s; ssz += h * f; sxx += s * s; szz += f * f;
        sdx += this.ws.dx; sdz += this.ws.dz;
      }
    }
    const n = NX * NZ;
    const heave = sh / n;
    const rollSlope = ssx / sxx; // dh/ds
    const pitchSlope = ssz / szz; // dh/df
    // barge response: partial following (RAO < 1), keeps the deck walkable in calm seas
    const roll = Math.atan(rollSlope * 0.8);
    const pitch = Math.atan(pitchSlope * 0.7);
    out.heave = heave * 0.9;
    out.roll = roll;
    out.pitch = pitch;
    const surge = 0.35 / n;
    const px = cx + sdx * surge, pz = cz + sdz * surge;
    // deck center on the deck surface
    const up = this.up;
    out.pos.set(px, cy, pz).addScaledVector(up, OCISLY.deckHeight + out.heave);
    // orientation: start from (stbd, up, bow), pitch about starboard axis (bow up = +pitch), roll about bow
    const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // deck normal tilts toward -starboard when the starboard side is higher (roll>0), toward -bow when bow higher
    const nU = out.up.copy(up).multiplyScalar(cr * cp).addScaledVector(this.stbd0, -sr * cp).addScaledVector(this.bow0, -sp);
    nU.normalize();
    out.bow.copy(this.bow0).addScaledVector(nU, -this.bow0.dot(nU)).normalize();
    out.starboard.crossVectors(nU, out.bow).normalize();
    this.m.makeBasis(out.starboard, nU, out.bow);
    out.quat.setFromRotationMatrix(this.m);
    return out;
  }

  /** Surface point of the (mean) sea at W position p. */
  seaHeightAt(x: number, z: number, t: number): number {
    return sampleWaves(this.waves, x, z, t, this.ws).height;
  }
}
