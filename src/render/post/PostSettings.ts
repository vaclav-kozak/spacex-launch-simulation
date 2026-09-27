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
    /** display value of the metered luminance in bright scenes (middle grey) */
    key: number;
    /** display value of the metered luminance in dark scenes (twilight / night look) */
    keyDark: number;
    /** log2 metered luminance at/below which keyDark applies, and at/above which key applies */
    darkLog: number;
    brightLog: number;
    /** darkest / brightest average luminance the camera will compensate (EV clamp, default camera;
     * per camera type offsets live in PostPipeline) */
    minLum: number;
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
    /** slew limits (EV/s) — an iris / gain ride, not an instant jump. Up = scene got brighter
     * (ignition: stop down quickly), down = scene got darker (open up slowly). */
    maxRateUp: number;
    maxRateDown: number;
    /** stops a tracked subject (vehicle at the centre depth) may sit above the metered level */
    subjectHeadroom: number;
    /** at night (moon-lit), dark scenes get a lower key, by up to this many stops:
     *  near-empty night frames read dark instead of lifted to a grey (ramp: Ln darkLog+4 .. darkLog-2) */
    nightKeyStops: number;
  };
  /** local highlight compression (camera knee): 0 = off .. 1 */
  highlightCompress: number;
  /** stops above the metered level where the compression starts */
  compressStart: number;
  /** stops the compressed highlights may still rise above the start (dark scenes / bright scenes) */
  compressRangeDark: number;
  compressRangeBright: number;
  /** exposed luminance where the bloom source saturates (keeps a night plume from flooding the frame) */
  bloomKnee: number;
  /** 0..1 mesopic night look (rod desaturation + slight blue shift of dim, moon-lit regions) */
  nightLook: number;
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
    keyDark: 0.032,
    darkLog: -12,
    brightLog: -3.5,
    minLum: 2.2e-6,
    maxLum: 400,
    lowPercent: 0.4,
    highPercent: 0.82,
    highlightPercent: 0.97,
    highlightHeadroom: 9.0,
    priorWeight: 0.7,
    speedUp: 3.5,
    speedDown: 1.0,
    maxRateUp: 24,
    maxRateDown: 4,
    subjectHeadroom: 1.5,
    nightKeyStops: 1.5,
  },
  highlightCompress: 1,
  compressStart: 4.0,
  compressRangeDark: 3.5,
  compressRangeBright: 7.0,
  bloomKnee: 48,
  nightLook: 0.65,
  debug: 'none',
};
