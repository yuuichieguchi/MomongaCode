import { describe, expect, it } from 'vitest';
import { JournalThreadError } from '@momonga/store';
import { afterMicrotasks, createFakeTimers, waitFor } from '@momonga/testkit';
import { LEASE_MS, makeEnv, typesOf } from './harness.ts';
import { MEASURED_ITEM, preparerFake } from './preparer-fake.ts';
import { textStep } from './scripts.ts';

const envWithPreparer = async () => {
  const fake = preparerFake();
  const env = await makeEnv({ preparer: fake.preparer });
  fake.bind(env.store);
  return { env, fake };
};

describe('a worker terminal awaits the contribution port', () => {
  it('a completed run carries the measurement of the port immediately before its terminal status, measured for that run only', async () => {
    const { env, fake } = await envWithPreparer();
    env.gateway.script.push(textStep('the final answer'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(typesOf(env.events(run.id)).slice(-2)).toEqual(['context.contribution', 'run.status']);
    expect(env.ofType(run.id, 'context.contribution').map((event) => event.items)).toEqual([[MEASURED_ITEM]]);
    expect(fake.requests.map((request) => request.runId)).toEqual([run.id]);
  });

  it('P6: while the terminal awaits the preparer the heartbeat keeps the lease, so no other claim takes the run', async () => {
    const { env, fake } = await envWithPreparer();
    env.gateway.script.push(textStep('the final answer'));
    const run = env.enqueue('Work');
    const timers = createFakeTimers(env.clock);
    const open = fake.hold();

    const running = env.runOnce(env.worker('worker-1', { timers }));
    await waitFor(() => fake.requests.length === 1, { description: 'the terminal to await the preparer' });
    for (let elapsed = 0; elapsed < 3 * LEASE_MS; elapsed += LEASE_MS / 10) {
      timers.advance(LEASE_MS / 10);
      await afterMicrotasks();
    }

    const held = env.run(run.id);
    expect(held).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-1' });
    expect(held.leaseExpiresAt ?? 0).toBeGreaterThan(env.clock.now());
    expect(env.store.claim('worker-2')).toBeNull();

    open();
    expect(await running).toBe('yielded');
    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
  });

  it('a thread failure at the end of a run requeues it with one notice, writes no terminal, and the next claim finishes it without a second model call', async () => {
    const { env, fake } = await envWithPreparer();
    env.gateway.script.push(textStep('the final answer'));
    env.gateway.script.push(textStep('a second, paid answer'));
    fake.failures.push(new JournalThreadError('the journal thread exited'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    const requeued = env.run(run.id);
    expect(requeued).toMatchObject({ status: 'QUEUED', attempts: 1, leaseOwner: null });
    expect(typesOf(env.events(run.id))).not.toContain('context.contribution');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'attempt_retried')).toHaveLength(1);

    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.ofType(run.id, 'context.contribution')).toHaveLength(1);
    expect(fake.requests.map((request) => request.runId)).toEqual([run.id, run.id]);
  });
});
