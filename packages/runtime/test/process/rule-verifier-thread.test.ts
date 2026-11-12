import { describe, expect, it, vi } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { systemTimers } from '../../src/service/timers.ts';
import { RuleVerificationFailure, verifyInThread } from '../../src/process/rule-verifier-thread-client.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const HANG_GUARD_MS = 60_000;
const START_BOUND_MS = 77;

vi.setConfig({ testTimeout: HANG_GUARD_MS });

const runningWorkerCount = (): number => (process.report.getReport() as unknown as { workers: unknown[] }).workers.length;

const job: RuleVerifyJob = { unixSockets: { kind: 'limited', allowed: [] },
  input: { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', deniedLocations: [], cwd: '/work', exemptDirectory: null, enforcement: 'exact-paths', protectedSet: {} as never, secretLocations: [] },
  solver: { kind: 'installed', entry: '/nowhere/z3.js' },
  solverVersion: 'z3 1',
  budgetMs: 60_000,
  askedAtMs: 0,
  platform: 'linux',
  bashPath: '/bin/bash',
};

const ENTERED = `parentPort.postMessage({ entered: true });`;
const REPLYING = `
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
${ENTERED}
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [String(isMainThread), workerData.input.cwd] }, report: 'the report of the thread', findings: { exitCode: 0 } });
`;
const BLOCKING_THEN_REPLYING = `
const { parentPort, workerData } = require('node:worker_threads');
${ENTERED}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: '', findings: { exitCode: 0 } });
`;
const ENTERED_THEN_REFUTED_LATER = `
const { parentPort, workerData } = require('node:worker_threads');
${ENTERED}
setTimeout(() => parentPort.postMessage({ ok: true, verdict: { verdict: 'refuted', solver: workerData.solverVersion, refuted: [{ property: 'secret-reach', subject: 'Read', message: 'found before the budget ended' }], unknown: [{ property: 'bash-admission', reason: 'the verification budget was spent' }], notProved: [] }, report: 'partial', findings: { exitCode: 1 } }), 300);
`;
const REFUSING = `require('node:worker_threads').parentPort.postMessage({ ok: false, reason: 'the Z3 solver at /nowhere/z3.js cannot be used' });`;
const THROWING = `throw new Error('no memory for the solver');`;
const EXITING = `process.exit(3);`;
const MALFORMED = `require('node:worker_threads').parentPort.postMessage({ ok: true, verdict: { verdict: 'certain' }, report: '', findings: {} });`;
const WITHOUT_REPORT = `require('node:worker_threads').parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: [] }, findings: {} });`;
const SILENT = `setInterval(() => undefined, 1000);`;
const ENTERED_THEN_SILENT = `const { parentPort } = require('node:worker_threads'); ${ENTERED} setInterval(() => undefined, 1000);`;

const failureWith = (reason: string | RegExp) => expect.objectContaining({ name: 'RuleVerificationFailure', message: typeof reason === 'string' ? reason : expect.stringMatching(reason) });

const options = (timers = systemTimers, code = REPLYING) => ({ code, timers, startBoundMs: START_BOUND_MS });

describe('a verification in its own thread', () => {
  it('gives the verdict, the report and the findings of the thread, which is not the calling thread and receives the job', async () => {
    const verification = await verifyInThread(options(), job, new AbortController().signal);
    expect(verification).toEqual({ verdict: { verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: ['false', '/work'] }, report: 'the report of the thread', findings: { exitCode: 0 } });
    expect(runningWorkerCount()).toBe(0);
  });

  it('leaves the event loop of the caller free while the thread computes', async () => {
    let turns = 0;
    const ticking = setInterval(() => (turns += 1), 10);
    try {
      await verifyInThread(options(systemTimers, BLOCKING_THEN_REPLYING), job, new AbortController().signal);
    } finally {
      clearInterval(ticking);
    }
    expect(turns).toBeGreaterThan(3);
  });

  it.each([
    ['reports a failure', REFUSING, 'the verification thread failed: the Z3 solver at /nowhere/z3.js cannot be used'],
    ['throws', THROWING, 'the verification thread failed: no memory for the solver'],
    ['exits without a verdict', EXITING, 'the verification thread exited with code 3 before it gave a verdict'],
    ['replies with no verdict', MALFORMED, 'the verification thread gave a reply that is not a verdict'],
    ['replies with no report', WITHOUT_REPORT, 'the verification thread gave a reply that is not a verdict'],
  ])('fails with an error, not a verdict, when the thread %s', async (_case, code, reason) => {
    const failure = await verifyInThread(options(systemTimers, code), job, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuleVerificationFailure);
    expect(failure).toEqual(failureWith(reason));
    expect(runningWorkerCount()).toBe(0);
  });

  it('fails with an error when the job cannot be given to a thread', async () => {
    const uncloneable = { ...job, input: { ...job.input, protectedSet: { probe: () => true } as never } };
    await expect(verifyInThread(options(), uncloneable, new AbortController().signal)).rejects.toEqual(failureWith(/^the verification thread could not be started: /));
  });

  it('bounds the start of the thread by its own bound, which is not the verification budget: a thread that never enters the verification fails with that bound and is ended', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const pending = verifyInThread(options(timers, SILENT), { ...job, budgetMs: 1234 }, new AbortController().signal);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(runningWorkerCount()).toBe(1);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([START_BOUND_MS]);
    timers.advance(START_BOUND_MS);
    expect(await outcome).toEqual(failureWith('the verification thread did not start within 77 ms'));
    expect(runningWorkerCount()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('keeps no timer of its own once the thread has entered the verification: the budget of the solver is the one bound, and what the thread found before it ended is kept', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    let entered = false;
    const pending = verifyInThread({ ...options(timers, ENTERED_THEN_REFUTED_LATER), onEntered: () => (entered = true) }, { ...job, budgetMs: 5 }, new AbortController().signal);
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(timers.pending()).toEqual([]);
    timers.advance(5 + START_BOUND_MS + 60_000);
    expect((await pending).verdict).toMatchObject({ verdict: 'refuted', refuted: [{ property: 'secret-reach' }], unknown: [{ property: 'bash-admission' }] });
    expect(runningWorkerCount()).toBe(0);
  });

  it('ends with the reason of the signal of its asker, and the thread is ended', async () => {
    const asker = new AbortController();
    const timers = createFakeTimers(createFakeClock(0));
    const pending = verifyInThread(options(timers, ENTERED_THEN_SILENT), job, asker.signal);
    expect(runningWorkerCount()).toBe(1);
    asker.abort(new Error('the run was cancelled'));
    await expect(pending).rejects.toThrow('the run was cancelled');
    expect(runningWorkerCount()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('starts no thread for an asker that is already gone', async () => {
    const asker = new AbortController();
    asker.abort(new Error('gone'));
    await expect(verifyInThread(options(), job, asker.signal)).rejects.toThrow('gone');
    expect(runningWorkerCount()).toBe(0);
  });
});
