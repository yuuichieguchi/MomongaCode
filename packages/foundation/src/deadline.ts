export class Deadline {
  readonly signal: AbortSignal;
  private readonly expiresAt: number;
  private readonly parent: AbortSignal | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly onParentAbort: () => void;

  private constructor(ms: number, parent: AbortSignal | undefined) {
    const controller = new AbortController();
    this.signal = controller.signal;
    this.expiresAt = Date.now() + ms;
    this.parent = parent;
    this.onParentAbort = (): void => {
      this.dispose();
      controller.abort(parent?.reason);
    };
    if (parent?.aborted === true) {
      controller.abort(parent.reason);
      return;
    }
    this.timer = setTimeout(() => {
      parent?.removeEventListener('abort', this.onParentAbort);
      controller.abort();
    }, ms);
    this.timer.unref();
    parent?.addEventListener('abort', this.onParentAbort, { once: true });
  }

  static after(ms: number): Deadline {
    return new Deadline(ms, undefined);
  }

  get expired(): boolean {
    return this.signal.aborted;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  child(ms: number): Deadline {
    return new Deadline(Math.min(ms, this.remainingMs()), this.signal);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.parent?.removeEventListener('abort', this.onParentAbort);
  }
}
