import { describe, expect, it } from 'vitest';

import { LEASE_MS, makeEnv } from './harness.ts';
import { gated, textStep } from './scripts.ts';

describe('worker lease loss', () => {
  it('stops writing once another worker steals the expired lease', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('late answer', { chunks: ['late ', 'answer'] }), 4);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const running = env.runOnce(env.worker('worker-a'));
    await env.settled(blocked.gate.reached.promise, 'the stream to start');
    const [started] = env.ofType(run.id, 'run.started');
    if (started === undefined) throw new Error('expected run.started');

    env.clock.advance(LEASE_MS + 1);
    const thief = env.store.claim('worker-thief');
    expect(thief?.runId).toBe(run.id);
    const stolenAtSeq = env.run(run.id).lastSeq;
    blocked.gate.release.resolve();
    await env.settled(running, 'the first worker to stop after losing its lease');

    const lateWrites = env.events(run.id).filter((event) => event.leaseToken === started.leaseToken && event.seq > stolenAtSeq);
    expect(lateWrites).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-thief' });
    expect(env.run(run.id).lastSeq).toBe(stolenAtSeq);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('notices the lost lease through its heartbeat and aborts the stream without transitioning', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('never delivered'), 4);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const running = env.runOnce(env.worker('worker-a', { heartbeatMs: 10 }));
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('worker-thief')?.runId).toBe(run.id);
    const stolenAtSeq = env.run(run.id).lastSeq;
    await env.settled(running, 'the heartbeat to detect the lost lease');

    expect(env.gateway.streams[0]?.signal.aborted).toBe(true);
    expect(env.run(run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'worker-thief', lastSeq: stolenAtSeq });
  });
});
