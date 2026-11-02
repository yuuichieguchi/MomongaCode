import type { StreamEvent } from '@momonga/protocol';
import { frameOf } from '../core/frame.ts';
import { GatewayError, readerStalledError } from '../core/errors.ts';
import type { GatewayTimers } from '../types.ts';

const encoder = new TextEncoder();
const KEEP_ALIVE_FRAME = encoder.encode(': keep-alive\n\n');

export type SseOptions = {
  timers: GatewayTimers;
  keepAliveMs: number;
  readerStallMs: number;
  signal: AbortSignal;
  onEnd: () => void;
};

export const sseResponse = (first: StreamEvent, rest: AsyncIterator<StreamEvent>, options: SseOptions): Response => {
  const { timers, keepAliveMs, readerStallMs, signal } = options;
  let ended = false;
  let streamDone = false;
  let timer: unknown;
  let stallTimer: unknown;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stopTimer = (): void => {
    timers.clearTimeout(timer);
    timer = undefined;
  };
  const stopStallTimer = (): void => {
    timers.clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const armStallTimer = (): void => {
    stopStallTimer();
    stallTimer = timers.setTimeout(() => stopRelay(readerStalledError()), readerStallMs);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    stopTimer();
    stopStallTimer();
    signal.removeEventListener('abort', onAbort);
    options.onEnd();
  };
  const schedule = (): void => {
    timer = timers.setTimeout(() => {
      if (ended || streamDone) return;
      if ((streamController?.desiredSize ?? 0) > 0) streamController?.enqueue(KEEP_ALIVE_FRAME);
      schedule();
    }, keepAliveMs);
  };
  const stopRelay = (reason: unknown): void => {
    if (ended) return;
    stopTimer();
    stopStallTimer();
    Promise.resolve(rest.return?.()).then(
      () => {
        if (!streamDone) {
          streamDone = true;
          if (reason instanceof GatewayError) streamController?.error(reason);
          else streamController?.close();
        }
        end();
      },
      (error: unknown) => {
        if (!streamDone) {
          streamDone = true;
          streamController?.error(error);
        }
        end();
      },
    );
  };
  const onAbort = (): void => stopRelay(signal.reason);

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller;
      controller.enqueue(frameOf(first));
      signal.addEventListener('abort', onAbort, { once: true });
      schedule();
      armStallTimer();
    },
    pull: async (controller) => {
      if (ended) return;
      stopStallTimer();
      try {
        const step = await rest.next();
        if (step.done === true) {
          if (!streamDone) {
            streamDone = true;
            controller.close();
          }
          end();
          return;
        }
        controller.enqueue(frameOf(step.value));
        armStallTimer();
      } catch (error) {
        if (!streamDone) {
          streamDone = true;
          controller.error(error);
        }
        end();
      }
    },
    cancel: async () => {
      streamDone = true;
      stopTimer();
      try {
        await rest.return?.();
      } finally {
        end();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
};
