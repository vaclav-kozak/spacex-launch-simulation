// Construction / copying helpers for the BodyState contract objects.

import { Vector3, Quaternion } from 'three';
import type { BodyId, BodyState } from '../core/types';
import { makeEngineStates } from './engines';

export function makeBody(id: BodyId): BodyState {
  const nEng = id === 'S1' ? 9 : id === 'S2' ? 1 : 0;
  const b: BodyState = {
    id, status: id === 'SHIP' ? 'free' : 'stacked',
    pos: new Vector3(), vel: new Vector3(), quat: new Quaternion(), angVel: new Vector3(),
    mass: 0, propMass: 0, propCapacity: 1, altitude: 0, speedInertial: 0, speed: 0, verticalSpeed: 0, mach: 0,
    dynPressure: 0, ambientPressure: 101_325, density: 1.225, downrange: 0, gLoad: 1,
    engines: makeEngineStates(nEng), thrust: 0, rcs: new Array(8).fill(0), heating: 0,
  };
  if (id === 'S1') {
    b.gridFins = { deploy: 0, angles: [0, 0, 0, 0] };
    b.legs = 0;
    b.phase = 'PRELAUNCH';
    b.propLox = 0;
    b.propFuel = 0;
  }
  if (id === 'S2') { b.propLox = 0; b.propFuel = 0; }
  if (id === 'FAIRING_A' || id === 'FAIRING_B') b.parafoil = 0;
  return b;
}

/** Deep copy of all fields from src into dst (same body id / array sizes). */
export function copyBody(dst: BodyState, src: BodyState): void {
  dst.status = src.status;
  dst.pos.copy(src.pos); dst.vel.copy(src.vel); dst.quat.copy(src.quat); dst.angVel.copy(src.angVel);
  dst.mass = src.mass; dst.propMass = src.propMass; dst.propCapacity = src.propCapacity;
  dst.altitude = src.altitude; dst.speedInertial = src.speedInertial; dst.speed = src.speed;
  dst.verticalSpeed = src.verticalSpeed; dst.mach = src.mach; dst.dynPressure = src.dynPressure;
  dst.ambientPressure = src.ambientPressure; dst.density = src.density; dst.downrange = src.downrange;
  dst.gLoad = src.gLoad; dst.thrust = src.thrust; dst.heating = src.heating;
  for (let i = 0; i < src.engines.length; i++) Object.assign(dst.engines[i], src.engines[i]);
  for (let i = 0; i < src.rcs.length; i++) dst.rcs[i] = src.rcs[i];
  if (src.gridFins && dst.gridFins) {
    dst.gridFins.deploy = src.gridFins.deploy;
    for (let i = 0; i < 4; i++) dst.gridFins.angles[i] = src.gridFins.angles[i];
  }
  if (src.legs !== undefined) dst.legs = src.legs;
  if (src.parafoil !== undefined) dst.parafoil = src.parafoil;
  dst.phase = src.phase;
  if (src.propLox !== undefined) dst.propLox = src.propLox;
  if (src.propFuel !== undefined) dst.propFuel = src.propFuel;
}
