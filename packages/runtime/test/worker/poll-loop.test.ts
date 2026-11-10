import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { waitUntil, within } from './deferred.ts';
import { DEADLINE_MS, makeEnv, createdRun } from './harness.ts';
import { MODEL_ID, textStep } from './scripts.ts';

describe('worker poll loop', () => {
  it('reports a claim error through onError and keeps claiming the next run without an unhandled rejection', async () => {
    const env = await makeEnv();
    const failing = env.enqueue('Fails to load');
    const otherSession = env.store.createSession({ cwd: env.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, permissionMode: 'manual', model: MODEL_ID });
    const healthy = createdRun(env.store.createRunAndEnqueue(otherSession.id, { input: 'Say hello', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {} }));
    env.gateway.script.push(textStep('Hello.'));
    const failure = new Error('load exploded');
    let thrown = false;
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id && !thrown) {
          thrown = true;
          throw failure;
        }
        return env.store.load(runId);
      },
    };
    const reported: { error: unknown; context: unknown }[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const worker = env.worker('worker-1', {
        store,
        idlePollMs: 10,
        onError: (error, context) => {
          reported.push({ error, context });
        },
      });
      worker.start();
      await waitUntil(() => env.run(healthy.id).status === 'COMPLETED', 3_000, 'the healthy run to complete');
      await within(worker.stop(), 1_000, 'the worker to stop');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(reported).toEqual([{ error: failure, context: expect.objectContaining({ runId: failing.id, workerId: 'worker-1' }) }]);
    expect(unhandled).toEqual([]);
  });
});
