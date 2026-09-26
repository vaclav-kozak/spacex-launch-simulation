// Headless mission tests for the flight simulation. Usage:
//   npm run simtest                 # all scenarios
//   npm run simtest -- nominal      # scenarios whose name contains "nominal"
//   npm run simtest -- nominal --trace   # + 5 s state trace
//   npm run simtest -- --callouts   # include CALLOUT events in the log

import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import type { SimEvent } from '../src/core/types';
import { Simulation } from '../src/sim/Simulation';
import { EARTH_RADIUS } from '../src/core/constants';

interface Scenario {
  name: string;
  settings?: Partial<Settings>;
  actions?: { t: number; label: string; run: (s: Simulation) => void }[];
  until?: number;
}

const args = process.argv.slice(2);
const filter = args.filter((a) => !a.startsWith('--'));
const TRACE = args.includes('--trace');
const CALLOUTS = args.includes('--callouts');

const SCENARIOS: Scenario[] = [
  { name: 'nominal' },
  { name: 'early-staging-T100', actions: [{ t: 100, label: 'manual staging', run: (s) => s.stageSeparation() }] },
  { name: 'early-staging-T130', actions: [{ t: 130, label: 'manual staging', run: (s) => s.stageSeparation() }] },
  { name: 'rough-sea6-wind15', settings: { seaState: 6, windSpeed: 15 } },
  { name: 'fairing-never', actions: [{ t: -10, label: 'auto fairing off', run: (s) => s.setAutoFairing(false) }] },
  { name: 'fairing-early-T120', actions: [{ t: 120, label: 'manual fairing sep', run: (s) => s.fairingSeparation() }] },
  { name: 'manual-landing-zero-input', settings: { manualLanding: true } },
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
  const seekTo = (t: number) => {
    if (!TRACE) { sim.seek(t); return; }
    while (f.t < t) { sim.seek(Math.min(t, f.t + 0.5)); doTrace(); }
  };
  for (const a of actions) {
    seekTo(a.t);
    console.log(`  ${fmt(sim.flight.t)} >> ${a.label}`);
    a.run(sim);
  }
  seekTo(until);
  const tRun = performance.now() - tS;
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
