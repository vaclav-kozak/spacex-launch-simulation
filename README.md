# Falcon 9 · Starlink · OCISLY

An interactive, cinematic, physically grounded 3D simulation of a Falcon 9 Block 5 Starlink launch from
SLC-4E (Vandenberg SFB). The first stage lands on the droneship *Of Course I Still Love You*. It runs in
the browser: Vite, TypeScript, three.js and Web Audio. Models are built procedurally in Blender.

## Run

```bash
npm install && npm start
```

`npm start` opens http://127.0.0.1:5173. The countdown starts at T−60 s on page load. Browsers block
autoplay audio, so click anywhere (the **CLICK FOR SOUND** prompt) to hear the engines and launch control.

Other scripts:

| Command | What it does |
|---|---|
| `npm run build` / `npm run preview` | Type-check, build a static bundle to `dist/`, and serve it |
| `npm run simtest` | Run the headless flight sim: the nominal mission plus off-nominal scenarios, with event timelines and outcomes |
| `python3 scripts/shot.py NAME "seek=505&cam=S1:deck" …` | Take headless GPU screenshots (Playwright + Chrome) |
| `python3 scripts/perf.py NAME "seek=150"` | Report CPU and GPU frame cost per scenario |

Requirements: Node 20+ and a WebGL2 GPU (float render targets). Chrome or Edge is recommended.

## What's simulated

**Flight physics (`src/sim`)** — 6-DOF rigid bodies. The sim runs on a fixed timestep, separate from
rendering, in an Earth-fixed rotating frame. It models:
- spherical Earth: μ/r² gravity, Coriolis and centrifugal forces
- US Standard Atmosphere 1976, extended to orbit
- wind profile with Dryden-style gusts
- Mach-dependent drag and lift tables for every body
- published Block 5 figures:
  - 9× Merlin 1D: 845 kN at sea level / 914 kN in vacuum, Isp 282/311 s, 40–100 % throttle
  - MVac: 981 kN, Isp 348 s
  - propellant loads, dry masses and a 22-satellite Starlink stack
- engine spool transients and pressure-dependent thrust

Guidance and control:
- **Ascent:** a gravity turn with a Max-Q throttle bucket.
- **Second stage:** closed-loop guidance to orbit.
- **Booster:** closed-loop recovery from its *actual* state and remaining propellant. Sequence: RCS flip,
  grid-fin deploy, ballistic coast, three-engine entry burn, grid-fin-steered aero descent, then a
  single-engine hoverslam timed from the predicted stopping distance. Legs deploy in the final seconds.
- **Touchdown:** judged against the moving deck of OCISLY. The deck heaves, pitches and rolls with the
  same Gerstner sea that the ocean renders.
- **Fairing halves:** tumble, reenter, then descend under drogues and parafoils to splashdown.
- **Droneship placement:** at startup a headless pre-sim of the nominal flight positions OCISLY about
  600 km downrange.

Your decisions change the outcome:
- **Manual stage separation:** early staging leaves the booster short of the ship, which can mean a
  splashdown, a boost-back or a break-up. It can also leave S2 suborbital.
- **Fairing separation:** early (payload overheats) or never (S2 carries dead mass).
- **Sea state and wind:** these make the landing harder.
- **Manual landing mode:** you fly the landing burn yourself.

**Visuals (`src/render`)**
- **Floating origin and logarithmic depth:** these keep the 0–700 km scene precise.
- **Vehicle, droneship and pad models:** built in Blender (`blender/`), with 3 LODs. The booster has an
  octaweb with 9 engines, a black interstage, titanium grid fins, carbon legs with pistons, N2 RCS pods
  and a flight-proven soot option. The MVac nozzle extension glows as it heats. The droneship and
  SLC-4E are modelled too.
- **Atmosphere:** physically based Rayleigh, Mie and ozone scattering, with transmittance and
  multiple-scattering LUTs. It includes aerial perspective, twilight and Earth's shadow, and fades to
  black with real stars and the Milky Way.
- **Earth:** a NASA Blue Marble / Black Marble globe with the atmospheric limb.
- **Terrain:** real terrain and imagery around Vandenberg.
- **Ocean:** Gerstner waves plus detail, with foam, sky reflections and sun glint.
- **Clouds:** a raymarched volumetric marine layer and cumulus. The clouds cast shadows, the plume lights
  them, and the rocket punches through them.
- **Plumes (VFX):** raymarched, and they change with ambient pressure:
  - sea level: bright core, shock diamonds, soot, massive lit steam at the pad
  - altitude: hugely expanded, with the twilight "jellyfish"
  - vacuum: near-invisible MVac plume
  - entry burn: the plume wraps ahead of the booster
  - landing burn: the plume impinges on the deck and throws sea spray
  - also: TEA-TEB green ignition flash, Max-Q condensation, RCS puffs, staging gas, plume-lit smoke and
    point lights
- **HDR post:** per-viewport auto-exposure, AgX tone mapping, bloom, heat haze and long-lens shimmer,
  camera motion blur, lens flare and ghosts, chromatic aberration, vignette, grain and SMAA. Quality
  adapts to frame time.

**Audio (`src/audio`)**
- **Engine sound:** synthesised in an AudioWorklet: sub-bass rumble, roar and Merlin crackle (skewed
  shock impulses).
- **Propagation:** each listening camera gets distance attenuation, ISO 9613 air absorption and
  speed-of-sound delay.
- **Thin air:** sound fades as the air thins. Onboard cameras switch to structure-borne rumble.
- **Other effects:** RCS puffs, sonic booms that reach the ship, deck and ambient beds.
- **Voices:** launch control and host callouts, generated offline with Kokoro TTS and radio-processed.

**Cameras (`src/cameras`)**
- **Split screen:** at stage separation the screen splits automatically into one viewport per object:
  second stage, booster and fairing. Viewports merge back when an object's story ends.
- **Camera modes** (per viewport): chase, onboard (booster looking down; S2 engine cam), long-lens
  ground/ship tracking with shimmer, deck cam, pad cams and free orbit.
- **Auto-director:** cuts to key moments, e.g. the deck cam for touchdown.
- **Viewports:** click one to maximise it; press Esc to restore.

## Controls

The **MISSION CONTROL** panel (top right) gives access to everything. Press **?** in the app for the
full list.

| Key | Action |
|---|---|
| Space | Pause / resume |
| L | Liftoff now (skip countdown) |
| H | Hold / resume countdown |
| S / F | Manual stage separation / fairing separation |
| 1–6, [ ] | Time warp 1×/2×/4×/8×/30×/100×. 30× and 100× only in coast phases; warp drops to 1× before key events |
| C | Cycle camera on the main viewport |
| Esc | Restore viewports / close dialogs / exit photo mode |
| P | Photo mode: free camera, exposure, FOV, capture PNG |
| R | Slow-motion replay of the touchdown |
| M | Mute |
| K | Manual landing mode. During the landing burn: W/S throttle, X cut, arrows and A/D steer |

The panel also sets time of day (morning / twilight / night), sea state, wind, the flight-proven sooty
booster and restart. An end-of-mission summary appears when the mission resolves.

**Render quality** (panel → RENDER QUALITY): AUTO (default) adapts to the frame rate. LOW / MED / HIGH /
ULTRA fix the level; each scales render resolution, cloud and plume ray-march resolution and steps, ocean
detail, particle budgets and post effects. The line under the selector shows the active level and fps. Your
choice is remembered between visits. `?quality=` overrides it.

### URL parameters (testing / screenshots)

| Parameter | Meaning |
|---|---|
| `seek=<s>` | Fast-forward to that mission time |
| `pause=1` | Start paused |
| `warp=<n>` | Start at that time warp |
| `tod=morning\|twilight\|night` | Time of day |
| `sea=0..6` | Sea state |
| `wind=<m/s>` | Wind speed |
| `soot=0\|1` | Flight-proven sooty booster off / on |
| `manual=1` | Manual landing mode |
| `quality=auto\|low\|medium\|high\|ultra` | Render quality |
| `cam=<BODY>:<mode>[:preset]` | Camera, e.g. `S1:deck`, `S2:onboard_engine`, `S1:long_lens`, `S1:pad:engine` |
| `director=0` | Turn off the auto-director |
| `hud=0` | Hide the HUD |
| `labels=0` | Hide viewport labels |

## Architecture

Read `ARCHITECTURE.md` first. It is the contract between subsystems: frames, floating origin, the frame
loop, render layers, lighting units and ownership. Each area also keeps notes in `docs/notes/<area>.md`.

```
src/core      shared contract: frames (W = Earth-fixed pad frame), vehicle spec, waves, snapshot types, events
src/app       frame loop, floating origin per viewport, adaptive quality, replay, actions
src/sim       6-DOF flight sim + GNC (headless; also runs in node for scripts/simtest.ts)
src/render    env (sky/earth/terrain/ocean/clouds) · vehicles (GLB rigs) · vfx (plumes/particles) · post (HDR)
src/cameras   viewports, rigs, director, labels
src/audio     Web Audio engine, worklet synth, propagation, callouts
src/ui        webcast HUD, controls, captions, manual-landing HUD, summary, photo mode
blender/      reproducible model and texture generators
tools/audio/  offline callout generation (Kokoro TTS) and audio analysis
```

## Known limitations

- SECO is at about T+8:59, later than the webcast's ~8:45. The published second-stage propellant load and
  MVac mass flow force a ~383 s burn.
- In the twilight coast shot, the far-field "jellyfish" shells are softer than real footage and have less
  filament structure. Clouds do not hide far plumes.
- On a 60 Hz display, AUTO quality tops out at HIGH because vsync caps the frame time. Pick ULTRA by hand
  if you want it.
- Perf targets were estimated for a GTX 1650-class GPU from RTX 5070 Ti measurements. Lower-end GPUs should
  use AUTO or LOW.

## Assets and licenses

All models, VFX textures and sound effects are generated procedurally by the scripts in this repo.
Third-party data, with details in `docs/assets/*.md`:

- NASA Blue Marble Next Generation, Black Marble 2016, Blue Marble clouds, SVS Deep Star Maps 2020
  (Milky Way) and CGI Moon Kit: public domain (NASA).
- Yale Bright Star Catalogue, 5th ed.: public domain.
- Terrain Tiles (Mapzen / AWS Open Data; sources include USGS 3DEP/NED, SRTM, GMTED and ETOPO1): see
  tilezen/joerd attribution.
- **Sentinel-2 cloudless — https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus
  Sentinel data 2016)**, CC BY 4.0.
- D-DIN font by Datto Inc., SIL OFL 1.1.
- Kokoro-82M TTS model and voices (Apache-2.0), used offline to generate callouts, run through
  kokoro-onnx (MIT).
- Google Draco decoder (Apache-2.0).

This is a fan-made simulation and is not affiliated with SpaceX.
