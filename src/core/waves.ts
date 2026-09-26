// Shared sea-state wave model (Gerstner sum). The ocean shader (render/env) and the droneship
// motion (sim) MUST both use getWaveSet() so the ship rides the waves you see.
// Horizontal wave coordinates are W-frame (x, z) in meters; height is along local up.
// Higher-frequency detail (normal maps / FFT cascades) may be added in the shader on top, but
// must not change the low-frequency surface the ship samples.

export interface GerstnerWave {
  /** unit direction of travel in the W x/z plane */
  dirX: number;
  dirZ: number;
  amplitude: number; // m
  wavelength: number; // m
  k: number; // 2π/λ
  omega: number; // deep-water dispersion sqrt(g k)
  phase: number; // rad
  steepness: number; // Gerstner Q (0..1)
}

export interface WaveSet {
  seaState: number;
  significantHeight: number;
  peakPeriod: number;
  waves: GerstnerWave[];
}

const HS_BY_SEA_STATE = [0.0, 0.1, 0.3, 0.875, 1.875, 3.25, 5.0];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, WaveSet>();

/**
 * @param seaState Douglas 0..6 (fractional allowed)
 * @param windFromDeg direction the wind blows FROM (deg from north)
 */
export function getWaveSet(seaState: number, windFromDeg: number, count = 12): WaveSet {
  const key = `${seaState.toFixed(2)}|${windFromDeg.toFixed(1)}|${count}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const s = Math.max(0, Math.min(6, seaState));
  const i0 = Math.floor(s), i1 = Math.min(6, i0 + 1);
  const hs = Math.max(0.05, HS_BY_SEA_STATE[i0] + (HS_BY_SEA_STATE[i1] - HS_BY_SEA_STATE[i0]) * (s - i0));
  const tp = 2 + 3.9 * Math.sqrt(hs);
  const g = 9.81;
  const lambdaP = (g * tp * tp) / (2 * Math.PI);
  // waves travel downwind: toward (windFrom + 180°). heading -> W dir (x=east, z=south)
  const travelAz = ((windFromDeg + 180) * Math.PI) / 180;
  const rnd = mulberry32(1337);

  const waves: GerstnerWave[] = [];
  let sumA2 = 0;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    // log-spaced wavelengths 0.35..1.6 λp; one long swell component from a different direction
    const isSwell = i === 0;
    const wl = isSwell ? lambdaP * 2.4 : lambdaP * Math.pow(2, -1.5 + 2.2 * f);
    const spread = isSwell ? 0.6 : (rnd() - 0.5) * 1.6;
    const az = travelAz + spread;
    // PM-like weighting: most energy near λp, less for short waves
    const rel = wl / lambdaP;
    const weight = isSwell ? 0.55 : Math.exp(-1.25 * Math.pow(Math.log(rel) / 0.7, 2)) * rel + 0.05 * rel;
    const k = (2 * Math.PI) / wl;
    waves.push({
      dirX: Math.sin(az),
      dirZ: -Math.cos(az),
      amplitude: weight,
      wavelength: wl,
      k,
      omega: Math.sqrt(g * k),
      phase: rnd() * Math.PI * 2,
      steepness: 0,
    });
    sumA2 += weight * weight;
  }
  // scale so Hs = 4*sqrt(m0), m0 = Σ a²/2
  const scale = hs / 4 / Math.sqrt(sumA2 / 2);
  for (const w of waves) {
    w.amplitude *= scale;
    // keep sum of Q*k*a below 1 to avoid loops
    w.steepness = Math.min(0.9, 0.55 / (w.k * w.amplitude * count + 1e-6));
  }
  const set: WaveSet = { seaState: s, significantHeight: hs, peakPeriod: tp, waves };
  cache.set(key, set);
  return set;
}

export interface WaveSample {
  /** vertical displacement (m, along local up) */
  height: number;
  /** horizontal Gerstner displacement in W x/z (m) */
  dx: number;
  dz: number;
  /** surface normal in local tangent frame (x=W x, y=up, z=W z), unnormalized ok */
  nx: number;
  ny: number;
  nz: number;
}

/** Evaluate the Gerstner sum at W horizontal coords (x, z) and time t (s). */
export function sampleWaves(set: WaveSet, x: number, z: number, t: number, out?: WaveSample): WaveSample {
  let h = 0, dx = 0, dz = 0, nx = 0, nz = 0, ny = 1;
  for (const w of set.waves) {
    const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase;
    const c = Math.cos(th), s = Math.sin(th);
    h += w.amplitude * s;
    const qa = w.steepness * w.amplitude;
    dx += qa * w.dirX * c;
    dz += qa * w.dirZ * c;
    const wa = w.k * w.amplitude;
    nx -= w.dirX * wa * c;
    nz -= w.dirZ * wa * c;
    ny -= w.steepness * wa * s;
  }
  const o = out ?? ({} as WaveSample);
  o.height = h; o.dx = dx; o.dz = dz; o.nx = nx; o.ny = ny; o.nz = nz;
  return o;
}
