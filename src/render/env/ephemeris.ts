// Solar / lunar ephemeris (Meeus low-precision series, ~0.01° sun, ~0.2° moon) and sidereal
// rotation, expressed in the W frame via frames.ts. Also the time-of-day launch presets.
import { Vector3, Matrix3 } from 'three';
import { ecefDirToWorld, geodeticToWorld, EARTH_CENTER } from '../../core/frames';
import { PAD_LAT_DEG, PAD_LON_DEG } from '../../core/constants';
import type { TimeOfDay } from '../../core/settings';

const D2R = Math.PI / 180;

/**
 * Launch epochs (UTC) for T-0 per time-of-day preset at SLC-4E. Chosen so that:
 *  morning : sun 15° up in the ESE (az 112°)                                   08:29 PDT
 *  twilight: end of civil twilight, sun -6.0° in the WSW (az 246°): deep-blue sky with a warm
 *            western glow at the pad; the rocket climbs into sunlight around 45–50 km
 *            ("jellyfish"); nearly full moon rising in the ENE                      17:24 PST
 *  night   : sun -36°, full moon 35° up in the SSE (az 161°, along the launch azimuth
 *            -> moon glitter path on the sea downrange)                           23:30 PDT
 * (dates verified with this ephemeris; see envDebug in the test page)
 */
export const TOD_EPOCHS: Record<TimeOfDay, string> = {
  morning: '2026-10-15T15:29:00Z',
  twilight: '2026-12-23T01:24:00Z',
  night: '2026-05-01T06:30:00Z',
};

export function julianDate(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

/** Greenwich mean sidereal time (rad) */
export function gmst(jd: number): number {
  const d = jd - 2451545.0;
  const T = d / 36525;
  let g = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T;
  g = ((g % 360) + 360) % 360;
  return g * D2R;
}

function obliquity(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return (23.439291 - 0.0130042 * T) * D2R;
}

/** geocentric equatorial (RA, Dec) of the sun, rad */
export function sunRaDec(jd: number): { ra: number; dec: number; distAU: number } {
  const d = jd - 2451545.0;
  const T = d / 36525;
  const L0 = 280.46646 + 36000.76983 * T;
  const M = (357.52911 + 35999.05029 * T) * D2R;
  const C = (1.914602 - 0.004817 * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const lon = (L0 + C) * D2R;
  const e = 0.016708634 - 0.000042037 * T;
  const nu = M + C * D2R;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu));
  const eps = obliquity(jd);
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lon), Math.cos(lon));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lon));
  return { ra, dec, distAU: R };
}

/** geocentric equatorial (RA, Dec) + distance (m) of the moon */
export function moonRaDec(jd: number): { ra: number; dec: number; dist: number } {
  const d = jd - 2451545.0;
  const Lp = (218.316 + 13.176396 * d) * D2R;
  const Mp = (134.963 + 13.064993 * d) * D2R;
  const F = (93.272 + 13.22935 * d) * D2R;
  const D = (297.850 + 12.190749 * d) * D2R;
  const M = (357.529 + 0.98560028 * d) * D2R;
  const s = Math.sin;
  const lon =
    Lp +
    D2R *
      (6.289 * s(Mp) - 1.274 * s(Mp - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(M) - 0.059 * s(2 * Mp - 2 * D) -
        0.057 * s(Mp - 2 * D + M) + 0.053 * s(Mp + 2 * D) + 0.046 * s(2 * D - M) + 0.041 * s(Mp - M) -
        0.035 * s(D) - 0.031 * s(Mp + M) - 0.015 * s(2 * F - 2 * D) + 0.011 * s(Mp - 4 * D));
  const lat =
    D2R * (5.128 * s(F) + 0.281 * s(Mp + F) + 0.278 * s(Mp - F) + 0.173 * s(2 * D - F) + 0.055 * s(2 * D + F - Mp) -
      0.046 * s(2 * D - F - Mp) + 0.033 * s(F + 2 * Mp) + 0.017 * s(2 * Mp - F));
  const distKm = 385001 - 20905 * Math.cos(Mp) - 3699 * Math.cos(2 * D - Mp) - 2956 * Math.cos(2 * D) - 570 * Math.cos(2 * Mp);
  const eps = obliquity(jd);
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(eps) * Math.cos(lat) * Math.sin(lon) - Math.sin(eps) * Math.sin(lat);
  const z = Math.sin(eps) * Math.cos(lat) * Math.sin(lon) + Math.cos(eps) * Math.sin(lat);
  return { ra: Math.atan2(y, x), dec: Math.asin(z), dist: distKm * 1000 };
}

/** ECI (equator-of-date) unit vector -> ECEF via GMST */
function raDecToEcef(ra: number, dec: number, g: number, out = new Vector3()): Vector3 {
  const h = ra - g;
  return out.set(Math.cos(dec) * Math.cos(h), Math.cos(dec) * Math.sin(h), Math.sin(dec));
}

/** Rotation matrix taking ECI (J2000-ish equatorial, x=vernal equinox) directions into W. */
export function eciToWorldMatrix(jd: number, out = new Matrix3()): Matrix3 {
  const g = gmst(jd);
  const cx = ecefDirToWorld(raDecToEcef(0, 0, g));
  const cy = ecefDirToWorld(raDecToEcef(Math.PI / 2, 0, g));
  const cz = ecefDirToWorld(raDecToEcef(0, Math.PI / 2, g));
  return out.set(cx.x, cy.x, cz.x, cx.y, cy.y, cz.y, cx.z, cy.z, cz.z);
}

export interface Ephemeris {
  jd: number;
  /** unit W vector toward the sun (geocentric ≈ topocentric) */
  sunDir: Vector3;
  /** unit W vector from the PAD toward the moon (topocentric) */
  moonDir: Vector3;
  /** moon W position (m) */
  moonPos: Vector3;
  /** 0..1 illuminated fraction */
  moonIllum: number;
  /** ECI -> W rotation for star/Milky Way placement */
  eciToW: Matrix3;
}

const _padW = geodeticToWorld(PAD_LAT_DEG, PAD_LON_DEG, 0);

export function computeEphemeris(ms: number, out?: Ephemeris): Ephemeris {
  const jd = julianDate(ms);
  const g = gmst(jd);
  const e = out ?? { jd, sunDir: new Vector3(), moonDir: new Vector3(), moonPos: new Vector3(), moonIllum: 1, eciToW: new Matrix3() };
  e.jd = jd;
  const sun = sunRaDec(jd);
  ecefDirToWorld(raDecToEcef(sun.ra, sun.dec, g), e.sunDir).normalize();
  const moon = moonRaDec(jd);
  const mEcef = raDecToEcef(moon.ra, moon.dec, g);
  const mW = ecefDirToWorld(mEcef).normalize();
  e.moonPos.copy(EARTH_CENTER).addScaledVector(mW, moon.dist);
  e.moonDir.copy(e.moonPos).sub(_padW).normalize();
  // illuminated fraction from sun-moon elongation (geocentric)
  const cosPsi = e.sunDir.dot(mW);
  e.moonIllum = (1 - cosPsi) / 2;
  eciToWorldMatrix(jd, e.eciToW);
  return e;
}

/** local horizontal coordinates at the pad of a W direction: elevation/azimuth in degrees */
export function azEl(dirW: Vector3): { az: number; el: number } {
  // at the pad: +X east, +Y up, +Z south
  const el = Math.asin(Math.max(-1, Math.min(1, dirW.y))) / D2R;
  let az = Math.atan2(dirW.x, -dirW.z) / D2R;
  if (az < 0) az += 360;
  return { az, el };
}
