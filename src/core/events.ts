import type { SimEvent, SimEventType } from './types';

type Handler = (e: SimEvent) => void;

/** Tiny synchronous event bus. The sim emits; everyone else listens. */
export class EventBus {
  private handlers = new Map<SimEventType | '*', Set<Handler>>();
  /** events emitted since the last drain (consumers that prefer polling) */
  readonly recent: SimEvent[] = [];

  on(type: SimEventType | '*', h: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  emit(e: SimEvent): void {
    this.recent.push(e);
    if (this.recent.length > 256) this.recent.shift();
    this.handlers.get(e.type)?.forEach((h) => h(e));
    this.handlers.get('*')?.forEach((h) => h(e));
  }
}
