import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { DEADLINE_MS, START_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const startJob = (store: RuntimeStore, sessionId: string, runId: string, id = 'bash_aaaaaaaaaaaa') =>
  store.jobs.start({ id, idemKey: `${id}-key`, sessionId, runId, callId: 'call-1', command: 'sleep 30' });

const setup = () => {
  const h = harness();
  const session = newSession(h.store);
  const run = enqueue(h.store, session.id);
  const claim = mustClaim(h.store, 'w1');
  return { h, session, run, claim };
};

describe('background jobs', () => {
  it('records a running job once per idempotency key', async () => {
    const { h, session, run } = setup();
    const first = startJob(h.store, session.id, run.id);
    expect(first.created).toBe(true);
    expect(first.job).toMatchObject({ id: 'bash_aaaaaaaaaaaa', sessionId: session.id, runId: run.id, status: 'running', readOffset: 0, startedAt: START_MS });
    const again = startJob(h.store, session.id, run.id);
    expect(again.created).toBe(false);
    expect(again.job).toEqual(first.job);
    h.store.jobs.attachProcess(first.job.id, 4242);
    expect(h.store.jobs.get(first.job.id)?.pgid).toBe(4242);
    expect(h.store.jobs.listRunning().map((job) => job.id)).toEqual([first.job.id]);
  });

  it('files a job started in a child session under the root session', async () => {
    const { h, session, run } = setup();
    const child = h.store.createChildRun({ parentRunId: run.id, parentCallId: 'c', input: 'x', pins: {}, model: 'fm' });
    if (child.kind !== 'created') throw new Error('expected a child');
    const { job } = startJob(h.store, child.session.id, child.run.id);
    expect(job.sessionId).toBe(session.id);
    expect(h.store.jobs.listForSession(child.session.id).map((entry) => entry.id)).toEqual([job.id]);
    expect(h.store.jobs.listForSession(session.id).map((entry) => entry.id)).toEqual([job.id]);
  });

  it('finishes a job once, records the output reference and tells the active run', async () => {
    const { h, session, run } = setup();
    const { job } = startJob(h.store, session.id, run.id);
    const finished = h.store.jobs.finish(job.id, { status: 'exited', exitCode: 3, output: { handle: 'h'.repeat(64), start: 0, total: 12 } });
    expect(finished).toMatchObject({ kind: 'finished', job: { status: 'exited', exitCode: 3, outputHandle: 'h'.repeat(64), outputTotal: 12, endedAt: START_MS } });
    const events = h.store.readRunEvents(run.id, 0, 50).filter((event) => event.type === 'job.finished');
    expect(events).toMatchObject([{ jobId: job.id, status: 'exited', exitCode: 3 }]);
    expect(h.store.jobs.finish(job.id, { status: 'killed' }).kind).toBe('already_finished');
    expect(h.store.readRunEvents(run.id, 0, 50).filter((event) => event.type === 'job.finished')).toHaveLength(1);
    expect(h.store.jobs.finish('missing', { status: 'killed' })).toEqual({ kind: 'not_found' });
  });

  it('records no event when no run is active', async () => {
    const { h, session, run, claim } = setup();
    const { job } = startJob(h.store, session.id, run.id);
    await h.store.transition(claim, ['RUNNING'], 'COMPLETED');
    const before = mustRun(h.store, run.id).lastSeq;
    h.store.jobs.finish(job.id, { status: 'killed', signal: 'SIGTERM' });
    expect(mustRun(h.store, run.id).lastSeq).toBe(before);
  });

  it('wakes a run parked on the job, including one in a child session', async () => {
    const { h, session, run, claim } = setup();
    const child = h.store.createChildRun({ parentRunId: run.id, parentCallId: 'c', input: 'x', pins: {}, model: 'fm' });
    if (child.kind !== 'created') throw new Error('expected a child');
    await h.store.release(claim, 'WAITING_TOOL', DEADLINE_MS);
    const childClaim = mustClaim(h.store, 'w2');
    const { job } = startJob(h.store, session.id, run.id);
    await h.store.release(childClaim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [], jobIds: [job.id] } });
    expect(mustRun(h.store, child.run.id).status).toBe('WAITING_TOOL');
    h.store.jobs.finish(job.id, { status: 'exited', exitCode: 0 });
    expect(mustRun(h.store, child.run.id).status).toBe('QUEUED');
    expect(mustRun(h.store, run.id).status).toBe('QUEUED');
  });

  it('queues a run that tries to park on a job that already finished', async () => {
    const { h, session, run, claim } = setup();
    const { job } = startJob(h.store, session.id, run.id);
    h.store.jobs.finish(job.id, { status: 'exited', exitCode: 0 });
    await h.store.release(claim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [], jobIds: [job.id] } });
    expect(mustRun(h.store, run.id).status).toBe('QUEUED');
  });

  it('only moves the read offset forward', async () => {
    const { h, session, run } = setup();
    const { job } = startJob(h.store, session.id, run.id);
    h.store.jobs.advanceRead(job.id, 40, 'call-a');
    h.store.jobs.advanceRead(job.id, 10, 'call-b');
    expect(h.store.jobs.get(job.id)?.readOffset).toBe(40);
  });
});
