// Procedural AudioBuffers generated once at startup (no sample assets needed):
// noise beds, ambience loops, reverb IR and one-shot SFX (sonic boom N-waves, TEA-TEB pop,
// structure clunks, touchdown, explosion, splash, RCS puff).

type Ctx = BaseAudioContext;

// ---------- tiny offline DSP helpers
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function gauss(r: () => number): number {
  return (r() + r() + r() + r() - 2) * 1.7320508;
}

/** RBJ biquad (in-place). type: lp | hp | bp | peak */
function biquad(x: Float32Array, sr: number, type: 'lp' | 'hp' | 'bp' | 'peak', f: number | ((i: number) => number), q = 0.707, gainDb = 0): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const dyn = typeof f === 'function';
  const coef = (fc: number) => {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let a0: number;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  };
  if (!dyn) coef(f as number);
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 31) === 0) coef((f as (i: number) => number)(i));
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

function normalize(x: Float32Array, peak = 0.9): void {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) { const g = peak / m; for (let i = 0; i < x.length; i++) x[i] *= g; }
}
function rmsNormalize(x: Float32Array, rms: number): void {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const r = Math.sqrt(s / Math.max(1, x.length));
  if (r > 0) { const g = rms / r; for (let i = 0; i < x.length; i++) x[i] *= g; }
}
/** crossfade the tail into the head so the buffer loops seamlessly */
function makeLoop(x: Float32Array, sr: number, fadeSec = 0.5): Float32Array {
  const f = Math.min(Math.floor(fadeSec * sr), Math.floor(x.length / 4));
  const n = x.length - f;
  const y = new Float32Array(n);
  y.set(x.subarray(0, n));
  for (let i = 0; i < f; i++) {
    const u = i / f;
    y[i] = x[n + i] * Math.cos(u * Math.PI / 2) + x[i] * Math.sin(u * Math.PI / 2);
  }
  return y;
}
function buf(ctx: Ctx, chans: Float32Array[]): AudioBuffer {
  const b = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}

// ---------- noise beds
export function whiteNoise(ctx: Ctx, seconds: number, seed = 1): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const chans = [0, 1].map((c) => {
    const r = rng(seed * 7 + c * 13 + 1);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = gauss(r) * 0.3;
    return makeLoop(x, sr, 0.05);
  });
  return buf(ctx, chans);
}

export function pinkNoise(ctx: Ctx, seconds: number, seed = 2): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const chans = [0, 1].map((c) => {
    const r = rng(seed * 11 + c * 17 + 3);
    const x = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    rmsNormalize(x, 0.25);
    return makeLoop(x, sr, 0.2);
  });
  return buf(ctx, chans);
}

/** distant surf on the coast below SLC-4E: slow wave crashes over a low roar (stereo, loops) */
export function surfBuffer(ctx: Ctx, seconds = 26, seed = 5): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const chans = [0, 1].map((c) => {
    const r = rng(seed + c * 101);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = gauss(r);
    // crash envelope: waves every 6–11 s
    const env = new Float32Array(n).fill(0.28);
    let t = r() * 3;
    while (t < seconds + 4) {
      const a = 0.9 + r() * 0.8, d = 3 + r() * 3, amp = 0.6 + r() * 0.6;
      const i0 = Math.floor(t * sr);
      for (let i = Math.max(0, i0); i < Math.min(n, i0 + (a + d * 2) * sr); i++) {
        const tt = (i - i0) / sr;
        const e = tt < a ? Math.pow(tt / a, 2) : Math.exp(-(tt - a) / d * 1.6);
        env[i] += amp * e;
      }
      t += 6 + r() * 5;
    }
    for (let i = 0; i < n; i++) x[i] *= env[i];
    biquad(x, sr, 'lp', (i) => 260 + 700 * Math.min(1, env[i] * 0.8), 0.6);
    biquad(x, sr, 'lp', 900, 0.6);
    biquad(x, sr, 'hp', 40, 0.7);
    rmsNormalize(x, 0.2);
    return makeLoop(x, sr, 1.5);
  });
  return buf(ctx, chans);
}

/** water slapping/sloshing against OCISLY's hull (stereo, loops); seaState scales at runtime */
export function hullWaterBuffer(ctx: Ctx, seconds = 17, seed = 9): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const chans = [0, 1].map((c) => {
    const r = rng(seed + c * 37);
    const slosh = new Float32Array(n), slap = new Float32Array(n);
    for (let i = 0; i < n; i++) { slosh[i] = gauss(r); slap[i] = gauss(r); }
    // slow sloshing: AM at swell period
    const per = 7 + r() * 2;
    for (let i = 0; i < n; i++) slosh[i] *= 0.35 + 0.3 * Math.sin((i / sr) * 2 * Math.PI / per + c) ** 2;
    biquad(slosh, sr, 'lp', 380, 0.7);
    // slaps: short splashy bursts
    const env = new Float32Array(n);
    let t = r() * 0.5;
    while (t < seconds) {
      const d = 0.12 + r() * 0.35, amp = 0.3 + r() * r() * 1.2, i0 = Math.floor(t * sr);
      for (let i = i0; i < Math.min(n, i0 + d * 4 * sr); i++) {
        const tt = (i - i0) / sr;
        env[i] += amp * (tt < 0.012 ? tt / 0.012 : Math.exp(-(tt - 0.012) / d));
      }
      t += 0.35 + r() * 1.6;
    }
    for (let i = 0; i < n; i++) slap[i] *= env[i];
    biquad(slap, sr, 'bp', 900, 0.6);
    biquad(slap, sr, 'lp', 3500, 0.7);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = slosh[i] + slap[i] * 0.8;
    rmsNormalize(x, 0.2);
    return makeLoop(x, sr, 0.8);
  });
  return buf(ctx, chans);
}

/** generated stereo IR: early reflections + optional terrain slap echoes + damped diffuse tail */
export function reverbIR(ctx: Ctx, seconds = 3.2, opts: { echoes?: number[]; damp?: number } = {}): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const damp = opts.damp ?? 1;
  const chans = [0, 1].map((c) => {
    const r = rng(77 + c * 5);
    const x = new Float32Array(n);
    const pre = Math.floor(0.018 * sr);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      x[i] = gauss(r) * Math.exp(-t / (0.55 * damp)) * Math.min(1, t / 0.03);
    }
    // frequency-dependent decay: progressively lower corner with time
    biquad(x, sr, 'lp', (i) => 9000 * Math.exp(-(i / sr) * 2.2) + 350, 0.6);
    // early reflections
    for (let k = 0; k < 10; k++) {
      const i0 = Math.floor((0.012 + r() * 0.09) * sr);
      x[i0] += (r() * 2 - 1) * 0.7 * Math.exp(-k * 0.15);
    }
    // slap echoes from terrain (smeared lowpassed copies)
    for (const e of opts.echoes ?? []) {
      const i0 = Math.floor((e + c * 0.013) * sr);
      for (let j = 0; j < Math.floor(0.08 * sr) && i0 + j < n; j++) {
        x[i0 + j] += gauss(r) * 0.35 * Math.exp(-j / (0.02 * sr)) * Math.exp(-e / 1.2);
      }
    }
    normalize(x, 0.9);
    return x;
  });
  return buf(ctx, chans);
}

// ---------- one-shots

/** one N-wave with finite rise time (s) and duration (s) */
function addNWave(x: Float32Array, sr: number, t0: number, dur: number, rise: number, amp: number): void {
  const i0 = Math.floor(t0 * sr), nr = Math.max(1, Math.floor(rise * sr)), nd = Math.floor(dur * sr);
  for (let j = 0; j < nd + 2 * nr && i0 + j < x.length; j++) {
    let v: number;
    if (j < nr) v = 0.5 - 0.5 * Math.cos(Math.PI * j / nr); // front shock
    else if (j < nr + nd) v = 1 - 2 * (j - nr) / nd; // linear expansion
    else v = -1 + (0.5 - 0.5 * Math.cos(Math.PI * (j - nr - nd) / nr)); // rear shock
    x[i0 + j] += v * amp;
  }
}

/**
 * Falcon 9 booster return boom: the classic double/triple boom (shocks from the engine section,
 * the interstage/grid fins and the legs/nose), each a short N-wave, plus a rumbling
 * ground/sea-scattered tail. `distanceKm` lengthens rise time and duration.
 */
export function sonicBoom(ctx: Ctx, distanceKm = 8, seed = 3): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(3.5 * sr);
  const r = rng(seed);
  const chans = [0, 1].map((c) => {
    const x = new Float32Array(n);
    const rise = 0.0015 + 0.0006 * distanceKm;
    const dur = 0.085 * Math.pow(Math.max(1, distanceKm) / 8, 0.25);
    const gaps = [0, 0.34 + r() * 0.06, 0.62 + r() * 0.08];
    const amps = [1, 0.62, 0.8];
    gaps.forEach((g, k) => addNWave(x, sr, 0.02 + g + c * 0.0006, dur * (1 - 0.1 * k), rise, amps[k]));
    // scattered/reflected rumble tail
    const rr = rng(seed * 3 + c);
    const tail = new Float32Array(n);
    for (let i = Math.floor(0.03 * sr); i < n; i++) {
      const t = i / sr;
      tail[i] = gauss(rr) * Math.exp(-(t - 0.03) / 0.9) * Math.min(1, (t - 0.03) / 0.05);
    }
    biquad(tail, sr, 'lp', 160, 0.7);
    biquad(tail, sr, 'lp', 220, 0.6);
    rmsNormalize(tail, 0.06);
    for (let i = 0; i < n; i++) x[i] += tail[i];
    biquad(x, sr, 'lp', 5000 / Math.max(1, distanceKm / 6), 0.6);
    normalize(x, 0.95);
    return x;
  });
  return buf(ctx, chans);
}

/** TEA-TEB ignition: sharp chemical "pop" + low whump (per engine start) */
export function ignitionPop(ctx: Ctx, seed = 4): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(0.9 * sr);
  const r = rng(seed);
  const chans = [0, 1].map((c) => {
    const x = new Float32Array(n);
    addNWave(x, sr, 0.004 + c * 0.0004, 0.0035, 0.0003, 1);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 38 + 60 * Math.exp(-t / 0.05);
      x[i] += 0.9 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.16) * Math.min(1, t / 0.004);
      x[i] += gauss(r) * 0.25 * Math.exp(-t / 0.05);
    }
    biquad(x, sr, 'lp', 6000, 0.7);
    normalize(x, 0.9);
    return x;
  });
  return buf(ctx, chans);
}

/** engine shutdown: gas-flow chuff + low decay */
export function shutdownChuff(ctx: Ctx, seed = 6): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(1.4 * sr);
  const r = rng(seed);
  const chans = [0, 1].map(() => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = gauss(r) * Math.exp(-t / 0.22) * Math.min(1, t / 0.01) + 0.7 * Math.sin(2 * Math.PI * (30 + 25 * Math.exp(-t / 0.2)) * t) * Math.exp(-t / 0.35);
    }
    biquad(x, sr, 'lp', (i) => 1800 * Math.exp(-(i / sr) / 0.25) + 120, 0.7);
    normalize(x, 0.8);
    return x;
  });
  return buf(ctx, chans);
}

/** metallic structural modes (inharmonic, decaying) for clunks/clangs */
function addModes(x: Float32Array, sr: number, t0: number, freqs: number[], decay: number, amp: number, r: () => number): void {
  const i0 = Math.floor(t0 * sr);
  for (const f of freqs) {
    const ph = r() * Math.PI * 2, a = amp * (0.5 + r() * 0.5), d = decay * (0.6 + r() * 0.8) * (400 / (f + 300));
    for (let i = i0; i < x.length; i++) {
      const t = (i - i0) / sr;
      const e = Math.exp(-t / d);
      if (e < 1e-3) break;
      x[i] += a * e * Math.sin(2 * Math.PI * f * t + ph);
    }
  }
}

export type ClunkKind = 'stagesep' | 'fairing' | 'legs' | 'gridfins' | 'thud';
/** structure-borne mechanical events heard by onboard cameras */
export function clunk(ctx: Ctx, kind: ClunkKind, seed = 8): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = kind === 'legs' ? 1.6 : kind === 'stagesep' ? 1.8 : 1.2;
  const n = Math.floor(len * sr);
  const r = rng(seed + kind.length * 13);
  const chans = [0, 1].map((c) => {
    const x = new Float32Array(n);
    const hit = (t0: number, lowF: number, amp: number, modes: number[], decay: number) => {
      const i0 = Math.floor(t0 * sr);
      for (let i = i0; i < n; i++) {
        const t = (i - i0) / sr;
        x[i] += amp * Math.sin(2 * Math.PI * (lowF + lowF * 1.5 * Math.exp(-t / 0.02)) * t) * Math.exp(-t / 0.09);
        if (t < 0.012) x[i] += amp * 0.6 * gauss(r) * (1 - t / 0.012);
      }
      addModes(x, sr, t0, modes, decay, amp * 0.25, r);
    };
    if (kind === 'stagesep') {
      hit(0.01, 42, 1, [187, 331, 529, 804, 1190, 1733], 0.5);
      hit(0.09 + c * 0.004, 60, 0.4, [240, 611, 1402], 0.3);
    } else if (kind === 'fairing') {
      hit(0.005, 55, 0.7, [402, 915, 1571, 2350], 0.25);
      hit(0.028, 48, 0.5, [260, 733], 0.3);
    } else if (kind === 'legs') {
      hit(0.01, 50, 0.8, [210, 470, 890, 1400], 0.35);
      // pneumatic (helium) actuator hiss
      const h = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / sr; h[i] = gauss(r) * 0.25 * Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.1) / 0.45); }
      biquad(h, sr, 'hp', 1800, 0.7);
      for (let i = 0; i < n; i++) x[i] += h[i];
      hit(0.9 + c * 0.003, 44, 0.6, [233, 517, 980], 0.3);
    } else if (kind === 'gridfins') {
      hit(0.008, 70, 0.6, [520, 1250, 2230, 3100], 0.18);
      hit(0.05, 90, 0.35, [610, 1480], 0.15);
    } else {
      hit(0.005, 40, 1, [150, 380, 700], 0.25);
    }
    biquad(x, sr, 'lp', 7000, 0.7);
    normalize(x, 0.9);
    return x;
  });
  return buf(ctx, chans);
}

/** booster touchdown on the steel deck: thump + deck-plate clang + crush-core groan */
export function touchdown(ctx: Ctx, severity: number, seed = 10): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(3 * sr);
  const r = rng(seed);
  const chans = [0, 1].map((c) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] += Math.sin(2 * Math.PI * (28 + 40 * Math.exp(-t / 0.05)) * t) * Math.exp(-t / (0.25 + 0.2 * severity)) * Math.min(1, t / 0.003);
    }
    addModes(x, sr, 0.004 + c * 0.002, [97, 143, 211, 318, 452, 689, 1033, 1512], 0.9, 0.22 * (1 + severity), r);
    // crush/groan: swept band-passed noise
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; g[i] = gauss(r) * Math.exp(-t / (0.35 + 0.5 * severity)) * Math.min(1, t / 0.02); }
    biquad(g, sr, 'bp', (i) => 900 - 500 * Math.min(1, i / sr / 0.6), 3);
    for (let i = 0; i < n; i++) x[i] += g[i] * (0.4 + 1.2 * severity);
    if (severity > 0.6) for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * (1 + 2 * severity));
    normalize(x, 0.95);
    return x;
  });
  return buf(ctx, chans);
}

/** RUD: blast + crackling fireball + long rumble */
export function explosion(ctx: Ctx, seed = 12): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(7 * sr);
  const r = rng(seed);
  const chans = [0, 1].map(() => {
    const x = new Float32Array(n);
    addNWave(x, sr, 0.01, 0.06, 0.002, 1);
    const rum = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; rum[i] = gauss(r) * Math.exp(-t / 1.8) * Math.min(1, t / 0.03); }
    biquad(rum, sr, 'lp', 90, 0.8); biquad(rum, sr, 'lp', 140, 0.6);
    rmsNormalize(rum, 0.35);
    // fire crackle: sparse sharp pops decaying over seconds
    let t = 0.05;
    while (t < 6) {
      const a = (0.15 + r() * r() * 0.7) * Math.exp(-t / 2.2);
      addNWave(x, sr, t, 0.0006 + r() * 0.002, 0.0001, a);
      t += -Math.log(1 - r() * 0.999) / (60 * Math.exp(-t / 2));
    }
    const roar = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t2 = i / sr; roar[i] = gauss(r) * Math.exp(-t2 / 1.2) * Math.min(1, t2 / 0.02); }
    biquad(roar, sr, 'lp', 700, 0.7);
    rmsNormalize(roar, 0.12);
    for (let i = 0; i < n; i++) x[i] += rum[i] + roar[i];
    normalize(x, 0.95);
    return x;
  });
  return buf(ctx, chans);
}

/** big object hitting the water */
export function splash(ctx: Ctx, seed = 14): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(3.5 * sr);
  const r = rng(seed);
  const chans = [0, 1].map(() => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = gauss(r) * (t < 0.08 ? t / 0.08 : Math.exp(-(t - 0.08) / 0.9));
    }
    biquad(x, sr, 'bp', (i) => 600 + 900 * Math.exp(-(i / sr) / 0.6), 0.5);
    for (let i = 0; i < n; i++) { const t = i / sr; x[i] += 0.8 * Math.sin(2 * Math.PI * (35 + 30 * Math.exp(-t / 0.08)) * t) * Math.exp(-t / 0.25); }
    normalize(x, 0.9);
    return x;
  });
  return buf(ctx, chans);
}

/** cold-gas N2 RCS puff: valve click + short hiss */
export function rcsPuff(ctx: Ctx, seed = 16): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(0.35 * sr);
  const r = rng(seed);
  const chans = [0, 1].map(() => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      x[i] = gauss(r) * (t < 0.004 ? t / 0.004 : Math.exp(-(t - 0.004) / 0.07));
    }
    biquad(x, sr, 'hp', 900, 0.7);
    biquad(x, sr, 'peak', 3800, 1.2, 6);
    x[2] += 0.8; x[3] -= 0.5;
    normalize(x, 0.9);
    return x;
  });
  return buf(ctx, chans);
}
