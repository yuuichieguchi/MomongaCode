import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const setup = () => {
  const h = harness();
  const session = newSession(h.store);
  const run = enqueue(h.store, session.id);
  mustClaim(h.store, 'w1');
  return { h, session, run };
};

describe('the generation columns of a background job (17.3, 20.38)', () => {
  it('records the owner generation and the absolute output path at start', () => {
    const { h, session, run } = setup();
    const { job } = h.store.jobs.start({ id: 'bash_a', idemKey: 'k', sessionId: session.id, runId: run.id, callId: 'c', command: 'sleep 1', ownerGeneration: 2, outputPath: '/home/u/.momonga/run/g2/jobs/bash_a.out' });
    expect(job).toMatchObject({ ownerGeneration: 2, outputPath: '/home/u/.momonga/run/g2/jobs/bash_a.out' });
    expect(job).not.toHaveProperty('killRequestedAt');
  });

  it('sets kill_requested_at once, only while the job is running', () => {
    const { h, session, run } = setup();
    const { job } = h.store.jobs.start({ id: 'bash_a', idemKey: 'k', sessionId: session.id, runId: run.id, callId: 'c', command: 'sleep 1', ownerGeneration: 1 });
    expect(h.store.jobs.requestKill(job.id)).toBe(true);
    expect(h.store.jobs.get(job.id)?.killRequestedAt).toBe(START_MS);
    h.clock.advance(50);
    expect(h.store.jobs.requestKill(job.id)).toBe(false);
    expect(h.store.jobs.get(job.id)?.killRequestedAt).toBe(START_MS);
    const other = h.store.jobs.start({ id: 'bash_b', idemKey: 'k2', sessionId: session.id, runId: run.id, callId: 'c2', command: 'true', ownerGeneration: 1 }).job;
    h.store.jobs.finish(other.id, { status: 'exited', exitCode: 0 });
    expect(h.store.jobs.requestKill(other.id)).toBe(false);
    expect(rawDb(h.dbPath).prepare('SELECT kill_requested_at FROM jobs WHERE id = ?').get(other.id)).toEqual({ kill_requested_at: null });
  });

  it('clears the output path on request', () => {
    const { h, session, run } = setup();
    const { job } = h.store.jobs.start({ id: 'bash_a', idemKey: 'k', sessionId: session.id, runId: run.id, callId: 'c', command: 'sleep 1', ownerGeneration: 1, outputPath: '/x/bash_a.out' });
    h.store.jobs.clearOutputPath(job.id);
    expect(h.store.jobs.get(job.id)).not.toHaveProperty('outputPath');
  });
});
