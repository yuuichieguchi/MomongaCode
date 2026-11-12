import { describe, expect, it } from 'vitest';
import { benchRunApi } from '../src/commands/bench.ts';
import { goldenRunApi } from '../src/client/golden-run-api.ts';
import type { EventFollow } from '../src/client/golden-run-api.ts';

const event = (id: number) => ({ id, event: undefined, data: { type: 'agent.message.delta', id } });

const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

const droppingClient = (opened: (number | undefined)[]) => ({
  streamEvents: async function* (_runId: string, options: { lastEventId?: number } = {}) {
    opened.push(options.lastEventId);
    if (options.lastEventId === undefined) {
      yield event(1);
      throw reset();
    }
    yield event(2);
  },
  getRun: async () => ({ id: 'run-1', status: 'COMPLETED' }),
});

const follow = (slept: number[]): EventFollow => ({
  clock: { now: () => 0, sleep: async (ms: number) => void slept.push(ms) },
  random: () => 0,
  reconnectBoundMs: 60_000,
  restoreConnection: async () => undefined,
});

const settle = { pendingBoundMs: 1, attemptBoundMs: 1, pollMs: 1, now: () => 0, wait: async () => undefined };

const collect = async (events: AsyncIterable<unknown>): Promise<unknown[]> => {
  const seen: unknown[] = [];
  for await (const data of events) seen.push(data);
  return seen;
};

describe('a trial follows its run through the one follower, which reconnects after a lost stream', () => {
  it('eval run: a stream reset mid-run reconnects after a backoff and the run completes with every event once', async () => {
    const opened: (number | undefined)[] = [];
    const slept: number[] = [];
    const api = goldenRunApi(droppingClient(opened) as never, undefined, settle, follow(slept));
    expect(await collect(api.events('run-1'))).toEqual([event(1).data, event(2).data]);
    expect(opened).toEqual([undefined, 1]);
    expect(slept).toHaveLength(1);
  });

  it('eval bench: a stream reset mid-trial reconnects after a backoff and the trial completes with every event once', async () => {
    const opened: (number | undefined)[] = [];
    const slept: number[] = [];
    const api = benchRunApi(droppingClient(opened) as never, {}, follow(slept));
    expect(await collect(api.events('run-1'))).toEqual([event(1).data, event(2).data]);
    expect(opened).toEqual([undefined, 1]);
    expect(slept).toHaveLength(1);
  });
});
