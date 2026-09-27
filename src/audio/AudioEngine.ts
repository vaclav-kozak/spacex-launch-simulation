// Audio for the Falcon 9 / OCISLY sim. OWNER: audio.
//
// Listener = the primary view's camera (W frame). Per emitter (S1 cluster, S2 MVac) we keep a
// history of acoustic source states and play what the listener hears *now*: the state emitted
// at the retarded time (speed-of-sound delay), with spherical spreading (near-field clamp),
// ISO 9613 air absorption as a distance-dependent low-pass, jet-noise directivity, a thin-air
// source factor (nothing airborne from above ~35 km), thin-air receiver factor and Doppler.
// Onboard cameras add structure-borne rumble/buffet/clunks + aero rush; RCS hiss; sonic booms,
// touchdown/RUD/splash one-shots arrive after the proper delay; ambience beds; TTS callouts.
//
// Graph (all nodes created once at unlock):
//   engine voices ─► engineBus ─► agc ─► warpGain ─┐
//   onboard/aero/rcs ─► structBus ─► warpGain2 ────┼─► sceneMix ─► switchGain ─► duck ─┬─► dry ──────────┐
//   one-shots ─► oneShotBus ───────────────────────┤                                   └─► send ─► reverb ┤
//   ambience ─► ambBus ────────────────────────────┘                                                      │
//   callouts ─► calloutBus ────────────────────────────────────────────────────────────────────────────► pre
//   pre ─► compressor ─► limiter ─► soft clip ─► runGain (mute/pause) ─► destination (+ debug tap)

import * as THREE from 'three';
import type { AppContext, CameraMode, ViewInfo } from '../core/context';
import type { BodyId, BodyState, SimEvent, SimSnapshot } from '../core/types';
import { PAD_ELEVATION } from '../core/constants';
import { WORKLET_SOURCE } from './worklet';
import {
  EmitterHistory, H, STRIDE, pathSoundSpeed, absorptionCutoff, absorptionBroadbandDb, jetDirectivityDb,
  dbToGain, gainToDb, smoothstep, densityRatio, altitudeOfXYZ,
} from './propagation';
import * as S from './synth';
import { CalloutPlayer } from './callouts';
import {
  EngineVoice, OnboardVoice, NoiseVoice, WorkletNoise, BufferNoise, crackleLoop, setP, snapP, softClipCurve,
  type NoiseParams, type NoiseSource, ZERO_NOISE,
} from './voices';

const FULL_THRUST = 9 * 845_000;
/** calibration: 9 Merlins heard at REF_R metres → engine bus ≈ −18 dBFS RMS before AGC/compression */
const MIC_DB = -21;
const REF_R = 300;
const R_NEAR = 30;
const AGC_TARGET = -17;
const AGC_MAX = 26;
const ONBOARD_DB = -19;
/** share of the onboard bed (structure-borne rumble + aero rush) on chase / orbit cams above Mach ~1.2 */
const CHASE_ONBOARD_MIX = 0.45;
const BOOM_DB = -4; // boom peak level at 8 km (dB re full scale before master)
const ONE_ENGINE_DB = 10 * Math.log10(845_000 / FULL_THRUST);

type EmitterId = 'S1' | 'S2';
interface Emitter {
  id: EmitterId;
  hist: EmitterHistory;
  plumeOffset: number;
  voice: EngineVoice | null;
  rcs: NoiseVoice[];
  rec: Float64Array;
  lastNon: number;
  lastPopReal: number;
  heardDb: number;
  propGain: number;
  cutoff: number;
  pan: number;
  r: number;
  delay: number;
  lastRcs: [number, number];
  /** no retarded root although the history once had one: silent, never a km-scale stale emission */
  lostRoot: boolean;
  /** history (re)started and no root found yet: the oldest-record fallback is allowed (seek) */
  freshHist: boolean;
}

interface PendingShot {
  kind: 'boom' | 'touchdown' | 'rud' | 'splash' | 'clunk';
  clunk?: S.ClunkKind;
  t: number;
  pos: THREE.Vector3;
  /** onboard cameras on these bodies hear it instantly through the structure */
  structural: BodyId[];
  severity: number;
  /** dB at REF_R (airborne) */
  level: number;
  played: boolean;
}

interface Listener {
  pos: THREE.Vector3;
  alt: number;
  onboard: boolean;
  body: BodyId | null;
  mode: CameraMode | 'none';
  right: THREE.Vector3;
  vel: THREE.Vector3;
  /** camera rigidly following its focus body (chase / orbit / onboard / dolly): propagation is
   * solved in an air frame moving with that body (`vf`), see propagation.ts */
  coMoving: boolean;
  vf: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class AudioEngine {
  unlocked = false;
  private ac: AudioContext | null = null;
  private ready = false;
  private building = false;
  private muted = true;
  private paused = false;
  private hasWorklet = false;
  private callouts = new CalloutPlayer();
  private emitters: Record<EmitterId, Emitter>;
  private rawEvents: SimEvent[] = [];
  private pending: PendingShot[] = [];
  private realTime = 0;
  private heldByEvent = false;
  private lastSimT = NaN;
  private lastSimAdvanceReal = 0;
  private lastRecT = -Infinity;
  private wasReplay = false;
  private prevMach = 0;
  private lastBoomT = -Infinity;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  // graph
  private engineBus!: GainNode; private structBus!: GainNode; private oneShotBus!: GainNode; private ambBus!: GainNode;
  private agc!: GainNode; private warpGain!: GainNode; private warpGain2!: GainNode;
  private sceneMix!: GainNode; private switchGain!: GainNode; private duck!: GainNode; private revSend!: GainNode;
  private calloutBus!: GainNode; private pre!: GainNode; private runGain!: GainNode;
  private onboard: OnboardVoice | null = null;
  private aero: NoiseVoice | null = null;
  private amb: {
    wind: NoiseVoice; surf: GainNode; hull: GainNode; diesel: GainNode; chatter: GainNode; chatterPan: StereoPannerNode;
  } | null = null;
  private buf: Record<string, AudioBuffer> = {};
  private tap: AudioWorkletNode | null = null;
  private capture: { l: Float32Array[]; r: Float32Array[] } | null = null;

  // listener state
  private L: Listener = {
    pos: new THREE.Vector3(), alt: 0, onboard: false, body: null, mode: 'none', right: new THREE.Vector3(1, 0, 0), vel: new THREE.Vector3(),
    coMoving: false, vf: new THREE.Vector3(),
  };
  private lastKey = '';
  private lastPos = new THREE.Vector3();
  private lastT = NaN;
  private snapAt = -1; // audio time at which a camera-switch dip bottoms out
  private agcDb = 0;
  private gust = 0;
  private nextChatter = 0;
  private lastGroupNon = -1;
  private lastOnbPop = 0;
  private res = { clamped: false };
  /** last computed values (debug / tests) */
  readonly debug: Record<string, number | string | boolean> = {};

  constructor(private ctx: AppContext) {
    const mk = (id: EmitterId, plume: number): Emitter => ({
      id, hist: new EmitterHistory(16384), plumeOffset: plume, voice: null, rcs: [], rec: new Float64Array(STRIDE),
      lastNon: -1, lastPopReal: 0, heardDb: -120, propGain: 0, cutoff: 8000, pan: 0, r: 0, delay: 0, lastRcs: [0, 0], lostRoot: false, freshHist: true,
    });
    this.emitters = { S1: mk('S1', 15), S2: mk('S2', 4) };
    ctx.events.on('*', (e) => {
      if (e.type === 'CALLOUT') {
        if (this.wantRunning() && this.ready && !this.ctx.replay) this.callouts.enqueue(e, this.realTime);
      } else this.rawEvents.push(e);
    });
    // any first gesture creates/resumes the context (mute state still follows settings)
    const gesture = () => {
      if (!this.ac) this.createContext();
      else if (this.wantRunning()) this.ac.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', gesture, { capture: true });
    window.addEventListener('keydown', gesture, { capture: true });
    document.addEventListener('visibilitychange', () => this.applyRunState());
  }

  async load(): Promise<void> {
    const base = `${import.meta.env.BASE_URL ?? '/'}audio/callouts/`;
    await this.callouts.loadManifest(base);
    this.callouts.prefetch();
  }

  /** call from a user gesture */
  unlock(): void {
    this.createContext();
    this.unlocked = true;
    this.ac?.resume().catch(() => {});
    this.applyRunState();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (!m && !this.ac) this.createContext();
    if (!m) this.unlocked = true;
    this.applyRunState();
  }

  // ------------------------------------------------------------------ context + graph
  private createContext(): void {
    if (this.ac) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ac = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ac.resume().catch(() => {});
    this.build().catch((e) => console.warn('[audio] init failed', e));
  }

  private wantRunning(): boolean {
    return this.unlocked && !this.muted && !this.paused && !document.hidden;
  }

  private applyRunState(): void {
    const ac = this.ac;
    if (!ac) return;
    if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
    if (this.wantRunning()) {
      if (ac.state !== 'running') ac.resume().catch(() => {});
      if (this.runGain) setP(this.runGain.gain, 1, ac.currentTime, 0.04);
    } else {
      if (this.runGain) setP(this.runGain.gain, 0, ac.currentTime, 0.02);
      this.suspendTimer = setTimeout(() => {
        if (!this.wantRunning() && ac.state === 'running' && !this.capture) ac.suspend().catch(() => {});
      }, 160);
    }
  }

  private async build(): Promise<void> {
    const ac = this.ac!;
    if (this.building) return;
    this.building = true;
    const yieldUI = () => new Promise((r) => setTimeout(r, 0));
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await ac.audioWorklet.addModule(url);
      this.hasWorklet = true;
    } catch (e) {
      console.warn('[audio] AudioWorklet unavailable, using buffer fallback', e);
      this.hasWorklet = false;
    }
    const g = (v = 1) => { const n = ac.createGain(); n.gain.value = v; return n; };

    // master chain
    this.pre = g(1);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.012; comp.release.value = 0.3;
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.09;
    const makeup = g(dbToGain(1.5));
    const clip = ac.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
    const ceiling = g(0.92); // headroom for the oversampling filter's overshoot
    this.runGain = g(0);
    this.pre.connect(comp).connect(lim).connect(makeup).connect(clip).connect(ceiling).connect(this.runGain).connect(ac.destination);

    // scene
    this.sceneMix = g(1); this.switchGain = g(1); this.duck = g(1);
    this.revSend = g(0.15);
    this.sceneMix.connect(this.switchGain).connect(this.duck);
    this.duck.connect(this.pre);
    this.duck.connect(this.revSend);
    this.engineBus = g(1); this.agc = g(1); this.warpGain = g(1);
    this.engineBus.connect(this.agc).connect(this.warpGain).connect(this.sceneMix);
    this.structBus = g(1); this.warpGain2 = g(1);
    this.structBus.connect(this.warpGain2).connect(this.sceneMix);
    this.oneShotBus = g(1); this.oneShotBus.connect(this.sceneMix);
    this.ambBus = g(1); this.ambBus.connect(this.sceneMix);
    this.calloutBus = g(0.9); this.calloutBus.connect(this.pre);

    // noise beds
    this.buf.white = S.whiteNoise(ac, 5);
    this.buf.pink = S.pinkNoise(ac, 9);
    await yieldUI();
    const crk = this.hasWorklet ? null : crackleLoop(ac);
    const noise = (seed: number, split = false): NoiseSource =>
      this.hasWorklet ? new WorkletNoise(ac, seed, split) : new BufferNoise(ac, this.buf.pink, crk!);

    // emitters
    let seed = 101;
    for (const em of Object.values(this.emitters)) {
      em.voice = new EngineVoice(ac, noise(seed++, true), this.engineBus);
      em.rcs = [0, 1].map(() => new NoiseVoice(ac, this.buf.white, this.structBus, 3600, 0.55, 7000, 0.9 + Math.random() * 0.2));
    }
    this.onboard = new OnboardVoice(ac, noise(seed++), this.structBus);
    this.aero = new NoiseVoice(ac, this.buf.pink, this.structBus, 600, 0.6, 1800);
    await yieldUI();

    // reverb
    const conv = ac.createConvolver();
    conv.normalize = true;
    conv.buffer = S.reverbIR(ac, 3.2, { echoes: [0.42, 0.97] });
    const revOut = g(0.5);
    this.revSend.connect(conv).connect(revOut).connect(this.pre);
    await yieldUI();

    // ambience
    this.buf.surf = S.surfBuffer(ac);
    await yieldUI();
    this.buf.hull = S.hullWaterBuffer(ac);
    await yieldUI();
    const loop = (b: AudioBuffer, out: AudioNode) => {
      const s = ac.createBufferSource(); s.buffer = b; s.loop = true; s.connect(out); s.start(ac.currentTime, Math.random() * b.duration * 0.9);
    };
    const surf = g(0); loop(this.buf.surf, surf); surf.connect(this.ambBus);
    const hull = g(0); loop(this.buf.hull, hull); hull.connect(this.ambBus);
    const diesel = g(0);
    const dlp = ac.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 170; dlp.Q.value = 0.8;
    for (const [f, a] of [[28.5, 1], [57.3, 0.55], [85.2, 0.3]] as const) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 8;
      const og = g(a * 0.3); o.connect(og).connect(dlp); o.start();
    }
    dlp.connect(diesel).connect(this.ambBus);
    const wind = new NoiseVoice(ac, this.buf.pink, this.ambBus, 450, 0.45, 2200, 0.97);
    const chatter = g(0.13);
    const chatterLp = ac.createBiquadFilter(); chatterLp.type = 'lowpass'; chatterLp.frequency.value = 2600;
    const chatterPan = ac.createStereoPanner();
    chatter.connect(chatterLp).connect(chatterPan).connect(this.ambBus);
    this.amb = { wind, surf, hull, diesel, chatter, chatterPan };

    // one-shots used often
    this.buf.pop = S.ignitionPop(ac);
    this.buf.chuff = S.shutdownChuff(ac);
    this.buf.puff = S.rcsPuff(ac);

    this.ready = true;
    this.lastKey = '';
    this.callouts.decodeAll(ac);
    this.applyRunState();
  }

  // ------------------------------------------------------------------ frame update
  /** listener = the primary (largest / maximized) viewport */
  update(snap: SimSnapshot, listener: ViewInfo | null, dtReal: number): void {
    this.realTime += dtReal;
    const replay = this.ctx.replay;

    // 1) record emitter history (always, even before the audio context exists)
    if (!replay) {
      if (snap.t < this.lastRecT - 0.5) this.resetTimeline();
      if (snap.t - this.lastRecT >= 1 / 30 || this.lastRecT === -Infinity) {
        for (const em of Object.values(this.emitters)) em.hist.push(snap.t, snap.bodies[em.id], em.plumeOffset);
        this.lastRecT = snap.t;
      }
      this.detectBoom(snap);
    }
    if (replay && !this.wasReplay) {
      for (const p of this.pending) if (p.t >= snap.t - 0.5) p.played = false;
      this.callouts.clear();
    }
    this.wasReplay = replay;

    // 2) sim events → one-shots
    for (const e of this.rawEvents) this.onEvent(e, snap);
    this.rawEvents.length = 0;
    if (this.pending.length > 64) this.pending.splice(0, this.pending.length - 64);

    // pause: snap.paused, plus a fallback for a sim that stops its clock without flagging it
    // (not during a countdown hold, where ambience and net chatter continue, nor in replay)
    if (snap.t !== this.lastSimT) { this.lastSimT = snap.t; this.lastSimAdvanceReal = this.realTime; }
    const frozen = !replay && !snap.countdownHeld && !this.heldByEvent && this.realTime - this.lastSimAdvanceReal > 0.35;
    const paused = snap.paused || frozen;
    if (paused !== this.paused) { this.paused = paused; this.applyRunState(); }
    const ac = this.ac;
    if (!ac || !this.ready || paused || ac.state !== 'running') { this.lastT = snap.t; return; }
    const now = ac.currentTime;

    // 3) listener
    const Lr = this.L;
    const key = this.readListener(listener, snap);
    const dtM = snap.t - this.lastT;
    const jump = this.lastPos.distanceTo(Lr.pos);
    // a camera riding its focus body moves at up to orbital speed (S2 ≈ 7.5 km/s = 120 m/frame):
    // budget for that, or every frame reads as a cut and the dip-crossfade mutes everything
    const focus = Lr.body ? snap.bodies[Lr.body] : undefined;
    const vBudget = Math.max(Lr.vel.length(), focus ? focus.vel.length() * 1.5 : 0);
    const expected = vBudget * Math.max(0, dtM) + 60 + 400 * Math.abs(dtM);
    let switched = false;
    if (key !== this.lastKey || jump > expected) {
      switched = true;
      Lr.vel.set(0, 0, 0);
      if (this.lastKey !== '') {
        // dip-crossfade: fade out, jump every parameter at the bottom, fade back in
        setP(this.switchGain.gain, 0, now, 0.025);
        this.snapAt = now + 0.1;
      } else this.snapAt = now;
      for (const em of Object.values(this.emitters)) em.lastNon = -1;
      this.lastGroupNon = -1;
    } else if (dtM > 1e-4) {
      _v.copy(Lr.pos).sub(this.lastPos).divideScalar(dtM);
      Lr.vel.lerp(_v, 0.25);
    }
    this.lastKey = key;
    this.lastPos.copy(Lr.pos);
    this.lastT = snap.t;
    // co-moving listener: chase / orbit / onboard by mode; a cinematic move when it tracks its body
    const fb = Lr.body ? snap.bodies[Lr.body] : undefined;
    if (fb && Lr.mode === 'cinematic') {
      const vb = fb.vel.length();
      Lr.coMoving = vb > 30 && _v.copy(Lr.vel).sub(fb.vel).length() < 0.2 * vb;
    }
    if (Lr.coMoving && fb) Lr.vf.copy(fb.vel); else { Lr.coMoving = false; Lr.vf.set(0, 0, 0); }
    if (this.snapAt > 0 && now < this.snapAt) return; // hold during the dip
    const snapNow = this.snapAt > 0;
    if (snapNow) { this.snapAt = -1; setP(this.switchGain.gain, 1, now + 0.005, 0.1); }
    const tc = 0.06;

    const warp = snap.warp;
    const warpOn = warp > 4 ? 0 : 1;
    setP(this.warpGain.gain, warpOn, now, 0.12);
    setP(this.warpGain2.gain, warpOn, now, 0.12);
    const pitchMul = replay ? 0.55 : 1;

    // 4) airborne engine voices
    let loudest = -120;
    for (const em of Object.values(this.emitters)) {
      this.updateEmitter(em, snap, now, tc, snapNow || switched, pitchMul);
      loudest = Math.max(loudest, em.heardDb);
    }

    // 5) onboard structure-borne + aero + RCS
    this.updateOnboard(snap, now, tc, snapNow || switched, pitchMul);
    this.updateRcs(snap, now, tc);

    // 6) ambience
    this.updateAmbience(snap, now, dtReal);

    // 7) one-shots (booms, touchdown, clunks…)
    this.updatePending(snap, now, pitchMul);

    // 8) camera-mic AGC (ground / chase cams), reverb send, ducking
    const agcTarget = Lr.onboard ? 0 : Math.max(0, Math.min(AGC_MAX, AGC_TARGET - loudest));
    const k = agcTarget < this.agcDb ? 1 - Math.exp(-dtReal / 0.35) : 1 - Math.exp(-dtReal / 3.5);
    this.agcDb += (agcTarget - this.agcDb) * k;
    setP(this.agc.gain, dbToGain(this.agcDb), now, 0.05);
    const m = Lr.mode;
    const rev = Lr.onboard ? 0 : m === 'pad' || m === 'long_lens' ? 0.26 : m === 'deck' ? 0.07 : Lr.alt < 1500 ? 0.16 : 0.05;
    setP(this.revSend.gain, rev, now, 0.3);
    const busy = this.callouts.isBusy(ac);
    setP(this.duck.gain, busy ? 0.63 : 1, now, busy ? 0.06 : 0.4);

    // 9) callouts
    this.callouts.tick(ac, this.calloutBus, snap.t, this.realTime, warp, paused || replay);
    this.debug.callout = this.callouts.lastPlayed; this.debug.calloutDropped = this.callouts.dropped;

    this.debug.t = snap.t;
    this.debug.agcDb = +this.agcDb.toFixed(1);
    this.debug.listener = key;
    this.debug.coMoving = Lr.coMoving;
    this.debug.listenerAlt = Math.round(Lr.alt);
  }

  private resetTimeline(): void {
    for (const em of Object.values(this.emitters)) { em.hist.clear(); em.lastNon = -1; em.lostRoot = false; em.freshHist = true; }
    this.pending.length = 0;
    this.callouts.clear();
    this.lastRecT = -Infinity;
    this.lastBoomT = -Infinity;
  }

  private readListener(v: ViewInfo | null, snap: SimSnapshot): string {
    const L = this.L;
    if (v) {
      L.pos.copy(v.camWorldPos);
      L.onboard = !!v.onboard;
      L.body = v.focus;
      L.mode = v.mode;
      L.coMoving = !!v.focus && (L.onboard || v.mode === 'chase' || v.mode === 'orbit' || v.mode === 'onboard_down' || v.mode === 'onboard_engine');
      v.camera.updateMatrixWorld();
      _m.extractRotation(v.camera.matrixWorld);
      L.right.set(_m.elements[0], _m.elements[1], _m.elements[2]).normalize();
    } else {
      L.pos.set(420, PAD_ELEVATION + 3, 380);
      L.onboard = false; L.body = null; L.mode = 'none'; L.coMoving = false;
      L.right.set(1, 0, 0);
    }
    L.alt = altitudeOfXYZ(L.pos.x, L.pos.y, L.pos.z);
    return v ? `${v.id}|${v.mode}|${v.focus}|${v.onboard ? 1 : 0}` : 'none';
  }

  // ------------------------------------------------------------------ emitters
  private impingement(rec: Float64Array, snap: SimSnapshot): number {
    // plume hitting the pad (liftoff) or the droneship deck (landing burn) → extra roar + crackle
    const ship = snap.bodies.SHIP;
    const nx = rec[H.PX], ny = rec[H.PY], nz = rec[H.PZ];
    const alt = rec[H.ALT];
    let imp = 0;
    const padH = alt - PAD_ELEVATION;
    if (padH < 80 && nx * nx + nz * nz < 250 * 250) imp = Math.max(imp, 1 - Math.max(0, padH) / 80);
    const dx = nx - ship.pos.x, dy = ny - ship.pos.y, dz = nz - ship.pos.z;
    const deckH = alt - ship.altitude;
    if (deckH < 70 && dx * dx + dy * dy + dz * dz < 200 * 200) imp = Math.max(imp, 1 - Math.max(0, deckH) / 70);
    return imp;
  }

  private updateEmitter(em: Emitter, snap: SimSnapshot, now: number, tc: number, snapParams: boolean, pitchMul: number): void {
    const v = em.voice!;
    const L = this.L;
    const b = snap.bodies[em.id];
    const c = pathSoundSpeed(L.alt, b.altitude);
    const rec = em.rec;
    const r = em.hist.retarded(snap.t, L.pos, c, rec, this.res, L.coMoving ? L.vf : null);
    // no root (listener outside a Mach cone): silent — the oldest-record fallback is only for a
    // freshly (re)started history, e.g. after a seek, never a jump to a km-scale stale emission
    if (!this.res.clamped) em.freshHist = false;
    em.lostRoot = this.res.clamped && !em.freshHist;
    if (r < 0 || rec[H.ALIVE] < 0.5 || b.status === 'gone' || em.lostRoot) {
      v.src.set(ZERO_NOISE, now, tc, snapParams);
      v.setPropagation(0, 8000, 16000, 16000, 0, now, tc, snapParams);
      em.heardDb = -120; em.propGain = 0; em.lastNon = -1;
      return;
    }
    const rE = Math.max(R_NEAR, r);
    const pr = Math.max(0, rec[H.PAMB]) / 101325;
    const airAmp = Math.sqrt(pr) * (1 - smoothstep(26_000, 40_000, rec[H.ALT]));
    const rcvAmp = Math.sqrt(densityRatio(L.alt));
    const propDb = -20 * Math.log10(rE / REF_R) - absorptionBroadbandDb(r) + gainToDb(airAmp * rcvAmp) + MIC_DB;
    const inv = 1 / Math.max(1e-3, r);
    const ux = (L.pos.x - rec[H.PX]) * inv, uy = (L.pos.y - rec[H.PY]) * inv, uz = (L.pos.z - rec[H.PZ]) * inv;
    const cosT = -(ux * rec[H.AX] + uy * rec[H.AY] + uz * rec[H.AZ]);
    const dirDb = jetDirectivityDb(cosT);
    // Doppler: f' = f (c + v_listener·n) / (c + v_source·n), n = unit listener→source
    // (velocities relative to the air frame: the moving frame of a co-moving listener, else W)
    const vf = L.vf;
    const vs = -((rec[H.VX] - vf.x) * ux + (rec[H.VY] - vf.y) * uy + (rec[H.VZ] - vf.z) * uz);
    const vl = -((L.vel.x - vf.x) * ux + (L.vel.y - vf.y) * uy + (L.vel.z - vf.z) * uz);
    const dop = Math.max(0.65, Math.min(1.5, (c + vl) / Math.max(60, c + vs)));
    const T = rec[H.THRUST], non = rec[H.NON], spool = rec[H.SPOOL], thr = rec[H.THROT];
    const srcDb = T > 500 ? 10 * Math.log10(T / FULL_THRUST) : -120;
    const imp = this.impingement(rec, snap);
    const base = T > 500 ? dbToGain(srcDb + dirDb + 3 * imp) : 0;
    // nonlinear steepening: crackle grows relative to the roar out to ~2 km, then weakens
    const steep = smoothstep(60, 1800, r) * (1 - 0.6 * smoothstep(6000, 30000, r));
    const crackleF = Math.pow(Math.min(1, pr * 1.1), 0.7) * smoothstep(0.5, 0.9, spool) * (0.5 + 0.5 * thr) *
      (0.55 + 0.45 * steep) * dbToGain(0.7 * dirDb) * (1 + 0.6 * imp);
    const totalDb = T > 500 ? srcDb + dirDb + propDb + 2.5 : -120;
    const np: NoiseParams = {
      rumble: base * 1.0,
      roar: base * 0.8 * (0.35 + 0.65 * Math.min(1, spool * 1.2)),
      crackle: base * 0.7 * crackleF,
      rate: 130 * Math.pow(Math.max(1, non), 0.8) * (0.5 + 0.5 * thr),
      tone: Math.max(0, Math.min(1, 0.42 + 0.28 * Math.min(1, pr) + 0.18 * spool + 0.12 * imp)),
      pitch: dop * pitchMul,
      drive: 0.35 * smoothstep(-6, 6, totalDb),
      buffet: 0, whine: 0, whineHz: 620,
      // shocklets lengthen with range (≈ √r, 'old-age' N-waves) while their fronts stay steep
      crackSize: Math.min(5, Math.sqrt(1 + r / 400)),
    };
    const slow = pitchMul < 1 ? 0.6 : 1;
    const cutoff = absorptionCutoff(r, 7) * slow;
    const f30 = absorptionCutoff(r, 30) * slow;
    const fC = Math.max(absorptionCutoff(r, 20), 1400 * (1 - 0.7 * smoothstep(8000, 30000, r))) * slow;
    const pan = Math.max(-0.85, Math.min(0.85, -(ux * L.right.x + uy * L.right.y + uz * L.right.z) * 0.75));
    const pg = dbToGain(propDb);
    v.src.set(np, now, tc, snapParams);
    v.setPropagation(pg, cutoff, f30, fC, pan, now, tc, snapParams);
    em.heardDb = totalDb; em.propGain = pg; em.cutoff = cutoff; em.pan = pan; em.r = r;
    em.delay = snap.t - rec[H.T];

    // ignition pops / shutdown chuffs as heard (retarded engine count changes)
    if (em.lastNon >= 0 && !snapParams && airAmp > 0.01) {
      if (non > em.lastNon && this.realTime - em.lastPopReal > 0.12) {
        em.lastPopReal = this.realTime;
        this.playBuffer(this.buf.pop, v.input, dbToGain(ONE_ENGINE_DB + 7) * Math.sqrt(non - em.lastNon), pitchMul * dop);
      } else if (non < em.lastNon) {
        this.playBuffer(this.buf.chuff, v.input, dbToGain(ONE_ENGINE_DB + 4) * Math.sqrt(em.lastNon - non), pitchMul * dop);
      }
    }
    em.lastNon = non;

    const d = this.debug, p = em.id;
    d[p + '_r'] = Math.round(r); d[p + '_delay'] = +em.delay.toFixed(2); d[p + '_heardDb'] = +totalDb.toFixed(1);
    d[p + '_cutoff'] = Math.round(cutoff); d[p + '_dop'] = +dop.toFixed(3); d[p + '_clamped'] = this.res.clamped;
    d[p + '_crackle'] = +np.crackle.toFixed(3); d[p + '_thrust'] = Math.round(T); d[p + '_lost'] = em.lostRoot;
  }

  /** bodies mechanically connected to `id` (the stack before separation) */
  private group(snap: SimSnapshot, id: BodyId): BodyState[] {
    const b = snap.bodies;
    const stacked = b.S2.status === 'stacked';
    if ((id === 'S1' || id === 'S2' || id === 'PAYLOAD' || id === 'FAIRING_A' || id === 'FAIRING_B') && stacked) return [b.S1, b.S2];
    if ((id === 'PAYLOAD' || id === 'FAIRING_A' || id === 'FAIRING_B') && b[id].status === 'stacked') return [b.S2];
    return [b[id]];
  }

  private updateOnboard(snap: SimSnapshot, now: number, tc: number, snapParams: boolean, pitchMul: number): void {
    const ob = this.onboard!, aero = this.aero!;
    const L = this.L;
    // chase / orbit cameras borrow some structure-borne character once supersonic (the airborne
    // roar thins with ambient pressure; this keeps the vehicle 'felt' at altitude)
    const fb = L.body ? snap.bodies[L.body] : undefined;
    const mix = !fb ? 0 : L.onboard ? 1 : L.coMoving ? CHASE_ONBOARD_MIX * smoothstep(0.9, 1.5, fb.mach) : 0;
    if (mix <= 0.001 || !L.body || !fb) {
      ob.src.set(ZERO_NOISE, now, tc, snapParams);
      setP(ob.gain.gain, 0, now, 0.1);
      setP(aero.gain.gain, 0, now, 0.1);
      this.lastGroupNon = -1;
      return;
    }
    const body = snap.bodies[L.body];
    const grp = this.group(snap, L.body);
    let T = 0, non = 0;
    for (const g of grp) for (const e of g.engines) { T += Math.max(0, e.thrust); if (e.on) non++; }
    const s = Math.sqrt(T / FULL_THRUST);
    const q = body.dynPressure, mach = body.mach;
    const qn = Math.min(2.5, q / 30_000);
    const transonic = Math.exp(-(((mach - 1) / 0.18) ** 2));
    const buffet = Math.pow(qn, 0.8) * (1 + 1.5 * transonic) * 0.8 + s * 0.3;
    const np: NoiseParams = {
      rumble: s * 1.15, roar: s * 0.5, crackle: 0, rate: 0, tone: 0.1, pitch: pitchMul, drive: 0,
      buffet, whine: T > 1000 ? 0.035 : 0, whineHz: L.body === 'S2' ? 655 : 598, crackSize: 1,
    };
    ob.src.set(np, now, tc, snapParams);
    setP(ob.lp.frequency, (260 + 520 * Math.min(1, s + qn * 0.3)) * (L.onboard ? 1 : 0.7), now, tc);
    setP(ob.gain.gain, dbToGain(ONBOARD_DB) * mix, now, 0.1);
    // aerodynamic rush over the camera housing
    const aLvl = 0.55 * Math.pow(qn, 0.6) * (1 + 0.6 * transonic);
    const fc = 280 + 520 * Math.min(2.5, mach);
    setP(aero.gain.gain, aLvl * mix, now, 0.08);
    setP(aero.bp.frequency, fc, now, 0.2);
    setP(aero.lp.frequency, fc * 3.2, now, 0.2);
    // structure-borne ignition/shutdown transients
    if (L.onboard && this.lastGroupNon >= 0 && !snapParams && this.realTime - this.lastOnbPop > 0.12) {
      if (non > this.lastGroupNon) { this.lastOnbPop = this.realTime; this.playBuffer(this.buf.pop, ob.input, 0.5, pitchMul); }
      else if (non < this.lastGroupNon) { this.lastOnbPop = this.realTime; this.playBuffer(this.buf.chuff, ob.input, 0.8, pitchMul); }
    }
    this.lastGroupNon = non;
    this.debug.onboardS = +s.toFixed(3); this.debug.onboardQ = Math.round(q);
  }

  private updateRcs(snap: SimSnapshot, now: number, tc: number): void {
    const L = this.L;
    for (const em of Object.values(this.emitters)) {
      if (!em.rcs.length) continue;
      const b = snap.bodies[em.id];
      const onb = L.onboard && L.body !== null && this.group(snap, L.body).includes(b);
      let a0: number, a1: number, gain: number, lp: number;
      if (onb) {
        const n = b.rcs.length, half = n >> 1;
        a0 = 0; a1 = 0;
        for (let i = 0; i < n; i++) { if (i < half) a0 += b.rcs[i]; else a1 += b.rcs[i]; }
        const vac = b.density < 0.01;
        gain = vac ? 0.12 : 0.3; // in vacuum only the structure-borne valve/flow noise remains
        lp = vac ? 1600 : 7500;
      } else {
        a0 = em.rec[H.RCS0]; a1 = em.rec[H.RCS1];
        const r = Math.max(8, em.r || 1e9);
        const air = Math.sqrt(Math.max(0, em.rec[H.PAMB]) / 101325) * Math.sqrt(densityRatio(L.alt));
        gain = 0.3 * dbToGain(-20 * Math.log10(r / 15)) * air;
        if (gain < 2e-4) gain = 0;
        lp = absorptionCutoff(r);
      }
      const acts = [Math.min(1, a0), Math.min(1, a1)];
      for (let k = 0; k < 2; k++) {
        const vce = em.rcs[k];
        setP(vce.gain.gain, gain * acts[k], now, 0.02);
        setP(vce.lp.frequency, Math.max(400, Math.min(12000, lp)), now, tc);
        setP(vce.pan.pan, onb ? (k ? 0.55 : -0.55) : em.pan, now, tc);
        if (gain > 0 && acts[k] > 0.3 && em.lastRcs[k] < 0.1) this.playBuffer(this.buf.puff, vce.pan, gain * 1.6, 0.9 + Math.random() * 0.2);
        em.lastRcs[k] = acts[k];
      }
    }
  }

  // ------------------------------------------------------------------ ambience
  private updateAmbience(snap: SimSnapshot, now: number, dt: number): void {
    const a = this.amb;
    if (!a) return;
    const L = this.L;
    const set = this.ctx.settings;
    const padD = Math.hypot(L.pos.x, L.pos.z);
    const wPad = (1 - smoothstep(3000, 15000, padD)) * (1 - smoothstep(600, 3000, L.alt));
    const ship = snap.bodies.SHIP;
    const shipD = L.pos.distanceTo(ship.pos);
    const wShip = (1 - smoothstep(1500, 6000, shipD)) * (1 - smoothstep(300, 2000, L.alt - ship.altitude));
    const wLow = 1 - smoothstep(300, 5000, L.alt);
    let onb = 1;
    if (L.onboard) onb = L.body && snap.bodies[L.body] && snap.bodies[L.body].altitude > 150 ? 0 : 0.4;
    // gusts: OU process at frame rate
    const th = 0.35;
    this.gust += -th * this.gust * dt + Math.sqrt(2 * th * dt) * ((Math.random() + Math.random() + Math.random() - 1.5) * 2);
    const ws = set.windSpeed;
    const windLvl = onb * Math.max(wPad, 0.75 * wShip, 0.6 * wLow) * (0.016 + 0.006 * ws) * Math.exp(0.35 * this.gust);
    setP(a.wind.gain.gain, windLvl, now, 0.25);
    setP(a.wind.bp.frequency, 330 + 22 * ws + 60 * this.gust, now, 0.4);
    setP(a.surf.gain, onb * wPad * 0.045, now, 0.5);
    setP(a.hull.gain, onb * wShip * (0.034 + 0.02 * set.seaState), now, 0.5);
    setP(a.diesel.gain, onb * wShip * 0.022, now, 0.5);
    // launch-control net chatter near the pad before launch
    if (wPad * onb > 0.3 && snap.t < 2 && snap.t > -3600 && this.callouts.chatter.length && this.realTime > this.nextChatter) {
      this.nextChatter = this.realTime + 5 + Math.random() * 9;
      if (!this.callouts.isBusy(this.ac!) && snap.warp <= 4) {
        const l = this.callouts.chatter[(Math.random() * this.callouts.chatter.length) | 0];
        const b = this.callouts.bufferFor(l);
        if (b) {
          setP(a.chatterPan.pan, (Math.random() - 0.5) * 0.9, now, 0.01);
          setP(a.chatter.gain, 0.12 * wPad * onb, now, 0.01);
          this.playBuffer(b, a.chatter, 1, 1);
        }
      }
    }
    this.debug.wPad = +wPad.toFixed(2); this.debug.wShip = +wShip.toFixed(2);
  }

  // ------------------------------------------------------------------ events / one-shots
  private onEvent(e: SimEvent, snap: SimSnapshot): void {
    const b = snap.bodies;
    const bodyPos = (id?: BodyId) => (id && b[id] ? b[id].pos : b.S1.pos).clone();
    const add = (p: Omit<PendingShot, 'played'>) => this.pending.push({ ...p, played: false });
    switch (e.type) {
      case 'COUNTDOWN_HOLD': this.heldByEvent = true; break;
      case 'COUNTDOWN_RESUME': this.heldByEvent = false; break;
      case 'SONIC_BOOM':
        this.lastBoomT = e.t;
        add({ kind: 'boom', t: e.t, pos: bodyPos(e.body ?? 'S1'), structural: [], severity: 1, level: BOOM_DB });
        break;
      case 'TOUCHDOWN': {
        const o = String(e.data?.outcome ?? 'success');
        if (o === 'offdeck') add({ kind: 'splash', t: e.t, pos: bodyPos('S1'), structural: [], severity: 1, level: 0 });
        else add({ kind: 'touchdown', t: e.t, pos: bodyPos('S1'), structural: ['S1', 'SHIP'], severity: o === 'hard' ? 0.85 : o === 'tipped' ? 0.6 : 0.2, level: -2 });
        break;
      }
      case 'SPLASHDOWN':
        if (e.body === 'S1' || e.body === 'S2' || !e.body)
          add({ kind: 'splash', t: e.t, pos: bodyPos(e.body), structural: [], severity: 1, level: -4 });
        break;
      case 'RUD':
        add({ kind: 'rud', t: e.t, pos: bodyPos(e.body), structural: e.body ? [e.body] : [], severity: 1, level: 8 });
        break;
      case 'STAGE_SEP':
        add({ kind: 'clunk', clunk: 'stagesep', t: e.t, pos: bodyPos('S1'), structural: ['S1', 'S2'], severity: 1, level: -22 });
        break;
      case 'FAIRING_SEP':
        add({ kind: 'clunk', clunk: 'fairing', t: e.t, pos: bodyPos('S2'), structural: ['S2', 'PAYLOAD', 'FAIRING_A', 'FAIRING_B'], severity: 1, level: -24 });
        break;
      case 'LEGS_DEPLOY':
        add({ kind: 'clunk', clunk: 'legs', t: e.t, pos: bodyPos('S1'), structural: ['S1'], severity: 1, level: -26 });
        break;
      case 'GRIDFINS_DEPLOY':
        add({ kind: 'clunk', clunk: 'gridfins', t: e.t, pos: bodyPos('S1'), structural: ['S1'], severity: 1, level: -30 });
        break;
      case 'PAYLOAD_DEPLOY':
        add({ kind: 'clunk', clunk: 'thud', t: e.t, pos: bodyPos('S2'), structural: ['S2', 'PAYLOAD'], severity: 1, level: -40 });
        break;
      default:
        break;
    }
  }

  /** fallback when the sim does not emit SONIC_BOOM: booster decelerating through Mach 1 on descent */
  private detectBoom(snap: SimSnapshot): void {
    const s1 = snap.bodies.S1;
    if (this.prevMach > 1 && s1.mach <= 1 && s1.verticalSpeed < -50 && s1.status === 'free' && Math.abs(snap.t - this.lastBoomT) > 30) {
      this.lastBoomT = snap.t;
      this.pending.push({ kind: 'boom', t: snap.t, pos: s1.pos.clone(), structural: [], severity: 1, level: BOOM_DB, played: false });
    }
    this.prevMach = s1.mach;
  }

  private shotBuffer(p: PendingShot, rKm: number): AudioBuffer | null {
    const ac = this.ac!;
    switch (p.kind) {
      case 'boom': return S.sonicBoom(ac, rKm, 3 + Math.floor(p.t));
      case 'touchdown': return (this.buf['td' + p.severity] ??= S.touchdown(ac, p.severity));
      case 'rud': return (this.buf.rud ??= S.explosion(ac));
      case 'splash': return (this.buf.splash ??= S.splash(ac));
      case 'clunk': return (this.buf['clunk_' + p.clunk] ??= S.clunk(ac, p.clunk ?? 'thud'));
    }
    return null;
  }

  private updatePending(snap: SimSnapshot, now: number, pitchMul: number): void {
    const L = this.L;
    const warp = snap.warp;
    for (const p of this.pending) {
      if (p.played) continue;
      if (snap.t < p.t) continue;
      const structural = L.onboard && L.body !== null && p.structural.includes(L.body);
      if (structural) {
        p.played = true;
        if (snap.t - p.t > 1.5 || warp > 4) continue;
        const b = this.shotBuffer(p, 0.1);
        const lvl = p.kind === 'clunk' ? 0.9 : p.kind === 'touchdown' ? 1.1 : 1;
        if (b) this.playBuffer(b, this.structBus, lvl, pitchMul);
        continue;
      }
      // co-moving listener: the emission point rides the moving air frame; no ground boom for it
      if (L.coMoving && p.kind === 'boom') { p.played = true; continue; }
      const r = L.coMoving ? _v.copy(p.pos).addScaledVector(L.vf, snap.t - p.t).distanceTo(L.pos) : L.pos.distanceTo(p.pos);
      const c = pathSoundSpeed(L.alt, altitudeOfXYZ(p.pos.x, p.pos.y, p.pos.z));
      const arrival = p.t + r / c;
      if (snap.t < arrival) continue;
      p.played = true;
      if (snap.t - arrival > 1.2 || warp > 4) continue;
      const srcAlt = altitudeOfXYZ(p.pos.x, p.pos.y, p.pos.z);
      const air = Math.sqrt(densityRatio(srcAlt)) * Math.sqrt(densityRatio(L.alt));
      let db: number;
      if (p.kind === 'boom') {
        if (r > 80_000) continue;
        db = p.level - 15 * Math.log10(Math.max(500, r) / 8000); // weak-shock decay ~ r^-3/4
      } else {
        db = p.level - 20 * Math.log10(Math.max(R_NEAR, r) / REF_R) - absorptionBroadbandDb(r) + MIC_DB + 10;
      }
      const gain = dbToGain(db) * air;
      if (gain < 1e-4) continue;
      const buf = this.shotBuffer(p, r / 1000);
      if (!buf) continue;
      const ac = this.ac!;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
      lp.frequency.value = Math.max(80, Math.min(16000, absorptionCutoff(r) * (p.kind === 'boom' ? 1.5 : 1)));
      const pan = ac.createStereoPanner();
      const inv = 1 / Math.max(1, r);
      pan.pan.value = Math.max(-0.8, Math.min(0.8, -((L.pos.x - p.pos.x) * L.right.x + (L.pos.y - p.pos.y) * L.right.y + (L.pos.z - p.pos.z) * L.right.z) * inv * 0.7));
      lp.connect(pan).connect(this.oneShotBus);
      this.playBuffer(buf, lp, gain, pitchMul);
      this.debug.lastShot = `${p.kind}@${snap.t.toFixed(2)} r=${Math.round(r)} delay=${(snap.t - p.t).toFixed(2)} gain=${gain.toExponential(2)}`;
    }
    // forget old entries (keep ~10 min for replays)
    if (this.pending.length && this.pending[0].played && snap.t - this.pending[0].t > 600) this.pending.shift();
  }

  private playBuffer(b: AudioBuffer, out: AudioNode, gain: number, rate = 1): void {
    const ac = this.ac!;
    const s = ac.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = gain;
    s.connect(g).connect(out);
    s.start();
    s.onended = () => { s.disconnect(); g.disconnect(); };
  }

  // ------------------------------------------------------------------ debug capture (tests)
  /** Start recording the master output (post limiter) into memory. */
  async debugCaptureStart(): Promise<boolean> {
    const ac = this.ac;
    if (!ac || !this.ready || !this.hasWorklet) return false;
    if (!this.tap) {
      this.tap = new AudioWorkletNode(ac, 'tap-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const z = ac.createGain(); z.gain.value = 0;
      this.runGain.connect(this.tap).connect(z).connect(ac.destination);
      this.tap.port.onmessage = (e) => {
        if (this.capture && Array.isArray(e.data)) { this.capture.l.push(e.data[0]); this.capture.r.push(e.data[1]); }
      };
    }
    this.capture = { l: [], r: [] };
    this.tap.port.postMessage('start');
    return true;
  }
  /** Stop recording; returns a 32-bit float stereo WAV as base64 (for playwright). */
  async debugCaptureStop(): Promise<string> {
    if (!this.tap || !this.capture) return '';
    this.tap.port.postMessage('stop');
    await new Promise((r) => setTimeout(r, 60));
    const { l, r } = this.capture;
    this.capture = null;
    const n = l.reduce((s, a) => s + a.length, 0);
    const sr = this.ac!.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + n * 8));
    const w4 = (o: number, s: string) => { for (let i = 0; i < 4; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w4(0, 'RIFF'); data.setUint32(4, 36 + n * 8, true); w4(8, 'WAVE'); w4(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 3, true); data.setUint16(22, 2, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * 8, true); data.setUint16(32, 8, true); data.setUint16(34, 32, true);
    w4(36, 'data'); data.setUint32(40, n * 8, true);
    let o = 44;
    for (let k = 0; k < l.length; k++) {
      const a = l[k], b = r[k];
      for (let i = 0; i < a.length; i++) { data.setFloat32(o, a[i], true); data.setFloat32(o + 4, b[i], true); o += 8; }
    }
    const bytes = new Uint8Array(data.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
}
