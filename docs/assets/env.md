# Environment assets (owner: env)

All runtime env assets are baked by two scripts in this repo:

* `python3 src/render/env/tools/prep_assets.py [--raw DIR] [step ...]` downloads the sources listed below
  into `.cache/env-raw/` (not shipped) and bakes the runtime files. The steps are
  `stars milkyway moon earth night clouds mask terrain coast`.
* `python3 src/render/env/tools/gen_cloud_noise.py` generates the procedural cloud noise. It needs only
  numpy, is deterministic (seed 1337), and takes about 25 s.

The total shipped size is about 40 MB: `public/textures/env` is about 20 MB and `public/data/env` is about 20 MB. `public/hdri` is empty
because the sky and the reflection probe are computed at runtime.

| Output | Source | License / attribution |
|---|---|---|
| `textures/env/earth_day.jpg` (8192x4096), `earth_day_reg.jpg` (4096², 18-42N 130-106W) | NASA Blue Marble Next Generation, July 2004 (`eoimages.gsfc.nasa.gov/.../74092/world.200407.3x21600x10800.jpg`, tile A1) | Public domain (NASA Earth Observatory) |
| `textures/env/earth_night.jpg` (8192x4096), `earth_night_reg.jpg` (2048²) | NASA Black Marble 2016 (`.../144898/BlackMarble_2016_3km.jpg`, tile A1) | Public domain (NASA Earth Observatory) |
| `textures/env/earth_clouds.jpg` (4096x2048) | NASA Blue Marble cloud composite (`.../57747/cloud_combined_8192.tif`) | Public domain (NASA Earth Observatory) |
| `textures/env/mask_global.png`, `mask_reg.png` (land/water + depth) | Derived from AWS Terrain Tiles (terrarium, z4 / z8) + Blue Marble | See terrain row |
| `textures/env/milkyway.jpg` | NASA SVS "Deep Star Maps 2020" `milkyway_2020_4k.exr` (svs.gsfc.nasa.gov/4851) | Public domain (NASA/Goddard SVS) |
| `textures/env/moon.jpg` | NASA SVS CGI Moon Kit, LROC colour `lroc_color_poles_1k.jpg` (svs.gsfc.nasa.gov/4720) | Public domain (NASA/Goddard SVS, LRO/LROC) |
| `data/env/stars.bin` (9k stars: RA/Dec/Vmag/B-V) | Yale Bright Star Catalogue 5th ed. (CDS V/50) | Public domain |
| `data/env/t1_height.bin`, `t2_height.bin` (int16 dm, 2048²) | AWS Terrain Tiles / Mapzen terrarium (z13 / z10) | Attribution: "Terrain Tiles: Mapzen / AWS Open Data; sources incl. USGS 3DEP/NED, SRTM, GMTED, ETOPO1" (mostly public domain, see github.com/tilezen/joerd/blob/master/docs/attribution.md) |
| `textures/env/t1_albedo.jpg`, `t2_albedo.jpg` (4096²) | EOX Sentinel-2 cloudless 2016 (WMTS `s2cloudless_3857`, z14 / z11) | **CC BY 4.0**, credit: "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)" |
| `data/env/cloud_shape.bin` (128³), `cloud_detail.bin` (32³), `cloud_weather.bin` (512² RGBA) | Procedural (Perlin-Worley / Worley fBm / Perlin), `gen_cloud_noise.py` | Generated in-house, no third-party data |
| `data/env/meta.json` | Written by `prep_assets.py` | n/a |

Notes
* The `coast` step cleans the terrarium DEM offshore. The source has flat 0 m tiles and positive
  interpolation blobs along the coast, and the old nodata fill left a fake plateau in the T2 corner. The step
  classifies water from the Sentinel-2 imagery, keeps only water connected to the open sea, and pushes
  it to ≤ -4 m so the ocean shader draws it. It is idempotent, and `terrain` runs it automatically.
* The credits UI should show the EOX line above. It is the only asset that requires attribution by license.
