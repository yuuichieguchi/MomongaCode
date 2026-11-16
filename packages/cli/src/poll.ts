import type { CliClock } from './ports.ts';

export class PollTimeout extends Error {
  readonly description: string;
  readonly boundMs: number;

  constructor(description: string, boundMs: number) {
    super(`timed out after ${boundMs} ms waiting for ${description}`);
    this.name = 'PollTimeout';
    this.description = description;
    this.boundMs = boundMs;
  }
}

export type PollOptions = { boundMs: number; intervalMs: number; description: string; signal?: AbortSignal; progressMark?: () => string };

export const pollUntil = async <T>(clock: CliClock, probe: () => Promise<T | undefined>, options: PollOptions): Promise<T> => {
  let deadline = clock.now() + options.boundMs;
  let mark = options.progressMark?.();
  for (;;) {
    options.signal?.throwIfAborted();
    const value = await probe();
    if (value !== undefined) return value;
    const nextMark = options.progressMark?.();
    if (nextMark !== mark) {
      mark = nextMark;
      deadline = clock.now() + options.boundMs;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw new PollTimeout(options.description, options.boundMs);
    await clock.sleep(Math.min(options.intervalMs, remaining), options.signal);
  }
};
