export type TimeOfDay = 'morning' | 'twilight' | 'night';
export type QualityPreset = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  timeOfDay: TimeOfDay;
  /** Douglas sea state 0..6 */
  seaState: number;
  /** wind at 10 m (m/s) */
  windSpeed: number;
  /** direction the wind blows FROM, deg from north */
  windFromDeg: number;
  /** flight-proven sooty booster */
  sootyBooster: boolean;
  /** player controls throttle + gimbal during the landing burn */
  manualLanding: boolean;
  quality: QualityPreset;
  muted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  timeOfDay: 'twilight',
  seaState: 3,
  windSpeed: 6,
  windFromDeg: 300,
  sootyBooster: true,
  manualLanding: false,
  quality: 'auto',
  muted: true,
};

/** Apply ?tod=night&sea=5&wind=12&soot=0&manual=1&quality=low overrides. */
export function settingsFromUrl(base: Settings, params: URLSearchParams): Settings {
  const s = { ...base };
  const tod = params.get('tod');
  if (tod === 'morning' || tod === 'twilight' || tod === 'night') s.timeOfDay = tod;
  if (params.has('sea')) s.seaState = Math.max(0, Math.min(6, Number(params.get('sea'))));
  if (params.has('wind')) s.windSpeed = Math.max(0, Number(params.get('wind')));
  if (params.has('windfrom')) s.windFromDeg = Number(params.get('windfrom'));
  if (params.has('soot')) s.sootyBooster = params.get('soot') !== '0';
  if (params.has('manual')) s.manualLanding = params.get('manual') === '1';
  const q = params.get('quality');
  if (isQualityPreset(q)) s.quality = q;
  return s;
}

export function isQualityPreset(q: unknown): q is QualityPreset {
  return q === 'auto' || q === 'low' || q === 'medium' || q === 'high' || q === 'ultra';
}

const QUALITY_KEY = 'f9sim.quality';

/** Apply preferences remembered from earlier visits (currently the render quality preset). */
export function storedSettings(base: Settings): Settings {
  try {
    const q = globalThis.localStorage?.getItem(QUALITY_KEY);
    if (isQualityPreset(q)) return { ...base, quality: q };
  } catch { /* storage blocked */ }
  return base;
}

export function storeQuality(q: QualityPreset): void {
  try { globalThis.localStorage?.setItem(QUALITY_KEY, q); } catch { /* storage blocked */ }
}
