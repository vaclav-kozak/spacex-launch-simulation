// Coordinate frames.
//
// WORLD FRAME "W" (used everywhere: sim state, rendering, audio):
//   Earth-fixed (rotating with Earth), right-handed, meters, JS doubles.
//   Origin: sea-level point directly below SLC-4E.
//   +X = local east at pad, +Y = local up at pad, +Z = local south at pad.
//   Earth center is at (0, -EARTH_RADIUS, 0). Earth is a sphere.
//   Far from the pad "up" is NOT +Y: always use upAt(pos).
//
// Sim integrates in W (a rotating frame) so it adds Coriolis + centrifugal terms using
// EARTH_OMEGA_W. Air is at rest in W (plus wind).
//
// BODY FRAME: +Y = vehicle long axis toward the nose, origin = that stage's nozzle-exit plane
// center (see vehicleSpec.ts). Body quaternion rotates body -> W.

import { Vector3, Quaternion, Matrix4 } from 'three';
import { EARTH_RADIUS, EARTH_OMEGA, PAD_LAT_DEG, PAD_LON_DEG } from './constants';

const D2R = Math.PI / 180;
export const DEG = D2R;

export const EARTH_CENTER = Object.freeze(new Vector3(0, -EARTH_RADIUS, 0)) as Vector3;

const phi0 = PAD_LAT_DEG * D2R;
const lam0 = PAD_LON_DEG * D2R;

// ECEF unit vectors of the pad's local ENU basis
const E_ECEF = new Vector3(-Math.sin(lam0), Math.cos(lam0), 0);
const N_ECEF = new Vector3(-Math.sin(phi0) * Math.cos(lam0), -Math.sin(phi0) * Math.sin(lam0), Math.cos(phi0));
const U_ECEF = new Vector3(Math.cos(phi0) * Math.cos(lam0), Math.cos(phi0) * Math.sin(lam0), Math.sin(phi0));

/** Earth angular velocity expressed in W (rad/s). */
export const EARTH_OMEGA_W = Object.freeze(
  new Vector3(0, Math.sin(phi0), -Math.cos(phi0)).multiplyScalar(EARTH_OMEGA),
) as Vector3;

/** Convert an ECEF direction (unit or not) into W. */
export function ecefDirToWorld(d: Vector3, out = new Vector3()): Vector3 {
  return out.set(d.dot(E_ECEF), d.dot(U_ECEF), -d.dot(N_ECEF));
}

/** Convert a W direction into ECEF. */
export function worldDirToEcef(d: Vector3, out = new Vector3()): Vector3 {
  const x = d.x, y = d.y, z = d.z;
  return out
    .copy(E_ECEF).multiplyScalar(x)
    .addScaledVector(U_ECEF, y)
    .addScaledVector(N_ECEF, -z);
}

/** Geodetic (spherical) lat/lon (deg) + altitude above sea level (m) -> W position. */
export function geodeticToWorld(latDeg: number, lonDeg: number, alt: number, out = new Vector3()): Vector3 {
  const phi = latDeg * D2R, lam = lonDeg * D2R;
  const r = EARTH_RADIUS + alt;
  const ecef = new Vector3(r * Math.cos(phi) * Math.cos(lam), r * Math.cos(phi) * Math.sin(lam), r * Math.sin(phi));
  // W = R*(ecef) - R*(pad sea-level point); pad sea-level point in W is (0,0,0) and Earth center is (0,-R,0)
  ecefDirToWorld(ecef, out);
  out.y -= EARTH_RADIUS;
  return out;
}

export interface Geodetic { lat: number; lon: number; alt: number }

/** W position -> spherical lat/lon (deg) and altitude (m). */
export function worldToGeodetic(p: Vector3): Geodetic {
  const rel = new Vector3(p.x, p.y + EARTH_RADIUS, p.z);
  const ecef = worldDirToEcef(rel);
  const r = ecef.length();
  return {
    lat: Math.asin(ecef.z / r) / D2R,
    lon: Math.atan2(ecef.y, ecef.x) / D2R,
    alt: r - EARTH_RADIUS,
  };
}

/** Altitude above the spherical sea level (m). */
export function altitudeOf(p: Vector3): number {
  const dx = p.x, dy = p.y + EARTH_RADIUS, dz = p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - EARTH_RADIUS;
}

/** Local vertical (unit) at a W position. */
export function upAt(p: Vector3, out = new Vector3()): Vector3 {
  return out.set(p.x, p.y + EARTH_RADIUS, p.z).normalize();
}

/** Local East/North/Up unit vectors at a W position (north toward geographic north pole). */
export function enuAt(p: Vector3): { east: Vector3; north: Vector3; up: Vector3 } {
  const up = upAt(p);
  const pole = new Vector3(0, Math.sin(phi0), -Math.cos(phi0)); // Earth axis in W
  const east = new Vector3().crossVectors(pole, up);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  const north = new Vector3().crossVectors(up, east).normalize();
  return { east, north, up };
}

/** Great-circle surface distance between the ground projections of two W points (m). */
export function surfaceDistance(a: Vector3, b: Vector3): number {
  const ua = upAt(a), ub = upAt(b);
  return Math.acos(Math.min(1, Math.max(-1, ua.dot(ub)))) * EARTH_RADIUS;
}

/**
 * Point at the given surface distance (m) along initial heading (deg from north, clockwise)
 * from the pad, at altitude alt. Used to place the droneship and for downrange math.
 */
export function pointAlongAzimuth(distance: number, azimuthDeg: number, alt = 0, out = new Vector3()): Vector3 {
  const d = distance / EARTH_RADIUS;
  const az = azimuthDeg * D2R;
  const lat = Math.asin(Math.sin(phi0) * Math.cos(d) + Math.cos(phi0) * Math.sin(d) * Math.cos(az));
  const lon = lam0 + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(phi0), Math.cos(d) - Math.sin(phi0) * Math.sin(lat));
  return geodeticToWorld(lat / D2R, lon / D2R, alt, out);
}

/** Unit horizontal direction at the pad for a heading (deg from north, clockwise), in W. */
export function padHeadingDir(azimuthDeg: number, out = new Vector3()): Vector3 {
  const az = azimuthDeg * D2R;
  return out.set(Math.sin(az), 0, -Math.cos(az));
}

/**
 * Fraction (0..1) of the solar disc visible from p (Earth shadow incl. a thin refracting
 * atmosphere shell). sunDir is a unit W vector toward the sun.
 */
export function sunVisibility(p: Vector3, sunDir: Vector3): number {
  const cx = p.x, cy = p.y + EARTH_RADIUS, cz = p.z;
  const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
  // angle between local up and sun, compared with horizon dip angle
  const cosZen = (cx * sunDir.x + cy * sunDir.y + cz * sunDir.z) / r;
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const Reff = EARTH_RADIUS + 12_000; // the lower atmosphere blocks grazing sunlight
  const dip = r > Reff ? Math.acos(Reff / r) : 0;
  const horizon = Math.PI / 2 + dip;
  const sunRadius = 0.0047;
  const x = (horizon - zen) / (2 * sunRadius) + 0.5;
  return Math.max(0, Math.min(1, x));
}

/** Build a quaternion whose body +Y points along `axis` (W), with body +Z as close to `ref` as possible. */
export function quatFromAxis(axis: Vector3, ref: Vector3, out = new Quaternion()): Quaternion {
  const y = axis.clone().normalize();
  let z = ref.clone().addScaledVector(y, -ref.dot(y));
  if (z.lengthSq() < 1e-10) z = new Vector3(1, 0, 0).addScaledVector(y, -y.x);
  z.normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  const m = new Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}
