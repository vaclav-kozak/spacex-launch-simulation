# Architecture — Falcon 9 / OCISLY simulation

Full product spec: `prompt.txt`. This file is the contract between subsystems.

## Stack
Vite + TypeScript + three.js r186 (WebGLRenderer, logarithmic depth buffer) + `postprocessing`.
Blender 4.5 (headless, `blender -b --python ...`) for models/bakes. Run: `npm start`.

## Frames & precision (src/core/frames.ts)
* **W frame**: Earth-fixed, origin at sea level below SLC-4E, +X east, +Y up, +Z south (at the pad).
  Earth center `(0,-R,0)`, spherical Earth R = 6 371 km. All sim state and all render positions use W
  (JS doubles). Far from the pad use `upAt(p)` / `enuAt(p)` — +Y is not up 600 km downrange.
* **Sim** integrates in W as a rotating frame (gravity μ/r² + Coriolis + centrifugal via `EARTH_OMEGA_W`).
  Air is at rest in W (+ wind). Webcast speed = inertial speed.
* **Floating origin**: every W-positioned object lives under `ctx.worldRoot` at its true W position. Before
  each viewport render the app sets `worldRoot.position = -view.camWorldPos`, camera at (0,0,0).
  `ctx.renderOrigin` holds the subtracted W position. Shaders needing absolute W coords (wave phase, terrain)
  add `renderOrigin` via uniforms (split hi/lo or modulo where precision matters).
* **Body frame**: +Y along the vehicle axis toward the nose; origin = the stage's nozzle-exit plane center
  (`vehicleSpec.ts`). SHIP origin = deck center on the deck surface, +Y up, +Z toward the bow.
  Stacked bodies' poses are filled in by the sim, so renderers never compose offsets themselves.

## Loop (src/app/App.ts)
```
sim.advance(dtReal)      // fixed timestep inside, warp/pause/hold, interpolated snapshot
snap = sim.getSnapshot() // or history.sample(t) during replay
env.update, vehicles.update, vfx.update(snap, dt)
views.update(snap, dt)   // cameras, tiling rects, director
audio.update(snap, views.primaryView(), dt); hud.update(snap, views.views, dt)
for view of views.views:
   worldRoot.position = -view.camWorldPos
   env/vehicles/vfx.beforeViewRender(view, snap)
   postPipeline[view.id].render(view)     // draws into view.rect on the canvas
```
URL params (tests/screenshots): `seek=<missionT>` `pause=1` `warp=<n>` `cam=<BODY>:<mode>` `tod=` `sea=`
`wind=` `soot=0|1` `manual=1` `quality=` `hud=0` `shot=1`. `window.__app` exposes the App
(`__app.actions.*`, `__app.sim`, `__app.frame(dt)`).
Screenshots: `python3 scripts/shot.py --out shots/<area> NAME "query" [NAME "query"...]`
(headless Chrome on the real GPU; dev server at http://127.0.0.1:5173).

## Ownership (edit only your area; request contract changes in `docs/notes/<area>.md`)
| Area | Paths | Public API used by others |
|---|---|---|
| integrator | `src/app/**`, `src/core/*` (except types.ts), `src/main.ts`, `index.html`, `ARCHITECTURE.md`, `README.md` | `AppContext`, `AppActions` |
| sim | `src/sim/**`, `src/core/types.ts` (additive changes only), `scripts/simtest.ts` | `Simulation`, `SimSnapshot`, events |
| models | `src/render/vehicles/**`, `blender/**`, `public/models/**`, `public/textures/vehicles/**` | `VehicleVisuals` |
| env | `src/render/env/**`, `public/textures/env/**`, `public/hdri/**`, `public/data/env/**` | `Environment`, `ctx.lighting`, `aerial.ts` |
| vfx | `src/render/vfx/**`, `public/textures/vfx/**` | `VFX`, `ctx.hazeSources`, `ctx.plumeLights` |
| post | `src/render/post/**` | `PostPipeline`, `ctx.sceneDepth` |
| cameras | `src/cameras/**` | `ViewportManager` (+ director) |
| audio | `src/audio/**`, `public/audio/**`, `tools/audio/**` | `AudioEngine` |
| ui | `src/ui/**`, `public/fonts/**` | `HUD` |

Assets: list every external asset (source URL + license) in `docs/assets/<area>.md`.

## Cross-cutting contracts
* **Lighting units** (`SUN_INTENSITY` in context.ts): linear HDR, sun ≈ 6, sky ambient ≈ 1–2, plume core
  60–150, MVac hot nozzle 4–20, moonlit night ≈ 0.01. Post auto-exposure maps to display. No tone mapping
  anywhere except post.
* **Aerial perspective**: `render/env/aerial.ts` (`aerialUniforms`, `AERIAL_GLSL` with
  `aerialApply/aerialTransmittance/aerialInscatter(rel)`, `patchMaterial`). Env patches built-in materials
  under worldRoot automatically; custom shaders include the GLSL and share the uniform objects.
* **Layers**: `LAYER_DEFAULT` (0) opaque + ordinary; `LAYER_VFX` (1) soft particles/plumes/volumetrics,
  rendered after a linear-depth copy (`ctx.sceneDepth.texture`, R32F meters) with depth test, no depth write.
* **Plume lights**: vfx publishes `ctx.plumeLights` (W pos, linear color×intensity, range) every frame and also
  owns ≤3 real `THREE.PointLight`s so standard materials (pad, deck, vehicle) are lit by the flame. Custom
  shaders (smoke, ocean, clouds) read `ctx.plumeLights`.
* **Heat haze**: vfx publishes `ctx.hazeSources` (W segments); post projects them and distorts.
* **Waves**: `core/waves.ts` `getWaveSet(seaState, windFrom)` + `sampleWaves` is the single source of truth
  for the low-frequency sea surface: ocean shader and ship motion both use it.
* **Adaptive quality**: `ctx.quality.level` 0..3 and `renderScale`; every module scales its cost.
  Budget at 1080p on a mid-range laptop GPU (GTX 1650 / RTX 3050 class): env ≤ 5 ms (sky+ocean+clouds),
  vfx ≤ 3 ms, post ≤ 3 ms, vehicles/pad/ship ≤ 1.5 ms, total ≤ 14 ms. Dev box is an RTX 5070 Ti — 60 fps
  there proves little; check `quality=low` cost too.
* **Events**: `ctx.events` (EventBus) — sim emits `SimEvent`s (see core/types.ts). Callout text arrives as
  `CALLOUT` events; audio speaks them, UI captions them.
