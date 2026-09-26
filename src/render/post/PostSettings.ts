// Global post-processing settings shared by every PostPipeline (photo mode / debug hooks).
// OWNER: post. UI (photo mode) may write these through PostPipeline.settings or the setters.

export type ToneMapper = 'agx' | 'aces' | 'neutral';

export interface DofSettings {
  enabled: boolean;
  /** focus on whatever is under the screen center (else focusDistance) */
  autoFocus: boolean;
  /** meters */
  focusDistance: number;
  /** f-number (smaller = shallower) */
  fStop: number;
}

export type PostDebug = 'none' | 'depth' | 'bloom' | 'exposure' | 'haze' | 'dirt' | 'flare';

export interface PostSettings {
  /** extra EV added on top of ctx.lighting.exposureBias (photo mode) */
  exposureBias: number;
  /** false: exposure frozen at manualEV (log2 of the scene luminance mapped to middle gray) */
  autoExposure: boolean;
  manualEV: number;
  toneMapper: ToneMapper;
  /** AgX look (ASC-CDL-ish, applied in AgX log space) */
  agxLook: { slope: number; power: number; saturation: number };
  /** multipliers (1 = default look) */
  bloom: number;
  dirt: number;
  flares: boolean;
  flareStrength: number;
  grain: number;
  vignette: number;
  chromaticAberration: number;
  motionBlur: boolean;
  heatHaze: boolean;
  shimmer: boolean;
  lensDistortion: boolean;
  /** blend the view over the canvas with view.alpha (cross-dissolve). Off = opaque (fade handled elsewhere). */
  viewAlpha: boolean;
  dof: DofSettings;
  /** exposure meter tuning */
  meter: {
    key: number; // middle-gray target
    minLum: number; // darkest average luminance the camera will fully compensate (EV clamp)
    maxLum: number;
    lowPercent: number;
    highPercent: number;
    highlightPercent: number;
    /** stops the metered highlight percentile may sit above the average before it pulls exposure down */
    highlightHeadroom: number;
    /** 0..1 weight of the incident (sun-lit gray card) prior in mostly-black frames (space) */
    priorWeight: number;
    speedUp: number; // EV adaptation rate (1/s) when the scene gets brighter
    speedDown: number; // when the scene gets darker
  };
  debug: PostDebug;
}

export const postSettings: PostSettings = {
  exposureBias: 0,
  autoExposure: true,
  manualEV: -1,
  toneMapper: 'agx',
  agxLook: { slope: 1.0, power: 1.12, saturation: 1.18 },
  bloom: 1,
  dirt: 1,
  flares: true,
  flareStrength: 1,
  grain: 1,
  vignette: 1,
  chromaticAberration: 1,
  motionBlur: true,
  heatHaze: true,
  shimmer: true,
  lensDistortion: true,
  viewAlpha: true,
  dof: { enabled: false, autoFocus: true, focusDistance: 100, fStop: 2.8 },
  meter: {
    key: 0.18,
    minLum: 0.03,
    maxLum: 400,
    lowPercent: 0.45,
    highPercent: 0.95,
    highlightPercent: 0.985,
    highlightHeadroom: 6.0,
    priorWeight: 0.7,
    speedUp: 3.0,
    speedDown: 1.3,
  },
  debug: 'none',
};
