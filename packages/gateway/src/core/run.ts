import type { StreamEvent } from '@momonga/protocol';
import { frameOf } from './frame.ts';
import { ClientDisconnectedError, readerStalledError } from './errors.ts';
import type { GatewayTimers } from '../types.ts';

export type RunControl = {
  readonly signal: AbortSignal;
  abort(reason: unknown): void;
  frames(): readonly StreamEvent[] | undefined;
};

export type RunSubscription = AsyncIterator<StreamEvent> & { readonly evicted: AbortSignal };

export const NEVER_EVICTED: AbortSignal = new AbortController().signal;

export type SharedRun = {
  subscribe(signal: AbortSignal): RunSubscription;
  abort(reason: unknown): void;
  joinable(): boolean;
  readonly settled: Promise<void>;
};

type Produce = (control: RunControl) => AsyncGenerator<StreamEvent>;

const DONE: IteratorResult<StreamEvent> = { done: true, value: undefined };

export const startDirectRun = (produce: Produce, onSettled: () => void): SharedRun => {
  const controller = new AbortController();
  const generator = produce({ signal: controller.signal, abort: (reason) => controller.abort(reason), frames: () => undefined });
  let finished = false;
  let subscribed = false;
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onSettled();
    resolveSettled();
  };

  return {
    settled,
    abort: (reason) => controller.abort(reason),
    joinable: () => false,
    subscribe: (signal) => {
      if (subscribed) throw new Error('a run without an idempotency key accepts exactly one subscriber');
      subscribed = true;
      let closed = false;
      const onAbort = (): void => {
        closed = true;
        controller.abort(new ClientDisconnectedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const endGenerator = async (): Promise<void> => {
        try {
          await generator.return(undefined);
        } finally {
          finish();
        }
      };
      return {
        evicted: NEVER_EVICTED,
        next: async () => {
          if (closed || finished) return DONE;
          let step: IteratorResult<StreamEvent>;
          try {
            step = await generator.next();
          } catch (error) {
            finish();
            throw error;
          }
          if (step.done === true) {
            finish();
            return step;
          }
          if (closed) {
            await endGenerator();
            return DONE;
          }
          return step;
        },
        return: async () => {
          closed = true;
          signal.removeEventListener('abort', onAbort);
          if (!finished) {
            controller.abort(new ClientDisconnectedError());
            await endGenerator();
          }
          return DONE;
        },
      };
    },
  };
};

type Slot = { event: StreamEvent; bytes: number };
type Cursor = { position: number; evict: () => void };

export type BufferedRunOptions = {
  maxBufferedBytes: number;
  readerStallMs: number;
  timers: GatewayTimers;
};

export const startBufferedRun = (produce: Produce, onSettled: () => void, options: BufferedRunOptions): SharedRun => {
  const { maxBufferedBytes, readerStallMs, timers } = options;
  const controller = new AbortController();
  const waiters = new Set<() => void>();
  const cursors = new Set<Cursor>();
  const slots: Slot[] = [];
  let base = 0;
  let heldBytes = 0;
  let retained = true;
  let failure: { error: unknown } | undefined;
  let finished = false;

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };
  const changed = (): Promise<void> => new Promise((resolve) => waiters.add(resolve));
  controller.signal.addEventListener('abort', wake, { once: true });

  const lowestPosition = (): number => Math.min(base + slots.length, ...[...cursors].map((cursor) => cursor.position));

  const trim = (): void => {
    if (retained) return;
    const lowest = lowestPosition();
    const drop = lowest - base;
    if (drop <= 0) return;
    for (const slot of slots.splice(0, drop)) heldBytes -= slot.bytes;
    base = lowest;
  };

  const evictStalled = (): void => {
    const lowest = lowestPosition();
    for (const cursor of [...cursors]) if (cursor.position === lowest) cursor.evict();
    if (cursors.size === 0 && !finished) controller.abort(new ClientDisconnectedError());
    trim();
    wake();
  };

  const blocked = (): boolean =>
    !retained && cursors.size > 0 && heldBytes >= maxBufferedBytes && !controller.signal.aborted;

  const control: RunControl = {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    frames: () => (retained ? slots.map((slot) => slot.event) : undefined),
  };

  const pump = async (): Promise<void> => {
    try {
      for await (const event of produce(control)) {
        const bytes = frameOf(event).byteLength;
        slots.push({ event, bytes });
        heldBytes += bytes;
        if (retained && heldBytes > maxBufferedBytes) retained = false;
        trim();
        wake();
        while (blocked()) {
          const stallTimer = timers.setTimeout(evictStalled, readerStallMs);
          await changed();
          timers.clearTimeout(stallTimer);
        }
      }
    } catch (error) {
      failure = { error };
    } finally {
      finished = true;
      onSettled();
      wake();
    }
  };

  return {
    settled: Promise.resolve().then(pump),
    abort: (reason) => controller.abort(reason),
    joinable: () => retained,
    subscribe: (signal) => {
      if (!retained) throw new Error('a run that outgrew its frame buffer cannot accept new subscribers');
      const evictedController = new AbortController();
      let closed = false;
      let evicted = false;
      const cursor: Cursor = {
        position: base,
        evict: () => {
          evicted = true;
          cursors.delete(cursor);
          evictedController.abort(readerStalledError());
        },
      };
      cursors.add(cursor);
      const close = (): void => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', onAbort);
        if (cursors.delete(cursor) && cursors.size === 0 && !finished) controller.abort(new ClientDisconnectedError());
        trim();
        wake();
      };
      const onAbort = (): void => close();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) close();
      return {
        evicted: evictedController.signal,
        next: async () => {
          for (;;) {
            if (evicted) {
              close();
              throw readerStalledError();
            }
            if (closed) return DONE;
            const slot = slots[cursor.position - base];
            if (slot !== undefined) {
              cursor.position += 1;
              trim();
              wake();
              return { done: false, value: slot.event };
            }
            if (failure !== undefined) {
              close();
              throw failure.error;
            }
            if (finished) {
              close();
              return DONE;
            }
            await changed();
          }
        },
        return: async () => {
          close();
          return DONE;
        },
      };
    },
  };
};
