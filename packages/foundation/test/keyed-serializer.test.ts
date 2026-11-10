import { describe, expect, it } from 'vitest';
import { createKeyedSerializer } from '@momonga/foundation';
import { deferred, settlementOf, turn } from './support/secret-store-fakes.ts';

const NEVER_ABORTED = new AbortController().signal;

describe('the keyed serializer under the signal of each requester', () => {
  it('a queued requester leaves at its own signal without starting its task', async () => {
    const serialized = createKeyedSerializer();
    const held = deferred<void>();
    const events: string[] = [];
    const predecessor = serialized(
      'k',
      async () => {
        events.push('predecessor:start');
        await held.promise;
        events.push('predecessor:end');
      },
      NEVER_ABORTED,
    );
    const controller = new AbortController();
    const waiter = serialized(
      'k',
      async () => {
        events.push('waiter:start');
      },
      controller.signal,
    );
    const settlement = settlementOf(waiter);
    await turn();
    expect(settlement.current()).toBe('pending');
    const reason = new Error('the requester left');
    controller.abort(reason);
    await turn();
    expect(settlement.current()).toEqual({ rejected: reason });
    held.resolve();
    await predecessor;
    await turn();
    expect(events).toEqual(['predecessor:start', 'predecessor:end']);
  });

  it('a requester whose signal is already aborted never starts its task', async () => {
    const serialized = createKeyedSerializer();
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    let started = false;
    const settlement = settlementOf(
      serialized(
        'k',
        async () => {
          started = true;
        },
        controller.signal,
      ),
    );
    await turn();
    expect(settlement.current()).toEqual({ rejected: reason });
    expect(started).toBe(false);
  });

  it('the next requester still waits for the predecessor after an earlier one left', async () => {
    const serialized = createKeyedSerializer();
    const held = deferred<void>();
    const events: string[] = [];
    const predecessor = serialized(
      'k',
      async () => {
        events.push('predecessor:start');
        await held.promise;
        events.push('predecessor:end');
      },
      NEVER_ABORTED,
    );
    const controller = new AbortController();
    const leaver = serialized(
      'k',
      async () => {
        events.push('leaver:start');
      },
      controller.signal,
    );
    leaver.catch(() => undefined);
    const next = serialized(
      'k',
      async () => {
        events.push('next:start');
        return 'done';
      },
      NEVER_ABORTED,
    );
    controller.abort(new Error('the requester left'));
    await turn();
    await turn();
    expect(events).toEqual(['predecessor:start']);
    held.resolve();
    expect(await next).toBe('done');
    await predecessor;
    expect(events).toEqual(['predecessor:start', 'predecessor:end', 'next:start']);
  });

  it('another key does not wait', async () => {
    const serialized = createKeyedSerializer();
    const held = deferred<void>();
    const blocking = serialized('a', () => held.promise, NEVER_ABORTED);
    expect(await serialized('b', async () => 'free', NEVER_ABORTED)).toBe('free');
    held.resolve();
    await blocking;
  });
});
