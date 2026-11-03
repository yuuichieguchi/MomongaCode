import { encodeSse } from '@momonga/foundation';
import { COMPACTION_RESULT_EVENT } from '@momonga/protocol';
import type { CompactResource, StreamEvent } from '@momonga/protocol';
import { frameOf } from '../core/frame.ts';
import { ClientDisconnectedError, GatewayError, readerStalledError } from '../core/errors.ts';
import type { GatewayTimers } from '../types.ts';

const encoder = new TextEncoder();
const KEEP_ALIVE_FRAME = encoder.encode(': keep-alive\n\n');

export type SseOptions = {
  timers: GatewayTimers;
  keepAliveMs: number;
  readerStallMs: number;
  signal: AbortSignal;
  onEnd: () => void;
  onError: (error: unknown) => void;
};

export const errorEventOf = (error: GatewayError): StreamEvent => {
  const retryAfterSeconds = Number(error.headers['retry-after']);
  return {
    type: 'error',
    sequence_number: 0,
    error: error.body,
    status: error.status,
    ...(Number.isFinite(retryAfterSeconds) ? { retry_after_ms: retryAfterSeconds * 1000 } : {}),
  };
};

export const gatewayErrorOf = (error: unknown, onError: (error: unknown) => void): GatewayError => {
  if (error instanceof GatewayError) return error;
  onError(error);
  return new GatewayError({
    status: 500,
    type: 'server_error',
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
};

export type CompactSseOptions = {
  timers: GatewayTimers;
  keepAliveMs: number;
  signal: AbortSignal;
  onEnd: () => void;
  onError: (error: unknown) => void;
};

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };

export const compactSseResponse = (work: Promise<CompactResource>, options: CompactSseOptions): Response => {
  const { timers, keepAliveMs, signal } = options;
  let timer: unknown;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stopTimer = (): void => {
    timers.clearTimeout(timer);
    timer = undefined;
  };
  const end = (): void => {
    if (finished) return;
    finished = true;
    stopTimer();
    options.onEnd();
  };
  const schedule = (): void => {
    timer = timers.setTimeout(() => {
      if (finished) return;
      if ((streamController?.desiredSize ?? 0) > 0) streamController?.enqueue(KEEP_ALIVE_FRAME);
      schedule();
    }, keepAliveMs);
  };
  const conclude = (frame: Uint8Array): void => {
    if (finished) return;
    streamController?.enqueue(frame);
    streamController?.close();
    end();
  };

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller;
      controller.enqueue(KEEP_ALIVE_FRAME);
      schedule();
      work.then(
        (resource) => conclude(encoder.encode(encodeSse({ event: COMPACTION_RESULT_EVENT, data: JSON.stringify(resource) }))),
        (error: unknown) => {
          if (finished) return;
          if (signal.aborted || error instanceof ClientDisconnectedError) {
            streamController?.error(error);
            end();
            return;
          }
          conclude(frameOf(errorEventOf(gatewayErrorOf(error, options.onError))));
        },
      );
    },
    cancel: () => {
      end();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
};

export const sseResponse = (first: StreamEvent | undefined, rest: AsyncIterator<StreamEvent>, options: SseOptions): Response => {
  const { timers, keepAliveMs, readerStallMs, signal } = options;
  let emitted = first !== undefined;
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
      controller.enqueue(first === undefined ? KEEP_ALIVE_FRAME : frameOf(first));
      signal.addEventListener('abort', onAbort, { once: true });
      schedule();
      if (first !== undefined) armStallTimer();
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
        emitted = true;
        armStallTimer();
      } catch (error) {
        if (!streamDone) {
          streamDone = true;
          if (!emitted && !signal.aborted && !(error instanceof ClientDisconnectedError)) {
            controller.enqueue(frameOf(errorEventOf(gatewayErrorOf(error, options.onError))));
            controller.close();
          } else {
            controller.error(error);
          }
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
  return new Response(body, { status: 200, headers: SSE_HEADERS });
};
