// Launch-control + webcast-host callout script. OWNER: sim.
//
// Every CALLOUT event the sim emits carries data = { id, text, voice } where `id` is a key of
// CALLOUTS and text/voice are exactly the values below (no dynamic numbers), so audio can
// pre-generate one TTS clip per entry of CALLOUT_LINES (file name = id).
//   voice 'lc'   = launch control / flight controller net (terse, radio-filtered)
//   voice 'host' = webcast host (studio voice)

export type CalloutVoice = 'lc' | 'host';

export interface CalloutLine {
  id: string;
  text: string;
  voice: CalloutVoice;
}

const L = (voice: CalloutVoice, text: string) => ({ text, voice });

export const CALLOUTS = {
  // ---- countdown ----
  host_welcome: L('host', 'Welcome to Vandenberg Space Force Base, where Falcon 9 is about to launch another batch of Starlink satellites.'),
  lc_startup: L('lc', 'Falcon 9 is in startup.'),
  host_ship_ready: L('host', 'The droneship Of Course I Still Love You is on station in the Pacific, ready to catch the booster.'),
  lc_go_for_launch: L('lc', 'Launch director has verified go for launch.'),
  host_t30: L('host', 'T minus thirty seconds.'),
  lc_t15: L('lc', 'T minus fifteen.'),
  lc_10: L('lc', 'Ten.'),
  lc_9: L('lc', 'Nine.'),
  lc_8: L('lc', 'Eight.'),
  lc_7: L('lc', 'Seven.'),
  lc_6: L('lc', 'Six.'),
  lc_5: L('lc', 'Five.'),
  lc_4: L('lc', 'Four.'),
  lc_ignition: L('lc', 'Ignition sequence start.'),
  lc_2: L('lc', 'Two.'),
  lc_1: L('lc', 'One.'),
  lc_0: L('lc', 'Zero.'),
  lc_liftoff: L('lc', 'Liftoff.'),
  host_liftoff: L('host', 'And liftoff of Falcon 9 and Starlink!'),
  lc_hold: L('lc', 'Hold, hold, hold.'),
  lc_holding: L('lc', 'We are holding the count.'),
  lc_resume: L('lc', 'Resuming the count.'),
  lc_abort: L('lc', 'Abort, abort, abort. Engine shutdown.'),
  lc_recycle: L('lc', 'Recycling the count to T minus sixty seconds.'),

  // ---- ascent ----
  lc_cleared_tower: L('lc', 'Vehicle has cleared the tower.'),
  lc_s1_nominal: L('lc', 'Stage one propulsion is nominal.'),
  lc_supersonic: L('lc', 'Vehicle is supersonic.'),
  lc_throttle_down: L('lc', 'Throttling down.'),
  lc_maxq: L('lc', 'Max Q.'),
  host_maxq: L('host', 'Falcon 9 is passing through max Q, the moment of peak mechanical stress on the rocket.'),
  lc_throttle_up: L('lc', 'Throttle up.'),
  lc_meco: L('lc', 'MECO.'),
  lc_stage_sep: L('lc', 'Stage separation confirmed.'),
  lc_mvac_ignition: L('lc', 'MVac ignition.'),
  host_s2_burning: L('host', 'The second stage engine is burning, and we have a good MVac plume.'),
  lc_fairing_sep: L('lc', 'Fairing separation confirmed.'),
  host_fairing: L('host', 'The fairing halves have separated and will parachute down to the ocean for recovery.'),
  lc_s2_nominal: L('lc', 'Stage two propulsion is nominal.'),
  lc_seco: L('lc', 'SECO.'),
  host_orbit: L('host', 'Second stage engine cutoff, and we are in a nominal parking orbit.'),
  lc_deploy: L('lc', 'Starlink deployment confirmed.'),
  host_deploy: L('host', 'All Starlink satellites have been successfully deployed. That concludes our mission.'),

  // ---- booster recovery ----
  lc_flip: L('lc', 'Stage one flip maneuver in progress.'),
  host_flip: L('host', 'The first stage is using its cold gas thrusters to flip around, engines first.'),
  lc_gridfins: L('lc', 'Grid fins deployed.'),
  host_apogee: L('host', 'The booster has reached apogee and is starting to fall back toward the droneship.'),
  lc_entry_start: L('lc', 'Entry burn startup.'),
  lc_entry_end: L('lc', 'Entry burn shutdown.'),
  host_entry: L('host', 'Three engines relit to slow the booster down and protect it from the heat of reentry.'),
  lc_transonic: L('lc', 'Stage one transonic.'),
  host_gridfins_steer: L('host', 'The grid fins are now steering the booster toward Of Course I Still Love You.'),
  lc_landing_start: L('lc', 'Landing burn startup.'),
  lc_legs: L('lc', 'Landing legs deployed.'),
  host_landed: L('host', 'The Falcon has landed!'),
  lc_landed: L('lc', 'Stage one touchdown confirmed.'),
  host_manual: L('host', 'Manual landing mode. You have the controls.'),

  // ---- manual commands ----
  lc_manual_staging: L('lc', 'Manual stage separation commanded.'),
  lc_manual_fairing: L('lc', 'Manual fairing separation commanded.'),

  // ---- failures ----
  host_hard_landing: L('host', 'That was a hard landing. The legs could not absorb the impact.'),
  host_tipped: L('host', 'The booster has tipped over on the deck.'),
  host_offdeck: L('host', 'The booster missed the droneship and went into the water.'),
  host_splash_short: L('host', 'The booster did not have the energy to reach the droneship and has splashed down in the ocean.'),
  host_booster_lost: L('host', 'It looks like we have lost the booster.'),
  lc_s1_flameout: L('lc', 'Stage one engine flameout. Propellant depleted.'),
  lc_anomaly: L('lc', 'We have lost telemetry from the vehicle. Vehicle anomaly.'),
  host_anomaly: L('host', 'It appears the vehicle has experienced an anomaly.'),
  lc_s2_flameout: L('lc', 'Premature second stage engine shutdown.'),
  host_no_orbit: L('host', 'Unfortunately the second stage did not reach orbit.'),
  lc_mvac_failure: L('lc', 'MVac nozzle failure. Stage two engine shutdown.'),
  host_payload_damaged: L('host', 'The fairing separated too early. The satellites were likely damaged by aerodynamic heating.'),
  host_fairing_stuck: L('host', 'The fairing never separated, so the satellites cannot be deployed.'),
} as const;

export type CalloutId = keyof typeof CALLOUTS;

/** Complete list of distinct callout lines (for TTS pre-generation). */
export const CALLOUT_LINES: readonly CalloutLine[] = (Object.keys(CALLOUTS) as CalloutId[]).map((id) => ({
  id,
  text: CALLOUTS[id].text,
  voice: CALLOUTS[id].voice,
}));
