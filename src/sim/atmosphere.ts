// U.S. Standard Atmosphere 1976 (0–86 km, geopotential layers) + tabulated US76 thermosphere
// values to 1000 km (log-linear interpolation in density/pressure). Headless, allocation-free.

const R_AIR = 287.05287;
const GAMMA = 1.4;
const G0 = 9.80665;
const R0_GEOPOT = 6_356_766; // US76 Earth radius for geopotential altitude

// base geopotential altitude (m), base temperature (K), lapse rate (K/m), base pressure (Pa)
const HB = [0, 11_000, 20_000, 32_000, 47_000, 51_000, 71_000, 84_852];
const TB = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.946];
const LB = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002, 0];
const PB = [101_325, 22_632.06, 5_474.889, 868.0187, 110.9063, 66.93887, 3.95642, 0.3733836];

// geometric altitude (km), T (K), p (Pa), rho (kg/m^3)  — US76 upper atmosphere
const UP_H = [86, 90, 95, 100, 110, 120, 130, 150, 180, 200, 250, 300, 400, 500, 600, 700, 800, 1000];
const UP_T = [186.87, 186.87, 188.42, 195.08, 240.0, 360.0, 469.27, 634.39, 777.0, 854.56, 941.33, 976.01, 995.83, 999.24, 999.85, 999.97, 999.99, 1000.0];
const UP_P = [0.3734, 0.1836, 0.07597, 0.03201, 7.104e-3, 2.538e-3, 1.251e-3, 4.542e-4, 1.638e-4, 8.47e-5, 2.48e-5, 8.77e-6, 1.45e-6, 3.02e-7, 8.21e-8, 3.19e-8, 1.7e-8, 7.51e-9];
const UP_RHO = [6.958e-6, 3.416e-6, 1.393e-6, 5.604e-7, 9.708e-8, 2.222e-8, 8.152e-9, 2.076e-9, 5.194e-10, 2.541e-10, 6.073e-11, 1.916e-11, 2.803e-12, 5.215e-13, 1.137e-13, 3.07e-14, 1.136e-14, 3.561e-15];
const LN_P = UP_P.map(Math.log);
const LN_RHO = UP_RHO.map(Math.log);

export interface AtmoSample {
  /** temperature K */
  T: number;
  /** pressure Pa */
  p: number;
  /** density kg/m^3 */
  rho: number;
  /** speed of sound m/s */
  a: number;
}

export function makeAtmo(): AtmoSample {
  return { T: 288.15, p: 101_325, rho: 1.225, a: 340.29 };
}

/** Standard atmosphere at geometric altitude h (m). Below sea level extrapolates layer 0. */
export function atmosphere(h: number, out: AtmoSample): AtmoSample {
  if (h < 86_000) {
    const hg = (R0_GEOPOT * h) / (R0_GEOPOT + h);
    let i = 0;
    while (i < 7 && hg >= HB[i + 1]) i++;
    const dh = hg - HB[i];
    const Tb = TB[i], Lb = LB[i];
    let T: number, p: number;
    if (Lb === 0) {
      T = Tb;
      p = PB[i] * Math.exp((-G0 * dh) / (R_AIR * Tb));
    } else {
      T = Tb + Lb * dh;
      p = PB[i] * Math.pow(Tb / T, G0 / (R_AIR * Lb));
    }
    out.T = T;
    out.p = p;
    out.rho = p / (R_AIR * T);
    out.a = Math.sqrt(GAMMA * R_AIR * T);
    return out;
  }
  const hk = h / 1000;
  if (hk >= 1000) {
    // exponential tail beyond the table (scale height ~ 250 km at the top of the thermosphere)
    const f = Math.exp(-(hk - 1000) / 250);
    out.T = 1000;
    out.p = UP_P[UP_P.length - 1] * f;
    out.rho = UP_RHO[UP_RHO.length - 1] * f;
    out.a = Math.sqrt(GAMMA * R_AIR * 1000);
    return out;
  }
  let i = 0;
  while (i < UP_H.length - 2 && hk >= UP_H[i + 1]) i++;
  const f = (hk - UP_H[i]) / (UP_H[i + 1] - UP_H[i]);
  const T = UP_T[i] + (UP_T[i + 1] - UP_T[i]) * f;
  out.T = T;
  out.p = Math.exp(LN_P[i] + (LN_P[i + 1] - LN_P[i]) * f);
  out.rho = Math.exp(LN_RHO[i] + (LN_RHO[i + 1] - LN_RHO[i]) * f);
  out.a = Math.sqrt(GAMMA * R_AIR * T);
  return out;
}

const _s = makeAtmo();
export function densityAt(h: number): number {
  return atmosphere(h, _s).rho;
}
export function pressureAt(h: number): number {
  return atmosphere(h, _s).p;
}
