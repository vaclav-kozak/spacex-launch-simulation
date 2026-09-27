// Auto-director: which camera each viewport should show right now. Pure script over the
// snapshot (statuses/phases) + event times, so it behaves after seeks too. The ViewportManager
// applies it with minimum shot lengths and user overrides. OWNER: cameras.
import type { CameraMode } from '../core/context';
import type { SimEventType, SimSnapshot } from '../core/types';
import * as THREE from 'three';
import { OCISLY } from '../core/vehicleSpec';
import { sitePosition } from './rigs';

export interface Shot {
  mode: CameraMode;
  preset?: string;
  /** cut immediately even if the current shot is younger than the minimum length */
  urgent?: boolean;
}

export type StoryKey = 'S1' | 'S2' | 'FAIRING' | 'REPLAY';
export type EvT = (type: SimEventType) => number | undefined;

const chase: Shot = { mode: 'chase' };
const _site = new THREE.Vector3();

/** Cut to the deck cam this many seconds before the PREDICTED touchdown. The in-burn prediction is a
 * constant-deceleration estimate that ignores the ~2 s terminal creep (last 5 m at 2-3 m/s), so this
 * lands the cut ~6 s before the predicted and ~8 s before the actual touchdown (webcast: the booster
 * appears in the deck cam's sky ~7 s out). */
export const DECK_CUT_TGO = 6.2;

/** Seconds until booster touchdown (predicted), or Infinity. */
export function boosterTimeToGo(snap: SimSnapshot): number {
  const s1 = snap.bodies.S1;
  if (s1.phase !== 'LANDING_BURN' && s1.phase !== 'AERO') return Infinity;
  const L = snap.landing;
  if (L && Number.isFinite(L.touchdownT) && L.touchdownT > snap.t - 1) return L.touchdownT - snap.t;
  const h = Math.max(0, s1.altitude - OCISLY.deckHeight - 2);
  const vs = Math.max(1, -s1.verticalSpeed);
  // constant-deceleration hoverslam: t = 2h/v ; unpowered: h/v
  return s1.phase === 'LANDING_BURN' ? (2 * h) / vs : h / vs;
}

/** Launch / ascent while the vehicle is still stacked (single "FALCON 9" view). */
function stackShot(snap: SimSnapshot, evT: EvT): Shot {
  const t = snap.t;
  if (t < -46) return { mode: 'pad', preset: 'wide' };
  if (t < -33) return { mode: 'pad', preset: 'tower' };
  if (t < -21) return { mode: 'long_lens', preset: 'near' };
  if (t < -11) return { mode: 'pad', preset: 'wide' };
  if (t < -4.6) return { mode: 'pad', preset: 'up' };
  if (t < 1.8) return { mode: 'pad', preset: 'engine', urgent: true }; // TEA-TEB green flash, hold-down release
  if (t < 7) return { mode: 'pad', preset: 'up' };
  if (t < 14) return { mode: 'pad', preset: 'wide' };
  if (t < 34) return { mode: 'long_lens' };
  const maxQ = evT('MAX_Q') ?? 72;
  const meco = evT('MECO') ?? 147;
  if (t < maxQ - 14) return chase;
  if (t < maxQ - 6) return { mode: 'cinematic', preset: 'flyby' };
  if (t < maxQ + 18) return chase; // condensation around max-Q
  if (t < maxQ + 40) return { mode: 'onboard_down' }; // plume + coastline below
  if (t < meco - 18) return { mode: 'long_lens' }; // expanding plume from the ground
  return chase; // MECO + separation seen from behind
}

function boosterShot(snap: SimSnapshot, evT: EvT): Shot {
  const t = snap.t;
  const s1 = snap.bodies.S1;
  if (s1.status === 'landed' || s1.status === 'tipped') {
    const td = evT('TOUCHDOWN') ?? t;
    if (t - td < 7.5) return { mode: 'deck' };
    return { mode: 'cinematic', preset: 'ship_orbit' };
  }
  if (s1.status === 'splashed' || s1.status === 'destroyed' || s1.status === 'gone') {
    return { mode: 'long_lens', preset: 'ship' };
  }
  const tgo = boosterTimeToGo(snap);
  switch (s1.phase) {
    case 'LANDING_BURN':
      if (tgo < DECK_CUT_TGO) return { mode: 'deck', urgent: true };
      return { mode: 'onboard_down', urgent: true };
    case 'AERO': {
      if (tgo < 4) return { mode: 'onboard_down' };
      const since = t - (evT('ENTRY_BURN_END') ?? t);
      // the support ship's tracker only makes sense once the booster is inside ~15 km (further out it
      // is a speck in haze even at the longest focal length); a flyby at 1 km/s is over in a blink
      const inRange = sitePosition('ship', snap, _site).distanceTo(s1.pos) < 15_000;
      if (since < 14) return chase; // side-on: plume dies, the horizon behind
      if (since < 30) return { mode: 'onboard_down' }; // grid fins steering, ocean below
      if (since < 46 || !inRange) return chase;
      return { mode: 'long_lens', preset: 'ship' };
    }
    case 'ENTRY_BURN': {
      const since = t - (evT('ENTRY_BURN_START') ?? t);
      return since < 7 ? chase : { mode: 'onboard_down' };
    }
    default: {
      // COAST / FLIP (and anything unexpected): flip + RCS in chase, then onboard during the coast
      const since = t - (evT('STAGE_SEP') ?? t);
      if (s1.phase === 'FLIP' || since < 50) return chase;
      const eb = evT('ENTRY_BURN_START');
      if (eb !== undefined && eb > t && eb - t < 12) return chase; // see the entry burn light up
      const k = (since - 50) % 55;
      return k < 32 ? { mode: 'onboard_down' } : chase;
    }
  }
}

/** Scene facts the director can't read from the snapshot. */
export interface DirectorOpts {
  /** night preset: the upper stage is in the Earth's shadow, so after SECO the bell is lit only by its own glow */
  night?: boolean;
}

/** Seconds after SECO to stay on the engine cam. At night the bell is lit only by its own glow: the MVac
 * extension cools from ~1480 K to ~1100 K (no longer visible at the onboard exposure) in ~7 s, so cut then,
 * before auto-exposure lifts the black frame. In daylight the sunlit bell stays readable a little longer. */
const POST_SECO_HOLD = { day: 13, night: 7.5 };

function secondStageShot(snap: SimSnapshot, evT: EvT, opts: DirectorOpts): Shot {
  const t = snap.t;
  const s2 = snap.bodies.S2;
  const seco = evT('SECO');
  const secoDone = seco !== undefined && t >= seco && s2.thrust < 1;
  const deploy = evT('PAYLOAD_DEPLOY');
  if (snap.bodies.PAYLOAD.status === 'deployed' || (deploy !== undefined && secoDone && t > deploy - 4)) return chase;
  // after SECO: stay on the engine cam while the extension visibly cools (~1480 K -> dull red in
  // ~8 s), then cut away before auto-exposure lifts the dark, unlit bell to a grey ball
  if (secoDone) return t - seco! < (opts.night ? POST_SECO_HOLD.night : POST_SECO_HOLD.day) ? { mode: 'onboard_engine' } : chase;
  const fs = evT('FAIRING_SEP');
  if (fs !== undefined && t > fs - 4 && t < fs + 10) return chase;
  const ses = evT('SES1');
  if (ses === undefined || t < ses + 3 || s2.thrust < 1) return chase; // separation + MVac start
  const k = (t - ses - 3) % 44;
  return k < 30 ? { mode: 'onboard_engine' } : chase;
}

/** Slow-mo touchdown replay (single fullscreen view). */
function replayShot(snap: SimSnapshot, evT: EvT): Shot {
  const t = snap.t;
  const td = evT('TOUCHDOWN') ?? evT('SPLASHDOWN') ?? t;
  if (t < td - 6.5) return { mode: 'long_lens', preset: 'ship' };
  if (t < td + 1.5) return { mode: 'deck' };
  return { mode: 'cinematic', preset: 'ship_orbit' };
}

export function directorShot(key: StoryKey, snap: SimSnapshot, evT: EvT, opts: DirectorOpts = {}): Shot {
  switch (key) {
    case 'REPLAY': return replayShot(snap, evT);
    case 'S1': return snap.bodies.S2.status === 'stacked' ? stackShot(snap, evT) : boosterShot(snap, evT);
    case 'S2': return secondStageShot(snap, evT, opts);
    case 'FAIRING': return snap.t - (evT('FAIRING_SEP') ?? snap.t) < 40 ? chase : { mode: 'cinematic', preset: 'dolly' };
  }
}

/** Major events that release a user's manual camera choice. */
export const MAJOR_EVENTS: ReadonlySet<SimEventType> = new Set<SimEventType>([
  'LIFTOFF', 'MAX_Q', 'MECO', 'STAGE_SEP', 'SES1', 'FAIRING_SEP', 'BOOSTER_FLIP', 'ENTRY_BURN_START',
  'LANDING_BURN_START', 'TOUCHDOWN', 'SPLASHDOWN', 'RUD', 'SECO', 'PAYLOAD_DEPLOY',
]);
