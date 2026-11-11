import { describe, expect, it } from 'vitest';
import { heartbeatMsFor } from '../../src/worker/heartbeat.ts';
import { LEASE_MS, START_MS, makeEnv } from './harness.ts';
import { gated, textStep } from './scripts.ts';

describe('the worker harness has one time source: the clock and the timers of the worker are the same fake', () => {
  it('fires the lease heartbeat at a third of the lease when the fake clock reaches it, and not before', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('late answer'), 0);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Work');
    let heartbeats = 0;
    const store = {
      ...env.store,
      heartbeat: (...args: Parameters<typeof env.store.heartbeat>) => {
        heartbeats += 1;
        return env.store.heartbeat(...args);
      },
    };
    const running = env.runOnce(env.worker('worker-a', { store }));
    await blocked.gate.reached.promise;

    expect(env.timers.pending().map((timer) => timer.delayMs)).toContain(heartbeatMsFor(LEASE_MS));
    await env.timers.advanceAsync(heartbeatMsFor(LEASE_MS) - 1);
    expect(heartbeats).toBe(0);
    await env.timers.advanceAsync(1);
    expect(heartbeats).toBe(1);
    expect(env.clock.now()).toBe(START_MS + heartbeatMsFor(LEASE_MS));

    blocked.gate.release.resolve();
    await running;
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('notices a lost lease at the next heartbeat on the fake clock', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('late answer'), 0);
    env.gateway.script.push(blocked);
    const run = env.enqueue('Work');
    const running = env.runOnce(env.worker('worker-a'));
    await blocked.gate.reached.promise;

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    expect(env.gateway.streams[0]?.signal.aborted).toBe(false);
    await env.timers.advanceAsync(0);

    expect(env.gateway.streams[0]?.signal.reason).toBe('lease_lost');
    blocked.gate.release.resolve();
    await running;
  });
});
