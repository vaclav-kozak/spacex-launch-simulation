# Model / texture assets (owner: models)

Everything in this area is procedural and generated from scripts in this repo. There are no third-party
meshes or photos.

| Output | Generator | Notes |
|---|---|---|
| `public/models/falcon9.glb` (~0.5 MB, Draco) + `falcon9_rig.json` | `blender -b --python blender/build_falcon9.py` | S1/S2/fairings/Starlink/parafoil, 3 LODs, named rig nodes |
| `public/models/ocisly.glb` (~0.1 MB, Draco) | `blender -b --python blender/build_ocisly.py` | droneship, `SHIP_L0..2` |
| `public/models/slc4e.glb` (~0.14 MB, Draco) | `blender -b --python blender/build_slc4e.py` | launch complex, `PAD_L0..2` + `PAD_COMMON` |
| `public/textures/vehicles/s1_*, s2_*, fairing_*, m1d_bell.jpg` | `python3 blender/tex/gen_f9_textures.py` | tank seams, markings, soot variants, bell heat tint |
| `public/textures/vehicles/ocisly_*.jpg` | `python3 blender/tex/gen_ocisly_textures.py` | deck (ring/X/scorch), hull strip with name |
| `public/textures/vehicles/pad_*.jpg` | `python3 blender/tex/gen_pad_textures.py` | tiling concrete, unique apron scorch map, gravel |
| `public/models/draco/*` | copied from `three/examples/jsm/libs/draco/gltf` | Google Draco decoder (Apache-2.0) |

* Shared mesh helpers are in `blender/lib/bgeo.py` (Blender 4.5, three.js coordinates) and shared texture
  helpers in `blender/tex/texlib.py` (numpy + Pillow).
* Text on textures (SPACEX, FALCON 9, OF COURSE I STILL LOVE YOU, MARMAC 300) is rasterised from the system
  URW base35 fonts (`/usr/share/fonts/opentype/urw-base35`, AGPL with font exception); no font files ship.
* Total size is ~1.5 MB of models plus ~3.1 MB of textures, well under the 80 MB budget.
