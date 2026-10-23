import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, textResponseEvents, waitFor } from '@momonga/testkit';
import type { StreamEvent } from '@momonga/protocol';
import { startBufferedRun } from '../src/core/run.ts';
import type { RunControl } from '../src/core/run.ts';
import { sseResponse } from '../src/server/sse.ts';
import { gatewayClosedError } from '../src/core/errors.ts';
import { START_MS } from './gateway-helpers.ts';

const eventsOf = (chunks: number, text: string): StreamEvent[] =>
  textResponseEvents({ model: 'm', chunks: Array.from({ length: chunks }, () => text) });

const generatorOf = (events: readonly StreamEvent[], produced: { count: number }) =>
  async function* (control: RunControl): AsyncGenerator<StreamEvent> {
    for (const event of events) {
      if (control.signal.aborted) throw control.signal.reason;
      produced.count += 1;
      yield event;
    }
  };

const setup = () => {
  const timers = createFakeTimers(createFakeClock(START_MS));
  return { timers, never: new AbortController().signal };
};

describe('buffered run backpressure', () => {
  it('stops waiting on a stalled reader as soon as the run is aborted', async () => {
    const { timers, never } = setup();
    const produced = { count: 0 };
    const run = startBufferedRun(generatorOf(eventsOf(20, 'x'.repeat(600)), produced), () => undefined, {
      maxBufferedBytes: 1000,
      readerStallMs: 5000,
      timers,
    });
    run.subscribe(never);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 5000), { description: 'producer waiting on the reader' });
    const stalledAt = produced.count;
    run.abort(new Error('shutdown'));
    await run.settled;
    expect(produced.count).toBe(stalledAt);
    expect(timers.pending()).toEqual([]);
  });

  it('evicts a reader that holds the log at the cap past readerStallMs while other readers finish', async () => {
    const { timers, never } = setup();
    const events = eventsOf(20, 'x'.repeat(600));
    const run = startBufferedRun(generatorOf(events, { count: 0 }), () => undefined, {
      maxBufferedBytes: 1000,
      readerStallMs: 5000,
      timers,
    });
    const stalled = run.subscribe(never);
    const healthy = run.subscribe(never);
    const received: StreamEvent[] = [];
    const draining = (async () => {
      for (let step = await healthy.next(); step.done !== true; step = await healthy.next()) received.push(step.value);
    })();
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 5000), { description: 'stall timer' });
    timers.advance(5000);
    await draining;
    await run.settled;
    expect(received).toHaveLength(events.length);
    await expect(stalled.next()).rejects.toMatchObject({ body: { code: 'reader_stalled' } });
    expect(stalled.evicted.aborted).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('counts UTF-8 bytes of the encoded frame, not UTF-16 units, against the cap', async () => {
    const { timers, never } = setup();
    const events = eventsOf(1, 'あ'.repeat(1000));
    const run = startBufferedRun(generatorOf(events, { count: 0 }), () => undefined, {
      maxBufferedBytes: 2500,
      readerStallMs: 5000,
      timers,
    });
    const reader = run.subscribe(never);
    const frames: StreamEvent[] = [];
    for (let step = await reader.next(); step.done !== true; step = await reader.next()) frames.push(step.value);
    expect(frames.some((event) => event.type === 'response.output_text.delta')).toBe(true);
    expect(run.joinable()).toBe(false);
  });
});

describe('sseResponse on shutdown', () => {
  it('errors the stream with the gateway error instead of ending it cleanly', async () => {
    const { timers } = setup();
    const events = eventsOf(1, 'x');
    const closing = new AbortController();
    const rest: AsyncIterator<StreamEvent> = {
      next: () => new Promise(() => undefined),
      return: async () => ({ done: true, value: undefined }),
    };
    const response = sseResponse(events[0] as StreamEvent, rest, { timers, keepAliveMs: 1000, signal: closing.signal, onEnd: () => undefined });
    closing.abort(gatewayClosedError());
    await expect(response.text()).rejects.toMatchObject({ body: { code: 'gateway_closed' } });
  });
});
