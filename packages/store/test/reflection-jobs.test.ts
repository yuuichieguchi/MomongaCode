import { describe, expect, it } from 'vitest';
import type { RunCharge, RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, cancelToEnd, enqueue, harness, makeStoreDir, mustClaim, newSession, rawDb } from './helpers.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

type Job = { runId: string; state: string; attempts: number; lastError: string | null; dropped: { ordinal: number; text: string | null; cause: string; reason: string }[]; createdAt: number; updatedAt: number };

type Jobs = {
  runOrigin(runId: string): string | undefined;
  enqueue(runId: string): boolean;
  get(runId: string): Job | undefined;
  latestForProject(project: string): Job | undefined;
  next(exclude?: ReadonlySet<string>): Job | undefined;
  begin(runId: string): Job;
  finish(runId: string, reason?: string): Job;
  fail(runId: string, reason: string): Job;
};

const jobsOf = (store: RuntimeStore): Jobs => {
  const found = (store as unknown as { reflection?: Jobs }).reflection;
  if (found === undefined) throw new Error('the store has no reflection job API');
  return found;
};

const setup = async () => {
  const { store, clock, dbPath } = harness();
  const session = newSession(store);
  const first = await enqueue(store, session.id, 'one');
  return { store, clock, dbPath, session, first, jobs: jobsOf(store) };
};

describe('reflection jobs', () => {
  it('creates one pending job per run', async () => {
    const { jobs, first } = await setup();
    expect(jobs.enqueue(first.id)).toBe(true);
    expect(jobs.enqueue(first.id)).toBe(false);
    expect(jobs.get(first.id)).toEqual({ runId: first.id, state: 'pending', attempts: 0, lastError: null, dropped: [], createdAt: START_MS, updatedAt: START_MS });
  });

  it('counts the open jobs created before a job, pending or running and not finished, as the jobs ahead of it', async () => {
    const { store, clock, session, first, jobs } = await setup();
    const second = await enqueue(store, session.id, 'two');
    const third = await enqueue(store, session.id, 'three');
    const aheadOf = (runId: string): number => (jobs as unknown as { aheadOf(runId: string): number }).aheadOf(runId);
    jobs.enqueue(first.id);
    clock.advance(10);
    jobs.enqueue(second.id);
    jobs.enqueue(third.id);

    expect([first.id, second.id, third.id].map(aheadOf)).toEqual([0, 1, 2]);

    jobs.begin(first.id);
    expect(aheadOf(third.id)).toBe(2);
    jobs.finish(first.id, 'a fixture run that is not under test');
    expect([second.id, third.id].map(aheadOf)).toEqual([0, 1]);
  });

  it('is written in the terminal transition of a completed root run, in the same step as the status', async () => {
    const { store, jobs, first } = await setup();
    const claim = mustClaim(store, 'w1');
    expect(jobs.get(first.id)).toBeUndefined();
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED', {})).kind).toBe('ok');
    expect(jobs.get(first.id)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it.each(['FAILED', 'STOPPED'] as const)('is not written for a run that ended %s', async (outcome) => {
    const { store, jobs, first } = await setup();
    const claim = mustClaim(store, 'w1');
    expect((await store.transition(claim, ['RUNNING'], outcome, outcome === 'FAILED' ? { error: { code: 'x', message: 'x' } } : { stopReason: 'budget' })).kind).toBe('ok');
    expect(jobs.get(first.id)).toBeUndefined();
  });

  it('is not written for a child run, which belongs to the run that spawned it', async () => {
    const { store, jobs, first } = await setup();
    const parentClaim = mustClaim(store, 'w1');
    expect(store.append(parentClaim, [callEvent('c1')]).kind).toBe('ok');
    const spawned = await store.createChildRun({ parentRunId: first.id, parentCallId: 'c1', input: 'child task', pins: {}, model: 'fm' });
    if (spawned.kind !== 'created') throw new Error(`expected a child run, got ${spawned.kind}`);
    const childClaim = mustClaim(store, 'w2');
    expect(childClaim.runId).toBe(spawned.run.id);
    expect((await store.transition(childClaim, ['RUNNING'], 'COMPLETED', {})).kind).toBe('ok');
    expect(jobs.get(spawned.run.id)).toBeUndefined();
  });

  it('ends failed with the reason, and is never handed out again', async () => {
    const { jobs, first } = await setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.fail(first.id, 'connection lost')).toMatchObject({ state: 'failed', lastError: 'connection lost', attempts: 1 });
    expect(jobs.next()).toBeUndefined();
    expect(() => jobs.begin(first.id)).toThrow();
  });

  it('hands out the oldest job that is not excluded', async () => {
    const { store, clock, jobs, first, session } = await setup();
    jobs.enqueue(first.id);
    clock.advance(10);
    const second = await enqueue(store, session.id, 'two');
    jobs.enqueue(second.id);
    expect(jobs.next(new Set([first.id]))?.runId).toBe(second.id);
    expect(jobs.next(new Set([first.id, second.id]))).toBeUndefined();
  });

  it('reports the origin recorded when the run was created', async () => {
    const { store, jobs, first } = await setup();
    expect(jobs.runOrigin(first.id)).toBe('untrusted');
    const folder = makeStoreDir();
    await store.trust.setAsked(folder, 'trusted', NEVER_CANCELLED);
    const trustedRun = await enqueue(store, newSession(store, folder).id, 'two');
    expect(jobs.runOrigin(trustedRun.id)).toBe('trusted');
    expect(jobs.runOrigin('missing')).toBeUndefined();
  });

  it('counts an attempt when a job begins', async () => {
    const { jobs, first } = await setup();
    jobs.enqueue(first.id);
    expect(jobs.begin(first.id)).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('hands out the oldest job first', async () => {
    const { store, clock, jobs, first, session } = await setup();
    jobs.enqueue(first.id);
    clock.advance(10);
    jobs.enqueue((await enqueue(store, session.id, 'two')).id);
    expect(jobs.next()?.runId).toBe(first.id);
  });

  it('hands out a job left running by a crash, so a restart resumes it', async () => {
    const { jobs, first } = await setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.next()).toMatchObject({ runId: first.id, state: 'running', attempts: 1 });
  });

  it('never hands out a finished job again', async () => {
    const { jobs, first } = await setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.finish(first.id).state).toBe('done');
    expect(jobs.next()).toBeUndefined();
  });

  it('keeps the reason of a skipped job', async () => {
    const { jobs, first } = await setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.finish(first.id, 'output failed the schema')).toMatchObject({ lastError: 'output failed the schema' });
    expect(jobs.next()).toBeUndefined();
  });
});

type Dropped = { ordinal: number; text: string | null; cause: string; reason: string };

type Charge = RunCharge;

type Settling = Jobs & {
  complete(input: { runId: string; charge: Charge | null; candidates: Record<string, unknown>[]; dropped?: Dropped[]; reason?: string }): Job;
  fail(runId: string, reason: string, charge?: Charge): Job;
  release(runId: string): Job;
};

describe('settling a reflection job', () => {
  const charge = (runId: string): Charge => ({ runId, charged: { type: 'usage.charged', purpose: 'reflection', inputTokens: 10, outputTokens: 5, totalTokens: 15, responseId: 'response-1' } });
  const chargesOf = (store: RuntimeStore, runId: string) => store.readRunEventsOfTypes(runId, ['usage.charged']);

  const candidate = (runId: string, ordinal: number, text: string): Record<string, unknown> => ({
    scope: 'project',
    origin: 'trusted',
    project: '/work/a',
    text,
    runId,
    ordinal,
    kind: 'fact',
    evidence: [],
  });

  const started = async () => {
    const env = await setup();
    const settling = env.store.reflection as unknown as Settling;
    await cancelToEnd(env.store, env.first.id);
    env.jobs.enqueue(env.first.id);
    env.jobs.begin(env.first.id);
    return { ...env, settling };
  };

  const failOn = (dbPath: string, table: string): void => {
    const db = rawDb(dbPath);
    db.exec(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  };

  it('records the charge, stores the candidates and finishes the job in one commit', async () => {
    const { store, settling, first } = await started();
    const done = settling.complete({ runId: first.id, charge: charge(first.id), candidates: [candidate(first.id, 0, 'one'), candidate(first.id, 1, 'two')], reason: 'kept two' });
    expect(done).toMatchObject({ state: 'done', lastError: 'kept two' });
    expect(chargesOf(store, first.id)).toHaveLength(1);
    expect(store.memories.candidates().map((memory) => memory.text)).toEqual(['one', 'two']);
  });

  it('keeps the dropped candidates with the job and reads them back whole', async () => {
    const { settling, first } = await started();
    const dropped: Dropped[] = [
      { ordinal: 0, text: null, cause: 'text_rule', reason: 'looks like a credential' },
      { ordinal: 2, text: 'repeated note', cause: 'duplicate', reason: 'already known' },
      { ordinal: 3, text: 'unbound note', cause: 'evidence', reason: 'src/x.ts was not read' },
    ];
    settling.complete({ runId: first.id, charge: null, candidates: [], dropped, reason: 'every candidate the model proposed was dropped' });
    expect(settling.get(first.id)).toMatchObject({ state: 'done', lastError: 'every candidate the model proposed was dropped', dropped });
  });

  it('refuses to read a dropped candidate of an unknown cause', async () => {
    const { store, settling, first, dbPath } = await started();
    settling.complete({ runId: first.id, charge: null, candidates: [], dropped: [{ ordinal: 0, text: 'x', cause: 'duplicate', reason: 'r' }] });
    rawDb(dbPath).prepare('UPDATE reflection_jobs SET dropped_json = ? WHERE run_id = ?').run('[{"ordinal":0,"text":"x","cause":"bored","reason":"r"}]', first.id);
    expect(() => (store.reflection as unknown as Jobs).get(first.id)).toThrow(/dropped_json/);
  });

  it('finds the latest job of the runs of one folder', async () => {
    const env = await setup();
    const other = await enqueue(env.store, newSession(env.store, '/work/b').id, 'elsewhere');
    const jobs = env.store.reflection as unknown as Settling;
    jobs.enqueue(env.first.id);
    jobs.begin(env.first.id);
    jobs.finish(env.first.id, 'first folder, first job');
    env.clock.advance(1);
    jobs.enqueue(other.id);
    jobs.begin(other.id);
    jobs.finish(other.id, 'second folder');
    expect(jobs.latestForProject('/work/a')).toMatchObject({ runId: env.first.id, lastError: 'first folder, first job' });
    expect(jobs.latestForProject('/work/b')).toMatchObject({ runId: other.id, lastError: 'second folder' });
    expect(jobs.latestForProject('/work/none')).toBeUndefined();
  });

  it('answers the newest settled job of a folder when it has several', async () => {
    const env = await setup();
    const second = await enqueue(env.store, env.session.id, 'again');
    const jobs = env.store.reflection as unknown as Settling;
    jobs.enqueue(env.first.id);
    jobs.begin(env.first.id);
    jobs.finish(env.first.id, 'older');
    env.clock.advance(5);
    jobs.enqueue(second.id);
    jobs.begin(second.id);
    jobs.finish(second.id, 'newer');
    expect(jobs.latestForProject('/work/a')).toMatchObject({ runId: second.id, lastError: 'newer' });
  });

  it('records no charge when it is given none', async () => {
    const { store, settling, first } = await started();
    expect(settling.complete({ runId: first.id, charge: null, candidates: [] })).toMatchObject({ state: 'done' });
    expect(chargesOf(store, first.id)).toEqual([]);
  });

  it('commits nothing when a candidate cannot be stored: no charge, no candidate, the job still running', async () => {
    const { store, settling, first, dbPath } = await started();
    failOn(dbPath, 'memories');
    expect(() => settling.complete({ runId: first.id, charge: charge(first.id), candidates: [candidate(first.id, 0, 'one')] })).toThrow('injected failure');
    expect(chargesOf(store, first.id)).toEqual([]);
    expect(store.memories.candidates()).toEqual([]);
    expect(settling.get(first.id)).toMatchObject({ state: 'running' });
  });

  it('commits nothing when the charge cannot be recorded', async () => {
    const { store, settling, first, dbPath } = await started();
    failOn(dbPath, 'events');
    expect(() => settling.complete({ runId: first.id, charge: charge(first.id), candidates: [candidate(first.id, 0, 'one')] })).toThrow('injected failure');
    expect(store.memories.candidates()).toEqual([]);
    expect(settling.get(first.id)).toMatchObject({ state: 'running' });
  });

  it('commits nothing when the job is not running any more, so a finished job is never charged again', async () => {
    const { store, settling, first } = await started();
    settling.finish(first.id, 'finished elsewhere');
    expect(() => settling.complete({ runId: first.id, charge: charge(first.id), candidates: [candidate(first.id, 0, 'one')] })).toThrow('cannot finish');
    expect(chargesOf(store, first.id)).toEqual([]);
    expect(store.memories.candidates()).toEqual([]);
  });

  it('records the charge together with the failure of the job', async () => {
    const { store, settling, first } = await started();
    expect(settling.fail(first.id, 'the call failed', charge(first.id))).toMatchObject({ state: 'failed', lastError: 'the call failed' });
    expect(chargesOf(store, first.id)).toHaveLength(1);
  });

  it('records no charge when the failure cannot be written', async () => {
    const { store, settling, first } = await started();
    settling.finish(first.id);
    expect(() => settling.fail(first.id, 'late', charge(first.id))).toThrow('cannot fail');
    expect(chargesOf(store, first.id)).toEqual([]);
  });

  it('gives back the attempt of a job that was aborted, and leaves it to be handed out again', async () => {
    const { settling, first } = await started();
    expect(settling.release(first.id)).toMatchObject({ state: 'running', attempts: 0 });
    expect(settling.next()).toMatchObject({ runId: first.id });
    expect(settling.begin(first.id)).toMatchObject({ attempts: 1 });
  });

  it('refuses to give back an attempt that was never taken, or of a finished job', async () => {
    const { settling, first } = await started();
    settling.release(first.id);
    expect(() => settling.release(first.id)).toThrow('cannot release');
    settling.begin(first.id);
    settling.finish(first.id);
    expect(() => settling.release(first.id)).toThrow('cannot release');
  });
});
