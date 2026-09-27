// Headless mission tests for the flight simulation. Usage:
//   npm run simtest                 # all scenarios
//   npm run simtest -- nominal      # scenarios whose name contains "nominal"
//   npm run simtest -- nominal --trace   # + 5 s state trace
//   npm run simtest -- --callouts   # include CALLOUT events in the log

import { Quaternion, Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import type { SimEvent, SimSnapshot } from '../src/core/types';
import { Simulation } from '../src/sim/Simulation';
import { EARTH_RADIUS } from '../src/core/constants';
import { F9, MERLIN_1D } from '../src/core/vehicleSpec';

interface Scenario {
  name: string;
  settings?: Partial<Settings>;
  actions?: { t: number; label: string; run: (s: Simulation) => void }[];
  /** manual-landing pilot fed like the HUD (every 1/30 s while S1 is in AERO / LANDING_BURN) */
  pilot?: () => Pilot;
  until?: number;
}

interface Pilot {
  update(snap: SimSnapshot, dt: number): { throttle: number; pitch: number; yaw: number };
  log: string[];
}

/**
 * A "reasonable human" flying the manual-landing HUD: same inputs as ManualHud (persistent lever
 * ramped at 0.7/s with W/S, X cuts, stick slewed at 6/s), 0.3 s reaction delay, and only the
 * information the HUD shows: deck map (booster + predicted impact point relative to the deck,
 * deck-relative velocity), height, sink rate, the ignition cue (`landing.burnStartT`) and the
 * "NEED x %" throttle readout (HUD formula: stop at the deck at constant deceleration, half the
 * measured drag deceleration credited).
 */
function makeHumanPilot(opts: { delay?: number; ignitionLate?: number } = {}): () => Pilot {
  return () => {
    const delay = opts.delay ?? 0.3;
    const late = opts.ignitionLate ?? 0;
    const q = new Quaternion();
    const rel = new Vector3(), vRel = new Vector3(), ip = new Vector3(), ax = new Vector3();
    let lever = 0, pitch = 0, yaw = 0, cut = false, lit = false;
    let aDrag = 0, prevT = NaN, prevVs = 0, cueT = NaN, nextLog = 0;
    const seen: { t: number; obs: Obs }[] = [];
    interface Obs { h: number; vDown: number; x: number; z: number; vx: number; vz: number; ipx: number; ipz: number; ipOk: boolean; req: number; burnStartT: number; engOn: boolean; t: number }
    const log: string[] = [];
    const observe = (snap: SimSnapshot): Obs => {
      const s1 = snap.bodies.S1, ship = snap.bodies.SHIP;
      q.copy(ship.quat).invert();
      rel.copy(s1.pos).sub(ship.pos).applyQuaternion(q);
      vRel.copy(s1.vel).sub(ship.vel).applyQuaternion(q);
      const h = rel.y + (s1.legs ?? 0) * F9.s1.leg.footY;
      const vDown = -vRel.y;
      const dts = snap.t - prevT;
      if (dts > 0.02 && dts < 1) {
        const aVert = (s1.verticalSpeed - prevVs) / dts;
        ax.set(0, 1, 0).applyQuaternion(s1.quat);
        const aThrust = (s1.thrust ?? 0) / Math.max(1, s1.mass) * ax.y;
        aDrag += (Math.min(60, Math.max(0, aVert + 9.81 - aThrust)) - aDrag) * Math.min(1, dts / 0.4);
      }
      prevT = snap.t; prevVs = s1.verticalSpeed;
      const req = vDown > 1 && h > 0.5 ? (s1.mass * Math.max(0, (vDown * vDown) / (2 * Math.max(1, h)) + 9.81 - 0.5 * aDrag)) / MERLIN_1D.thrustSL : NaN;
      const L = snap.landing;
      const ipOk = !!L && L.valid !== false;
      if (ipOk) ip.copy(L!.impactPoint).sub(ship.pos).applyQuaternion(q);
      return {
        h, vDown, x: rel.x, z: rel.z, vx: vRel.x, vz: vRel.z, ipx: ipOk ? ip.x : rel.x, ipz: ipOk ? ip.z : rel.z, ipOk, req,
        burnStartT: L?.burnStartT ?? NaN, engOn: !!s1.engines[0]?.on, t: snap.t,
      };
    };
    const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
    return {
      log,
      update(snap, dt) {
        seen.push({ t: snap.t, obs: observe(snap) });
        while (seen.length > 1 && seen[1].t <= snap.t - delay) seen.shift();
        const o = seen[0].obs; // what the pilot has perceived and reacted to
        const ph = snap.bodies.S1.phase;
        // --- throttle lever ---
        let target = lever;
        if (!lit) {
          // wait for the ignition cue, then hold W
          // the HUD counts down "IGNITION IN x s" and then shows "IGNITE NOW"
          if (Number.isNaN(cueT) && Number.isFinite(o.burnStartT) && o.t >= o.burnStartT) cueT = o.t;
          const go = late >= 0 ? o.t >= cueT + late : Number.isFinite(o.burnStartT) && o.t >= o.burnStartT + late;
          if (go) { lit = true; log.push(`W at ${fmtT(snap.t)} (IGNITE NOW ${Number.isNaN(cueT) ? 'not yet shown' : `shown at ${fmtT(cueT)}`})`); }
          target = lit ? 0.8 : 0;
        }
        if (lit && !cut) {
          // keep the lever a little above the HUD's "NEED x %" marker (it ignores the tilt and the
          // back-pressure loss at part throttle, and the pilot wants to stop just above the deck)
          if (Number.isFinite(o.req)) target = Math.max(MERLIN_1D.minThrottle + 0.02, Math.min(1, o.req * 1.08 + 0.02));
          // last metres: feather at minimum (T/W ≈ 1.1, cannot hover) and cut at contact / if it stops
          if (o.h < 12 && o.vDown < 4) target = MERLIN_1D.minThrottle;
          if (ph === 'LANDING_BURN' && (o.h < 0.8 || o.vDown < 0.3)) { cut = true; log.push(`X at ${fmtT(snap.t)} h=${o.h.toFixed(1)} vDown=${o.vDown.toFixed(1)}`); }
        }
        if (cut) lever = 0;
        else if (Math.abs(target - lever) > 0.03) lever += Math.sign(target - lever) * Math.min(Math.abs(target - lever), 0.7 * dt);
        // --- stick: push the impact point / booster onto the deck (deck frame) ---
        let tx: number, tz: number;
        if (ph === 'AERO' || o.h > 200) {
          const ex = o.ipOk ? o.ipx : o.x, ez = o.ipOk ? o.ipz : o.z;
          tx = Math.abs(ex) < 5 ? 0 : clamp1(-ex / 80);
          tz = Math.abs(ez) < 5 ? 0 : clamp1(-ez / 80);
        } else {
          // low: the stick commands drift over the deck — steer toward the X, easing off as it closes
          tx = Math.abs(o.x) < 1.5 ? 0 : clamp1(-o.x / 25);
          tz = Math.abs(o.z) < 1.5 ? 0 : clamp1(-o.z / 25);
        }
        if (PILOT_LOG && lit && snap.t >= nextLog) {
          nextLog = snap.t + 1;
          const s1 = snap.bodies.S1;
          ax.set(0, 1, 0).applyQuaternion(s1.quat);
          log.push(`${fmtT(snap.t)} h=${o.h.toFixed(0)} vD=${o.vDown.toFixed(1)} req=${o.req.toFixed(2)} lever=${lever.toFixed(2)} thr=${(s1.engines[0]?.throttle ?? 0).toFixed(2)} x=${o.x.toFixed(0)} z=${o.z.toFixed(0)} vx=${o.vx.toFixed(1)} vz=${o.vz.toFixed(1)} ip=${o.ipx.toFixed(0)},${o.ipz.toFixed(0)} stick=${yaw.toFixed(2)},${pitch.toFixed(2)} tilt=${(Math.acos(Math.min(1, ax.y)) * 57.3).toFixed(1)}`);
        }
        const rate = 6 * dt;
        yaw += Math.max(-rate, Math.min(rate, tx - yaw));
        pitch += Math.max(-rate, Math.min(rate, tz - pitch));
        return { throttle: lever, pitch, yaw };
      },
    };
  };
}

function fmtT(t: number): string {
  return `T+${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}

const args = process.argv.slice(2);
const filter = args.filter((a) => !a.startsWith('--'));
const TRACE = args.includes('--trace');
const CALLOUTS = args.includes('--callouts');
const PILOT_LOG = args.includes('--pilot-log');

const SCENARIOS: Scenario[] = [
  { name: 'nominal' },
  ...[60, 100, 130, 145].map((t): Scenario => ({
    name: `early-staging-T${t}`, actions: [{ t, label: 'manual staging', run: (s) => s.stageSeparation() }],
  })),
  { name: 'rough-sea6-wind15', settings: { seaState: 6, windSpeed: 15 } },
  { name: 'rough-sea6-wind20', settings: { seaState: 6, windSpeed: 20 } },
  { name: 'fairing-never', actions: [{ t: -10, label: 'auto fairing off', run: (s) => s.setAutoFairing(false) }] },
  { name: 'fairing-early-T120', actions: [{ t: 120, label: 'manual fairing sep', run: (s) => s.fairingSeparation() }] },
  { name: 'manual-landing-zero-input', settings: { manualLanding: true } },
  { name: 'manual-landing-pilot', settings: { manualLanding: true, seaState: 2, windSpeed: 4 }, pilot: makeHumanPilot() },
  { name: 'manual-landing-pilot-late', settings: { manualLanding: true, seaState: 2, windSpeed: 4 }, pilot: makeHumanPilot({ ignitionLate: 1.5 }) },
  { name: 'manual-landing-pilot-early', settings: { manualLanding: true, seaState: 2, windSpeed: 4 }, pilot: makeHumanPilot({ ignitionLate: -2 }) },
  { name: 'manual-landing-pilot-sea4', settings: { manualLanding: true, seaState: 4, windSpeed: 10 }, pilot: makeHumanPilot({ delay: 0.45 }) },
  { name: 'manual-landing-pilot-very-late', settings: { manualLanding: true, seaState: 2, windSpeed: 4 }, pilot: makeHumanPilot({ ignitionLate: 4 }) },
];

function fmt(t: number): string {
  if (!Number.isFinite(t)) return '   —   ';
  const s = Math.abs(t);
  const m = Math.floor(s / 60);
  return `T${t < 0 ? '-' : '+'}${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function dataStr(d?: Record<string, unknown>): string {
  if (!d) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number') parts.push(`${k}=${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)}`);
    else if (typeof v === 'string' || typeof v === 'boolean') parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

function run(sc: Scenario): Record<string, number | string> {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...sc.settings };
  const bus = new EventBus();
  const log: SimEvent[] = [];
  bus.on('*', (e) => log.push(e));
  const t0 = performance.now();
  const sim = new Simulation(settings, bus);
  const tCtor = performance.now() - t0;
  console.log(`\n=== ${sc.name} ===  (constructor incl. pre-sim ${tCtor.toFixed(0)} ms, pre-sim ${sim.nominalMs.toFixed(0)} ms)`);
  const actions = [...(sc.actions ?? [])].sort((a, b) => a.t - b.t);
  const until = sc.until ?? 1000;
  const tS = performance.now();
  let traceNext = 0;
  const f = sim.flight;
  const doTrace = () => {
    if (!TRACE) return;
    while (f.t >= traceNext) {
      const ids = ['S1', 'S2'] as const;
      const parts: string[] = [];
      for (const id of ids) {
        const b = f.bodies[id];
        if (b.status === 'gone') continue;
        const up = new Vector3(b.pos.x, b.pos.y + EARTH_RADIUS, b.pos.z).normalize();
        const ax = new Vector3(0, 1, 0).applyQuaternion(b.quat);
        const pitch = (Math.asin(Math.max(-1, Math.min(1, ax.dot(up)))) * 180) / Math.PI;
        parts.push(`${id}[${b.phase ?? b.status}] h=${(b.altitude / 1000).toFixed(1)}km vI=${b.speedInertial.toFixed(0)} v=${b.speed.toFixed(0)} vz=${b.verticalSpeed.toFixed(0)} q=${(b.dynPressure / 1000).toFixed(1)}k M=${b.mach.toFixed(2)} el=${pitch.toFixed(1)} prop=${(b.propMass / 1000).toFixed(1)}t F=${(b.thrust / 1000).toFixed(0)}kN dr=${(b.downrange / 1000).toFixed(1)}km`);
      }
      const L = sim.getSnapshot().landing;
      if (L?.valid) parts.push(`miss=${L.missDistance.toFixed(0)}`);
      console.log(`  ${fmt(f.t)} ${parts.join(' | ')}`);
      traceNext += f.t < 140 ? 10 : f.t > 440 && f.t < 530 ? 2 : 10;
    }
  };
  const pilot = sc.pilot?.();
  const seekTo = (t: number) => {
    if (!TRACE && !pilot) { sim.seek(t); return; }
    while (f.t < t) {
      const ph = sim.getSnapshot().bodies.S1.phase;
      const flying = !!pilot && (ph === 'AERO' || ph === 'LANDING_BURN');
      sim.seek(Math.min(t, f.t + (flying ? 1 / 30 : 0.5)));
      if (flying) sim.setManualInput(pilot.update(sim.getSnapshot(), 1 / 30));
      doTrace();
    }
  };
  for (const a of actions) {
    seekTo(a.t);
    console.log(`  ${fmt(sim.flight.t)} >> ${a.label}`);
    a.run(sim);
  }
  seekTo(until);
  const tRun = performance.now() - tS;
  if (pilot) for (const l of pilot.log) console.log(`  pilot: ${l}`);
  for (const e of log) {
    if (e.type === 'CALLOUT' && !CALLOUTS) continue;
    if (e.type === 'WARP_CHANGED') continue;
    console.log(`  ${fmt(e.t)} ${e.type.padEnd(20)} ${e.body ?? ''} ${e.type === 'CALLOUT' ? String(e.data?.text) : dataStr(e.data)}`);
  }
  const sum = sim.getSummary();
  console.log(`  --- summary: ${sum.outcome}`);
  for (const l of sum.lines) console.log(`      ${l.label.padEnd(26)} ${l.value}`);
  console.log(`  run time ${tRun.toFixed(0)} ms for ${until} s`);
  const et = f.eventTimes;
  return {
    name: sc.name, outcome: sum.outcome, maxq: et.MAX_Q ?? NaN, qpk: f.qPeak, meco: et.MECO ?? NaN,
    seco: et.SECO ?? NaN, td: f.touchdown?.t ?? NaN, miss: f.touchdown?.miss ?? NaN, ms: tRun,
  };
}

const results: Record<string, number | string>[] = [];
for (const sc of SCENARIOS) {
  if (filter.length && !filter.some((x) => sc.name.includes(x))) continue;
  results.push(run(sc));
}

// seek performance
if (!filter.length || filter.includes('seek')) {
  const sim = new Simulation({ ...DEFAULT_SETTINGS }, new EventBus());
  const t0 = performance.now();
  sim.seek(900);
  console.log(`\nseek(900) from T-60: ${(performance.now() - t0).toFixed(0)} ms`);
  const t1 = performance.now();
  sim.seek(500);
  console.log(`seek(500) backwards (rebuild): ${(performance.now() - t1).toFixed(0)} ms`);
}

console.log('\n' + results.map((r) => `${String(r.name).padEnd(28)} ${String(r.outcome).padEnd(36)} maxQ ${fmt(r.maxq as number)} ${((r.qpk as number) / 1000).toFixed(1)}kPa  MECO ${fmt(r.meco as number)}  SECO ${fmt(r.seco as number)}  TD ${fmt(r.td as number)} miss ${(r.miss as number).toFixed(1)}`).join('\n'));
