# Models notes (owner: models, `src/render/vehicles/**`, `blender/**`, `public/models/**`, `public/textures/vehicles/**`)

## Public API (App.ts contract unchanged)
`new VehicleVisuals(ctx)`, `load()`, `update(snap, dt)`, `beforeViewRender(view, snap)`. Extras:
* `object(id: BodyId)` → the scene group whose pose is written every update (S1, S2, FAIRING_A/B, PAYLOAD, SHIP).
* `materials` (`VehicleMaterials`: `m[name]`, `setSooty`, `setS1Heating`, `setMvacGlow`, `setEnvMap`), `shipVisual`, `padVisual`.
* `LAUNCH_MOUNT_HEIGHT = 4.0` (re-exported from `src/render/vehicles/rig.ts`): the nozzle exit stands 4 m above
  the pad surface at `PAD_ELEVATION`, which matches the sim's pre-launch `S1.pos.y = PAD_ELEVATION + 4`.
* Settings: `sootyBooster` and `timeOfDay` are followed via `SETTINGS_CHANGED`. Soot swaps albedo/ORM textures,
  and night/twilight turns on the pad floodlights (2 SpotLights, night only) and the ship's deck floods.
* LOD: 3 levels per body from projected size × `lodBias(ctx.quality.level)` = [2.0, 1.3, 1.0, 0.7].
  Bodies under ~0.3 px are hidden. The payload is drawn only once a fairing has opened.

## Frames / conventions used by the models
* Body frames follow `vehicleSpec.ts`: origin at the nozzle exit, +Y toward the nose, angle a in XZ = (cos a, 0, sin a).
  Legs sit at 0/90/180/270°, grid fins at 45/135/225/315°, S1 RCS pods at 90/270° with y 44.
* **Legs:** each rotates about the hinge axis (sin a, 0, −cos a) by `legs × 113.9°`. When fully deployed the feet
  reach footY −2 and span 18 m. The pistons are 3 telescoping segments that are recomputed every frame.
* **Grid fins:** deploy rotates each fin 90° about the same hinge-type axis. `gridFins.angles[i]` is the twist in
  radians about the fin's outward radial axis (right-hand rule). 0 = the fin plane contains the body axis.
* **MVac:** gimbal is `rotation.set(gimbalX, 0, gimbalZ, 'ZXY')` about the pivot at y 3.95. The niobium
  extension's glow is a function of sim time, so it is seek-safe. It heats with τ = 11 s after `engines[0].ignitionT`
  (emissive up to ~20) and cools with τ = 22 s after the SECO marker.
* **Fairing halves:** A is on +X and B on −X of the S2 frame. The parafoil canopy is ~45 m above the half along
  the local vertical. It inflates with `parafoil` 0..1 and its lines run to the half's nose.
* **Starlink stack:** 22 instanced sats. Deploy drift is deterministic (hash per sat): radial 1–4 cm/s, axial
  spread and a slow tumble. It is timed from the done `PAYLOAD_DEPLOY` marker, so seek works.
* **Ship frame (OCISLY):** origin = deck centre / landing aim point at deck level. +Y is up, +Z the bow and
  +X port. The deck is 3.2 m above the waterline and 91.4 × 52 m with the wings (z ∈ [−30, 38]).
  Aft blast wall at z −30.6. Thrusters are at (±11.8, ±42.3). Port lights are red and starboard green.

## SLC-4E pad (for VFX / cameras / env)
Pad frame = W shifted to (0, PAD_ELEVATION, 0).
* **Flame duct:** the opening under the mount is a dark 6 × 8 m slab aligned with the trench. The duct is
  covered and "underground": terrain hides anything below the pad surface.
* **Trench exit:** a headwall with a dark mouth plus flared wing walls at heading 200°, 40–52 m out, matching
  `vfx/emitters.ts` `TRENCH_EXIT`. A gravel berm covers the last 17 m of the duct. The mouth is at grade
  (0–2.9 m), not 9 m deep. VFX's 9 m impingement plane is fine because anything below 0 is hidden, but fire
  and smoke should leave the mouth at y ≈ 0–3 m.
* **Launch mount:** a steel frame of 4 columns at (±4.6, ±4.6) with beams on the W/N/E sides; the south is open.
  The octagonal table (r 2.05–3.4) is at y 4.8–5.25 with 4 hold-down clamps at 45/135/225/315°.
* **TE:** the strongback is on the north side (pivot (0, 5.2, −7.4)), leaning back 3°, top ~71 m. Rails at
  x ±5 run north to the hangar (z −130..−225).
* **Other structures:**
  * Lightning towers (88 m) at heading/distance 300°/30 m (next to the cameras' "tower" pad cam), 30°/48,
    120°/48 and 215°/48. Catenary wires join their tops.
  * Floodlight masts (38 m) at (−70, −60), (75, 40), (70, −65) and (−65, 55).
  * Water tower at 250°/150 m; propellant farm at 110°/105 m.
* **Camera clearance:** the cameras' pad presets (wide 64°/380 m, tower 300°/26 m/58 m, engine 205°/17 m/1.4 m,
  up 118°/7.8 m/1.1 m) were checked and none of them is blocked.
* **Apron:** 160 × 160 m of concrete at +0.08 m with a baked unique scorch/stain map. Roads and slabs sit at
  +0.06 m on top of env's flattened terrain (60 m within r 320 m).

## Env
* Every vehicle, pad and ship material is `MeshStandardMaterial` with no `onBeforeCompile` of its own (soot and
  heat work through texture/emissive swaps), so aerial.ts patching and chaining applies cleanly.
  `materials.setEnvMap(env)` is available if a probe should be pinned; otherwise `scene.environment` is used.

## Requests / known gaps
* **Sim (seen 2026-09-27):** in a real run at `?seek=505` S1 was still `stacked` / ASCENT at 308 km, so the
  deck cam showed an empty deck. Landing visuals were verified with `camfake=1`.
* **VFX:** consider moving the pad impingement plane from −9 m to the pad surface under the mount, or keep it.
  Visually both work because the duct opening is opaque black at the surface.
