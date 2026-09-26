// Screen-size based LOD selection. OWNER: models.
import * as THREE from 'three';
import type { ViewInfo } from '../../core/context';

const _v = new THREE.Vector3();

/**
 * Projected size (CSS px) of an object of characteristic size `size` (m) at W position `pos`
 * seen from `view` (camera at camWorldPos; floating origin).
 */
export function projectedPx(view: ViewInfo, pos: THREE.Vector3, size: number): number {
  const d = Math.max(0.1, _v.copy(pos).sub(view.camWorldPos).length());
  const cam = view.camera;
  const f = (view.rect.h * (cam.zoom || 1)) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  return (size / d) * f;
}

/** quality 0..3 -> LOD bias (>1 switches to coarser levels earlier) */
export function lodBias(level: number): number {
  return [2.0, 1.3, 1.0, 0.7][level] ?? 1;
}

/**
 * Pick a level: 0 (full) when the object covers more than `px0` px, 1 above `px1`, else 2;
 * -1 = cull (smaller than `pxCull`).
 */
export function pickLod(px: number, bias: number, px0: number, px1: number, pxCull = 0.3): number {
  if (px < pxCull) return -1;
  if (px > px0 * bias) return 0;
  if (px > px1 * bias) return 1;
  return 2;
}
