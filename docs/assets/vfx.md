# VFX assets (owner: vfx)

No external assets are used. Every VFX texture is generated procedurally by
`src/render/vfx/tools/gen_textures.py` (numpy + Pillow). They are original work, CC0:

| File | What | Generator |
|---|---|---|
| `public/textures/vfx/puffs.png` | 1024x512 atlas of 4x2 smoke puffs. RGB: sprite normal xy + AO/thickness; A: density. Row 0: billowy "cauliflower" puffs (variants 0-3). Row 1: wispy / thin gas (variants 4-7) | `gen_textures.py` (fBm + Worley billows) |
| `public/textures/vfx/noise3d_64.bin` | 64^3 RGBA8 tileable 3D noise, raw bytes. R: Perlin fBm, G: inverted Worley fBm, B: high-frequency Perlin, A: curl-ish Perlin | `gen_textures.py` |

Regenerate: `python3 src/render/vfx/tools/gen_textures.py` from the project root.
