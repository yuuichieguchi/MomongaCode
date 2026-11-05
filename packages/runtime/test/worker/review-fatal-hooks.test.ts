import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import { waitUntil, within } from './deferred.ts';
import { makeEnv } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { RECONCILE_FAILURE_PREFIX, fatalStoreError, seedStartedCalls } from './cancel-fixture.ts';
import { gated, textStep } from './scripts.ts';
import { afterMicrotasks } from '@momonga/testkit';

const gatewayClosed = (): ScriptStep => ({ events: [], error: new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }) });

describe('worker onFatal containment', () => {
  it('a throwing onFatal hook is contained and never becomes an unhandled rejection', async () => {
    const env = await makeEnv();
    const fatal = fatalStoreError();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      let fatalCalls = 0;
      const errors: unknown[] = [];
      const worker = env.worker('worker-1', {
        idlePollMs: 1,
        store: {
          ...env.store,
          claim: () => {
            throw fatal;
          },
        },
        onError: (error) => errors.push(error),
        onFatal: () => {
          fatalCalls += 1;
          throw new Error('the fatal hook exploded');
        },
      });

      worker.start();
      await waitUntil(() => fatalCalls > 0, 10_000, 'onFatal');
      await afterMicrotasks();
      await within(worker.stop(), 10_000, 'the worker to stop');
      await afterMicrotasks();

      expect(fatalCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('worker onFatal containment when the poll loop dies', () => {
  it('a throwing onFatal hook for a dying poll loop never becomes an unhandled rejection', async () => {
    const env = await makeEnv();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      let fatalCalls = 0;
      const worker = env.worker('worker-1', {
        idlePollMs: 1,
        clock: {
          now: () => {
            throw new Error('the clock exploded');
          },
        },
        onFatal: () => {
          fatalCalls += 1;
          throw new Error('the fatal hook exploded');
        },
      });

      worker.start();
      await waitUntil(() => fatalCalls > 0, 10_000, 'onFatal');
      await afterMicrotasks();

      expect(fatalCalls).toBe(1);
      expect(unhandled).toEqual([]);
      await within(worker.stop(), 10_000, 'the worker to stop');
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('worker poll loop after stop', () => {
  it('does not sweep memories after stop() was called while pollOnce was in flight', async () => {
    const env = await makeEnv();
    env.gateway.script.push(gatewayClosed());
    const requeued = env.enqueue('Requeued');
    const worker = env.worker('worker-1', { random: () => 0.5, idlePollMs: 10 });
    await env.runOnce(worker);
    expect(env.run(requeued.id).status).toBe('QUEUED');
    expect(worker.memorySize()).toBe(1);
    expect((await env.cancelToEnd(requeued.id)).status).toBe('CANCELLED');

    const blocked = gated(textStep('Finished.'));
    env.gateway.script.push(blocked);
    env.enqueue('In flight');
    worker.start();
    await within(blocked.gate.reached.promise, 10_000, 'the in-flight claim to reach the model');

    const stopping = worker.stop();
    blocked.gate.release.resolve();
    await within(stopping, 10_000, 'the worker to stop');

    expect(worker.memorySize()).toBe(1);
  });
});

describe('cancel recovery error hook failure', () => {
  it('folds the onError hook failure into the single cancel-recovery notice', async () => {
    const env = await makeEnv();
    const { run } = seedStartedCalls(env, [{ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } }]);
    const worker = env.worker('worker-1', {
      onError: () => {
        throw new Error('hook broke');
      },
      tools: {
        recoveryToolSet: async () => {
          throw new Error('builtin tools failed to load');
        },
      },
    });

    await within(env.runOnce(worker), 10_000, 'the cancel recovery');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error').map((notice) => notice.message)).toEqual([
      `${RECONCILE_FAILURE_PREFIX}builtin tools failed to load (the error hook also failed: hook broke)`,
    ]);
  });
});


describe('worker start after a fatal error', () => {
  it('start() throws an error naming the fatal state once onFatal has fired', async () => {
    const env = await makeEnv();
    const fatal = fatalStoreError();
    let claims = 0;
    const fatals: Error[] = [];
    const worker = env.worker('worker-1', {
      idlePollMs: 1,
      store: {
        ...env.store,
        claim: () => {
          claims += 1;
          throw fatal;
        },
      },
      onFatal: (error) => fatals.push(error),
    });

    worker.start();
    await waitUntil(() => fatals.length > 0, 10_000, 'onFatal');
    await within(worker.stop(), 10_000, 'the worker to stop');
    const claimsBefore = claims;

    expect(() => worker.start()).toThrow(/fatal/i);
    await afterMicrotasks();
    expect(claims).toBe(claimsBefore);
    expect(fatals).toEqual([fatal]);
    await within(worker.stop(), 10_000, 'the worker to stop again');
  });
});
