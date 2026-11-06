import { systemTiming } from './system-timing.ts';
import type { Timing } from './timing.ts';

export type DeadlineTiming = Pick<Timing, 'now' | 'setTimeout' | 'clearTimeout'>;

export class Deadline {
  readonly signal: AbortSignal;
  private readonly expiresAt: number;
  private readonly parent: AbortSignal | undefined;
  private readonly timing: DeadlineTiming;
  private timer: unknown;
  private readonly onParentAbort: () => void;

  private constructor(ms: number, parent: AbortSignal | undefined, timing: DeadlineTiming) {
    const controller = new AbortController();
    this.signal = controller.signal;
    this.timing = timing;
    this.expiresAt = timing.now() + ms;
    this.parent = parent;
    this.onParentAbort = (): void => {
      this.dispose();
      controller.abort(parent?.reason);
    };
    if (parent?.aborted === true) {
      controller.abort(parent.reason);
      return;
    }
    this.timer = timing.setTimeout(() => {
      parent?.removeEventListener('abort', this.onParentAbort);
      controller.abort();
    }, ms);
    parent?.addEventListener('abort', this.onParentAbort, { once: true });
  }

  static after(ms: number, timing: DeadlineTiming = systemTiming): Deadline {
    return new Deadline(ms, undefined, timing);
  }

  get expired(): boolean {
    return this.signal.aborted;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - this.timing.now());
  }

  child(ms: number): Deadline {
    return new Deadline(Math.min(ms, this.remainingMs()), this.signal, this.timing);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.timing.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.parent?.removeEventListener('abort', this.onParentAbort);
  }
}
