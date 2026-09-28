# Models notes (owner: models, `src/render/vehicles/**`, `blender/**`, `public/models/**`, `public/textures/vehicles/**`)

## Public API (App.ts contract unchanged)
`new VehicleVisuals(ctx)`, `load()`, `update(snap, dt)`, `beforeViewRender(view, snap)`. Extras:
* `object(id: BodyId)` → the scene group whose pose is written every update (S1, S2, FAIRING_A/B, PAYLOAD, SHIP).
* `materials` (`VehicleMaterials`: `m[name]`, `setSooty`, `setS1Heating`, `setMvacGlow`, `setEnvMap`), `shipVisual`, `padVisual`.
* `LAUNCH_MOUNT_HEIGHT = 4.0` (re-exported from `src/render/vehicles/rig.ts`): the nozzle exit stands 4 m above
  the pad surface at `PAD_ELEVATION`, which matches the sim's pre-launch `S1.pos.y = PAD_ELEVATION + 4`.
* Settings: `sootyBooster` and `timeOfDay` are followed via `SETTINGS_CHANGED`. Soot swaps albedo/ORM textures,
  and night/twilight turns on the pad floodlights (2 SpotLights: night 1.6e4, twilight 0.15 of that, per
  look-dev) and the ship's deck floods.
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
  extension's glow is a pure function of sim time (seek-safe). `secondStage.ts` computes the hottest-band
  temperature. During the burn it approaches the steady state with τ 7 s after `engines[0].ignitionT`: dull red after ~6 s,
  orange by ~15 s, full by ~30 s. The steady state is ~1480 K × throttle^0.25. After the SECO marker it cools as a
  radiating sheet, T = (T0^-3 + 3aT)^(-1/3): ~1000 K after 12 s and below visible after ~30 s.
  `materials.setMvacTemperature` maps T to a HalfFloat blackbody ramp along the bell (v 0 = regen joint, hottest
  → v 1 = exit, dull red / dark). Radiance = `GLOW_PEAK · (L/Lref)^GLOW_GAMMA` with GLOW_PEAK 0.35 and gamma 0.8.
  **This replaces the old "emissive 4..20" contract.** With sun = 6 (sunlit white ≈ 1.5), a physical 1480 K niobium
  surface is ~0.3–0.4 units. Values of 4–20 sit above the auto-exposure's metered percentile window, so the bell
  blew out through AgX into a white/peach ball. The extension material is matte charcoal (roughness 0.72); the
  glossier R512E setting read as a lilac mirror after SECO.
  Surface maps `mvac_ext_albedo.jpg`/`mvac_ext_rough.jpg` (`blender/tex/gen_mvac_textures.py`) carry only vertical
  streaks. `fixExtensionUVs` rewrites v (height) but keeps the lathe's around-the-bell u. The old constant u = 0.5
  sampled a single column of a 2D noise roughness map, so roughness varied with height only and the sunlit bell
  showed horizontal rings. The albedo is a bright multiplier (mean ~0.8) with the tone set in `color`, because an
  absolute charcoal map spans only ~6 8-bit levels and its gradients would quantise into bands.
* **MVac inner glow (round 4):** looking up into the bell now shows engine light: yellow-white at the throat,
  orange down the regen wall, fading into the extension.
  * **Runtime mesh.** The GLB regen section (y 2.4 → 3.6 in S2 coordinates) is a single-sided outer skin, so the
    sky used to show through it. `secondStage.ts` `addRegenInner` adds its inner wall to LOD 0/1: a 13-point
    lathe, the build_falcon9.py profile minus the 12 mm skin, plus a throat disc. The material is
    `MVac_RegenInner`: sooty copper, **BackSide** (so it never shows through the outer skin), no shadows.
  * **Drive.** `SecondStageVisual.gas` = spool^1.3 × (0.35 + 0.65 × throttle). It is 0 before `ignitionT` or
    while stacked, and it drops with the spool at cutoff.
    `setMvacTemperature(Thot, gas)` updates three ramps:
    * outer extension: blackbody wall, unchanged;
    * `MVac_ExtInner`: the same wall term + `MVAC_GAS.ext`, 1650 K, I 0.45·e^(−v/0.22) from the joint;
    * `MVac_RegenInner`: `MVAC_GAS.regen` only, T 1750 → 2600 K, I 0.5 → 6 at the throat.
  * **Units.** The throat is ~6 units, inside the ARCHITECTURE hot-nozzle 4–20 range. It stays small on screen
    and is only visible down the axis. The outer glow keeps GLOW_PEAK 0.35.
  * **Visibility.** `onboard_engine` does not see into the bell, so its anchored exposure is unchanged.
  * **Shots.** `shots/r4c/mv/up_crop_sheet.png` (in-app S2 orbit from behind, night/twilight/morning, T+180),
    `v_sheet.png` (models viewer), `ob_sheet.png` (engine cam, unchanged).
* **S1 heating:** grid fins never glow (their tips never reach visible temperatures). Engine bells and the
  octaweb get a dull-red glow only during and just after the entry burn, driven from the burn in
  `VehicleVisuals.ts` (`s1Glow`) and not from dynamic pressure.
* **Fairing halves:** A is on +X and B on −X of the S2 frame. The parafoil canopy is ~45 m above the half along
  the local vertical. It inflates with `parafoil` 0..1 and its lines run to the half's nose.
* **Starlink stack:** 22 instanced sats. Deploy drift is deterministic (hash per sat): radial 1–4 cm/s, axial
  spread and a slow tumble. It is timed from the done `PAYLOAD_DEPLOY` marker, so seek works.
* **Ship frame (OCISLY):** origin = deck centre / landing aim point at deck level. +Y is up, +Z the bow and
  +X port. The deck is 3.2 m above the waterline and 91.4 × 52 m with the wings (z ∈ [−30, 38]).
  Aft blast wall at z −30.6. Thrusters are at (±11.8, ±42.3). Port lights are red and starboard green.
* **OCISLY deck floods (round 5, `droneship.ts`):** there are six pole heads (x ±25.4, y 6.6, z −20/4/28), aimed
  at the deck centre, warm white (1, 0.84, 0.64). One head is `FLOOD_I` = 9 at night (irradiance = I cos/d²; the
  moon is ~0.01, the twilight sky at the ship ~1e-4). They are on at night (k 1) and at twilight (k 0.9, since the
  ship is past nautical twilight at landing), and off in the morning. The head emissive is 60·k and blooms. The light
  comes from two cheap parts:
  * **Deck lightmap** (`bakeDeckLight`): a 128×224 sRGB DataTexture baked at load from the six heads
    (Gaussian beam exp(−(θ/0.58)²) · cos/d²), with channel 0 = the deck UVs (u = (26 − x)/52, v = (45.7 − z)/91.4).
    It is on `Ship_Deck` as `lightMap`, intensity k·9·peak. It gives pools of light, the lit landing circle
    and dark gaps between the poles. The cost is one texture fetch.
  * **Two shadowless SpotLights** on the diagonal poles (starboard-aft (−25.4, −20) and port-bow (25.4, 28)),
    at 6.9 m, aimed 17 m up the booster's station, with I = 4.5·9·k, range 150 and a cone of 0.62. They light the
    landed or descending booster (and the deck hardware) from two sides. They live in the ship group, so they
    are counted only in views that show the ship, and the pad's two spots are never in such a view: every lit
    material keeps the 0- or 2-spot variant that the pad already compiled at liftoff.
  * Perf (`perf.py`, paused, floods on vs off): deck cam at T+508 GPU scene 1.86 vs 1.80 ms (ultra) and
    0.26 vs 0.26 ms (low); ship_orbit 1.32 vs 1.21 ms (ultra). That is within noise.
  * Not done: the flood reflections on the ocean (earth.ts `oceanSpec` only takes plume lights), the booster's
    shadow in the lightmap, and wet-deck roughness.

## SLC-4E pad (for VFX / cameras / env)
Pad frame = W shifted to (0, PAD_ELEVATION, 0).
* **Flame duct:** the opening under the mount is a dark 6 × 8 m slab aligned with the trench. The duct is
  covered and "underground": terrain hides anything below the pad surface.
* **Trench exit:** a headwall with a dark mouth plus flared wing walls at heading 200°, 40–52 m out, matching
  `vfx/emitters.ts` `TRENCH_EXIT`. A gravel berm covers the last 17 m of the duct. The mouth is at grade
  (0–2.9 m), not 9 m deep. VFX's 9 m impingement plane is fine because anything below 0 is hidden, but fire
  and smoke should leave the mouth at y ≈ 0–3 m.
* **Launch mount (detailed 2026-09-27, `blender/build_slc4e.py`):**
  * Frame: four built-up I-columns on footings with base plates, bolts and gussets at (±4.6, ±4.6). Stiffened
    I-girders sit on the W/N/E sides with X-bracing on those faces. The **south stays open** for the engine cam.
  * Table and deck: the table ring (r 2.05–3.4, y 4.8–5.25, sooted `Pad_SteelSoot`) is fed by I-beam cross beams.
    Grating walkways (`Pad_Grating`, y 4.73) with yellow handrails run on three sides, with a stair down the west side.
  * Hold-down clamps (45/135/225/315°): base block, jaw, cheek plates with pivot pin, hydraulic cylinder and
    rod, accumulator and hose.
  * Deluge: a sooted spray header (r 3.0, y 4.42) with 12 nozzles and risers, plus the ground deluge ring (r 10).
  * Services: the T-0 umbilical box (panel doors, QD plate). A cable tray and a pipe rack run on stands from the
    TE base (z −26) to the box: LOX (white, insulated), RP-1, GN2 and He.
* **Weathering:** steel, TE, pipe, white, yellow and tower materials use box-projected world UVs (4 m tiles,
  written by `box_uvs()` in the builder) with the tiling `pad_grime_albedo/rough.jpg`: rain streaks, soot
  blotches and rust bleed. Grating uses `pad_grating_albedo.jpg` (1 m tiles). Generator: `blender/tex/gen_pad_textures.py`.
* **Budget:** PAD_L0 has 9.3k faces (mostly quads), L1 2.3k and L2 0.8k. GLB 271 KB. Measured GPU (RTX 5070 Ti, 1080p, q2,
  scene pass incl. shadows): pad 0.19 ms at the pad cams, of which the new detail is +0.02–0.06 ms. Vehicles +
  pad + ship together cost 0.07–0.24 ms. Scaled ×8–10 for a GTX 1650 that is ~0.6–0.9 ms for vehicles + pad +
  ship on a normal shot, and up to ~2 ms on the pad close-ups at q2 (quality auto drops shadows there).
* **TE:** the strongback is on the north side (pivot (0, 5.2, −7.4)), leaning back 3°, top ~71 m. Rails at
  x ±5 run north to the hangar (z −130..−225). L0 detail:
  * Structure: built-up chords with 20 frames; K-braced wide faces, diagonals on the narrow faces, gusset plates.
  * Access: service decks every 4 levels, a caged ladder on the back face, a top-platform rail and pivot
    pedestals with pins.
  * Arms: 4 retracted truss umbilical arms with hinge blocks, carrier plates and sagging hose bundles.
  * Vehicle-face risers: insulated LOX, RP-1, pneumatics and a cable tray.
* **Other structures:**
  * Lightning towers (88 m) at heading/distance 300°/30 m (next to the cameras' "tower" pad cam), 30°/48,
    120°/48 and 215°/48. Catenary wires join their tops.
  * Floodlight masts (38 m) at (−70, −60), (75, 40), (70, −65) and (−65, 55).
  * Water tower at 250°/150 m; propellant farm at 110°/105 m.
* **Camera clearance:** the cameras' pad presets were checked and none of them is blocked: wide 64°/380 m,
  tower 300°/26 m/58 m, engine 205°/17 m/1.4 m, and up, which now stands on the east walkway at 100°/4.4 m/5.3 m.
* **Apron:** 160 × 160 m of concrete at +0.08 m with a baked unique scorch/stain map. Roads and slabs sit at
  +0.06 m on top of env's flattened terrain (60 m within r 320 m).

## Env
* Every vehicle, pad and ship material is `MeshStandardMaterial` with no `onBeforeCompile` of its own (soot and
  heat work through texture/emissive swaps), so aerial.ts patching and chaining applies cleanly.
  `materials.setEnvMap(env)` is available if a probe should be pinned; otherwise `scene.environment` is used.

## Requests / known gaps
* **Look-dev:**
  * Pink booster at twilight (~75 km): not material-related. S1 albedo and ORM are neutral; the tint comes from
    the sky / aerial light.
  * After SECO the S2 engine cam meters the dark, unlit bell to mid-grey (exposure ~×27), so it reads as a
    pale lilac ball. The director now leaves the engine cam 13 s after SECO. A fixed-ish exposure for
    `onboard_engine` would be more faithful (real engine cams keep the bell dark once the glow fades).
  * The MVac glow reads peachier whenever the frame holds little Earth, because the meter lifts it.
* **VFX:** the MVac plume haze is drawn over the lower bell in the engine cam (the bell should occlude its
  own inner plume).
* **Sim (seen 2026-09-27):** in a real run at `?seek=505` S1 was still `stacked` / ASCENT at 308 km, so the
  deck cam showed an empty deck. Landing visuals were verified with `camfake=1`.
* **VFX:** consider moving the pad impingement plane from −9 m to the pad surface under the mount, or keep it.
  Visually both work because the duct opening is opaque black at the surface.

## MVac extension glow, round 5 (plume agent)
* The heat-up after SES-1 uses `TAU_HEAT` 4.5 s (was 7), matching a ~1 mm radiatively cooled Nb sheet. The
  bell is dull red at +3 s, orange at +7 s and bright at +12 s. The steady-state profile `MVAC_T.ss` keeps the
  lip at ~1080 K (was ~950 K), so the exit rim stays a dull cherry red at full thrust.
* The display mapping is `GLOW_PEAK 1.8 x (L/Lref)^1.0`. L is Wien at 0.75 um (`GLOW_KCAM`: an IR-leaky camera
  red), not photopic. At the engine cam's anchored exposure (x3.05, read via `PostPipeline.readExposure`)
  the hot band maps ~2.5 stops over mid grey (AgX pale yellow-orange), mid-bell ~0.8 (saturated orange) and
  the lip ~0.05 (dim red). Anything much brighter goes to a peach ball through AgX.
* A shared uniform `uReflK` (onBeforeCompile on `MVac_Ext` / `MVac_ExtInner`) fades the extension's reflected
  sun and sky light to 15 % as the hot band passes 800 -> 1350 K, and brings it back while cooling. The grey
  sheen was mostly the rough coating's grazing sun specular (~0.07 pre-tonemap even at black albedo). It
  turned the orange salmon. The real engine cam's auto exposure hides it.
* Post-SECO: the director's 7.5 s night hold still ends on a dim red bell (~1100 K).
