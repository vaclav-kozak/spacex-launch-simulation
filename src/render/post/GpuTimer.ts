// Optional GPU timing (EXT_disjoint_timer_query_webgl2). Assign an instance to
// PostPipeline.profiler to get per-phase GPU milliseconds summed over all viewports:
//   'scene' = opaque + depth + VFX passes, 'post' = everything after (bloom .. final).
import type * as THREE from 'three';

interface Pending { q: WebGLQuery; label: string; frame: number }

export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: Pending[] = [];
  private free: WebGLQuery[] = [];
  private active: Pending | null = null;
  private frame = 0;
  /** smoothed ms per frame per label */
  readonly ms = new Map<string, number>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported(): boolean { return this.ext !== null; }

  begin(label: string): void {
    if (!this.ext || this.active) return;
    const q = this.free.pop() ?? this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, label, frame: this.frame };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  private open = new Map<number, Map<string, number>>();

  /** call once per frame (after rendering) */
  tick(): void {
    this.frame++;
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let newest = -1;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
      this.free.push(p.q);
      if (disjoint) continue;
      let m = this.open.get(p.frame);
      if (!m) this.open.set(p.frame, (m = new Map()));
      m.set(p.label, (m.get(p.label) ?? 0) + ns / 1e6);
      newest = Math.max(newest, p.frame);
    }
    // a frame is complete once a later frame's query resolved (queries resolve in order)
    const oldestPending = this.pending.length ? this.pending[0].frame : this.frame;
    for (const [f, m] of this.open) {
      if (f >= oldestPending) continue;
      for (const [k, v] of m) {
        const prev = this.ms.get(k);
        this.ms.set(k, prev === undefined ? v : prev * 0.9 + v * 0.1);
      }
      this.open.delete(f);
    }
    void newest;
  }

  summary(): string {
    return [...this.ms].map(([k, v]) => `${k} ${v.toFixed(2)}ms`).join('  ');
  }
}
