// DEV-ONLY fake snapshot harness for camera work (?camfake=1 | splash | rud).
// Replaces __app.sim.getSnapshot with a kinematic (keyframed, not physical) mission that has
// separated bodies: stage sep, booster flip / entry / landing on the ship, S2 to orbit,
// fairing halves. Mission time still comes from the real sim (seek/warp/pause keep working).
// Used only to exercise tiling, the director and rigs while the real sim is being written.
import * as THREE from 'three';
import type { AppContext } from '../core/context';
import type { BodyId, BodyState, SimEventType, SimSnapshot, TimelineMarker } from '../core/types';
import { LAUNCH_AZIMUTH_DEG, PAD_ELEVATION } from '../core/constants';
import { altitudeOf, pointAlongAzimuth, quatFromAxis, surfaceDistance, upAt, enuAt } from '../core/frames';
import { F9, MERLIN_1D, MERLIN_VAC } from '../core/vehicleSpec';
import { smoothstep } from './util';

type Key = [number, number, number]; // t, value, derivative

function herm(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1] + keys[0][2] * (t - keys[0][0]);
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1] + last[2] * (t - last[0]);
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const [t0, v0, d0] = keys[i], [t1, v1, d1] = keys[i + 1];
  const h = t1 - t0, s = (t - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * d0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * d1;
}

const AZ = LAUNCH_AZIMUTH_DEG;
const T_SEP = 150, T_SES = 157, T_FLIP0 = 158, T_FLIP1 = 176, T_FAIR = 190, T_ENTRY0 = 380, T_ENTRY1 = 400;
const T_LAND0 = 485, T_TD = 510, T_SECO = 525, T_DEPLOY = 900;

const H_ASC: Key[] = [[0, PAD_ELEVATION + 4, 0], [10, PAD_ELEVATION + 130, 28], [30, 2000, 150], [72, 12500, 380], [100, 25000, 520], [150, 68000, 1100]];
const D_ASC: Key[] = [[0, 0, 0], [15, 2, 1], [30, 180, 30], [72, 3800, 190], [100, 12000, 450], [150, 70000, 1900]];
const H_S2: Key[] = [[150, 68000, 1100], [300, 160000, 300], [525, 210000, 0], [2000, 210000, 0]];
const D_S2: Key[] = [[150, 70000, 1900], [300, 512000, 4000], [525, 1783000, 7300]];

const EVENTS: { t: number; type: SimEventType; body?: BodyId; data?: Record<string, unknown> }[] = [
  { t: -3, type: 'IGNITION_SEQUENCE' }, { t: 0, type: 'LIFTOFF' }, { t: 72, type: 'MAX_Q' },
  { t: 147, type: 'MECO' }, { t: T_SEP, type: 'STAGE_SEP' }, { t: T_SES, type: 'SES1' },
  { t: T_FLIP0, type: 'BOOSTER_FLIP', body: 'S1' }, { t: T_FLIP1, type: 'GRIDFINS_DEPLOY', body: 'S1' },
  { t: T_FAIR, type: 'FAIRING_SEP' }, { t: 262, type: 'APOGEE', body: 'S1' },
  { t: T_ENTRY0, type: 'ENTRY_BURN_START', body: 'S1' }, { t: T_ENTRY1, type: 'ENTRY_BURN_END', body: 'S1' },
  { t: 440, type: 'SONIC_BOOM', body: 'S1' },
  { t: T_LAND0, type: 'LANDING_BURN_START', body: 'S1' }, { t: 503, type: 'LEGS_DEPLOY', body: 'S1' },
  { t: T_TD, type: 'TOUCHDOWN', body: 'S1', data: { outcome: 'success' } },
  { t: T_SECO, type: 'SECO', body: 'S2' }, { t: T_DEPLOY, type: 'PAYLOAD_DEPLOY', body: 'PAYLOAD' },
];

function cloneBody(b: BodyState): BodyState {
  return {
    ...b, pos: b.pos.clone(), vel: b.vel.clone(), quat: b.quat.clone(), angVel: b.angVel.clone(),
    engines: b.engines.map((e) => ({ ...e })), rcs: [...b.rcs],
    gridFins: b.gridFins ? { deploy: b.gridFins.deploy, angles: [...b.gridFins.angles] as [number, number, number, number] } : undefined,
  };
}

class FakeMission {
  snap: SimSnapshot | null = null;
  private shipD = 600_000;
  constructor(private variant: string) {}

  private pathPos(D: number, h: number, out = new THREE.Vector3()) { return pointAlongAzimuth(D, AZ, h, out); }

  private stackPos(t: number, out = new THREE.Vector3()) {
    const tt = Math.max(0, t);
    return this.pathPos(Math.max(0, herm(D_ASC, tt)), herm(H_ASC, tt), out);
  }

  private boosterPos(t: number, ship: BodyState, out = new THREE.Vector3()) {
    if (t <= T_SEP) return this.stackPos(t, out);
    const shipAlt = altitudeOf(ship.pos);
    const H: Key[] = [[150, 68000, 1100], [262, 130000, 0], [380, 62000, -1160], [400, 44000, -750], [T_LAND0, 3200, -270], [T_TD, shipAlt + 2, 0]];
    const Dk: Key[] = [[150, 70000, 1900], [380, 505000, 1850], [400, 537000, 1300], [T_LAND0, this.shipD - 400, 40], [T_TD, this.shipD, 0]];
    const tt = Math.min(t, T_TD);
    const h = herm(H, tt);
    const D = herm(Dk, tt);
    this.pathPos(D, h, out);
    // converge exactly on the (possibly moving) deck
    const w = smoothstep(T_LAND0 - 20, T_TD - 3, tt);
    if (w > 0) {
      const up = upAt(ship.pos);
      const tgt = ship.pos.clone().addScaledVector(up, h - shipAlt);
      const behind = this.pathPos(D, h).sub(this.pathPos(this.shipD, h));
      tgt.add(behind);
      out.lerp(tgt, w);
    }
    if (this.variant === 'splash' && t > T_TD - 8) out.add(enuAt(ship.pos).east.multiplyScalar(110 * smoothstep(T_TD - 20, T_TD, t)));
    return out;
  }

  private s2Pos(t: number, out = new THREE.Vector3()) {
    const tt = Math.max(t, T_SEP);
    const D = tt > 525 ? 1783000 + 7300 * (tt - 525) : herm(D_S2, tt);
    return this.pathPos(D, herm(H_S2, tt), out);
  }

  build(real: SimSnapshot): SimSnapshot {
    if (!this.snap) {
      const bodies = {} as Record<BodyId, BodyState>;
      for (const id of Object.keys(real.bodies) as BodyId[]) bodies[id] = cloneBody(real.bodies[id]);
      this.snap = { ...real, bodies, timeline: EVENTS.filter((e) => e.t >= 0).map((e): TimelineMarker => ({ type: e.type, label: e.type.replace(/_/g, ' '), t: e.t, done: false })) };
    }
    const s = this.snap;
    const t = real.t;
    s.t = t; s.paused = real.paused; s.countdownHeld = real.countdownHeld; s.warp = real.warp; s.wind = real.wind;
    const b = s.bodies;
    const ship = b.SHIP;
    ship.pos.copy(real.bodies.SHIP.pos);
    // gentle pitch/roll from the swell
    const up = upAt(ship.pos);
    const baseQ = quatFromAxis(up, enuAt(ship.pos).north.negate());
    const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.025 * Math.sin(t * 0.7));
    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.012 * Math.sin(t * 0.53 + 1));
    ship.quat.copy(baseQ).multiply(roll).multiply(pitch);
    ship.status = 'free';
    this.shipD = surfaceDistance(new THREE.Vector3(), ship.pos);

    const setKin = (id: BodyId, fn: (tt: number, o: THREE.Vector3) => THREE.Vector3) => {
      const bb = b[id];
      fn(t, bb.pos);
      const a = fn(t + 0.1, new THREE.Vector3()), c = fn(t - 0.1, new THREE.Vector3());
      bb.vel.copy(a).sub(c).multiplyScalar(5);
    };
    const derive = (bb: BodyState) => {
      bb.altitude = altitudeOf(bb.pos);
      bb.speed = bb.vel.length();
      bb.speedInertial = bb.speed + (bb.altitude > 1000 ? 380 : 0);
      bb.verticalSpeed = bb.vel.dot(upAt(bb.pos));
      bb.ambientPressure = 101325 * Math.exp(-Math.max(0, bb.altitude) / 8400);
      bb.density = 1.225 * Math.exp(-Math.max(0, bb.altitude) / 8500);
      bb.dynPressure = 0.5 * bb.density * bb.speed * bb.speed;
      bb.mach = bb.speed / 300;
      bb.downrange = surfaceDistance(new THREE.Vector3(), bb.pos);
      bb.thrust = bb.engines.reduce((a, e) => a + e.thrust, 0);
    };
    const orient = (bb: BodyState, axis: THREE.Vector3) => {
      const e = enuAt(bb.pos);
      quatFromAxis(axis, e.east, bb.quat);
    };
    const velDir = (bb: BodyState, fallback: THREE.Vector3) => (bb.vel.lengthSq() > 25 ? bb.vel.clone().normalize() : fallback.clone());

    // ---------------- S1 ----------------
    const s1 = b.S1;
    setKin('S1', (tt, o) => this.boosterPos(tt, ship, o));
    const s1up = upAt(s1.pos);
    const pro = velDir(s1, s1up);
    let axis: THREE.Vector3;
    if (t < T_SEP + 8) axis = s1up.clone().lerp(pro, smoothstep(3, 60, s1.vel.length())).normalize();
    else if (t < T_FLIP1) {
      const k = smoothstep(T_FLIP0, T_FLIP1, t);
      const q = new THREE.Quaternion().setFromUnitVectors(pro, pro.clone().negate().add(s1up.clone().multiplyScalar(0.02)).normalize());
      axis = pro.clone().applyQuaternion(new THREE.Quaternion().slerp(q, k));
    } else axis = pro.clone().negate();
    if (t > T_LAND0 + 10) axis.lerp(upAt(ship.pos), smoothstep(T_LAND0 + 10, T_TD - 2, t)).normalize();
    if (t >= T_TD) axis = upAt(ship.pos);
    orient(s1, axis);
    const s1On = (k: number) =>
      (t > -3 && t < 147) || (t >= T_ENTRY0 && t < T_ENTRY1 && (k === 0 || k === 1 || k === 5)) || (t >= T_LAND0 && t < T_TD && k === 0);
    s1.engines.forEach((e, k) => {
      e.on = s1On(k);
      e.spool = e.on ? 1 : 0;
      e.throttle = e.on ? (t > 58 && t < 80 ? 0.72 : t >= T_LAND0 ? 0.75 : 1) : 0;
      e.thrust = e.on ? MERLIN_1D.thrustSL * e.throttle : 0;
      e.ignitionT = k === 0 ? (t >= T_LAND0 ? T_LAND0 : t >= T_ENTRY0 ? T_ENTRY0 : -3) : -3;
    });
    s1.phase = t < 0 ? 'PRELAUNCH' : t < T_SEP ? 'ASCENT' : t < T_FLIP0 ? 'COAST' : t < T_FLIP1 ? 'FLIP' : t < T_ENTRY0 ? 'COAST'
      : t < T_ENTRY1 ? 'ENTRY_BURN' : t < T_LAND0 ? 'AERO' : t < T_TD ? 'LANDING_BURN' : 'LANDED';
    s1.status = t < T_SEP ? 'free' : 'free';
    if (t >= T_TD) s1.status = 'landed';
    if (this.variant === 'splash' && t >= T_TD - 1) { s1.status = 'splashed'; s1.phase = 'LOST'; }
    if (this.variant === 'rud' && t >= T_TD - 1) { s1.status = 'destroyed'; s1.phase = 'LOST'; }
    if (s1.gridFins) s1.gridFins.deploy = smoothstep(T_FLIP1 - 4, T_FLIP1, t);
    s1.legs = smoothstep(503, 507, t);
    s1.rcs = s1.rcs.map((_, i) => (t > T_FLIP0 && t < T_FLIP1 && ((i + Math.floor(t * 3)) % 3 === 0) ? 1 : 0));
    s1.heating = t > T_ENTRY0 && t < T_ENTRY1 + 10 ? 0.6 : 0;
    derive(s1);

    // ---------------- S2 ----------------
    const s2 = b.S2;
    if (t < T_SEP) {
      s2.pos.copy(s1.pos).addScaledVector(axis, F9.s2.mountY);
      s2.vel.copy(s1.vel);
      s2.quat.copy(s1.quat);
      s2.status = 'stacked';
    } else {
      const off = new THREE.Vector3(0, F9.s2.mountY, 0).applyQuaternion(this.quatAtSep(ship));
      setKin('S2', (tt, o) => this.s2Pos(tt, o).add(off));
      orient(s2, velDir(s2, upAt(s2.pos)));
      s2.status = t < T_SECO ? 'free' : 'orbit';
    }
    const s2on = t >= T_SES && t < T_SECO;
    s2.engines.forEach((e) => { e.on = s2on; e.spool = s2on ? 1 : 0; e.throttle = s2on ? 1 : 0; e.thrust = s2on ? MERLIN_VAC.thrustVac : 0; e.ignitionT = T_SES; });
    derive(s2);
    const s2axis = new THREE.Vector3(0, 1, 0).applyQuaternion(s2.quat);

    // ---------------- fairings + payload ----------------
    for (const [id, sign] of [['FAIRING_A', 1], ['FAIRING_B', -1]] as const) {
      const f = b[id];
      if (t < T_FAIR) {
        f.pos.copy(s2.pos).addScaledVector(s2axis, F9.fairing.baseY);
        f.quat.copy(s2.quat); f.vel.copy(s2.vel); f.status = 'stacked'; f.parafoil = 0;
      } else {
        const p0 = this.s2Pos(T_FAIR), v0 = this.s2Pos(T_FAIR + 0.1).sub(this.s2Pos(T_FAIR - 0.1)).multiplyScalar(5);
        const q0 = quatFromAxis(v0.clone().normalize(), enuAt(p0).east);
        const ax0 = new THREE.Vector3(0, 1, 0).applyQuaternion(q0);
        const side = new THREE.Vector3(sign, 0, 0).applyQuaternion(q0);
        const fp = (tt: number, o: THREE.Vector3) => {
          const dt = tt - T_FAIR;
          o.copy(p0).addScaledVector(ax0, F9.fairing.baseY).addScaledVector(v0, dt * 0.995).addScaledVector(side, 2.5 * dt)
            .addScaledVector(upAt(p0), -0.5 * 9.6 * dt * dt);
          const a = altitudeOf(o);
          if (a < 3) o.addScaledVector(upAt(o), 3 - a);
          return o;
        };
        setKin(id, fp);
        const dt = t - T_FAIR;
        f.quat.copy(q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -sign * 0.22 * dt));
        f.status = altitudeOf(f.pos) <= 3.5 ? 'splashed' : 'free';
        f.parafoil = smoothstep(T_FAIR + 200, T_FAIR + 206, t);
      }
      derive(f);
    }
    const pl = b.PAYLOAD;
    if (t < T_DEPLOY) {
      pl.pos.copy(s2.pos).addScaledVector(s2axis, F9.payload.baseY); pl.quat.copy(s2.quat); pl.vel.copy(s2.vel); pl.status = 'stacked';
    } else {
      pl.pos.copy(s2.pos).addScaledVector(s2axis, F9.payload.baseY + 0.25 * (t - T_DEPLOY)); pl.quat.copy(s2.quat); pl.status = 'deployed';
    }
    derive(pl);
    derive(ship);

    for (const m of s.timeline) m.done = t >= m.t;
    s.landing = t > 440 && t < T_TD + 1 ? { impactPoint: ship.pos.clone(), missDistance: 3, burnStartT: T_LAND0, touchdownT: T_TD, manual: false } : undefined;
    return s;
  }

  private _qSep: THREE.Quaternion | null = null;
  private quatAtSep(ship: BodyState): THREE.Quaternion {
    if (!this._qSep) {
      const a = this.stackPos(T_SEP + 0.1), c = this.stackPos(T_SEP - 0.1);
      const v = a.sub(c).normalize();
      this._qSep = quatFromAxis(v, enuAt(c).east);
    }
    void ship;
    return this._qSep;
  }
}

export function installFakeSim(ctx: AppContext, variant: string): boolean {
  const app = (window as unknown as { __app?: { sim?: { getSnapshot: () => SimSnapshot } } }).__app;
  const sim = app?.sim;
  if (!sim) return false;
  const realGet = sim.getSnapshot.bind(sim);
  const fake = new FakeMission(variant);
  let prevT = NaN;
  sim.getSnapshot = () => {
    const s = fake.build(realGet());
    if (!Number.isNaN(prevT) && s.t > prevT && s.t - prevT < 5) {
      for (const e of EVENTS) {
        if (e.t > prevT && e.t <= s.t) {
          if (variant !== '1' && e.type === 'TOUCHDOWN') {
            ctx.events.emit({ type: variant === 'rud' ? 'RUD' : 'SPLASHDOWN', t: e.t, body: 'S1' });
            continue;
          }
          ctx.events.emit({ type: e.type, t: e.t, body: e.body, data: e.data });
        }
      }
    }
    prevT = s.t;
    return s;
  };
  console.info('[cameras] fake mission snapshots installed (camfake=%s)', variant);
  return true;
}
