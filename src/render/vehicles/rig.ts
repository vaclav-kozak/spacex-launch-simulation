// Rig constants shared with blender/build_falcon9.py (also written to public/models/falcon9_rig.json).
// OWNER: models. Body frame = vehicleSpec.ts: +Y toward the nose, origin at the nozzle-exit plane,
// angles in the XZ plane from +X toward +Z, position (cos a, 0, sin a).
import * as THREE from 'three';

export interface F9Rig {
  leg: {
    hinge: [number, number];
    L: number;
    /** deployed rotation (rad) about the tangential hinge axis */
    theta: number;
    tipDx: number;
    padBelow: number;
    pistonA: [number, number];
    pistonP: [number, number];
    pistonR: number[];
    angles: number[];
  };
  fin: { pivot: [number, number]; angles: number[]; depth: number };
  s2: { mvacPivotY: number };
  starlink: { pitch: number; first: number; count: number; rodXZ: [number, number] };
}

/** Defaults = values baked into the current falcon9.glb (overridden by falcon9_rig.json if present). */
export const DEFAULT_RIG: F9Rig = {
  leg: {
    hinge: [1.85, 1.6], L: 7.88196041603864, theta: 1.9877474223605116, tipDx: 0.14, padBelow: 0.28,
    pistonA: [1.99, 5.4], pistonP: [0.12, 0.92], pistonR: [0.078, 0.064, 0.05], angles: [0, 90, 180, 270],
  },
  fin: { pivot: [2.06, 45.2], angles: [45, 135, 225, 315], depth: 0.26 },
  s2: { mvacPivotY: 3.95 },
  starlink: { pitch: 0.335, first: 0.8, count: 22, rodXZ: [1.72, 1.05] },
};

export const D2R = Math.PI / 180;

/** unit outward radial at body angle a (deg) */
export function radial(aDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.cos(aDeg * D2R), 0, Math.sin(aDeg * D2R));
}

/** hinge axis k = Y × n: rotating +θ about k swings body +Y outward toward n */
export function hingeAxis(aDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(aDeg * D2R), 0, -Math.cos(aDeg * D2R));
}

/** Rotation mapping the canonical (a = 0) layout to body angle a. */
export function rotYDeg(aDeg: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.makeRotationY(-aDeg * D2R);
}

/**
 * Nozzle-exit height of the vehicle above the pad deck when it stands on the launch mount (m).
 * Matches the sim's pre-launch S1.pos (PAD_ELEVATION + 4).
 */
export const LAUNCH_MOUNT_HEIGHT = 4.0;
