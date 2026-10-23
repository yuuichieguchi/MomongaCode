import type { StreamEvent } from '@momonga/protocol';
import { frameOf } from '../core/frame.ts';
import { GatewayError } from '../core/errors.ts';
import type { GatewayTimers } from '../types.ts';

const encoder = new TextEncoder();
const KEEP_ALIVE_FRAME = encoder.encode(': keep-alive\n\n');

export type SseOptions = {
  timers: GatewayTimers;
  keepAliveMs: number;
  signal: AbortSignal;
  onEnd: () => void;
};

export const sseResponse = (first: StreamEvent, rest: AsyncIterator<StreamEvent>, options: SseOptions): Response => {
  const { timers, keepAliveMs, signal } = options;
  let ended = false;
  let streamDone = false;
  let timer: unknown;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stopTimer = (): void => {
    timers.clearTimeout(timer);
    timer = undefined;
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    stopTimer();
    signal.removeEventListener('abort', onAbort);
    options.onEnd();
  };
  const schedule = (): void => {
    timer = timers.setTimeout(() => {
      if (ended || streamDone) return;
      streamController?.enqueue(KEEP_ALIVE_FRAME);
      schedule();
    }, keepAliveMs);
  };
  const onAbort = (): void => {
    if (ended) return;
    stopTimer();
    Promise.resolve(rest.return?.()).then(
      () => {
        if (!streamDone) {
          streamDone = true;
          if (signal.reason instanceof GatewayError) streamController?.error(signal.reason);
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

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller;
      controller.enqueue(frameOf(first));
      signal.addEventListener('abort', onAbort, { once: true });
      schedule();
    },
    pull: async (controller) => {
      if (ended) return;
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
