// Deterministic seeded PRNG (mulberry32) + Gaussian (Box–Muller). Same seed => same sequence.

export class Rng {
  private s: number;
  private spare = 0;
  private hasSpare = false;
  constructor(seed: number) {
    this.s = seed | 0;
  }
  next(): number {
    let s = (this.s = (this.s + 0x6d2b79f5) | 0);
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform in [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0, v = 0;
    while (u < 1e-12) u = this.next();
    v = this.next();
    const m = Math.sqrt(-2 * Math.log(u));
    this.spare = m * Math.sin(2 * Math.PI * v);
    this.hasSpare = true;
    return m * Math.cos(2 * Math.PI * v);
  }
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
