// Callout voice playback: pre-generated TTS clips (public/audio/callouts, manifest.json), a
// non-overlapping queue with stale-dropping, and a speechSynthesis fallback for unknown lines.

import type { SimEvent } from '../core/types';

export interface ManifestLine {
  id?: string | null;
  text: string;
  key: string;
  voice: 'lc' | 'host' | 'chatter';
  kind: 'callout' | 'count' | 'chatter';
  file: string;
  dur: number;
}

const NUM_WORDS: Record<string, string> = {};
'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
  .split(' ').forEach((w, i) => (NUM_WORDS[w] = String(i)));
Object.assign(NUM_WORDS, { thirty: '30', forty: '40', fifty: '50', sixty: '60' });

/** MUST match norm_key() in tools/audio/gen_callouts.py */
export function normKey(s: string): string {
  let t = s.toLowerCase().replace(/…/g, ' ');
  t = t.replace(/t\s*-\s*minus/g, 't minus').replace(/t\s*-\s*(\d)/g, 't minus $1').replace(/max\s*-\s*q/g, 'max q');
  t = t.replace(/[^a-z0-9 ]+/g, ' ');
  return t.split(/\s+/).filter(Boolean).map((w) => NUM_WORDS[w] ?? w).join(' ');
}

interface QItem {
  lines: ManifestLine[] | null; // null → speech fallback
  text: string;
  voice: 'lc' | 'host';
  t: number; // mission time of the event
  real: number; // real time queued (s)
  count: boolean; // countdown number: superseded by any newer count
  id: string;
}

export class CalloutPlayer {
  private lines: ManifestLine[] = [];
  private byId = new Map<string, ManifestLine>();
  private byKey = new Map<string, ManifestLine>();
  private bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private buffers = new Map<string, AudioBuffer>();
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private queue: QItem[] = [];
  private busyUntil = 0; // AudioContext time the current clip ends
  private speaking = false;
  private current: AudioBufferSourceNode | null = null;
  chatter: ManifestLine[] = [];
  base = '';
  /** debug: last started line and number of stale-dropped items */
  lastPlayed = '';
  dropped = 0;
  /** debug ring (last 40): started / dropped lines with mission-time lag and clip length */
  log: { what: 'play' | 'drop'; id: string; evT: number; atT: number; lagR: number; dur: number }[] = [];
  private note(what: 'play' | 'drop', q: QItem, missionT: number, realNow: number, dur: number): void {
    this.log.push({ what, id: q.id || q.text.slice(0, 24), evT: +q.t.toFixed(2), atT: +missionT.toFixed(2), lagR: +(realNow - q.real).toFixed(2), dur: +dur.toFixed(2) });
    if (this.log.length > 40) this.log.shift();
  }

  async loadManifest(base: string): Promise<void> {
    this.base = base;
    try {
      const r = await fetch(base + 'manifest.json');
      if (!r.ok) return;
      const m = await r.json();
      this.lines = (m.lines ?? []) as ManifestLine[];
    } catch {
      return;
    }
    for (const l of this.lines) {
      if (l.voice === 'chatter') { this.chatter.push(l); continue; }
      if (l.id) this.byId.set(l.id, l);
      this.byKey.set(`${l.voice}|${l.key}`, l);
      if (!this.byKey.has(`*|${l.key}`)) this.byKey.set(`*|${l.key}`, l);
    }
  }

  /** fetch every clip's bytes in the background (small: ~2.5 MB total) */
  prefetch(): void {
    for (const l of this.lines) this.fetchBytes(l.file);
  }
  private fetchBytes(file: string): Promise<ArrayBuffer | null> {
    let p = this.bytes.get(file);
    if (!p) {
      p = fetch(this.base + file).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      this.bytes.set(file, p);
    }
    return p;
  }
  decode(ac: BaseAudioContext, file: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    let p = this.decoding.get(file);
    if (!p) {
      p = this.fetchBytes(file).then(async (ab) => {
        if (!ab) return null;
        try {
          const b = await ac.decodeAudioData(ab.slice(0));
          this.buffers.set(file, b);
          return b;
        } catch { return null; }
      });
      this.decoding.set(file, p);
    }
    return p;
  }
  decodeAll(ac: BaseAudioContext): void {
    // stagger so the main thread is not blocked at unlock
    let i = 0;
    const next = () => {
      const l = this.lines[i++];
      if (!l) return;
      this.decode(ac, l.file).then(() => setTimeout(next, 0));
    };
    for (let k = 0; k < 3; k++) next();
  }
  bufferFor(l: ManifestLine): AudioBuffer | null { return this.buffers.get(l.file) ?? null; }

  /** resolve a CALLOUT event to one or more clips (null → no clip, use speech) */
  resolve(id: string | undefined, text: string, voice: 'lc' | 'host'): ManifestLine[] | null {
    if (id) { const l = this.byId.get(id); if (l) return [l]; }
    const k = normKey(text);
    const hit = this.byKey.get(`${voice}|${k}`) ?? this.byKey.get(`*|${k}`);
    if (hit) return [hit];
    const k2 = k.replace(/^and /, '').replace(/^t minus (\d+)$/, '$1');
    const hit2 = this.byKey.get(`${voice}|${k2}`) ?? this.byKey.get(`*|${k2}`);
    if (hit2) return [hit2];
    // "3, 2, 1" or multi-sentence texts: play known segments in order if all are known
    const segs = text.split(/[,.;!?]+/).map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) {
      const out: ManifestLine[] = [];
      for (const s of segs) {
        const ks = normKey(s);
        const l = this.byKey.get(`${voice}|${ks}`) ?? this.byKey.get(`*|${ks}`);
        if (!l) return null;
        out.push(l);
      }
      return out;
    }
    return null;
  }

  enqueue(e: SimEvent, realNow: number): void {
    const d = e.data ?? {};
    const text = String(d.text ?? '');
    if (!text) return;
    const voice = d.voice === 'host' ? 'host' : 'lc';
    const lines = this.resolve(typeof d.id === 'string' ? d.id : undefined, text, voice);
    const count = !!lines && lines.length === 1 && lines[0].kind === 'count';
    this.queue.push({ lines, text, voice, t: e.t, real: realNow, count, id: typeof d.id === 'string' ? d.id : '' });
    if (this.queue.length > 12) this.queue.shift();
  }

  clear(): void {
    this.queue.length = 0;
    try { this.current?.stop(); } catch { /* already stopped */ }
    this.current = null;
    if (this.speaking && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.speaking = false;
    this.busyUntil = 0;
  }

  /** true while a clip or utterance is playing (for ducking) */
  isBusy(ac: BaseAudioContext): boolean { return this.speaking || ac.currentTime < this.busyUntil; }

  private stale(q: QItem, missionT: number, realNow: number, warp: number): boolean {
    const lagM = missionT - q.t, lagR = realNow - q.real;
    if (lagM < -0.5) return true; // time jumped backwards (replay/seek)
    if (q.count) return lagM > 1.3 || this.queue.some((o) => o !== q && o.count && o.t > q.t);
    const maxM = q.voice === 'host' ? 9 : 5.5;
    if (warp > 4 && lagM > 2.5) return true;
    return lagM > maxM || lagR > 7;
  }

  tick(ac: BaseAudioContext, out: AudioNode, missionT: number, realNow: number, warp: number, paused: boolean): void {
    if (paused) return;
    // drop stale items anywhere in the queue
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.stale(this.queue[i], missionT, realNow, warp)) { this.note('drop', this.queue[i], missionT, realNow, 0); this.queue.splice(i, 1); this.dropped++; }
    }
    if (this.isBusy(ac) || !this.queue.length) return;
    const q = this.queue[0];
    if (q.lines) {
      const bufs = q.lines.map((l) => this.buffers.get(l.file) ?? null);
      if (bufs.some((b) => !b)) {
        q.lines.forEach((l) => this.decode(ac, l.file));
        return; // wait (stale check drops it if it takes too long)
      }
      this.queue.shift();
      let t = ac.currentTime + 0.02;
      for (const b of bufs as AudioBuffer[]) {
        const s = ac.createBufferSource();
        s.buffer = b;
        s.connect(out);
        s.start(t);
        this.current = s;
        t += b.duration + 0.05;
      }
      this.busyUntil = t;
      this.lastPlayed = `${q.text}@${missionT.toFixed(2)}`;
      this.note('play', q, missionT, realNow, t - ac.currentTime);
      return;
    }
    this.queue.shift();
    this.lastPlayed = `(speech) ${q.text}@${missionT.toFixed(2)}`;
    this.note('play', q, missionT, realNow, -1);
    this.speak(q);
  }

  private speak(q: QItem): void {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      const u = new SpeechSynthesisUtterance(q.text);
      const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      const pref = q.voice === 'lc' ? /(david|daniel|alex|guy|male|fred)/i : /(zira|samantha|female|jenny|aria|google us)/i;
      u.voice = vs.find((v) => pref.test(v.name)) ?? vs[0] ?? null;
      u.rate = q.voice === 'lc' ? 1.1 : 1.0;
      u.pitch = q.voice === 'lc' ? 0.85 : 1.05;
      u.volume = 0.9;
      this.speaking = true;
      u.onend = u.onerror = () => { this.speaking = false; };
      speechSynthesis.speak(u);
      setTimeout(() => { this.speaking = false; }, 1500 + q.text.length * 90);
    } catch {
      this.speaking = false;
    }
  }
}
