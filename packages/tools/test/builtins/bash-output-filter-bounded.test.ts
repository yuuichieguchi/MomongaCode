import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobView } from '@momonga/protocol';
import { clearUntrustedSchemaCaches } from '@momonga/foundation';
import { createBuiltinTools } from '@momonga/tools';
import type { BackgroundJobs, ToolContext } from '@momonga/tools';
import { recordedWorkers } from '../worker-record.ts';

vi.mock('node:worker_threads', async (importOriginal) => (await import('../worker-record.ts')).recordingWorkerModule(importOriginal as never));
vi.mock('worker_threads', async (importOriginal) => (await import('../worker-record.ts')).recordingWorkerModule(importOriginal as never));

const INJECTED_LIMIT_MS = 300;
const HOSTILE_LINE = `${'a'.repeat(39)}!`;
const NESTED_QUANTIFIER = '^(a+)+$';
const BACKREFERENCE = '^(a+)+\\1$';

const JOB: JobView = { id: 'bash_aaaaaaaaaaaa', sessionId: 's', runId: 'run-1', callId: 'c', command: 'make', status: 'running', startedAt: 1 };

type ReadingJobs = BackgroundJobs & { consumed: number };

const jobsHolding = (output: string): ReadingJobs => {
  const jobs: ReadingJobs = {
    consumed: 0,
    start: async () => ({ jobId: JOB.id }),
    byCall: () => JOB,
    status: () => JOB,
    read: async (_runId, _jobId, options) => {
      const kept = options.keep === undefined ? output : (await options.keep(output.split('\n'))).join('\n');
      jobs.consumed += 1;
      return { job: JOB, output: kept };
    },
    kill: async () => ({ view: JOB, kill: 'stopped' }),
  };
  return jobs;
};

const bashOutput = (() => {
  const tool = createBuiltinTools().find((candidate) => candidate.name === 'BashOutput');
  if (tool === undefined) throw new Error('no BashOutput tool');
  return tool;
})();

const contextOf = (jobs: BackgroundJobs, extra: Record<string, unknown> = {}): ToolContext =>
  ({ runId: 'run-1', callId: 'call-1', jobs, clock: { now: () => 1000 }, signal: new AbortController().signal, ...extra }) as unknown as ToolContext;

const read = (jobs: BackgroundJobs, filter: string, extra: Record<string, unknown> = {}) =>
  bashOutput.execute({ bash_id: JOB.id, filter }, contextOf(jobs, extra), { waitUntil: 0 });

type NativeRun = { source: string; input: string };

const nativeRuns: NativeRun[] = [];
const originalExec = RegExp.prototype.exec;
const originalTest = RegExp.prototype.test;

beforeEach(() => {
  nativeRuns.length = 0;
  recordedWorkers.started.length = 0;
  recordedWorkers.onStart = undefined;
  clearUntrustedSchemaCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const watchNativeRuns = (): void => {
  vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
    nativeRuns.push({ source: this.source, input: String(input) });
    return originalExec.call(this, input);
  });
  vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
    nativeRuns.push({ source: this.source, input: String(input) });
    return originalTest.call(this, input);
  });
};

describe('the filter of BashOutput is matched only by the bounded checker', () => {
  it('keeps the lines a pattern matches and drops the others', async () => {
    const jobs = jobsHolding('ok 1\nERROR a\nok 2\nERROR b');
    expect(await read(jobs, 'ERR(OR)?')).toEqual({ status: 'completed', output: 'Job bash_aaaaaaaaaaaa: it is still running.\nERROR a\nERROR b' });
  });

  it('answers a nested quantifier on a line that never matches without running the pattern on the calling thread', async () => {
    const jobs = jobsHolding(`${HOSTILE_LINE}\naaaa`);
    watchNativeRuns();
    const result = await read(jobs, NESTED_QUANTIFIER);
    const runsOnTheLine = nativeRuns.filter((run) => run.source === NESTED_QUANTIFIER && run.input.includes(HOSTILE_LINE));
    vi.restoreAllMocks();
    expect(result).toEqual({ status: 'completed', output: 'Job bash_aaaaaaaaaaaa: it is still running.\naaaa' });
    expect(runsOnTheLine).toEqual([]);
  });

  it('refuses a pattern whose match does not end within the limit, with the worker exited and the output not consumed', async () => {
    const jobs = jobsHolding(HOSTILE_LINE);
    await expect(read(jobs, BACKREFERENCE, { patternCheckLimitMs: INJECTED_LIMIT_MS })).rejects.toThrow(
      `filter could not be matched against the new output within ${INJECTED_LIMIT_MS} ms: the pattern is too costly to match. The output was not consumed: read it again with a simpler filter, or with none.`,
    );
    expect(jobs.consumed).toBe(0);
    expect(recordedWorkers.started.length).toBe(1);
    expect(recordedWorkers.started[0]!.exited).toBe(true);
  });

  it('lets a timer scheduled before the read fire before the read is refused', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    const pending = read(jobsHolding(HOSTILE_LINE), BACKREFERENCE, { patternCheckLimitMs: INJECTED_LIMIT_MS }).catch(() => {
      order.push('refused');
    });
    expect(order).toEqual([]);
    await pending;
    expect(order).toEqual(['timer', 'refused']);
  });

  it('ends the read when the call is stopped during the match', async () => {
    const controller = new AbortController();
    recordedWorkers.onStart = () => setImmediate(() => controller.abort());
    await expect(read(jobsHolding(HOSTILE_LINE), BACKREFERENCE, { signal: controller.signal })).rejects.toThrow('BashOutput was cancelled');
    expect(recordedWorkers.started[0]!.exited).toBe(true);
  });

  it('rejects a filter that is not a regular expression before the job is read', async () => {
    const jobs = jobsHolding('line');
    await expect(read(jobs, '(')).rejects.toThrow('filter is not a valid regular expression');
    expect(jobs.consumed).toBe(0);
  });
});
