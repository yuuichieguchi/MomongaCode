import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { LEASE_MS, makeEnv, typesOf } from './harness.ts';
import { failedStep, textStep } from './scripts.ts';

const failingOnce = (target: RuntimeStore, status: 'COMPLETED' | 'FAILED'): { store: RuntimeStore; failures: () => number } => {
  let failures = 0;
  const store: RuntimeStore = {
    ...target,
    transition: (claim, from, to, patch, preceding) => {
      if (to === status && failures === 0) {
        failures += 1;
        throw new Error('the journal thread failed');
      }
      return target.transition(claim, from, to, patch, preceding);
    },
  };
  return { store, failures: () => failures };
};

describe('a run whose terminal transition failed', () => {
  it('after its final response was journaled is claimed again and finishes without a second model call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('the final answer'));
    env.gateway.script.push(textStep('a second, paid answer'));
    const run = env.enqueue('Work');
    const { store, failures } = failingOnce(env.store, 'COMPLETED');

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');
    expect(failures()).toBe(1);
    const requeued = env.run(run.id);
    expect(requeued.status).toBe('QUEUED');
    expect(requeued.attempts).toBe(1);
    expect(requeued.leaseOwner).toBeNull();

    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(env.worker('worker-2', { store }))).toBe('yielded');

    const types = typesOf(env.events(run.id));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(1);
    expect(types.filter((type) => type === 'model.requested')).toHaveLength(1);
    expect(types.filter((type) => type === 'model.responded')).toHaveLength(1);
    expect(env.run(run.id).attempts).toBe(2);
    expect(env.run(run.id).failedAttempts).toBe(0);
  });

  it('inside the error path of the worker escapes, keeps the lease until it expires, is not claimed again, and is dead-lettered by the sweep', async () => {
    const env = await makeEnv({ maxAttempts: 1, maxTotalAttempts: 1 });
    env.gateway.script.push(failedStep('upstream_unavailable'), textStep('never sent'));
    const run = env.enqueue('Work');
    const { store, failures } = failingOnce(env.store, 'FAILED');

    const first = env.worker('worker-1', { store }).runOnce();
    await first.then(
      () => undefined,
      () => undefined,
    );
    expect(failures()).toBe(1);
    const stranded = env.run(run.id);
    expect(stranded.status).toBe('RUNNING');
    expect(stranded.leaseOwner).toBe('worker-1');
    expect(stranded.attempts).toBe(1);

    env.clock.advance(LEASE_MS + 1);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.run(run.id)).toMatchObject({ status: 'RUNNING', deadLetter: false });

    const reported: unknown[] = [];
    expect(await env.store.deadLetterExhausted((error) => void reported.push(error))).toEqual([run.id]);

    expect(reported).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(env.run(run.id).error?.code).toBe('max_total_attempts');
    expect(env.gateway.streams).toHaveLength(1);
  });
});
