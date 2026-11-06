import type { Capabilities } from '@momonga/protocol';
import { StreamFailure } from './failures.ts';
import { realTimers } from '../../process-ports.ts';
import type { UpstreamLiveness } from './http-client.ts';

export const UPSTREAM_IDLE_CODE = 'stream_interrupted';

export const upstreamIdleText = (idleMs: number): string =>
  `The model sent no output for ${idleMs / 1000} s (only keep-alive signals arrived), so the call was stopped. Raise models.idleTimeoutMs if this model needs longer.`;

export type ContentWatch = {
  touch(): void;
  source<T>(iterable: AsyncIterable<T>): AsyncGenerator<T>;
  dispose(): void;
};

const unwatched: ContentWatch = {
  touch: () => undefined,
  source: async function* <T>(iterable: AsyncIterable<T>): AsyncGenerator<T> {
    yield* iterable;
  },
  dispose: () => undefined,
};

export const watchContent = (liveness: UpstreamLiveness | undefined): ContentWatch => {
  if (liveness === undefined || liveness.idleTimeoutMs === 0) return unwatched;
  const { idleTimeoutMs } = liveness;
  const timers = liveness.timers ?? realTimers;
  let timer: unknown;
  let expired: StreamFailure | undefined;
  let wake: ((failure: StreamFailure) => void) | undefined;
  const arm = (): void => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      expired = new StreamFailure(UPSTREAM_IDLE_CODE, 'server_error', upstreamIdleText(idleTimeoutMs));
      wake?.(expired);
    }, idleTimeoutMs);
  };
  arm();
  return {
    touch: () => {
      if (expired === undefined) arm();
    },
    source: async function* <T>(iterable: AsyncIterable<T>): AsyncGenerator<T> {
      const iterator = iterable[Symbol.asyncIterator]();
      for (;;) {
        if (expired !== undefined) throw expired;
        const pending = iterator.next();
        const stopped = new Promise<never>((_resolve, reject) => {
          wake = reject;
        });
        let step: IteratorResult<T>;
        try {
          step = await Promise.race([pending, stopped]);
        } catch (error) {
          if (error === expired) void pending.then(undefined, () => undefined);
          throw error;
        } finally {
          wake = undefined;
        }
        if (step.done === true) return;
        yield step.value;
      }
    },
    dispose: () => timers.clearTimeout(timer),
  };
};

export const watchedPostOf = (liveness: UpstreamLiveness | undefined): { streamed?: true } => (liveness === undefined ? {} : { streamed: true });

export const gatewayOutputCeilingOf = (capabilities: Capabilities): number | undefined =>
  capabilities.outputBoundField === 'none' ? capabilities.maxOutputTokens : undefined;
