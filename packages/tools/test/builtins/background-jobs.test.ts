import { describe, expect, it } from 'vitest';
import type { JobView } from '@momonga/protocol';
import type { Sandbox } from '@momonga/sandbox';
import { createBuiltinTools } from '@momonga/tools';
import type { BackgroundJobStart, BackgroundJobs, ReconcileContext, ToolContext } from '@momonga/tools';
import { makeBuiltins, resultOf } from './fixtures.ts';

const view = (overrides: Partial<JobView> = {}): JobView => ({
  id: 'bash_aaaaaaaaaaaa',
  sessionId: 's',
  runId: 'run-1',
  callId: 'c',
  command: 'sleep 30',
  status: 'running',
  startedAt: 1,
  ...overrides,
});

type FakeJobs = BackgroundJobs & { started: BackgroundJobStart[]; reads: { runId: string; jobId: string; filtered: boolean }[]; kills: string[]; current: JobView; output: string; known: boolean; killOutcome: 'stopped' | 'requested' };

const fakeJobs = (): FakeJobs => {
  const jobs: FakeJobs = {
    started: [],
    reads: [],
    kills: [],
    current: view(),
    output: '',
    known: true,
    killOutcome: 'stopped',
    start: async (request) => {
      jobs.started.push(request);
      return { jobId: 'bash_aaaaaaaaaaaa' };
    },
    byCall: () => (jobs.known ? jobs.current : undefined),
    status: (_runId, jobId) => {
      if (jobId !== jobs.current.id) throw new Error('unknown job');
      return jobs.current;
    },
    read: async (runId, jobId, options) => {
      jobs.reads.push({ runId, jobId, filtered: options.keep !== undefined });
      return { job: jobs.current, output: jobs.output };
    },
    kill: async (_runId, jobId) => {
      jobs.kills.push(jobId);
      if (jobs.killOutcome === 'requested') return { view: jobs.current, kill: 'requested' };
      jobs.current = view({ status: 'killed', signal: 'SIGTERM' });
      return { view: jobs.current, kill: 'stopped' };
    },
  };
  return jobs;
};

const toolOf = (name: string) => {
  const tool = createBuiltinTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no ${name} tool`);
  return tool;
};

type SpawnRecord = { argv: readonly string[]; markerFile?: string | undefined; cwd: string };

const recordingSandbox = (spawns: SpawnRecord[]): Sandbox => ({
  kind: 'seatbelt',
  spawn: (command) => {
    spawns.push({ argv: command.argv, markerFile: command.markerFile, cwd: command.cwd });
    return { pid: 1, pgid: 1, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.resolve({ code: 0, signal: null }) };
  },
});

describe('Bash run_in_background', () => {
  it('fails clearly when the runtime has no job registry', async () => {
    const builtins = await makeBuiltins();
    const outcome = await builtins.run('Bash', { command: 'sleep 30', run_in_background: true }, {}, 'allow_once');
    expect(resultOf(outcome)).toMatchObject({ status: 'failed', output: 'Background jobs are not available in this runtime' });
  });

  it('describes the job to the registry and answers with its id at once', async () => {
    const jobs = fakeJobs();
    const spawns: SpawnRecord[] = [];
    const builtins = await makeBuiltins({ jobs, sandbox: recordingSandbox(spawns) });
    const outcome = await builtins.run('Bash', { command: 'npm run dev', run_in_background: true }, {}, 'allow_once');
    expect(resultOf(outcome).status).toBe('completed');
    expect(resultOf(outcome).output).toContain('Started background job bash_aaaaaaaaaaaa');
    expect(resultOf(outcome).output).toContain('BashOutput');
    const [request] = jobs.started;
    expect(request).toMatchObject({ runId: 'run-1', command: 'npm run dev', timeoutMs: 1_800_000 });
    expect(request?.callKey).toMatch(/^[0-9a-f]{64}$/);
    await request?.spawn('/markers/key', new AbortController().signal);
    expect(spawns).toEqual([{ argv: ['/bin/bash', '-c', 'npm run dev'], markerFile: '/markers/key', cwd: builtins.layout.project }]);
  });

  it('uses timeout as the time limit of a background job', async () => {
    const jobs = fakeJobs();
    const builtins = await makeBuiltins({ jobs });
    await builtins.run('Bash', { command: 'x', run_in_background: true, timeout: 7_200_000 }, {}, 'allow_once');
    expect(jobs.started[0]?.timeoutMs).toBe(7_200_000);
  });

  it('refuses a timeout above the background maximum', async () => {
    const builtins = await makeBuiltins({ jobs: fakeJobs() });
    const outcome = await builtins.run('Bash', { command: 'x', run_in_background: true, timeout: 7_200_001 }, {}, 'allow_once');
    expect(resultOf(outcome).status).toBe('failed');
  });

  it('reconciles an interrupted start from the job the registry recorded', async () => {
    const jobs = fakeJobs();
    const context = { idemKey: 'k', jobs } as unknown as ReconcileContext;
    const input = { command: 'x', run_in_background: true };
    const record = { key: 'k', state: 'PENDING' as const, meta: {}, createdAt: 1, expiresAt: 2 };
    const reconcile = toolOf('Bash').reconcile;
    if (reconcile === undefined) throw new Error('Bash has no reconcile');
    jobs.current = view({ status: 'unknown' });
    expect(await reconcile(input, record, context)).toEqual({
      outcome: 'already_applied',
      output: 'Started background job bash_aaaaaaaaaaaa. The call was interrupted after the job started, so the runtime stopped while it ran, so its result is unknown.',
    });
    jobs.known = false;
    expect(await reconcile(input, record, context)).toEqual({ outcome: 'not_applied', output: '' });
  });
});

const contextOf = (jobs: FakeJobs, now = 1000): ToolContext => ({ runId: 'run-1', jobs, clock: { now: () => now } }) as unknown as ToolContext;

describe('BashOutput', () => {
  const bashOutput = toolOf('BashOutput');
  const input = (extra: Record<string, unknown> = {}) => ({ bash_id: 'bash_aaaaaaaaaaaa', ...extra });

  it('returns the new output with the state of the job', async () => {
    const jobs = fakeJobs();
    jobs.output = 'line one\nline two';
    expect(await bashOutput.execute(input(), contextOf(jobs), { waitUntil: 0 })).toEqual({
      status: 'completed',
      output: 'Job bash_aaaaaaaaaaaa: it is still running.\nline one\nline two',
    });
    jobs.current = view({ status: 'exited', exitCode: 2 });
    jobs.output = '';
    expect(await bashOutput.execute(input(), contextOf(jobs), { waitUntil: 0 })).toEqual({
      status: 'completed',
      output: 'Job bash_aaaaaaaaaaaa: it exited with code 2.\nNo new output.',
    });
  });

  it('gives the registry a line filter only when the call names one', async () => {
    const jobs = fakeJobs();
    await bashOutput.execute(input(), contextOf(jobs), { waitUntil: 0 });
    await bashOutput.execute(input({ filter: 'ERR(OR)?' }), contextOf(jobs), { waitUntil: 0 });
    expect(jobs.reads.map((read) => read.filtered)).toEqual([false, true]);
  });

  it('waits for a running job until the time it may wait until', async () => {
    const jobs = fakeJobs();
    expect(await bashOutput.execute(input({ block: true }), contextOf(jobs, 1000), { waitUntil: 31_000 })).toEqual({
      status: 'pending',
      awaits: { kind: 'job', jobId: 'bash_aaaaaaaaaaaa' },
      wakeAt: 31_000,
    });
    expect(jobs.reads).toEqual([]);
    expect(await bashOutput.execute(input({ block: true }), contextOf(jobs, 31_000), { waitUntil: 31_000 })).toMatchObject({ status: 'completed' });
    jobs.current = view({ status: 'exited', exitCode: 0 });
    expect(await bashOutput.execute(input({ block: true }), contextOf(jobs, 2000), { waitUntil: 31_000 })).toMatchObject({ status: 'completed' });
  });

  it('computes how long it may wait once, from the timeout or the 30 second default', async () => {
    const prepare = bashOutput.prepare;
    if (prepare === undefined) throw new Error('BashOutput has no prepare');
    const jobs = fakeJobs();
    expect(await prepare(input({ block: true }), contextOf(jobs, 5000))).toEqual({ waitUntil: 35_000 });
    expect(await prepare(input({ block: true, timeout: 1000 }), contextOf(jobs, 5000))).toEqual({ waitUntil: 6000 });
  });

  it('fails without a registry', async () => {
    await expect(bashOutput.execute(input(), { runId: 'r', clock: { now: () => 0 } } as unknown as ToolContext, { waitUntil: 0 })).rejects.toThrow('Background jobs are not available');
  });
});

describe('KillBash', () => {
  const killBash = toolOf('KillBash');

  it('stops the job and reports how it ended', async () => {
    const jobs = fakeJobs();
    expect(await killBash.execute({ shell_id: 'bash_aaaaaaaaaaaa' }, contextOf(jobs), undefined)).toEqual({
      status: 'completed',
      output: 'Job bash_aaaaaaaaaaaa: it was stopped (SIGTERM).',
    });
    expect(jobs.kills).toEqual(['bash_aaaaaaaaaaaa']);
  });

  it('reports a kill that its owner has not finished as a completed call with the requested text (20.39)', async () => {
    const jobs = fakeJobs();
    jobs.killOutcome = 'requested';
    expect(await killBash.execute({ shell_id: 'bash_aaaaaaaaaaaa' }, contextOf(jobs), undefined)).toEqual({
      status: 'completed',
      output: 'Job bash_aaaaaaaaaaaa: kill requested; it stops when its owner finishes the stop.',
    });
  });

  it('is a write tool, so plan mode does not offer it', () => {
    expect(killBash.sideEffect).toBe('write');
  });
});
