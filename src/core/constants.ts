// Physical and mission constants shared by sim + render.
// All units SI (m, kg, s, N, Pa, rad) unless the name says otherwise.

export const G0 = 9.80665;
export const EARTH_RADIUS = 6_371_000; // spherical Earth (m)
export const EARTH_MU = 3.986004418e14; // m^3/s^2
export const EARTH_OMEGA = 7.2921159e-5; // rad/s
export const SPEED_OF_SOUND_SL = 340.3;

// SLC-4E, Vandenberg SFB
export const PAD_LAT_DEG = 34.6321;
export const PAD_LON_DEG = -120.6106;
/** Pad surface height above sea level (m). World origin is at sea level directly below the pad. */
export const PAD_ELEVATION = 60;

// Mission: Starlink, 70° shell, southbound along the Baja coast
export const MISSION_NAME = 'STARLINK';
export const LAUNCH_AZIMUTH_DEG = 158; // Earth-relative heading at liftoff (deg from north, clockwise)
export const TARGET_ORBIT_ALT = 300_000; // m, S2 insertion target (near-circular)

// Nominal droneship station (refined at startup by a headless pre-sim of the nominal flight,
// see sim/Simulation.ts). Downrange distance along LAUNCH_AZIMUTH.
export const SHIP_NOMINAL_DOWNRANGE = 600_000;

// Countdown
export const COUNTDOWN_START = -60; // mission time at page load (s)
export const IGNITION_TIME = -3; // TEA-TEB + engine start

// Rendering scale hints
export const MAX_SCENE_EXTENT = 1_500_000; // m, farthest thing we ever draw besides Earth/sky
