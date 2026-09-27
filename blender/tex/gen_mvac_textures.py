"""MVac niobium nozzle-extension surface maps (python3 blender/tex/gen_mvac_textures.py).

Layout (matches src/render/vehicles/secondStage.ts fixExtensionUVs): u = around the bell (the lathe's
strip u, 0..1, tileable), v = 0 at the regen joint (row 0) .. 1 at the exit plane.

  mvac_ext_albedo.jpg  512x256 sRGB MULTIPLIER (mean ~0.8 linear) for the dark matte grey-charcoal material
                       colour (R512E silicide coating, set in materials.ts): subtle vertical streaking, a faint
                       blue-violet oxide tint in the hot band below the joint and a warmer, slightly lighter
                       exit zone. Stored bright on purpose: an absolute charcoal albedo spans only ~6 8-bit
                       levels and its v gradients quantised into visible horizontal bands.
  mvac_ext_rough.jpg   512x256 data: G = roughness (0.6..0.85), same streak structure; R = B = 1.
"""
import numpy as np
from texlib import *  # noqa

W, H = 512, 256
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32) + 0.5
v = yy / H                                  # 0 = joint, 1 = exit

# vertical streaks: long along v (rows), thin around u (cols); all periodic in u
s1 = fnoise(H, W, 70, 1.1, seed=51)
s2 = fnoise(H, W, 30, 3.5, seed=52)
s3 = fnoise(H, W, 140, 9, seed=53)
blot = fbm(H, W, 18, 30, 3, seed=54)
streak = 0.5 * s1 + 0.35 * s2 + 0.3 * s3

MEAN = 0.8
alb = np.zeros((H, W, 3), np.float32) + MEAN
alb *= (1 + 0.075 * streak + 0.03 * blot)[..., None]
# hot band just below the joint: faint blue-violet temper tint; exit: slightly warmer / lighter
hot = np.exp(-((v - 0.12) / 0.14) ** 2)
alb = lerp(alb, alb * np.array([0.93, 0.95, 1.1], np.float32), hot[..., None] * 0.8)
ex = smoothstep(0.55, 1.0, v)
alb = lerp(alb, alb * np.array([1.12, 1.06, 0.98], np.float32), ex[..., None] * 0.7)
# dither half an 8-bit step so no smooth v gradient can quantise into rings
alb += (np.random.default_rng(55).random((H, W, 1)).astype(np.float32) - 0.5) * 0.004
save_srgb(np.clip(alb, 0, 1), 'mvac_ext_albedo.jpg', 92)

rough = np.clip(0.73 + 0.045 * streak + 0.02 * blot - 0.04 * hot, 0.55, 0.9)
one = np.ones_like(rough)
save_raw(np.stack([one, rough, one], -1), 'mvac_ext_rough.jpg', 92)
print('done')
