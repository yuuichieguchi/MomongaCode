import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, makeStoreDir, newSession } from './helpers.ts';

type Job = { runId: string; state: string; attempts: number; lastError: string | null; createdAt: number; updatedAt: number };

type Jobs = {
  runOrigin(runId: string): string | undefined;
  enqueue(runId: string): boolean;
  get(runId: string): Job | undefined;
  next(): Job | undefined;
  begin(runId: string): Job;
  finish(runId: string, reason?: string): Job;
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
