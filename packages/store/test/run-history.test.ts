import { describe, expect, it } from 'vitest';
import { harness, mustRun, newSession, TIMEOUT_MS } from './helpers.ts';
import type { RuntimeStore } from '@momonga/store';

const create = (store: RuntimeStore, sessionId: string, input: string, history?: 'inherit' | 'fresh') => {
  const result = store.createRunAndEnqueue(sessionId, {
    input,
    timeoutMs: TIMEOUT_MS,
    limits: {},
    pins: {},
    ...(history === undefined ? {} : { history }),
  });
  if (result.kind !== 'created') throw new Error(`expected a created run, got ${result.kind}`);
  return result.run;
};

describe('run history and previous run', () => {
  it('gives the first run of a session no previous run and the inherit default', () => {
    const { store } = harness();
    const run = create(store, newSession(store).id, 'first');
    expect(run.previousRunId).toBeNull();
    expect(run.history).toBe('inherit');
    expect(mustRun(store, run.id)).toMatchObject({ previousRunId: null, history: 'inherit' });
  });

  it('points every later run at the latest run of the session', () => {
    const { store } = harness();
    const session = newSession(store);
    const first = create(store, session.id, 'first');
    const second = create(store, session.id, 'second');
    const third = create(store, session.id, 'third', 'fresh');
    expect(second).toMatchObject({ previousRunId: first.id, history: 'inherit' });
    expect(third).toMatchObject({ previousRunId: second.id, history: 'fresh' });
    expect(mustRun(store, third.id)).toMatchObject({ previousRunId: second.id, history: 'fresh' });
    expect(store.listRuns(session.id).map((run) => [run.ordinal, run.previousRunId, run.history])).toEqual([
      [1, null, 'inherit'],
      [2, first.id, 'inherit'],
      [3, second.id, 'fresh'],
    ]);
  });

  it('stores an explicit inherit as inherit', () => {
    const { store } = harness();
    const session = newSession(store);
    create(store, session.id, 'first');
    expect(create(store, session.id, 'second', 'inherit').history).toBe('inherit');
  });

  it('keeps previous runs per session', () => {
    const { store } = harness();
    const a = newSession(store, '/work/a');
    const b = newSession(store, '/work/b');
    create(store, a.id, 'a1');
    const b1 = create(store, b.id, 'b1');
    expect(b1.previousRunId).toBeNull();
  });
});
