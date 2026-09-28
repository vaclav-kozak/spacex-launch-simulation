// Web Audio graph building blocks. Nodes are created once; per-frame work is only AudioParam
// automation (setTargetAtTime), never node creation (one-shots excepted).

export type AC = BaseAudioContext;

export function setP(p: AudioParam, v: number, now: number, tc = 0.05): void {
  if (!Number.isFinite(v)) return;
  p.setTargetAtTime(v, now, tc);
}
/** jump a param immediately (used at the bottom of a camera-switch dip) */
export function snapP(p: AudioParam, v: number, now: number): void {
  if (!Number.isFinite(v)) return;
  p.cancelScheduledValues(now);
  p.setValueAtTime(v, now);
}

/** Looping buffer source, started. Never at playbackRate exactly 1: Chrome on Windows (seen in 152) stops a
 * looping source played at rate 1 at its first loop wrap, and its filters later put out NaN, which poisons the
 * master compressors and silences the whole mix for good. Any other rate loops fine (+0.05 %, inaudible). */
export function loopSource(ac: AC, b: AudioBuffer, rate = 1, when = ac.currentTime, offset = 0): AudioBufferSourceNode {
  const s = ac.createBufferSource();
  s.buffer = b;
  s.loop = true;
  s.playbackRate.value = rate === 1 ? 1.0005 : rate;
  s.start(when, offset);
  return s;
}

export interface NoiseParams {
  rumble: number; roar: number; crackle: number; rate: number; tone: number; pitch: number;
  drive: number; buffet: number; whine: number; whineHz: number; crackSize: number;
}
export const ZERO_NOISE: NoiseParams = {
  rumble: 0, roar: 0, crackle: 0, rate: 150, tone: 0.5, pitch: 1, drive: 0, buffet: 0, whine: 0, whineHz: 620, crackSize: 1,
};

/** A rocket-noise source: AudioWorklet when available, else looped buffers (reduced fidelity). */
export interface NoiseSource {
  output: AudioNode;
  /** crackle-only output (AudioWorklet output #1), or null when crackle is mixed into `output` */
  crackleOut: AudioNode | null;
  set(p: NoiseParams, now: number, tc: number, snap?: boolean): void;
}

export class WorkletNoise implements NoiseSource {
  readonly node: AudioWorkletNode;
  get output(): AudioNode { return this.node; }
  readonly crackleOut: AudioNode | null;
  private params: Map<string, AudioParam>;
  constructor(ac: AC, seed: number, splitCrackle = false) {
    this.node = new AudioWorkletNode(ac, 'rocket-noise', {
      numberOfInputs: 0, numberOfOutputs: splitCrackle ? 2 : 1, outputChannelCount: splitCrackle ? [2, 2] : [2], processorOptions: { seed },
    });
    this.crackleOut = splitCrackle ? this.node : null;
    this.params = this.node.parameters as unknown as Map<string, AudioParam>;
  }
  set(p: NoiseParams, now: number, tc: number, snap = false): void {
    for (const k in p) {
      const ap = this.params.get(k);
      if (!ap) continue;
      const v = (p as unknown as Record<string, number>)[k];
      if (snap) snapP(ap, v, now); else setP(ap, v, now, tc);
    }
    if (snap) this.node.port.postMessage('snap');
  }
}

/** fallback without AudioWorklet: brown-ish rumble + pink roar + pre-rendered crackle loop */
export class BufferNoise implements NoiseSource {
  readonly output: GainNode;
  readonly crackleOut = null;
  private rum: GainNode; private roar: GainNode; private crk: GainNode;
  private roarLp: BiquadFilterNode;
  constructor(ac: AC, pink: AudioBuffer, crackleLoop: AudioBuffer) {
    this.output = ac.createGain();
    const mk = (b: AudioBuffer, rate = 1) => loopSource(ac, b, rate, ac.currentTime + Math.random() * 0.1);
    const rs = mk(pink, 0.93);
    const rl = ac.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 45; rl.Q.value = 0.9;
    const rl2 = ac.createBiquadFilter(); rl2.type = 'lowpass'; rl2.frequency.value = 70;
    this.rum = ac.createGain(); this.rum.gain.value = 0;
    rs.connect(rl).connect(rl2).connect(this.rum).connect(this.output);
    const os = mk(pink, 1.07);
    this.roarLp = ac.createBiquadFilter(); this.roarLp.type = 'lowpass'; this.roarLp.frequency.value = 1200;
    this.roar = ac.createGain(); this.roar.gain.value = 0;
    os.connect(this.roarLp).connect(this.roar).connect(this.output);
    const cs = mk(crackleLoop);
    this.crk = ac.createGain(); this.crk.gain.value = 0;
    cs.connect(this.crk).connect(this.output);
  }
  set(p: NoiseParams, now: number, tc: number): void {
    setP(this.rum.gain, p.rumble * 22, now, tc);
    setP(this.roar.gain, p.roar * 3.2, now, tc);
    setP(this.crk.gain, p.crackle, now, tc);
    setP(this.roarLp.frequency, 260 * Math.pow(2, p.tone * 3.6) * p.pitch, now, tc);
  }
}

/** pre-rendered crackle loop (same skewed N-wave shocklet model as the worklet) for BufferNoise */
export function crackleLoop(ac: AC, seconds = 7, rate = 450): AudioBuffer {
  const sr = ac.sampleRate, n = Math.floor(seconds * sr);
  const b = ac.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const x = new Float32Array(n);
    let t = 0;
    while (true) {
      t += -Math.log(1 - Math.random() * 0.999) / rate * Math.exp(0.9 * (Math.random() - 0.5));
      const i0 = Math.floor(t * sr);
      if (i0 >= n) break;
      const A = Math.min(10, Math.pow(1 - Math.random() * 0.999, -1 / 2.8));
      const len = Math.max(1, 0.00022 * sr * (0.55 + 0.45 * Math.sqrt(A)) * Math.exp(0.45 * (Math.random() - 0.5) * 3));
      for (let j = 0; j < 2 * len && i0 + j < n; j++) x[i0 + j] += A * (j < len ? 1 - 1.5 * j / len : -0.5 * (1 - (j - len) / len));
    }
    let s = 0; for (let i = 0; i < n; i++) s += x[i] * x[i];
    const g = 1 / Math.sqrt(s / n || 1);
    for (let i = 0; i < n; i++) x[i] *= g;
    b.copyToChannel(x, c);
  }
  return b;
}

/**
 * Airborne engine voice of one emitter:
 *   roar/rumble (+ one-shot input) → gentle 2-pole LP (Q .5) at the 7 dB absorption corner →
 *   2-pole LP at the 30 dB corner  (≈ ISO 9613 exp(−α(f)·r) roll-off)
 *   crackle → single 2-pole LP at the 20 dB corner: shock fronts stay steep over km distances
 *   because nonlinear steepening keeps replenishing the high frequencies that air absorbs.
 *   → sub-sonic high-pass → propagation gain → stereo pan → bus.
 */
export class EngineVoice {
  readonly input: GainNode;
  readonly lp1: BiquadFilterNode; readonly lp2: BiquadFilterNode; readonly lpC: BiquadFilterNode;
  readonly gain: GainNode; readonly pan: StereoPannerNode;
  constructor(ac: AC, readonly src: NoiseSource, out: AudioNode) {
    this.input = ac.createGain();
    this.lp1 = ac.createBiquadFilter(); this.lp1.type = 'lowpass'; this.lp1.Q.value = 0.5; this.lp1.frequency.value = 8000;
    this.lp2 = ac.createBiquadFilter(); this.lp2.type = 'lowpass'; this.lp2.Q.value = 0.7; this.lp2.frequency.value = 16000;
    this.lpC = ac.createBiquadFilter(); this.lpC.type = 'lowpass'; this.lpC.Q.value = 0.6; this.lpC.frequency.value = 16000;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 14; hp.Q.value = 0.6;
    this.gain = ac.createGain(); this.gain.gain.value = 0;
    this.pan = ac.createStereoPanner();
    src.output.connect(this.input);
    this.input.connect(this.lp1).connect(this.lp2).connect(hp);
    if (src.crackleOut) src.crackleOut.connect(this.lpC, 1).connect(hp);
    hp.connect(this.gain).connect(this.pan).connect(out);
  }
  /** f7/f30: 7 dB and 30 dB absorption corners (Hz), fC: crackle corner */
  setPropagation(gain: number, f7: number, f30: number, fC: number, pan: number, now: number, tc: number, snap = false): void {
    const c = (f: number) => Math.max(40, Math.min(18000, f));
    const set = snap ? (p: AudioParam, v: number) => snapP(p, v, now) : (p: AudioParam, v: number) => setP(p, v, now, tc);
    set(this.gain.gain, gain); set(this.lp1.frequency, c(f7)); set(this.lp2.frequency, c(f30)); set(this.lpC.frequency, c(fC));
    if (snap) snapP(this.pan.pan, pan, now); else setP(this.pan.pan, pan, now, tc * 2);
  }
}

/** structure-borne sound for onboard cameras: resonant, low-passed, felt more than heard */
export class OnboardVoice {
  readonly input: GainNode;
  readonly lp: BiquadFilterNode; readonly gain: GainNode;
  constructor(ac: AC, readonly src: NoiseSource, out: AudioNode) {
    this.input = ac.createGain();
    const m1 = ac.createBiquadFilter(); m1.type = 'peaking'; m1.frequency.value = 31; m1.Q.value = 2.2; m1.gain.value = 6;
    const m2 = ac.createBiquadFilter(); m2.type = 'peaking'; m2.frequency.value = 74; m2.Q.value = 3; m2.gain.value = 5;
    const m3 = ac.createBiquadFilter(); m3.type = 'peaking'; m3.frequency.value = 163; m3.Q.value = 4; m3.gain.value = 4;
    this.lp = ac.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 420; this.lp.Q.value = 0.7;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 16;
    this.gain = ac.createGain(); this.gain.gain.value = 0;
    src.output.connect(this.input);
    this.input.connect(m1).connect(m2).connect(m3).connect(this.lp).connect(hp).connect(this.gain).connect(out);
  }
}

/** looped noise buffer → band-pass → low-pass → gain (→ pan) : wind, aero rush, RCS hiss */
export class NoiseVoice {
  readonly bp: BiquadFilterNode; readonly lp: BiquadFilterNode; readonly gain: GainNode; readonly pan: StereoPannerNode;
  constructor(ac: AC, noise: AudioBuffer, out: AudioNode, bpHz: number, bpQ: number, lpHz: number, rate = 1) {
    const s = loopSource(ac, noise, rate, ac.currentTime, Math.random() * noise.duration * 0.9);
    this.bp = ac.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = bpHz; this.bp.Q.value = bpQ;
    this.lp = ac.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = lpHz; this.lp.Q.value = 0.6;
    this.gain = ac.createGain(); this.gain.gain.value = 0;
    this.pan = ac.createStereoPanner();
    s.connect(this.bp).connect(this.lp).connect(this.gain).connect(this.pan).connect(out);
  }
}

/** soft clipper curve: linear to ±0.8, smooth knee to ±1 */
export function softClipCurve(n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
    c[i] = Math.sign(x) * y;
  }
  return c;
}
