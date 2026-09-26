// Shared runtime context + module interfaces. OWNER: app (integration). Everyone reads.

import type * as THREE from 'three';
import type { EventBus } from './events';
import type { Settings } from './settings';
import type { BodyId, SimSnapshot } from './types';

/** Adaptive quality. level 0=low .. 3=ultra. Modules read it every frame and scale work. */
export interface QualityState {
  level: 0 | 1 | 2 | 3;
  /** render resolution multiplier applied by post pipelines (0.5..1) */
  renderScale: number;
  /** smoothed frame time (ms) */
  frameMs: number;
}

/**
 * Global lighting published by render/env every frame (and refreshed per view in
 * env.beforeViewRender). Radiometric convention (linear HDR, arbitrary but consistent):
 *   - direct sun at zenith, clear sky, sea level:   sunColor ≈ (1,0.98,0.95) * SUN_INTENSITY (=6)
 *   - clear sky ambient irradiance:                 ≈ 1.0 .. 1.8
 *   - moonlit night:                                ≈ 0.003 .. 0.02
 *   - Merlin sea-level plume core radiance:         ≈ 60 .. 150 (so it blooms at any exposure)
 *   - MVac nozzle glow (hot niobium):               ≈ 4 .. 20
 * Post auto-exposure maps this to display.
 */
export const SUN_INTENSITY = 6;

export interface LightingState {
  /** unit W vector toward the sun */
  sunDir: THREE.Vector3;
  /** linear sun radiance (already attenuated by atmosphere at the current view focus altitude) */
  sunColor: THREE.Color;
  /** 0..1 sun visibility at the view focus (Earth shadow) */
  sunVisibility: number;
  /** sky ambient (hemisphere-ish) colors, linear */
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  /** PMREM env map of the current sky for reflections (may be null until ready) */
  envMap: THREE.Texture | null;
  /** exposure hint (EV bias) for post: env sets 0 by default; photo mode can override */
  exposureBias: number;
  /** moon direction + color (night) */
  moonDir: THREE.Vector3;
  moonColor: THREE.Color;
}

/** Heat-haze / shimmer emitter published by vfx each frame, consumed by post. W positions. */
export interface HazeSource {
  /** segment start (nozzle exit) and end (plume tail) in W */
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** radius at start / end (m) */
  radius0: number;
  radius1: number;
  /** 0..1 */
  strength: number;
}

/** Dynamic point light from plumes/flames, published by vfx. Anyone lighting custom shaders
 * (smoke, pad, deck, ocean, clouds) should add the top few of these. W positions. */
export interface PlumeLight {
  pos: THREE.Vector3;
  color: THREE.Color; // linear, includes intensity
  /** effective range (m) for falloff windowing */
  range: number;
}

/** Render layers. Post renders LAYER_DEFAULT (opaque + ordinary transparents) first, then copies
 * linear depth into ctx.sceneDepth, then renders LAYER_VFX (soft particles, plumes, volumetrics)
 * into the same HDR target with the scene depth buffer bound for depth testing (no depth write).
 * Objects must enable exactly one of these layers. */
export const LAYER_DEFAULT = 0;
export const LAYER_VFX = 1;

/** Linear view-space depth of the opaque pass of the CURRENT view (meters, R32F), for soft
 * particles / volumetrics. Valid only while LAYER_VFX renders. */
export interface SceneDepth {
  texture: THREE.Texture | null;
  /** render-target size in pixels (use gl_FragCoord.xy / resolution for UVs) */
  resolution: THREE.Vector2;
}

export type CameraMode =
  | 'chase'
  | 'onboard_down' // booster interstage cam looking down
  | 'onboard_engine' // S2 engine cam
  | 'long_lens' // ground/ship tracking telephoto with shimmer
  | 'deck' // camera on OCISLY deck / hull
  | 'orbit' // free orbit (mouse)
  | 'pad' // pad-side fixed cams
  | 'cinematic';

export interface ViewInfo {
  id: string;
  label: string;
  camera: THREE.PerspectiveCamera; // NOTE: always at the origin during render (floating origin)
  /** true W position of the camera (doubles) */
  camWorldPos: THREE.Vector3;
  focus: BodyId | null;
  mode: CameraMode;
  /** CSS-pixel rectangle on the canvas (animated during tiling transitions) */
  rect: { x: number; y: number; w: number; h: number };
  /** 0..1 opacity while a viewport spawns / merges away */
  alpha: number;
  /** long-lens atmospheric shimmer amount 0..1 (post applies) */
  shimmer: number;
  /** camera shake amplitude (applied by cameras); post may add blur */
  shake: number;
  /** true for cameras bolted to a vehicle (audio: structure-borne) */
  onboard: boolean;
}

/** Everything the frame loop drives. Each subsystem implements the relevant hooks. */
export interface FrameModule {
  /** once per rendered frame, after the sim advanced */
  update?(snap: SimSnapshot, dtReal: number): void;
  /** before each viewport render; the world root is already shifted by -view.camWorldPos */
  beforeViewRender?(view: ViewInfo, snap: SimSnapshot): void;
}

export interface AppContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /**
   * Floating-origin root. Put every W-positioned object in here with its true W position.
   * The app sets worldRoot.position = -view.camWorldPos before each viewport render,
   * so the camera sits at the origin and GPU coordinates stay small.
   * Camera-attached things (sky dome, stars) go directly in `scene`.
   */
  worldRoot: THREE.Group;
  /** W position subtracted for the current render (== current view camWorldPos) */
  renderOrigin: THREE.Vector3;
  settings: Settings;
  quality: QualityState;
  events: EventBus;
  lighting: LightingState;
  hazeSources: HazeSource[];
  plumeLights: PlumeLight[];
  /** set true in photo mode / replay so modules can hide UI-ish helpers */
  photoMode: boolean;
  sceneDepth: SceneDepth;
  /** replay playback in progress (sim frozen, snapshots from history) */
  replay: boolean;
  /** real seconds since page load */
  realTime: number;
  /** canvas CSS size */
  width: number;
  height: number;
}
