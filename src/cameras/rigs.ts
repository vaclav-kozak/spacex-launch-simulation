// Camera rigs: one class per CameraMode. Each rig writes view.camWorldPos (W doubles),
// view.camera.quaternion / fov, view.shake, view.shimmer, view.onboard. The ViewportManager then
// adds shake jitter and sets aspect/near/far. All tracking lags run in MISSION time (dtSim), so
// replay (0.25x) looks like real slow motion and warp keeps the target framed. OWNER: cameras.
import * as THREE from 'three';
import type { CameraMode, ViewInfo } from '../core/context';
import type { BodyId, SimEventType, SimSnapshot } from '../core/types';
import { PAD_ELEVATION } from '../core/constants';
import { altitudeOf, enuAt, pointAlongAzimuth, upAt } from '../core/frames';
import { F9, OCISLY, MERLIN_1D, MERLIN_VAC } from '../core/vehicleSpec';
import {
  RAD, bodyFraming, clamp, isStacked, clampAboveSurface, expK, lerp, lookQuat, noise1, plumeLength,
  smoothDampScalar, smoothDampVec, smoothstep, travelBasis, type Framing,
} from './util';

export interface RigInput {
  snap: SimSnapshot;
  focus: BodyId;
  /** mission-time step (0 when paused) */
  dtSim: number;
  dtReal: number;
  /** real seconds (ctx.realTime) */
  time: number;
  aspect: number;
  /** actual/predicted mission time of an event (undefined if unknown) */
  evT: (type: SimEventType) => number | undefined;
}

const S1_FULL_THRUST = 9 * MERLIN_1D.thrustSL;
const CHASE_FOV_MAX = 48;
/** hard cap on the chase camera's distance from the body centre (m) */
const CHASE_MAX_DIST = 250;

/** shake angular amplitude (rad at view.shake = 1) and frequency (Hz) per mode */
export const SHAKE_PROFILE: Record<CameraMode, { amp: number; freq: number }> = {
  chase: { amp: 0.0045, freq: 6 },
  onboard_down: { amp: 0.0065, freq: 21 },
  onboard_engine: { amp: 0.005, freq: 19 },
  long_lens: { amp: 0, freq: 9 }, // rig applies its own fov-scaled jitter
  deck: { amp: 0.014, freq: 11 },
  pad: { amp: 0.012, freq: 13 },
  orbit: { amp: 0, freq: 1 },
  cinematic: { amp: 0.003, freq: 5 },
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const _eul = new THREE.Euler();

export abstract class Rig {
  abstract readonly mode: CameraMode;
  preset = '';
  protected fresh = true;
  protected fr: Framing = { center: new THREE.Vector3(), size: 1, axis: new THREE.Vector3() };
  reset(): void { this.fresh = true; }
  abstract update(view: ViewInfo, inp: RigInput): void;
  /** secondary label text, e.g. "SUPPORT SHIP" */
  describe(): string { return ''; }
  protected aimAt(view: ViewInfo, target: THREE.Vector3, up?: THREE.Vector3): void {
    const d = _v1.copy(target).sub(view.camWorldPos);
    lookQuat(d, up ?? upAt(view.camWorldPos, _v2), view.camera.quaternion);
  }
}

// ---------------------------------------------------------------------------------------------
// CHASE: spring-follow with lag; offset depends on flight phase.

export class ChaseRig extends Rig {
  readonly mode = 'chase' as const;
  private off = new THREE.Vector3();
  private offVel = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookVel = new THREE.Vector3();
  private prevVel = new THREE.Vector3();
  private acc = new THREE.Vector3();
  private fov = 40;
  private fovVel = { v: 0 };
  /** dolly-out factor when the framing would need a wider lens than FOV_MAX (close, plume-heavy phases) */
  private pull = 1;
  private pullVel = { v: 0 };
  private orbitAz = 0;
  private f = new THREE.Vector3();
  private side = new THREE.Vector3();
  private up = new THREE.Vector3();

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, focus, dtSim } = inp;
    const b = snap.bodies[focus];
    const fr = bodyFraming(snap, focus, this.fr);
    const L = fr.size;
    const speed = b.vel.length();
    const f = this.f;
    const w = smoothstep(15, 90, speed);
    f.copy(fr.axis).multiplyScalar(1 - w);
    if (speed > 1e-3) f.addScaledVector(b.vel, w / speed);
    if (f.lengthSq() < 1e-9) f.copy(fr.axis);
    f.normalize();
    travelBasis(fr.center, f, this.side, this.up);
    const side = this.side, up = this.up;

    const plume = plumeLength(snap, focus);
    const R = Math.max(L, plume * 0.3); // framing radius grows with the plume at altitude
    let back = 1.6, sideD = 0.9, upD = -0.2, lead = 0.1, smooth = 1.1, orbitMode = false;
    /** share of the constraining frame dimension the body (+ visible plume) should fill */
    let fill = 0.82;
    /** offsets relative to the HORIZONTAL travel direction instead of the velocity (descent phases:
     * the velocity points at the ground, so "behind" would put the camera straight overhead) */
    let level = false;
    const phase = focus === 'S1' ? b.phase : undefined;
    const tSep = inp.evT('STAGE_SEP');
    if (focus === 'S1' && isStacked(snap)) {
      // ascent: slightly below / side, looking up the plume
      back = 1.5; sideD = 0.85; upD = -0.25;
      if (b.altitude > 25_000) { back = 1.7; sideD = 1.1; upD = 0.1; }
    } else if (focus === 'S1') {
      const since = tSep !== undefined ? snap.t - tSep : 999;
      if (b.status !== 'free') orbitMode = true;
      else if (phase === 'FLIP' || (phase === 'COAST' && since < 45)) {
        back = 0.25; sideD = 2.3; upD = 0.45; smooth = 1.8; lead = 0; fill = 0.66; // broadside: see the flip + RCS
      } else if (phase === 'COAST' || phase === 'ASCENT') {
        back = 1.4; sideD = 1.3; upD = 0.5; smooth = 2; fill = 0.7;
      } else if (phase === 'ENTRY_BURN') {
        // three-quarter from above the horizon: engines, the plume punching into the flow, the glow
        level = true; back = 0.55; sideD = 1.45; upD = 0.45; smooth = 1.3; fill = 0.82;
      } else if (phase === 'AERO') {
        // side-on, level with the booster: the horizon runs behind it, ocean below, fins steering
        level = true; back = 0.45; sideD = 1.5; upD = 0.12; smooth = 1.2; lead = 0.06; fill = 0.8;
      } else if (phase === 'LANDING_BURN') {
        level = true; back = 0.4; sideD = 1.35; upD = 0.05; smooth = 0.9; lead = 0.04; fill = 0.8;
      } else if (phase === 'LANDED' || phase === 'LOST') orbitMode = true;
    } else if (focus === 'S2') {
      back = 2.3; sideD = 0.9; upD = 0.35;
      if (b.thrust < 1 && b.status !== 'stacked') { back = 1.2; sideD = 2.2; upD = 0.6; smooth = 2.5; }
    } else if (focus === 'FAIRING_A' || focus === 'FAIRING_B') {
      back = 2.4; sideD = 1.5; upD = 0.6; smooth = 1.6; lead = 0;
    } else if (focus === 'PAYLOAD') {
      back = 2.8; sideD = 1.6; upD = 0.9; smooth = 2.2; lead = 0;
    } else if (focus === 'SHIP') orbitMode = true;

    const target = _v3;
    if (orbitMode) {
      // slow, low orbit around a stationary object (landed booster, ship)
      if (this.fresh) this.orbitAz = Math.atan2(-side.x, side.z);
      this.orbitAz += dtSim * 0.045;
      const enu = enuAt(fr.center);
      const r = Math.max(L, 30) * 2.1;
      target.copy(enu.east).multiplyScalar(Math.cos(this.orbitAz) * r)
        .addScaledVector(enu.north, Math.sin(this.orbitAz) * r)
        .addScaledVector(enu.up, -L * 0.2);
      smooth = 2.5;
    } else {
      const fb = level ? _v1.crossVectors(up, side).normalize() : f; // horizontal travel direction
      target.copy(fb).multiplyScalar(-back * R).addScaledVector(side, sideD * R).addScaledVector(up, upD * R);
      target.multiplyScalar(this.pull);
      // a chase is a chase: never more than CHASE_MAX_DIST out (anything farther is a long-lens shot)
      if (target.lengthSq() > CHASE_MAX_DIST * CHASE_MAX_DIST) target.setLength(CHASE_MAX_DIST);
      // acceleration lag: camera trails when the vehicle accelerates (engine start, staging)
      if (dtSim > 1e-4 && !this.fresh) {
        _v1.copy(b.vel).sub(this.prevVel).multiplyScalar(1 / dtSim);
        if (_v1.lengthSq() < 1e6) this.acc.lerp(_v1, expK(dtSim, 0.4));
      }
      _v2.copy(this.acc).multiplyScalar(-0.35);
      const lim = 0.3 * R;
      if (_v2.length() > lim) _v2.setLength(lim);
      target.add(_v2);
    }
    this.prevVel.copy(b.vel);

    if (this.fresh) { this.off.copy(target); this.offVel.set(0, 0, 0); }
    else smoothDampVec(this.off, this.offVel, target, smooth, dtSim);
    view.camWorldPos.copy(fr.center).add(this.off);
    clampAboveSurface(view.camWorldPos, 4);

    // look target (relative to the body center), lead along travel, bias toward plume
    const lookT = _v2.copy(f).multiplyScalar(lead * L);
    if (b.thrust > 1 && !orbitMode) lookT.addScaledVector(fr.axis, -Math.min(plume, L) * 0.2);
    if (this.fresh) { this.look.copy(lookT); this.lookVel.set(0, 0, 0); }
    else smoothDampVec(this.look, this.lookVel, lookT, 0.35, dtSim);
    const aim = _v3.copy(fr.center).add(this.look);
    this.aimAt(view, aim);

    // fit the body's PROJECTED extent (+ a share of the visible plume) into the 16:9 frame: a booster
    // seen along its axis or lying across the wide frame dimension needs a much tighter lens than
    // its raw length suggests
    // (both ends measured from the aim point, which leads / leans toward the plume)
    const d = _v1.copy(aim).sub(view.camWorldPos).normalize();
    const right = _v2.crossVectors(d, upAt(view.camWorldPos, _v3)).normalize();
    const camUp = _v3.crossVectors(right, d);
    const rad = Math.min(L, 4.5) * 0.5;
    const aspect = Math.max(1, inp.aspect);
    let tanNeed = 0.05;
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? L * 0.5 : -(L * 0.5 + (orbitMode ? 0 : Math.min(plume, 2 * L) * (focus === 'S2' ? 0.05 : 0.12)));
      const e = _v4.copy(fr.center).addScaledVector(fr.axis, s).sub(view.camWorldPos);
      const depth = Math.max(1, e.dot(d));
      tanNeed = Math.max(tanNeed, (Math.abs(e.dot(camUp)) + rad) / depth,
        (Math.abs(e.dot(right)) + rad) / depth / aspect);
    }
    const tanFit = tanNeed / (orbitMode ? 0.7 : fill);
    const fovT = clamp((2 * Math.atan(tanFit) / RAD), 14, CHASE_FOV_MAX);
    // lens alone can't hold the frame: dolly out (smoothly) instead of letting the body clip
    const pullT = orbitMode ? 1 : clamp((this.pull * tanFit) / Math.tan((CHASE_FOV_MAX * 0.5 - 1) * RAD), 1, 3);
    this.pull = this.fresh ? pullT : smoothDampScalar(this.pull, this.pullVel, pullT, 1.0, dtSim);
    this.fov = this.fresh ? fovT : smoothDampScalar(this.fov, this.fovVel, fovT, 1.2, dtSim);
    view.camera.fov = this.fov;

    const q = b.dynPressure / 35_000;
    view.shake = clamp(q * 0.45 + (b.thrust / S1_FULL_THRUST) * 0.12, 0, 1);
    view.shimmer = 0;
    view.onboard = false;
    this.fresh = false;
  }
}

// ---------------------------------------------------------------------------------------------
// ONBOARD cams: rigidly attached to the body.

/** S2 engine camera pod on the aft skirt rim (S2 body frame: origin = MVac exit, skirt rim at y 3.9, r 1.83;
 * the pod stands ~12 cm proud of the skirt, like the real one). Dev override: ?s2cam=angle,r,y,tilt,roll,fov. Earthward
 * is body angle ~90 deg during the burn (sim roll), so 115 deg shows the limb tilted across the frame. */
const S2_ENGINE_CAM = { angleDeg: 115, radius: 1.95, y: 3.85, tiltDeg: 28, rollDeg: 0, fov: 64 };
function devEngineCam(): Partial<typeof S2_ENGINE_CAM> {
  if (typeof location === 'undefined') return {};
  const v = new URLSearchParams(location.search).get('s2cam');
  if (!v) return {};
  const [angleDeg, radius, y, tiltDeg, rollDeg, fov] = v.split(',').map(Number);
  const o: Partial<typeof S2_ENGINE_CAM> = { angleDeg, radius, y, tiltDeg, rollDeg, fov };
  for (const k of Object.keys(o) as (keyof typeof o)[]) if (!Number.isFinite(o[k])) delete o[k];
  return o;
}

export class OnboardRig extends Rig {
  readonly mode: 'onboard_down' | 'onboard_engine';
  private localPos = new THREE.Vector3();
  private localQuat = new THREE.Quaternion();
  private fov = 68;
  constructor(mode: 'onboard_down' | 'onboard_engine') {
    super();
    this.mode = mode;
    if (mode === 'onboard_down') {
      const c = F9.s1.cams.down;
      const a = c.angleDeg * RAD;
      const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const tang = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      this.localPos.copy(radial).multiplyScalar(c.radius).setY(c.y);
      const fwd = new THREE.Vector3(0, -1, 0).addScaledVector(radial, 0.13).normalize();
      lookQuat(fwd, tang.negate(), this.localQuat);
    } else {
      // S2 engine cam: on a bracket just under the aft-skirt rim, looking aft along the stage and in
      // toward the MVac so the bell hangs from the top of the frame, glowing, with the Earth beyond.
      const c = { ...S2_ENGINE_CAM, ...devEngineCam() };
      const a = c.angleDeg * RAD;
      const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const inward = radial.clone().negate();
      this.localPos.copy(radial).multiplyScalar(c.radius).setY(c.y);
      const t = c.tiltDeg * RAD;
      const fwd = new THREE.Vector3(0, -Math.cos(t), 0).addScaledVector(inward, Math.sin(t));
      const up = new THREE.Vector3(0, Math.sin(t), 0).addScaledVector(inward, Math.cos(t));
      lookQuat(fwd, up, this.localQuat);
      if (c.rollDeg) this.localQuat.multiply(_q1.setFromAxisAngle(_v1.set(0, 0, 1), c.rollDeg * RAD));
      this.fov = c.fov;
    }
  }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap } = inp;
    const bodyId: BodyId = this.mode === 'onboard_down' ? 'S1' : 'S2';
    const b = snap.bodies[bodyId];
    view.camWorldPos.copy(this.localPos).applyQuaternion(b.quat).add(b.pos);
    view.camera.quaternion.copy(b.quat).multiply(this.localQuat);
    // fixed lens: `fov` is the vertical fov in a 16:9 frame; narrower tiles (split view) keep that
    // horizontal coverage (hor+, capped) so the MVac bell doesn't fill a half-width tile
    const aspect = Math.max(0.3, inp.aspect || 16 / 9);
    const vFov = aspect >= 16 / 9 ? this.fov
      : Math.min(92, 2 * Math.atan(Math.tan(this.fov * 0.5 * RAD) * (16 / 9) / aspect) / RAD);
    view.camera.fov = vFov;
    const q = b.dynPressure / 30_000;
    if (this.mode === 'onboard_down') {
      const s1 = snap.bodies.S1;
      const thr = s1.thrust / S1_FULL_THRUST;
      const entry = s1.phase === 'ENTRY_BURN' ? 0.35 : 0;
      const landing = s1.phase === 'LANDING_BURN' ? 0.25 * clamp(s1.thrust / MERLIN_1D.thrustSL, 0, 1) : 0;
      view.shake = clamp(0.1 + thr * 0.55 + q * 0.5 + entry + landing, 0, 1);
    } else {
      const s2 = snap.bodies.S2;
      const stacked = s2.status === 'stacked';
      const thr = stacked ? snap.bodies.S1.thrust / S1_FULL_THRUST : s2.thrust / MERLIN_VAC.thrustVac;
      view.shake = clamp(0.06 + thr * (stacked ? 0.5 : 0.28) + q * 0.4, 0, 1);
    }
    view.shimmer = 0;
    view.onboard = true;
    this.fresh = false;
  }
}

// ---------------------------------------------------------------------------------------------
// LONG LENS: ground / support-ship telephoto tracking with auto zoom, operator lag, shimmer.

type SiteId = 'near' | 'ground' | 'ship';
const SITE_LABEL: Record<SiteId, string> = { near: 'PAD PERIMETER', ground: 'VANDENBERG TRACKING', ship: 'SUPPORT SHIP' };
let _siteNear: THREE.Vector3 | null = null;
let _siteGround: THREE.Vector3 | null = null;

export function sitePosition(site: SiteId, snap: SimSnapshot, out: THREE.Vector3): THREE.Vector3 {
  // perimeter camera on the ridge SE of the pad (terrain ~213 m there; the old 1.9 km / 32 deg site
  // sat behind a rise and saw only hillside). Sun behind the operator in the morning.
  if (site === 'near') return out.copy(_siteNear ??= pointAlongAzimuth(900, 150, 233));
  if (site === 'ground') return out.copy(_siteGround ??= pointAlongAzimuth(7800, 62, 330));
  // support ship: ~3.2 km off OCISLY (east / slightly south), camera 14 m above the water
  const ship = snap.bodies.SHIP.pos;
  const enu = enuAt(ship);
  out.copy(ship).addScaledVector(enu.east, 2700).addScaledVector(enu.north, -1600);
  const alt = altitudeOf(out);
  out.addScaledVector(enu.up, 14 - alt);
  return out;
}

function siteVisible(site: THREE.Vector3, target: THREE.Vector3): boolean {
  const up = upAt(site, _v2);
  const d = _v3.copy(target).sub(site);
  const dist = d.length();
  const sinEl = d.dot(up) / Math.max(1, dist);
  const hs = Math.max(2, altitudeOf(site));
  const dip = Math.sqrt((2 * hs) / 6_371_000) + dist / (2 * 6_371_000);
  return sinEl > -dip + 0.002;
}

export class LongLensRig extends Rig {
  readonly mode = 'long_lens' as const;
  site: SiteId = 'ground';
  private dir = new THREE.Vector3();
  private fov = 5;
  private sitePos = new THREE.Vector3();

  describe(): string { return SITE_LABEL[this.site]; }

  private chooseSite(snap: SimSnapshot, focus: BodyId, target: THREE.Vector3): SiteId {
    if (this.preset === 'near' || this.preset === 'ground' || this.preset === 'ship') return this.preset;
    const b = snap.bodies[focus];
    const candidates: SiteId[] = ['near', 'ground', 'ship'];
    let best: SiteId = this.site, bestScore = Infinity;
    for (const s of candidates) {
      const p = sitePosition(s, snap, _v1);
      if (!siteVisible(p, target)) continue;
      let d = p.distanceTo(target);
      if (s === 'near') {
        // the perimeter camera only covers liftoff and the first seconds
        if (b.altitude > 4000 || focus !== 'S1' || !isStacked(snap)) continue;
        d *= 0.5;
      }
      if (s === 'ship' && focus === 'S1' && isStacked(snap)) continue;
      if (!this.fresh && s === this.site) d *= 0.6; // hysteresis
      if (d < bestScore) { bestScore = d; best = s; }
    }
    return best;
  }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, focus, dtSim } = inp;
    const b = snap.bodies[focus];
    const fr = bodyFraming(snap, focus, this.fr);
    const plume = plumeLength(snap, focus);
    const target = _v1.copy(fr.center).addScaledVector(fr.axis, -Math.min(plume, fr.size * 3) * 0.3);
    const tgt = new THREE.Vector3().copy(target);
    const site = this.chooseSite(snap, focus, tgt);
    if (site !== this.site) { this.site = site; this.fresh = true; }
    sitePosition(this.site, snap, this.sitePos);
    // support ship bobs on the swell
    if (this.site === 'ship') this.sitePos.addScaledVector(upAt(this.sitePos, _v2), 0.8 * noise1(inp.time * 0.35, 7));
    view.camWorldPos.copy(this.sitePos);

    const dT = _v2.copy(tgt).sub(view.camWorldPos);
    const dist = dT.length();
    dT.multiplyScalar(1 / Math.max(1e-6, dist));
    if (this.fresh) this.dir.copy(dT);
    else this.dir.lerp(dT, expK(dtSim, 0.14)).normalize();
    // keep the target inside the frame even if the operator lags (warp, fast crossings)
    const maxErr = this.fov * RAD * 0.3;
    const err = this.dir.angleTo(dT);
    if (err > maxErr) this.dir.lerp(dT, 1 - maxErr / err).normalize();

    // fit the PROJECTED length: a booster falling toward the tracker is heavily foreshortened, and
    // framing its raw length left a speck in the middle of the sky
    // (the high-altitude plume is as wide as it is long, so it sets a floor when seen end-on)
    const sinA = Math.sqrt(Math.max(0, 1 - fr.axis.dot(dT) ** 2));
    const extent = Math.max(8 + plume * 0.6, (fr.size * 1.15 + Math.min(plume, fr.size * 4) * 0.3) * Math.max(0.25, sinA));
    // a big expanding plume reads as a shape only with sky around it (else a flat wall of plume)
    const fill = lerp(0.42, 0.24, smoothstep(1, 3.5, plume / Math.max(1, fr.size)));
    const fovT = clamp((2 * Math.atan(extent / fill / 2 / Math.max(1, dist))) / RAD, 0.12, 32);
    this.fov = this.fresh ? fovT : Math.exp(lerp(Math.log(this.fov), Math.log(fovT), expK(dtSim, 0.9)));
    view.camera.fov = this.fov;

    const up = upAt(view.camWorldPos, _v3);
    lookQuat(this.dir, up, view.camera.quaternion);
    // operator micro-drift + tripod jitter (scaled by the field of view)
    const fr_ = this.fov * RAD;
    const ex = noise1(inp.time * 0.23, 11) * fr_ * 0.035 + noise1(inp.time * 7.3, 12) * fr_ * 0.0025;
    const ey = noise1(inp.time * 0.19, 13) * fr_ * 0.045 + noise1(inp.time * 6.1, 14) * fr_ * 0.0025;
    _q2.setFromEuler(_eul.set(ex, ey, 0));
    view.camera.quaternion.multiply(_q2);

    // shimmer: turbulent path length through the boundary layer, amplified by magnification
    const sinEl = Math.max(0.02, _v2.copy(tgt).sub(view.camWorldPos).normalize().dot(up));
    const lowPath = Math.min(dist, 2200 / sinEl);
    const mag = clamp(Math.sqrt(6 / Math.max(0.2, this.fov)), 0.5, 1.6);
    view.shimmer = clamp((lowPath / 11_000) * mag * (this.site === 'ship' ? 0.8 : 1), 0, 1);
    // acoustic shake near the pad at liftoff
    const s1 = snap.bodies.S1;
    const padDist = view.camWorldPos.distanceTo(s1.pos);
    view.shake = clamp((s1.thrust / S1_FULL_THRUST) * Math.min(1, 900 / Math.max(1, padDist)) * (s1.altitude < 3000 ? 0.5 : 0), 0, 1);
    view.onboard = false;
    void b;
    this.fresh = false;
  }
}
// long-lens applies shake itself (fov-scaled): SHAKE_PROFILE.long_lens.amp = 0

// ---------------------------------------------------------------------------------------------
// DECK: camera on OCISLY's aft structure, rides the ship, PTZ-tracks the incoming booster.

const DECK_CAM_LOCAL = new THREE.Vector3(-13, 9.5, -OCISLY.deckLength / 2 + 1.5);
const DECK_AIM_LOCAL = new THREE.Vector3(0, 21, 0);

export class DeckRig extends Rig {
  readonly mode = 'deck' as const;
  private aim = new THREE.Vector3();
  private fov = 84;
  private invShip = new THREE.Quaternion();

  describe(): string { return 'OCISLY'; }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, dtSim } = inp;
    const ship = snap.bodies.SHIP;
    const tracked: BodyId = inp.focus === 'SHIP' ? 'S1' : inp.focus;
    const fr = bodyFraming(snap, tracked, this.fr);
    view.camWorldPos.copy(DECK_CAM_LOCAL).applyQuaternion(ship.quat).add(ship.pos);
    this.invShip.copy(ship.quat).invert();
    const def = _v1.copy(DECK_AIM_LOCAL).sub(DECK_CAM_LOCAL).normalize();
    const bLocal = _v2.copy(fr.center).sub(view.camWorldPos).applyQuaternion(this.invShip);
    const dist = bLocal.length();
    bLocal.multiplyScalar(1 / Math.max(1e-6, dist));
    const b = snap.bodies[tracked];
    const gone = b.status === 'gone';

    // zoom: wide when close, tighter when the booster is still far out
    const fovT = gone ? 84 : clamp((2 * Math.atan((fr.size * 3.2) / 2 / Math.max(1, dist))) / RAD, 7, 84);
    this.fov = this.fresh ? fovT : Math.exp(lerp(Math.log(this.fov), Math.log(fovT), expK(dtSim, 0.6)));
    // PTZ: zoomed in on the incoming booster it stays centred; as the lens opens up the operator
    // lets it drift toward the frame edge to get the deck in, but never lets any part of it leave
    const aimT = _v3.copy(def);
    if (!gone) {
      const halfV = this.fov * RAD * 0.5;
      const bAng = Math.atan((fr.size * 0.5) / Math.max(1, dist));
      const lim = Math.max(0, halfV * 0.88 - bAng * 1.05) * smoothstep(22, 62, this.fov);
      const ang = def.angleTo(bLocal);
      if (ang > lim) {
        _q1.setFromUnitVectors(def, bLocal);
        _q2.identity().slerp(_q1, (ang - lim) / ang);
        aimT.applyQuaternion(_q2);
      }
    }
    if (this.fresh) this.aim.copy(aimT);
    else this.aim.lerp(aimT, expK(dtSim, 0.22)).normalize();
    lookQuat(this.aim, Y, _q1);
    view.camera.quaternion.copy(ship.quat).multiply(_q1);
    view.camera.fov = this.fov;

    // shake: landing-burn roar + touchdown thump
    let shake = 0.04 + 0.03 * clamp(snap.bodies.SHIP.angVel.length() * 5, 0, 1);
    const s1 = snap.bodies.S1;
    const d1 = view.camWorldPos.distanceTo(s1.pos);
    if (s1.thrust > 1) shake += clamp(1 - d1 / 1800, 0, 1) ** 2 * clamp(s1.thrust / MERLIN_1D.thrustSL, 0, 1.5) * 0.9;
    const td = inp.evT('TOUCHDOWN');
    if (td !== undefined && snap.t >= td && snap.t - td < 2) shake += 0.7 * (1 - (snap.t - td) / 2);
    view.shake = clamp(shake, 0, 1);
    view.shimmer = s1.thrust > 1 ? clamp(1 - d1 / 800, 0, 1) * 0.25 : 0;
    view.onboard = false;
    this.fresh = false;
  }
}

// ---------------------------------------------------------------------------------------------
// PAD: fixed remote cameras around SLC-4E.

type PadPreset = 'wide' | 'tower' | 'engine' | 'up';
/** "launch mount" camera: on the mount's east walkway grating, ~0.5 m above the deck and ~2.6 m from
 * the booster skin, looking up the side of the vehicle (the old spot under the SE girder corner framed
 * mostly the girder). Aim = point on the vehicle axis at aimY. Dev override: ?padup=heading,dist,h,aimY,fov,aimOff */
const PAD_UP = { hdg: 100, dist: 4.4, h: 5.3, aimY: 40, fov: 70, aimOff: -1.5 };
function devPadUp(): typeof PAD_UP {
  const o = { ...PAD_UP };
  if (typeof location === 'undefined') return o;
  const v = new URLSearchParams(location.search).get('padup');
  if (!v) return o;
  const keys = Object.keys(PAD_UP) as (keyof typeof PAD_UP)[];
  v.split(',').map(Number).forEach((x, i) => { if (Number.isFinite(x) && keys[i]) o[keys[i]] = x; });
  return o;
}
const PAD_LABEL: Record<PadPreset, string> = { wide: 'WIDE', tower: 'TOWER', engine: 'ENGINE CAM', up: 'LAUNCH MOUNT' };

export class PadRig extends Rig {
  readonly mode = 'pad' as const;
  private padBase = new THREE.Vector3(0, PAD_ELEVATION, 0);
  private dir = new THREE.Vector3();
  private fixedDir = new THREE.Vector3();
  private fov = 30;
  get p(): PadPreset { return (['wide', 'tower', 'engine', 'up'].includes(this.preset) ? this.preset : 'wide') as PadPreset; }
  describe(): string { return PAD_LABEL[this.p]; }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, dtSim } = inp;
    const s1 = snap.bodies.S1;
    if (s1.phase === 'PRELAUNCH' || (s1.altitude < PAD_ELEVATION + 8 && s1.vel.lengthSq() < 1)) {
      this.padBase.set(s1.pos.x, PAD_ELEVATION, s1.pos.z);
    }
    const fr = bodyFraming(snap, inp.focus === 'SHIP' ? 'S1' : inp.focus, this.fr);
    const stackH = F9.totalHeight;
    const base = this.padBase;
    const p = this.p;
    const at = (headingDeg: number, dist: number, h: number) =>
      view.camWorldPos.set(base.x + Math.sin(headingDeg * RAD) * dist, base.y + h, base.z - Math.cos(headingDeg * RAD) * dist);
    let fovT = 30;
    if (p === 'wide') {
      at(64, 380, 9);
      const dist = view.camWorldPos.distanceTo(fr.center);
      const plume = plumeLength(snap, 'S1');
      const extent = Math.max(stackH * 1.35, fr.size + plume * 0.7);
      fovT = clamp((2 * Math.atan(extent / 2 / dist) / RAD) * 1.25, 4, 30);
      const tgt = _v2.copy(fr.center);
      if (s1.altitude < PAD_ELEVATION + 30) tgt.set(base.x, base.y + stackH * 0.47, base.z);
      const dT = tgt.sub(view.camWorldPos).normalize();
      if (this.fresh) this.dir.copy(dT); else this.dir.lerp(dT, expK(dtSim, 0.25)).normalize();
      const maxErr = this.fov * RAD * 0.33, err = this.dir.angleTo(dT);
      if (err > maxErr) this.dir.lerp(dT, 1 - maxErr / err).normalize();
    } else if (p === 'tower') {
      at(300, 26, 58);
      const tgt = _v2.set(base.x, base.y + 18, base.z);
      if (s1.altitude > PAD_ELEVATION + 20) tgt.lerp(fr.center, smoothstep(PAD_ELEVATION + 20, PAD_ELEVATION + 120, s1.altitude));
      const dT = tgt.sub(view.camWorldPos).normalize();
      if (this.fresh) this.dir.copy(dT); else this.dir.lerp(dT, expK(dtSim, 0.4)).normalize();
      fovT = 56;
    } else if (p === 'engine') {
      at(205, 17, 1.4);
      if (this.fresh) this.fixedDir.set(base.x, base.y + 5.2, base.z).sub(view.camWorldPos).normalize();
      this.dir.copy(this.fixedDir);
      fovT = 44;
    } else {
      const c = devPadUp();
      at(c.hdg, c.dist, c.h);
      if (this.fresh) {
        const a = (c.hdg + 90) * RAD;   // aimOff: sideways along the tangent (m)
        this.fixedDir.set(base.x + Math.sin(a) * c.aimOff, base.y + c.aimY, base.z - Math.cos(a) * c.aimOff).sub(view.camWorldPos).normalize();
      }
      this.dir.copy(this.fixedDir);
      fovT = c.fov;
    }
    this.fov = this.fresh ? fovT : Math.exp(lerp(Math.log(this.fov), Math.log(fovT), expK(dtSim, 0.7)));
    view.camera.fov = this.fov;
    lookQuat(this.dir, upAt(view.camWorldPos, _v3), view.camera.quaternion);

    const d = view.camWorldPos.distanceTo(s1.pos);
    const thr = s1.thrust / S1_FULL_THRUST;
    const near = s1.altitude < 2500 ? 1 : 0;
    view.shake = clamp(thr * Math.pow(45 / Math.max(45, d), 0.55) * 0.9 * near + (p === 'wide' ? 0 : 0.02), 0, 1);
    view.shimmer = p === 'wide' && thr > 0 ? 0.15 * near : 0;
    view.onboard = false;
    this.fresh = false;
  }
}

// ---------------------------------------------------------------------------------------------
// ORBIT: free orbit around the focus (mouse), local ENU spherical coordinates.

export class OrbitRig extends Rig {
  readonly mode = 'orbit' as const;
  az = 0.6;
  el = 0.12;
  dist = 150;
  pan = new THREE.Vector3(); // ENU (e, n, u) meters
  private inited = false;

  /** initialise from the view's current camera pose so switching into orbit is seamless */
  initFrom(view: ViewInfo, snap: SimSnapshot, focus: BodyId): void {
    const fr = bodyFraming(snap, focus, this.fr);
    const enu = enuAt(fr.center);
    const rel = _v1.copy(view.camWorldPos).sub(fr.center);
    let d = rel.length();
    if (!(d > 1) || d > Math.max(3000, fr.size * 40)) { d = fr.size * 2.5; rel.copy(enu.east).multiplyScalar(d); }
    if (d < fr.size * 1.6) { rel.multiplyScalar((fr.size * 1.6) / d); d = fr.size * 1.6; }
    this.dist = d;
    this.el = Math.asin(clamp(rel.dot(enu.up) / d, -1, 1));
    this.az = Math.atan2(rel.dot(enu.north), rel.dot(enu.east));
    this.pan.set(0, 0, 0);
    this.inited = true;
  }

  rotate(dx: number, dy: number): void {
    this.az -= dx * 0.006;
    this.el = clamp(this.el + dy * 0.005, -1.45, 1.52);
  }
  zoom(delta: number, minDist: number): void {
    this.dist = clamp(this.dist * Math.exp(delta * 0.0012), minDist, 3_000_000);
  }
  panBy(dx: number, dy: number, view: ViewInfo): void {
    const s = this.dist * 0.0016;
    // camera right/up in ENU coords (approx: use az)
    const rx = -Math.sin(this.az), ry = Math.cos(this.az);
    this.pan.x += -dx * s * rx;
    this.pan.y += -dx * s * ry;
    this.pan.z += dy * s;
    void view;
  }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, focus } = inp;
    if (!this.inited) this.initFrom(view, snap, focus);
    const fr = bodyFraming(snap, focus, this.fr);
    const enu = enuAt(fr.center);
    const ce = Math.cos(this.el);
    const center = _v2.copy(fr.center)
      .addScaledVector(enu.east, this.pan.x).addScaledVector(enu.north, this.pan.y).addScaledVector(enu.up, this.pan.z);
    view.camWorldPos.copy(center)
      .addScaledVector(enu.east, Math.cos(this.az) * ce * this.dist)
      .addScaledVector(enu.north, Math.sin(this.az) * ce * this.dist)
      .addScaledVector(enu.up, Math.sin(this.el) * this.dist);
    clampAboveSurface(view.camWorldPos, 2.5);
    this.aimAt(view, center);
    view.camera.fov = 45;
    view.shake = 0;
    view.shimmer = 0;
    view.onboard = false;
    this.fresh = false;
  }
}

// ---------------------------------------------------------------------------------------------
// CINEMATIC: director / replay moves. presets: flyby | ship_orbit | dolly

export class CinematicRig extends Rig {
  readonly mode = 'cinematic' as const;
  private anchor = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private fov = 30;
  private startDist = 1;
  private az = 0;
  private t0 = 0;
  private rel = new THREE.Vector3();

  describe(): string {
    return this.preset === 'ship_orbit' ? 'SHIP LEVEL' : this.preset === 'dolly' ? 'DOLLY' : 'FLYBY';
  }

  update(view: ViewInfo, inp: RigInput): void {
    const { snap, dtSim } = inp;
    const focus = inp.focus;
    const fr = bodyFraming(snap, focus, this.fr);
    const b = snap.bodies[focus];
    const preset = this.preset || 'flyby';
    const L = fr.size;
    const target = _v3.copy(fr.center);

    if (preset === 'ship_orbit') {
      const ship = snap.bodies.SHIP;
      const enu = enuAt(ship.pos);
      const s1 = snap.bodies.S1;
      const nearShip = s1.pos.distanceTo(ship.pos) < 3000 && s1.status !== 'gone';
      if (this.fresh) { this.az = Math.atan2(0.8, 0.6); this.t0 = snap.t; }
      this.az += dtSim * 0.05;
      const r = 150;
      view.camWorldPos.copy(ship.pos)
        .addScaledVector(enu.east, Math.cos(this.az) * r).addScaledVector(enu.north, Math.sin(this.az) * r);
      const alt = altitudeOf(view.camWorldPos);
      view.camWorldPos.addScaledVector(enu.up, 7 - alt + 0.6 * noise1(inp.time * 0.4, 3));
      if (nearShip) bodyFraming(snap, 'S1', this.fr), target.copy(this.fr.center);
      else target.copy(ship.pos).addScaledVector(enu.up, 18);
      const dT = _v1.copy(target).sub(view.camWorldPos).normalize();
      if (this.fresh) this.dir.copy(dT); else this.dir.lerp(dT, expK(dtSim, 0.3)).normalize();
      const dist = view.camWorldPos.distanceTo(target);
      const fovT = clamp((2 * Math.atan((L * 1.9) / 2 / dist)) / RAD, 14, 55);
      this.fov = this.fresh ? fovT : lerp(this.fov, fovT, expK(dtSim, 0.8));
    } else if (preset === 'dolly') {
      if (this.fresh) {
        this.t0 = snap.t;
        const enu = enuAt(fr.center);
        this.rel.copy(enu.east).multiplyScalar(0.8).addScaledVector(enu.north, -0.55).addScaledVector(enu.up, 0.28).normalize();
      }
      const k = smoothstep(0, 16, snap.t - this.t0);
      const d = lerp(3.4, 1.7, k) * Math.max(L, 12);
      _q1.setFromAxisAngle(upAt(fr.center, _v2), 0.012 * (snap.t - this.t0));
      view.camWorldPos.copy(this.rel).applyQuaternion(_q1).multiplyScalar(d).add(fr.center);
      clampAboveSurface(view.camWorldPos, 4);
      const dT = _v1.copy(target).sub(view.camWorldPos).normalize();
      this.dir.copy(dT);
      this.fov = 38;
    } else {
      // flyby: a camera parked ahead of the vehicle's path; it roars past
      const speed = b.vel.length();
      const needNew = this.fresh || view.camWorldPos.distanceTo(fr.center) > this.startDist * 2.2 + 50;
      if (needNew) {
        const side = _v1, up = _v2;
        const f = new THREE.Vector3();
        if (speed > 5) f.copy(b.vel).multiplyScalar(1 / speed); else f.copy(fr.axis);
        travelBasis(fr.center, f, side, up);
        const lead = clamp(speed * 3.2, 3 * L, 6000);
        const lat = Math.max(2.2 * L, speed * 0.09);
        this.anchor.copy(fr.center).addScaledVector(f, lead).addScaledVector(side, lat).addScaledVector(up, lat * 0.25);
        clampAboveSurface(this.anchor, 6);
        this.startDist = this.anchor.distanceTo(fr.center);
        this.fresh = true;
      }
      view.camWorldPos.copy(this.anchor);
      const dT = _v1.copy(target).sub(view.camWorldPos).normalize();
      if (this.fresh) this.dir.copy(dT); else this.dir.lerp(dT, expK(dtSim, 0.08)).normalize();
      const maxErr = this.fov * RAD * 0.3, err = this.dir.angleTo(dT);
      if (err > maxErr) this.dir.lerp(dT, 1 - maxErr / err).normalize();
      const dist = view.camWorldPos.distanceTo(target);
      const plume = plumeLength(snap, focus);
      const fovT = clamp((2 * Math.atan((L * 1.6 + plume * 0.5) / 2 / dist)) / RAD, 3, 60);
      this.fov = this.fresh ? fovT : Math.exp(lerp(Math.log(this.fov), Math.log(fovT), expK(dtSim, 0.5)));
    }
    view.camera.fov = this.fov;
    lookQuat(this.dir, upAt(view.camWorldPos, _v2), view.camera.quaternion);
    const s1 = snap.bodies.S1;
    const d1 = view.camWorldPos.distanceTo(s1.pos);
    view.shake = clamp(b.dynPressure / 60_000 + (s1.thrust > 1 ? clamp(1 - d1 / 1500, 0, 1) * 0.5 : 0), 0, 1);
    view.shimmer = 0;
    view.onboard = false;
    this.fresh = false;
  }
}

export function makeRig(mode: CameraMode): Rig {
  switch (mode) {
    case 'chase': return new ChaseRig();
    case 'onboard_down': return new OnboardRig('onboard_down');
    case 'onboard_engine': return new OnboardRig('onboard_engine');
    case 'long_lens': return new LongLensRig();
    case 'deck': return new DeckRig();
    case 'pad': return new PadRig();
    case 'orbit': return new OrbitRig();
    case 'cinematic': return new CinematicRig();
  }
}
