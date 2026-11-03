import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession } from './helpers.ts';

type Job = { runId: string; state: string; attempts: number; lastError: string | null; createdAt: number; updatedAt: number };

type Jobs = {
  runOrigin(runId: string): string | undefined;
  enqueue(runId: string): boolean;
  get(runId: string): Job | undefined;
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

const setup = () => {
  const { store, clock, dbPath } = harness();
  const session = newSession(store);
  const first = enqueue(store, session.id, 'one');
  return { store, clock, dbPath, session, first, jobs: jobsOf(store) };
};

describe('reflection jobs', () => {
  it('creates one pending job per run', () => {
    const { jobs, first } = setup();
    expect(jobs.enqueue(first.id)).toBe(true);
    expect(jobs.enqueue(first.id)).toBe(false);
    expect(jobs.get(first.id)).toEqual({ runId: first.id, state: 'pending', attempts: 0, lastError: null, createdAt: START_MS, updatedAt: START_MS });
  });

  it('is written in the terminal transition of a completed root run, in the same step as the status', () => {
    const { store, jobs, first } = setup();
    const claim = mustClaim(store, 'w1');
    expect(jobs.get(first.id)).toBeUndefined();
    expect(store.transition(claim, ['RUNNING'], 'COMPLETED', {}).kind).toBe('ok');
    expect(jobs.get(first.id)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it.each(['FAILED', 'STOPPED'] as const)('is not written for a run that ended %s', (outcome) => {
    const { store, jobs, first } = setup();
    const claim = mustClaim(store, 'w1');
    expect(store.transition(claim, ['RUNNING'], outcome, outcome === 'FAILED' ? { error: { code: 'x', message: 'x' } } : { stopReason: 'budget' }).kind).toBe('ok');
    expect(jobs.get(first.id)).toBeUndefined();
  });

  it('is not written for a child run, which belongs to the run that spawned it', () => {
    const { store, jobs, first } = setup();
    const parentClaim = mustClaim(store, 'w1');
    expect(store.append(parentClaim, [callEvent('c1')]).kind).toBe('ok');
    const spawned = store.createChildRun({ parentRunId: first.id, parentCallId: 'c1', input: 'child task', pins: {} });
    if (spawned.kind !== 'created') throw new Error(`expected a child run, got ${spawned.kind}`);
    const childClaim = mustClaim(store, 'w2');
    expect(childClaim.runId).toBe(spawned.run.id);
    expect(store.transition(childClaim, ['RUNNING'], 'COMPLETED', {}).kind).toBe('ok');
    expect(jobs.get(spawned.run.id)).toBeUndefined();
  });

  it('ends failed with the reason, and is never handed out again', () => {
    const { jobs, first } = setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.fail(first.id, 'connection lost')).toMatchObject({ state: 'failed', lastError: 'connection lost', attempts: 1 });
    expect(jobs.next()).toBeUndefined();
    expect(() => jobs.begin(first.id)).toThrow();
  });

  it('hands out the oldest job that is not excluded', () => {
    const { store, clock, jobs, first, session } = setup();
    jobs.enqueue(first.id);
    clock.advance(10);
    const second = enqueue(store, session.id, 'two');
    jobs.enqueue(second.id);
    expect(jobs.next(new Set([first.id]))?.runId).toBe(second.id);
    expect(jobs.next(new Set([first.id, second.id]))).toBeUndefined();
  });

  it('reports the origin recorded when the run was created', () => {
    const { store, jobs, first } = setup();
    expect(jobs.runOrigin(first.id)).toBe('untrusted');
    const folder = makeStoreDir();
    store.trust.set(folder, 'trusted');
    const trustedRun = enqueue(store, newSession(store, folder).id, 'two');
    expect(jobs.runOrigin(trustedRun.id)).toBe('trusted');
    expect(jobs.runOrigin('missing')).toBeUndefined();
  });

  it('counts an attempt when a job begins', () => {
    const { jobs, first } = setup();
    jobs.enqueue(first.id);
    expect(jobs.begin(first.id)).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('hands out the oldest job first', () => {
    const { store, clock, jobs, first, session } = setup();
    jobs.enqueue(first.id);
    clock.advance(10);
    jobs.enqueue(enqueue(store, session.id, 'two').id);
    expect(jobs.next()?.runId).toBe(first.id);
  });

  it('hands out a job left running by a crash, so a restart resumes it', () => {
    const { jobs, first } = setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.next()).toMatchObject({ runId: first.id, state: 'running', attempts: 1 });
  });

  it('never hands out a finished job again', () => {
    const { jobs, first } = setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.finish(first.id).state).toBe('done');
    expect(jobs.next()).toBeUndefined();
  });

  it('keeps the reason of a skipped job', () => {
    const { jobs, first } = setup();
    jobs.enqueue(first.id);
    jobs.begin(first.id);
    expect(jobs.finish(first.id, 'output failed the schema')).toMatchObject({ lastError: 'output failed the schema' });
    expect(jobs.next()).toBeUndefined();
  });
});
