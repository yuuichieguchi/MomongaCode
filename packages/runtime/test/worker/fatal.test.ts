import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { fatalStoreError } from './cancel-fixture.ts';
import { gated, textStep } from './scripts.ts';

type Counting = RuntimeStore & { calls: Record<string, number> };

const countingStore = (env: Env, overrides: Partial<RuntimeStore>): Counting => {
  const calls: Record<string, number> = {};
  const count = <T extends keyof RuntimeStore>(name: T, fallback: RuntimeStore[T]): RuntimeStore[T] => {
    const target = (overrides[name] ?? fallback) as unknown as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return target(...args);
    }) as unknown as RuntimeStore[T];
  };
  return {
    ...env.store,
    calls,
    claim: count('claim', env.store.claim),
    getRun: count('getRun', env.store.getRun),
    append: count('append', env.store.append),
    transition: count('transition', env.store.transition),
    release: count('release', env.store.release),
    releaseLease: count('releaseLease', env.store.releaseLease),
    heartbeat: count('heartbeat', env.store.heartbeat),
  };
};

describe('worker fatal store errors', () => {
  it('a fatal store error from claim stops the loop and calls onFatal once', async () => {
    const env = await makeEnv();
    const fatal = fatalStoreError();
    const fatals: Error[] = [];
    const errors: unknown[] = [];
    const store = countingStore(env, {
      claim: () => {
        throw fatal;
      },
      getRun: () => {
        throw fatalStoreError('getRun must not be reached after a fatal error');
      },
    });
    const worker = env.worker('worker-1', { store, idlePollMs: 1, onFatal: (error) => fatals.push(error), onError: (error) => errors.push(error) });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([fatal]);
    expect(fatals[0]).toBe(fatal);
    expect(store.calls['claim']).toBe(1);
    expect(store.calls['getRun'] ?? 0).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a fatal store error inside a claim is rethrown before any recovery write', async () => {
    const env = await makeEnv();
    const fatal = fatalStoreError();
    const fatals: Error[] = [];
    let failed = false;
    const run = await env.enqueue('Work');
    env.gateway.script.push(textStep('never sent'));
    const store = countingStore(env, {
      append: (claim, payloads) => {
        if (payloads.some((payload) => payload.type === 'run.started')) {
          failed = true;
          throw fatal;
        }
        return env.store.append(claim, payloads);
      },
      getRun: (id) => {
        if (failed) throw fatalStoreError('a second fatal error from getRun');
        return env.store.getRun(id);
      },
    });
    const worker = env.worker('worker-1', { store, idlePollMs: 1, onFatal: (error) => fatals.push(error) });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toBe(fatal);
    expect(store.calls['append']).toBe(1);
    expect(store.calls['transition'] ?? 0).toBe(0);
    expect(store.calls['release'] ?? 0).toBe(0);
    expect(store.calls['releaseLease'] ?? 0).toBe(0);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(env.run(run.id).status).toBe('RUNNING');
  });

  it('a fatal heartbeat error reaches onFatal', async () => {
    const env = await makeEnv();
    const fatal = fatalStoreError();
    const fatals: Error[] = [];
    const blocked = gated(textStep('never finished'));
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const store = countingStore(env, {
      heartbeat: () => {
        throw fatal;
      },
    });
    const worker = env.worker('worker-1', { store, heartbeatMs: 5, idlePollMs: 1, onFatal: (error) => fatals.push(error) });

    worker.start();
    try {
      await env.passTime(() => fatals.length > 0, 'onFatal');
    } finally {
      blocked.gate.release.resolve();
    }
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toBe(fatal);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(store.calls['release'] ?? 0).toBe(0);
    expect(store.calls['transition'] ?? 0).toBe(0);
  });

  it('a dying poll loop calls onFatal', async () => {
    const env = await makeEnv();
    const failure = new Error('the clock exploded');
    const fatals: Error[] = [];
    const worker = env.worker('worker-1', {
      idlePollMs: 1,
      clock: {
        now: () => {
          throw failure;
        },
      },
      onFatal: (error) => fatals.push(error),
    });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([failure]);
  });

  it('a notice of a failed run that the store cannot write reaches onFatal instead of being dropped', async () => {
    const env = await makeEnv();
    const fatals: Error[] = [];
    const loadFailure = new Error('load exploded');
    const writeFailure = new Error('the notice could not be written');
    const run = await env.enqueue('Fails to load');
    const store: RuntimeStore = {
      ...env.store,
      load: () => {
        throw loadFailure;
      },
      append: (claim, payloads) => {
        if (payloads.some((payload) => payload.type === 'notice')) throw writeFailure;
        return env.store.append(claim, payloads);
      },
    };
    const worker = env.worker('worker-1', { store, idlePollMs: 1, onFatal: (error) => fatals.push(error), onError: () => undefined });

    worker.start();
    await env.passTime(() => fatals.length > 0, 'onFatal');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([writeFailure]);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
  });

  it('a non-fatal claim error keeps the loop alive', async () => {
    const env = await makeEnv();
    const fatals: Error[] = [];
    const errors: unknown[] = [];
    let thrown = false;
    const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
    const store = countingStore(env, {
      claim: (workerId) => {
        if (!thrown) {
          thrown = true;
          throw failure;
        }
        return env.store.claim(workerId);
      },
    });
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Work');
    const worker = env.worker('worker-1', { store, idlePollMs: 1, onFatal: (error) => fatals.push(error), onError: (error) => errors.push(error) });

    worker.start();
    await env.passTime(() => env.run(run.id).status === 'COMPLETED', 'the run to complete after the transient error');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(fatals).toEqual([]);
    expect(errors).toEqual([failure]);
  });
});
