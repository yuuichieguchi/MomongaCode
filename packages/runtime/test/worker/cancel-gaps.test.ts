import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { deferred } from './deferred.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

const responded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

describe('worker cancel before the model request', () => {
  it('passes the abort signal to countTokens and makes no model request after a cancel during counting', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const gate = deferred<void>();
    const reached = deferred<void>();
    env.gateway.countHook = async () => {
      reached.resolve();
      await gate.promise;
    };
    const run = env.enqueue('Count first');
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 10 }));
    try {
      await env.settled(reached.promise, 'countTokens to be called');
      await env.store.requestCancel(run.id);
      const [first] = env.gateway.countCalls;
      expect(first?.signal).toBeInstanceOf(AbortSignal);
      await env.passTime(() => first?.signal?.aborted === true, 'the countTokens signal to abort');
    } finally {
      gate.resolve();
    }
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });

  it('makes no model request when the cancel arrives while compacting', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    await env.seed(
      run.id,
      [
        responded(1, [assistantMessage('msg_big', 'x'.repeat(100_000))]),
        { type: 'user.message', text: 'question two' },
        responded(2, [assistantMessage('msg_r2', 'answer two')]),
        { type: 'user.message', text: 'question three' },
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('never sent'));
    const gate = deferred<void>();
    const reached = deferred<void>();
    env.gateway.compactHook = async () => {
      reached.resolve();
      await gate.promise;
    };
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 10 }));
    try {
      await env.settled(reached.promise, 'compaction to start');
      await env.store.requestCancel(run.id);
      await env.passTime(() => env.gateway.compacts[0]?.signal.aborted === true, 'the compaction signal to abort');
    } finally {
      gate.resolve();
    }
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('worker cancel with a non-cancel error', () => {
  it('records the real error as an error notice before CANCELLED', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } }]));
    const reached = deferred<void>();
    const run = env.enqueue('Echo');
    const running = env.runOnce(
      env.worker('worker-1', {
        cancelPollMs: 10,
        tools: {
          executor: {
            runBatch: async ({ signal }) => {
              reached.resolve();
              await untilAborted(signal);
              throw new Error('executor exploded');
            },
            release: (targets, options) => env.executor.release(targets, options),
            abandon: () => Promise.reject(new Error('abandon is not used by this test')),
          },
        },
      }),
    );
    await env.settled(reached.promise, 'the batch to start');
    await env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    const notices = env.ofType(run.id, 'notice').filter((notice) => notice.level === 'error' && notice.message.includes('executor exploded'));
    expect(notices).toHaveLength(1);
    const cancelled = env.ofType(run.id, 'run.status').find((event) => event.to === 'CANCELLED');
    expect(notices[0]?.seq).toBeLessThan(cancelled?.seq ?? 0);
  });
});
