import { describe, expect, it, vi } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { systemTimers } from '../../src/service/timers.ts';
import { verifyInThread } from '../../src/process/rule-verifier-thread-client.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const HANG_GUARD_MS = 60_000;

vi.setConfig({ testTimeout: HANG_GUARD_MS });

const runningWorkerCount = (): number => (process.report.getReport() as unknown as { workers: unknown[] }).workers.length;

const job: RuleVerifyJob = {
  input: { rules: [], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', enforcement: 'exact-paths', protectedSet: {} as never, secretLocations: [] },
  solver: { kind: 'installed', entry: '/nowhere/z3.js' },
  solverVersion: 'z3 1',
  budgetMs: 60_000,
};

const REPLYING = `
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [String(isMainThread), workerData.input.cwd] } });
`;
const BLOCKING_THEN_REPLYING = `
const { parentPort, workerData } = require('node:worker_threads');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] } });
`;
const REFUSING = `require('node:worker_threads').parentPort.postMessage({ ok: false, reason: 'the Z3 solver at /nowhere/z3.js cannot be used' });`;
const THROWING = `throw new Error('no memory for the solver');`;
const EXITING = `process.exit(3);`;
const MALFORMED = `require('node:worker_threads').parentPort.postMessage({ ok: true, verdict: { verdict: 'certain' } });`;
const SILENT = `setInterval(() => undefined, 1000);`;

const unknownWith = (reason: string | RegExp) => ({ verdict: 'unknown', solver: 'z3 1', refuted: [], unknown: [{ property: 'verification', reason: typeof reason === 'string' ? reason : expect.stringMatching(reason) }], notProved: [] });

describe('a verification in its own thread', () => {
  it('gives the verdict of the thread, which is not the calling thread and receives the job', async () => {
    const verdict = await verifyInThread({ code: REPLYING, timers: systemTimers }, job, new AbortController().signal);
    expect(verdict).toEqual({ verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: ['false', '/work'] });
    expect(runningWorkerCount()).toBe(0);
  });

  it('leaves the event loop of the caller free while the thread computes', async () => {
    let turns = 0;
    const ticking = setInterval(() => (turns += 1), 10);
    try {
      await verifyInThread({ code: BLOCKING_THEN_REPLYING, timers: systemTimers }, job, new AbortController().signal);
    } finally {
      clearInterval(ticking);
    }
    expect(turns).toBeGreaterThan(3);
  });

  it('is unknown with the reason when the thread reports a failure', async () => {
    expect(await verifyInThread({ code: REFUSING, timers: systemTimers }, job, new AbortController().signal)).toEqual(
      unknownWith('the verification thread failed: the Z3 solver at /nowhere/z3.js cannot be used'),
    );
  });

  it('is unknown with the reason when the thread throws', async () => {
    expect(await verifyInThread({ code: THROWING, timers: systemTimers }, job, new AbortController().signal)).toEqual(unknownWith('the verification thread failed: no memory for the solver'));
  });

  it('is unknown with the reason when the thread exits without a verdict', async () => {
    expect(await verifyInThread({ code: EXITING, timers: systemTimers }, job, new AbortController().signal)).toEqual(unknownWith('the verification thread exited with code 3 before it gave a verdict'));
  });

  it('is unknown with the reason when the reply is not a verdict', async () => {
    expect(await verifyInThread({ code: MALFORMED, timers: systemTimers }, job, new AbortController().signal)).toEqual(unknownWith('the verification thread gave a reply that is not a verdict'));
  });

  it('is unknown with the reason when the job cannot be given to a thread', async () => {
    const uncloneable = { ...job, input: { ...job.input, protectedSet: { probe: () => true } as never } };
    expect(await verifyInThread({ code: REPLYING, timers: systemTimers }, uncloneable, new AbortController().signal)).toEqual(unknownWith(/^the verification thread could not be started: /));
  });

  it('is cut at the budget of the job: unknown with the budget sentence, and the thread is ended', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const pending = verifyInThread({ code: SILENT, timers }, { ...job, budgetMs: 1234 }, new AbortController().signal);
    expect(runningWorkerCount()).toBe(1);
    expect(timers.pending().map((timer) => timer.delayMs)).toEqual([1234]);
    timers.advance(1234);
    expect(await pending).toEqual(unknownWith('the verification budget of 1234 ms was spent'));
    expect(runningWorkerCount()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('ends with the reason of the signal of its asker, and the thread is ended', async () => {
    const asker = new AbortController();
    const timers = createFakeTimers(createFakeClock(0));
    const pending = verifyInThread({ code: SILENT, timers }, job, asker.signal);
    expect(runningWorkerCount()).toBe(1);
    asker.abort(new Error('the run was cancelled'));
    await expect(pending).rejects.toThrow('the run was cancelled');
    expect(runningWorkerCount()).toBe(0);
    expect(timers.pending()).toEqual([]);
  });

  it('starts no thread for an asker that is already gone', async () => {
    const asker = new AbortController();
    asker.abort(new Error('gone'));
    await expect(verifyInThread({ code: REPLYING, timers: systemTimers }, job, asker.signal)).rejects.toThrow('gone');
    expect(runningWorkerCount()).toBe(0);
  });
});
