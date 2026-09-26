// AudioWorklet processors, shipped as a plain-JS source string and loaded through a Blob URL
// (works identically in `vite dev` and in the production build, no bundler special cases).
//
// 'rocket-noise'  — one per engine emitter (+1 for structure-borne onboard sound). Stereo out.
//   Layers:  rumble  deep 15–60 Hz sub rumble (SVF low-pass of white noise, slow log-normal AM)
//            roar    broadband pink roar, low-passed at a tone-dependent corner, turbulent AM
//            crackle Merlin/rocket crackle = intermittent train of skewed N-wave shocklets:
//                    each event jumps to +A in one sample (shock), ramps linearly to -A/2 and
//                    recovers (zero net area -> positive pressure skewness), Pareto-distributed
//                    amplitudes (heavy tail: occasional very loud pops), lognormal durations that
//                    grow with amplitude, Poisson arrivals whose rate is modulated by a log-normal
//                    OU process (bursty / intermittent), random stereo position per event.
//            buffet  low-frequency positive thumps (aero buffeting through the structure)
//            whine   faint turbopump whine (onboard only)
//   `pitch` scales all corner frequencies and shocklet durations (Doppler / slow-mo replay).
//   `drive` soft-saturates the sum (near-field camera-mic overload).
//   All amplitude params are target RMS values of that layer (normalized internally).
// 'tap-recorder' — debug tap: posts raw float blocks to the main thread while recording.

export const WORKLET_SOURCE = String.raw`
const SR = sampleRate;
const TAU = Math.PI * 2;

function xorshift(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Ornstein-Uhlenbeck process updated at block rate, unit stationary variance.
class OU {
  constructor(rng, hz) { this.rng = rng; this.x = 0; this.prev = 0; this.setHz(hz); }
  setHz(hz) { const dt = 128 / SR; this.a = Math.exp(-TAU * hz * dt); this.b = Math.sqrt(1 - this.a * this.a); }
  gauss() { let u = 0; for (let i = 0; i < 4; i++) u += this.rng(); return (u - 2) * 1.7320508; }
  step() { this.prev = this.x; this.x = this.a * this.x + this.b * this.gauss(); return this.x; }
}

// Topology-preserving-transform state-variable filter (Simper). Stable for any fc < SR/2.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.707); }
  set(fc, q) {
    const g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR); const k = 1 / q;
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  lp(v0) {
    const v3 = v0 - this.ic2; const v1 = this.a1 * this.ic1 + this.a2 * v3; const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2; return v2;
  }
}

const MAXEV = 96;
const PARETO_A = 2.8, AMP_CAP = 10;
// E[A^2 * lenFactor] for the capped Pareto amplitudes with len ~ (0.55 + 0.45 sqrt(A)) (numerically integrated)
function crackleEnergyNorm() {
  let s = 0, n = 0; const rng = xorshift(12345);
  for (let i = 0; i < 20000; i++) {
    const A = Math.min(AMP_CAP, Math.pow(1 - rng() * 0.999999, -1 / PARETO_A));
    s += A * A * (0.55 + 0.45 * Math.sqrt(A)); n++;
  }
  return s / n;
}
const CRACKLE_E = crackleEnergyNorm();

class RocketNoise extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate';
    return [
      { name: 'rumble', defaultValue: 0, minValue: 0, maxValue: 8, automationRate: k },
      { name: 'roar', defaultValue: 0, minValue: 0, maxValue: 8, automationRate: k },
      { name: 'crackle', defaultValue: 0, minValue: 0, maxValue: 8, automationRate: k },
      { name: 'rate', defaultValue: 150, minValue: 0, maxValue: 4000, automationRate: k },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'pitch', defaultValue: 1, minValue: 0.1, maxValue: 4, automationRate: k },
      { name: 'drive', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'buffet', defaultValue: 0, minValue: 0, maxValue: 8, automationRate: k },
      { name: 'whine', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'whineHz', defaultValue: 620, minValue: 20, maxValue: 4000, automationRate: k },
      { name: 'crackSize', defaultValue: 1, minValue: 0.2, maxValue: 6, automationRate: k },
    ];
  }
  constructor(options) {
    super();
    const seed = (options && options.processorOptions && options.processorOptions.seed) || (Math.random() * 1e9) | 0;
    const rng = this.rng = xorshift(seed);
    this.amRoar = new OU(rng, 5); this.amRumble = new OU(rng, 1.3); this.rateMod = new OU(rng, 2.2);
    this.buffetP = new OU(rng, 9); this.wob = new OU(rng, 0.4);
    this.rumF = new SVF(); this.rumF2 = new SVF();
    this.roarL = new SVF(); this.roarR = new SVF(); this.roarL2 = new SVF(); this.roarR2 = new SVF();
    this.bufF = new SVF();
    this.pk = [0, 0, 0, 0, 0, 0]; // pink states L (3) R (3)
    this.hpL = 0; this.hpR = 0; this.hpxL = 0; this.hpxR = 0; this.hpRum = 0; this.hpxRum = 0;
    this.cur = null;
    this.evPos = new Float32Array(MAXEV); this.evLen = new Float32Array(MAXEV); this.evAmp = new Float32Array(MAXEV);
    this.evL = new Float32Array(MAXEV); this.evR = new Float32Array(MAXEV); this.nev = 0;
    this.toNext = 0; this.phase = 0; this.jit = 0;
    this.port.onmessage = (e) => { if (e.data === 'snap') this.cur = null; };
  }
  spawn(rate, size, pitch) {
    const rng = this.rng;
    const A = Math.min(AMP_CAP, Math.pow(1 - rng() * 0.999999, -1 / PARETO_A));
    // lognormal duration (first segment), median ~0.22 ms * size / pitch, longer for big shocklets
    let g = 0; for (let i = 0; i < 3; i++) g += rng(); g = (g - 1.5) * 2;
    const d = 0.00022 * size / pitch * Math.exp(0.45 * g) * (0.55 + 0.45 * Math.sqrt(A));
    const len = Math.max(1, d * SR);
    if (this.nev < MAXEV) {
      const i = this.nev++;
      this.evPos[i] = 0; this.evLen[i] = len; this.evAmp[i] = A;
      const p = rng(); this.evL[i] = Math.cos(p * Math.PI * 0.5) * 1.4142; this.evR[i] = Math.sin(p * Math.PI * 0.5) * 1.4142;
    }
  }
  process(inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0]; const R = out.length > 1 ? out[1] : null;
    // optional second output: crackle only (so it can take a gentler, shock-preserving low-pass)
    const cOut = outputs.length > 1 ? outputs[1] : null;
    const CL = cOut ? cOut[0] : null; const CR = cOut && cOut.length > 1 ? cOut[1] : null;
    const n = L.length;
    const tgt = {
      rumble: params.rumble[0], roar: params.roar[0], crackle: params.crackle[0], rate: params.rate[0],
      tone: params.tone[0], pitch: params.pitch[0], drive: params.drive[0], buffet: params.buffet[0],
      whine: params.whine[0], whineHz: params.whineHz[0], crackSize: params.crackSize[0],
    };
    const c0 = this.cur || tgt; this.cur = tgt;
    const silent = tgt.rumble + tgt.roar + tgt.crackle + tgt.buffet + tgt.whine < 1e-6 &&
      c0.rumble + c0.roar + c0.crackle + c0.buffet + c0.whine < 1e-6 && this.nev === 0;
    if (silent) { L.fill(0); if (R) R.fill(0); if (CL) CL.fill(0); if (CR) CR.fill(0); return true; }

    const rng = this.rng; const pitch = Math.max(0.1, tgt.pitch);
    // corner frequencies
    const fRum = 34 * pitch, qRum = 0.85;
    this.rumF.set(fRum, qRum); this.rumF2.set(fRum * 1.7, 0.6);
    const fRoar = 260 * Math.pow(2, tgt.tone * 3.6) * pitch; // 260 Hz .. 3.1 kHz
    this.roarL.set(fRoar, 0.7); this.roarR.set(fRoar, 0.7); this.roarL2.set(fRoar * 2.2, 0.6); this.roarR2.set(fRoar * 2.2, 0.6);
    this.bufF.set(14 * pitch, 0.7);
    // normalizations -> unit RMS layers (white uniform noise has variance 1/3)
    const enbwR = Math.PI * fRum * qRum / 2;
    const rumNorm = 1 / Math.sqrt((1 / 3) * enbwR / (SR / 2)) * 0.62;
    const roarNorm = 1 / Math.sqrt(Math.max(1, Math.log2(fRoar / 25))) * 8.0;
    const bufNorm = 1 / Math.sqrt((1 / 3) * (Math.PI * 14 * pitch * 0.7 / 2) / (SR / 2));
    // block-rate modulators (interpolated inside the block)
    const aR0 = this.amRoar.x, aR1 = this.amRoar.step();
    const aU0 = this.amRumble.x, aU1 = this.amRumble.step();
    const rm = this.rateMod.step(); const wob = this.wob.step();
    this.buffetP.step();
    const hpA = Math.exp(-TAU * 22 / SR), hpRumA = Math.exp(-TAU * 11 / SR);
    const rateNow = Math.max(0, tgt.rate) * Math.exp(1.15 * rm - 0.66) * (1 + 0.25 * wob);
    const size = tgt.crackSize;
    const meanLen = 0.00022 * size / pitch * SR * 1.11;
    const crNorm = tgt.rate > 0 ? 1 / Math.sqrt(Math.max(1e-9, tgt.rate * 0.3333 * meanLen * CRACKLE_E / SR)) : 0;
    const drive = tgt.drive; const dg = 1 + 3.5 * drive;
    const pk = this.pk;
    const wInc = TAU * tgt.whineHz / SR;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const rumble = c0.rumble + (tgt.rumble - c0.rumble) * f;
      const roar = c0.roar + (tgt.roar - c0.roar) * f;
      const crackle = c0.crackle + (tgt.crackle - c0.crackle) * f;
      const buffet = c0.buffet + (tgt.buffet - c0.buffet) * f;
      const whine = c0.whine + (tgt.whine - c0.whine) * f;
      // --- rumble (mono)
      let r = 0;
      if (rumble > 0) {
        const w = rng() * 2 - 1;
        let v = this.rumF2.lp(this.rumF.lp(w));
        const y = v - this.hpxRum + hpRumA * this.hpRum; this.hpxRum = v; this.hpRum = y; // DC block
        const am = Math.exp(0.45 * (aU0 + (aU1 - aU0) * f) - 0.1);
        r = y * rumNorm * am * rumble;
      }
      // --- roar (stereo, independent noise, shared turbulent AM)
      let rl = 0, rr = 0;
      if (roar > 0) {
        const am = Math.exp(0.38 * (aR0 + (aR1 - aR0) * f) - 0.072);
        const wl = rng() * 2 - 1, wr = rng() * 2 - 1;
        pk[0] = 0.99765 * pk[0] + wl * 0.099046; pk[1] = 0.963 * pk[1] + wl * 0.2965164; pk[2] = 0.57 * pk[2] + wl * 1.0526913;
        pk[3] = 0.99765 * pk[3] + wr * 0.099046; pk[4] = 0.963 * pk[4] + wr * 0.2965164; pk[5] = 0.57 * pk[5] + wr * 1.0526913;
        const pl = (pk[0] + pk[1] + pk[2] + wl * 0.1848) * 0.25, pr = (pk[3] + pk[4] + pk[5] + wr * 0.1848) * 0.25;
        const hl = pl - this.hpxL + hpA * this.hpL; this.hpxL = pl; this.hpL = hl;
        const hr = pr - this.hpxR + hpA * this.hpR; this.hpxR = pr; this.hpR = hr;
        const g = roarNorm * am * roar;
        rl = this.roarL2.lp(this.roarL.lp(hl)) * g; rr = this.roarR2.lp(this.roarR.lp(hr)) * g;
      }
      // --- crackle
      let cl = 0, cr = 0;
      if (crackle > 0 || this.nev > 0) {
        if (crackle > 0 && rateNow > 0) {
          this.toNext -= 1;
          while (this.toNext <= 0) {
            this.spawn(rateNow, size, pitch);
            this.toNext += -Math.log(1 - rng() * 0.999999) * SR / rateNow;
          }
        }
        let k = 0;
        const ca = crackle * crNorm;
        while (k < this.nev) {
          const len = this.evLen[k]; const p = this.evPos[k];
          let v;
          if (p < len) v = 1 - 1.5 * p / len; else v = -0.5 * (1 - (p - len) / len);
          v *= this.evAmp[k] * ca;
          cl += v * this.evL[k]; cr += v * this.evR[k];
          const np = p + 1;
          if (np >= 2 * len) { // remove (swap with last)
            const j = --this.nev;
            this.evPos[k] = this.evPos[j]; this.evLen[k] = this.evLen[j]; this.evAmp[k] = this.evAmp[j];
            this.evL[k] = this.evL[j]; this.evR[k] = this.evR[j];
          } else { this.evPos[k] = np; k++; }
        }
      }
      // --- buffet (positive low-frequency thumps)
      let b = 0;
      if (buffet > 0) {
        const w = rng() * 2 - 1; const v = this.bufF.lp(w) * bufNorm;
        b = (v > 0 ? v * v : -0.25 * v * v) * buffet * 0.6;
      }
      // --- whine
      let wh = 0;
      if (whine > 0) {
        this.jit = 0.9995 * this.jit + 0.0005 * (rng() * 2 - 1);
        this.phase += wInc * (1 + this.jit * 4); if (this.phase > TAU) this.phase -= TAU;
        wh = (Math.sin(this.phase) + 0.3 * Math.sin(2 * this.phase) + 0.12 * Math.sin(3 * this.phase)) * whine * 0.6;
      }
      let yl = r + rl + b + wh, yr = r + rr + b + wh;
      if (CL) { CL[i] = cl; if (CR) CR[i] = cr; } else { yl += cl; yr += cr; }
      if (drive > 0) { yl = Math.tanh(yl * dg) / dg * (1 + 0.6 * drive); yr = Math.tanh(yr * dg) / dg * (1 + 0.6 * drive); }
      L[i] = yl; if (R) R[i] = yr;
    }
    return true;
  }
}
registerProcessor('rocket-noise', RocketNoise);

class TapRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.on = false;
    this.port.onmessage = (e) => { if (e.data === 'start') this.on = true; else if (e.data === 'stop') { this.on = false; this.port.postMessage('stopped'); } };
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      const l = new Float32Array(inp[0]); const r = new Float32Array(inp[1] || inp[0]);
      this.port.postMessage([l, r], [l.buffer, r.buffer]);
    }
    return true;
  }
}
registerProcessor('tap-recorder', TapRecorder);
`;
