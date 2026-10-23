import { encodeSse } from '@momonga/foundation';
import { toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent, SessionEvent } from '@momonga/protocol';
import type { Unsubscribe } from './notifier.ts';
import type { ServiceTimers } from './timers.ts';

export const MAX_PAGE_EVENTS = 200;
export const MAX_PAGE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
export const STREAM_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };

const KEEP_ALIVE_FRAME = encoder.encode(': keep-alive\n\n');

type StoredEvent = RunEvent | SessionEvent;

export type EventSource = {
  read(cursor: number, limit: number): { events: readonly StoredEvent[]; endsAt: number | undefined };
  cursorOf(event: StoredEvent): number;
};

export type EventStreamOptions = {
  source: EventSource;
  cursor: number;
  watch: (wake: () => void) => Unsubscribe;
  timers: ServiceTimers;
  keepAliveMs: number;
  signals: readonly AbortSignal[];
  onError: (error: unknown) => void;
};

type Outcome = 'wake' | 'keepalive' | 'closed';

type Page = { frames: Uint8Array | undefined; complete: boolean };

export const eventStreamResponse = (options: EventStreamOptions): Response => {
  const { source, timers, keepAliveMs } = options;
  let cursor = options.cursor;
  let finished = false;
  let cancelled = false;
  let aborted = false;
  let wakeRequested = false;
  let keepAliveDue = false;
  let keepAliveHandle: unknown;
  let keepAliveArmed = false;
  let settleWait: ((outcome: Outcome) => void) | undefined;

  const unsubscribe = options.watch(() => {
    wakeRequested = true;
    settleWait?.('wake');
  });

  const onAbort = (): void => {
    aborted = true;
    settleWait?.('closed');
  };

  const disarmKeepAlive = (): void => {
    if (!keepAliveArmed) return;
    keepAliveArmed = false;
    timers.clearTimeout(keepAliveHandle);
  };

  const armKeepAlive = (): void => {
    if (keepAliveArmed) return;
    keepAliveArmed = true;
    keepAliveHandle = timers.setTimeout(() => {
      keepAliveArmed = false;
      keepAliveDue = true;
      settleWait?.('keepalive');
    }, keepAliveMs);
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    disarmKeepAlive();
    unsubscribe();
    for (const signal of options.signals) signal.removeEventListener('abort', onAbort);
    settleWait?.('closed');
  };

  for (const signal of options.signals) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const nextPage = (): Page => {
    const { events, endsAt } = source.read(cursor, MAX_PAGE_EVENTS);
    const frames: Uint8Array[] = [];
    let bytes = 0;
    for (const event of events) {
      const id = source.cursorOf(event);
      const frame = encoder.encode(encodeSse({ id: String(id), event: event.type, data: JSON.stringify(toPublicRunEvent(event)) }));
      if (frames.length > 0 && bytes + frame.byteLength > MAX_PAGE_BYTES) break;
      frames.push(frame);
      bytes += frame.byteLength;
      cursor = id;
    }
    const complete = endsAt !== undefined && cursor >= endsAt;
    if (frames.length === 0) return { frames: undefined, complete };
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const frame of frames) {
      joined.set(frame, offset);
      offset += frame.byteLength;
    }
    return { frames: joined, complete };
  };

  const waitForSignal = (): Promise<Outcome> =>
    new Promise<Outcome>((resolve) => {
      settleWait = (outcome) => {
        settleWait = undefined;
        resolve(outcome);
      };
    });

  const pullPage = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    for (;;) {
      if (cancelled) return;
      if (aborted) {
        finish();
        controller.close();
        return;
      }
      wakeRequested = false;
      const page = nextPage();
      if (page.frames !== undefined) {
        disarmKeepAlive();
        keepAliveDue = false;
        controller.enqueue(page.frames);
      }
      if (page.complete) {
        finish();
        controller.close();
        return;
      }
      if (page.frames !== undefined) return;
      if (wakeRequested) continue;
      if (keepAliveDue) {
        keepAliveDue = false;
        controller.enqueue(KEEP_ALIVE_FRAME);
        return;
      }
      armKeepAlive();
      await waitForSignal();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        await pullPage(controller);
      } catch (error) {
        finish();
        options.onError(error);
        controller.error(error);
      }
    },
    cancel: () => {
      cancelled = true;
      finish();
    },
  });

  return new Response(body, { status: 200, headers: STREAM_HEADERS });
};
