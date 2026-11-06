import { describe, expect, it } from 'vitest';
import type { RunStatus } from '@momonga/protocol';
import { makeEnv, typesOf } from './harness.ts';
import type { Env } from './harness.ts';
import { inertTimers, preparerFake } from './preparer-fake.ts';
import { callsStep, textStep } from './scripts.ts';

type Step = { step: 'cancelUpstream' | 'releaseStopped'; runId: string; statusAtCall: RunStatus | undefined };

const recordingSweeper = async (env: Env) => {
  const steps: Step[] = [];
  const { startTerminalSweeper } = await import('../../src/service/terminal-sweeper.ts');
  const sweeper = startTerminalSweeper({
    store: env.store,
    timers: inertTimers,
    intervalMs: 1000,
    cancelUpstream: async (runId: string) => void steps.push({ step: 'cancelUpstream', runId, statusAtCall: env.store.getRun(runId)?.status }),
    releaseStopped: async (runId: string) => void steps.push({ step: 'releaseStopped', runId, statusAtCall: env.store.getRun(runId)?.status }),
    onError: (error: unknown) => {
      throw error;
    },
  });
  return { sweeper, steps };
};

const envWithPreparer = async () => {
  const fake = preparerFake();
  const env = await makeEnv({ preparer: fake.preparer });
  fake.bind(env.store);
  return env;
};

describe('the sweeper finish of a cancelled run that never ran, with no worker involved', () => {
  it('a QUEUED run: the request leaves it CANCELLING; the sweep commits CANCELLED, then cancels upstream and releases it, without a model call or an execution', async () => {
    const env = await envWithPreparer();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');
    const { sweeper, steps } = await recordingSweeper(env);

    expect(env.cancel(run.id).status).toBe('CANCELLING');
    expect(steps).toEqual([]);

    await sweeper.sweep();

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    expect(steps).toEqual([
      { step: 'cancelUpstream', runId: run.id, statusAtCall: 'CANCELLED' },
      { step: 'releaseStopped', runId: run.id, statusAtCall: 'CANCELLED' },
    ]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(0);
    expect(typesOf(env.events(run.id))).not.toContain('model.requested');
    await sweeper.close();
  });

  it('a WAITING_HUMAN run with a pending approval and an awaiting call: the sweep commits CANCELLED and then releases it, with nothing executed', async () => {
    const env = await envWithPreparer();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
    const run = env.enqueue('Write the file');
    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const streamsBefore = env.gateway.streams.length;
    const { sweeper, steps } = await recordingSweeper(env);

    expect(env.cancel(run.id).status).toBe('CANCELLING');
    await sweeper.sweep();

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    expect(steps.filter((step) => step.step === 'releaseStopped')).toEqual([{ step: 'releaseStopped', runId: run.id, statusAtCall: 'CANCELLED' }]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(streamsBefore);
    await sweeper.close();
  });
});
