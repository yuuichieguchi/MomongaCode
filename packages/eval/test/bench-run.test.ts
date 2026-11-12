import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeWorkspaceFiles } from '@momonga/eval';
import type { WorkspaceFiles } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { ADD_FIXED, CHEATING_TEST, benchmarkDir, exported, nodeProbe } from './bench-fixtures.ts';
import type { WorkspaceProbe } from './bench-fixtures.ts';

const T0 = 1_800_000_000_000;

type RunView = {
  sessionId: string;
  status: string;
  stopReason?: string;
  createdAt: number;
  deadlineAt: number;
  limits: { maxSteps?: number; maxTotalTokens?: number };
  step: number;
  tokensTotal: number;
  origin: string;
  agent: string;
  mode: string;
  model: string;
  declared: boolean;
};
type Mandate = { completion?: { conditions?: { id?: string; command: string; when?: string }[] } };
type Api = {
  createSession(input: { cwd: string; permissionMode: string; model: string }): Promise<{ id: string }>;
  createRun(sessionId: string, input: { input: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number }; mandate?: Mandate }): Promise<{ id: string }>;
  events(runId: string): AsyncIterable<PublicRunEvent>;
  runOf(runId: string): Promise<RunView>;
  answeredBy(runId: string): Promise<{ target: string; answers: 'model' | 'script' | 'unknown' }[]>;
  costs(runIds: readonly string[]): Promise<{ runId: string; calls: number; notPriced: number; legacyPrecisionCalls: number; priced: [] }[]>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
};
type Result = {
  report: { kind: string; total: { completion: { k: number; n: number; undeclared: number }; intervention: { k: number; n: number } }; harness: { suite: { name: string }; codeDigest: string; answeredBy: unknown[]; unrecordedAnswers: number }; tasks?: { task: string; trials: number; met: number }[]; population?: { notRun: { id: string; reason: string }[] } };
  trialsRun: number;
};
type TrialHome = { cwd: string; api: Api; close(): Promise<void> };
type RunBenchmark = (file: string, ports: { open(task: { id: string }, trial: number): Promise<TrialHome>; probe: WorkspaceProbe; files: WorkspaceFiles; model: string; codeDigest: string; groupBy: 'model' }) => Promise<Result>;

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bench-run-'));
  scratches.push(dir);
  return dir;
};

type Behaviour = { edit?(cwd: string, trial: number): void; ask?: boolean; unknownEffect?: boolean; delegate?: boolean; limits?: { maxSteps: number; maxTotalTokens: number }; mode?: string; pinned?(mandate: Mandate | undefined): boolean };

const fakeApi = (behaviour: Behaviour = {}) => {
  const sessions = new Map<string, { cwd: string; permissionMode: string; model: string }>();
  const runs = new Map<string, { sessionId: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number }; input: string; mandate?: Mandate }>();
  const resolved: { approvalId: string; optionId: string }[] = [];
  const children = new Map<string, string>();
  const asked: string[] = [];
  const cancelled: string[] = [];
  const api: Api = {
    createSession: async (input) => {
      const id = `sess-${sessions.size + 1}`;
      sessions.set(id, input);
      return { id };
    },
    createRun: async (sessionId, input) => {
      const id = `run-${runs.size + 1}`;
      runs.set(id, { sessionId, ...input });
      return { id };
    },
    events: async function* (runId) {
      const parent = children.get(runId);
      if (parent !== undefined) {
        const base = { runId, sessionId: `child-sess-${runId}`, step: 0 };
        yield { ...base, id: 1, seq: 1, createdAt: T0 + 1, type: 'run.status', from: 'QUEUED', to: 'RUNNING' } as PublicRunEvent;
        yield {
          ...base,
          id: 2,
          seq: 2,
          createdAt: T0 + 2,
          type: 'tool.permission.requested',
          approvalId: `approval-${runId}`,
          callId: 'child-call-1',
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
            { optionId: 'no', kind: 'reject_once', name: 'Reject' },
          ],
          subjectDigest: 'digest',
          reason: 'ask',
          shown: { title: 'approval', input: {} },
        } as PublicRunEvent;
        yield { ...base, id: 3, seq: 3, createdAt: T0 + 3, type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
        return;
      }
      const run = runs.get(runId) as { sessionId: string };
      const session = sessions.get(run.sessionId) as { cwd: string };
      const envelope = (seq: number) => ({ id: seq, runId, sessionId: run.sessionId, seq, step: 0, createdAt: T0 + seq });
      yield { ...envelope(1), type: 'run.status', from: 'QUEUED', to: 'RUNNING' } as PublicRunEvent;
      yield { ...envelope(2), type: 'run.started', attempt: 1 } as PublicRunEvent;
      if (behaviour.ask === true) {
        yield {
          ...envelope(3),
          type: 'tool.permission.requested',
          approvalId: `approval-${runId}`,
          callId: 'call-1',
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
            { optionId: 'no', kind: 'reject_once', name: 'Reject' },
          ],
          subjectDigest: 'digest',
          reason: 'ask',
          shown: { title: 'approval', input: {} },
        } as PublicRunEvent;
      }
      if (behaviour.unknownEffect === true) {
        yield {
          ...envelope(3),
          type: 'tool.unknown.requested',
          approvalId: `unknown-${runId}`,
          callIds: ['call-1'],
          options: [{ optionId: 'continue', kind: 'allow_once', name: 'Continue' }],
          subjectDigest: 'digest',
        } as PublicRunEvent;
      }
      if (behaviour.delegate === true) {
        const childRunId = `child-of-${runId}`;
        children.set(childRunId, runId);
        yield { ...envelope(3), type: 'tool.waiting', callId: 'call-agent', awaits: { kind: 'run', runId: childRunId, sessionId: `child-sess-${childRunId}`, agent: 'explore' } } as PublicRunEvent;
      }
      behaviour.edit?.(session.cwd, runs.size - 1);
      yield { ...envelope(4), type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
    },
    runOf: async (runId) => {
      if (children.has(runId)) {
        asked.push(runId);
        return { sessionId: `child-sess-${runId}`, status: 'COMPLETED', createdAt: T0, deadlineAt: T0 + 1000, limits: {}, step: 1, tokensTotal: 5, origin: 'trusted', agent: 'explore', mode: 'acceptEdits', model: 'fake/system', declared: false };
      }
      const run = runs.get(runId) as { sessionId: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number }; mandate?: Mandate };
      const session = sessions.get(run.sessionId) as { permissionMode: string; model: string };
      return {
        sessionId: run.sessionId,
        status: 'COMPLETED',
        createdAt: T0,
        deadlineAt: T0 + run.timeoutMs,
        limits: behaviour.limits ?? run.limits,
        step: 2,
        tokensTotal: 30,
        origin: 'trusted',
        agent: 'main',
        mode: behaviour.mode ?? session.permissionMode,
        model: session.model,
        declared: (behaviour.pinned ?? ((mandate) => (mandate?.completion?.conditions?.length ?? 0) > 0))(run.mandate),
      };
    },
    answeredBy: async () => [{ target: 'fake/system', answers: 'script' }],
    costs: async (runIds) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
    resolveApproval: async (approvalId, optionId) => {
      resolved.push({ approvalId, optionId });
    },
    cancelRun: async (runId) => {
      cancelled.push(runId);
    },
  };
  return { api, sessions, runs, resolved, asked, cancelled };
};

const openIn =
  (api: Api, at: string) =>
  async (task: { id: string }, trial: number): Promise<TrialHome> => {
    const cwd = path.join(at, `${task.id}-${trial}`);
    fs.mkdirSync(cwd);
    return { cwd, api, close: async () => undefined };
  };

const runBenchmark = (dir: string, api: Api, at: string): Promise<Result> =>
  exported<RunBenchmark>('runBenchmark')(path.join(dir, 'benchmark.json'), { open: openIn(api, at), probe: nodeProbe, files: nodeWorkspaceFiles, model: 'fake/system', codeDigest: 'sha256:build', groupBy: 'model' });

const fixTheBug = (cwd: string): void => fs.writeFileSync(path.join(cwd, 'src/add.js'), ADD_FIXED);

describe('momonga eval bench: the trials of a benchmark (3.3)', () => {
  it('runs every task its number of times in a fresh copy of its repository, with the mode, the model and the budget of the task', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({ edit: fixTheBug });
    const at = scratch();
    const { report, trialsRun } = await runBenchmark(dir, fake.api, at);

    expect([...fake.sessions.values()].map((session) => [session.permissionMode, session.model])).toEqual(Array.from({ length: 3 }, () => ['acceptEdits', 'fake/system']));
    const workspaces = [...fake.sessions.values()].map((session) => session.cwd);
    expect(new Set(workspaces).size).toBe(3);
    for (const workspace of workspaces) expect(workspace.startsWith(at)).toBe(true);
    expect([...fake.runs.values()].map((run) => [run.input, run.timeoutMs, run.limits])).toEqual(Array.from({ length: 3 }, () => ['Fix add.', 60000, { maxSteps: 10, maxTotalTokens: 100000 }]));
    expect(fs.readFileSync(path.join(dir, 'repos/fix/src/add.js'), 'utf8')).not.toBe(ADD_FIXED);

    expect(trialsRun).toBe(3);
    expect(report.population?.notRun).toEqual([]);
    expect(report.kind).toBe('benchmark');
    expect(report.harness).toMatchObject({ suite: { name: 'fixture' }, codeDigest: 'sha256:build', answeredBy: [{ target: 'fake/system', answers: 'script' }], unrecordedAnswers: 0 });
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 3, met: 3 })]);
  });

  it('takes met from the oracle and not from the status of the run: a completed run that left the bug, or edited the protected test, is not met', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({
      edit: (cwd, trial) => {
        if (trial === 0) fixTheBug(cwd);
        if (trial === 1) fs.writeFileSync(path.join(cwd, 'test/add.test.js'), CHEATING_TEST);
      },
    });
    const { report } = await runBenchmark(dir, fake.api, scratch());
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 3, met: 1 })]);
  });

  const declaring = async (declaration: unknown[]): Promise<string> => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const file = path.join(dir, 'benchmark.json');
    const benchmark = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: { declaration: unknown[] }[] };
    (benchmark.tasks[0] as { declaration: unknown[] }).declaration = declaration;
    fs.writeFileSync(file, JSON.stringify(benchmark));
    return dir;
  };

  it('sends the declaration of a task to its run as the mandate, and no mandate for a task that declares nothing', async () => {
    const declared = fakeApi({ edit: fixTheBug });
    await runBenchmark(await declaring([{ id: 'tests', command: 'node --test', when: 'always' }]), declared.api, scratch());
    expect([...declared.runs.values()].map((run) => run.mandate)).toEqual(
      Array.from({ length: 3 }, () => ({ completion: { conditions: [{ id: 'tests', command: 'node --test', when: 'always' }] } })),
    );
    const undeclared = fakeApi({ edit: fixTheBug });
    await runBenchmark(await declaring([]), undeclared.api, scratch());
    expect([...undeclared.runs.values()].map((run) => 'mandate' in run)).toEqual([false, false, false]);
  });

  it('counts a trial in the Task Completion Rate by the declaration its run pinned, with met from the oracle', async () => {
    const fake = fakeApi({ edit: (cwd, trial) => (trial === 0 ? fixTheBug(cwd) : undefined) });
    const { report } = await runBenchmark(await declaring([{ id: 'tests', command: 'node --test', when: 'always' }]), fake.api, scratch());
    expect(report.total.completion).toEqual({ k: 1, n: 3, undeclared: 0 });
  });

  it('counts a trial as declared by the declaration of its task alone: a standing condition of the settings does not declare a task that declares nothing', async () => {
    const nothingPinned = fakeApi({ edit: fixTheBug, pinned: () => false });
    const declared = await runBenchmark(await declaring([{ id: 'tests', command: 'node --test', when: 'always' }]), nothingPinned.api, scratch());
    expect(declared.report.total.completion).toEqual({ k: 3, n: 3, undeclared: 0 });
    const standing = fakeApi({ edit: fixTheBug, pinned: () => true });
    const settings = await runBenchmark(await declaring([]), standing.api, scratch());
    expect(settings.report.total.completion).toEqual({ k: 0, n: 0, undeclared: 3 });
  });

  it('answers an ask with the option the task names and counts the trial as needing a person', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({ edit: fixTheBug, ask: true });
    const { report } = await runBenchmark(dir, fake.api, scratch());
    expect(fake.resolved.map((entry) => entry.optionId)).toEqual(['yes', 'yes', 'yes']);
    expect(report.total.intervention).toEqual({ k: 3, n: 3 });
  });

  it('continues a trial that asks about a call whose effect is unknown, by the ask rule of the task', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({ edit: fixTheBug, unknownEffect: true });
    const { report } = await runBenchmark(dir, fake.api, scratch());
    expect(fake.resolved).toEqual([1, 2, 3].map((run) => ({ approvalId: `unknown-run-${run}`, optionId: 'continue' })));
    expect(fake.cancelled).toEqual([]);
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 3, met: 3 })]);
  });

  it('folds the facts of the child runs of a trial into the trial: a child that asked makes the task one that needed a person, and stays one task (2.2)', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({ edit: fixTheBug, delegate: true });
    const { report } = await runBenchmark(dir, fake.api, scratch());
    expect(fake.resolved.map((entry) => entry.approvalId)).toEqual(['approval-child-of-run-1', 'approval-child-of-run-2', 'approval-child-of-run-3']);
    expect(fake.asked).toEqual(['child-of-run-1', 'child-of-run-2', 'child-of-run-3']);
    expect(report.total.intervention).toEqual({ k: 3, n: 3 });
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 3, met: 3 })]);
  });

  it('writes the grader files after the run, so the run never sees them', async () => {
    const hidden = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('hidden', () => assert.strictEqual(add(1, 1), 2));\n";
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED }, graderFiles: { 'test/hidden.test.js': hidden } }]);
    const seen: boolean[] = [];
    const fake = fakeApi({
      edit: (cwd) => {
        seen.push(fs.existsSync(path.join(cwd, 'test/hidden.test.js')));
        fixTheBug(cwd);
      },
    });
    const { report } = await runBenchmark(dir, fake.api, scratch());
    expect(seen).toEqual([false, false, false]);
    expect(report.tasks).toEqual([expect.objectContaining({ met: 3 })]);
  });

  it('records a trial whose setup fails as not run, and never creates its run', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const file = path.join(dir, 'benchmark.json');
    const benchmark = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: { setup: unknown[]; runs: number }[] };
    (benchmark.tasks[0] as { setup: unknown[] }).setup = [{ run: 'exit 3', timeoutMs: 5000 }];
    fs.writeFileSync(file, JSON.stringify(benchmark));
    const fake = fakeApi({ edit: fixTheBug });
    const { report, trialsRun } = await runBenchmark(dir, fake.api, scratch());
    expect(trialsRun).toBe(0);
    expect(report.population?.notRun).toEqual([0, 1, 2].map((trial) => ({ id: `task fix trial ${trial}`, reason: 'its setup did not exit 0' })));
    expect(fake.runs.size).toBe(0);
    expect(report.tasks).toEqual([]);
  });

  it('refuses a repository whose content is not the one the benchmark file names', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    fs.writeFileSync(path.join(dir, 'repos/fix/src/extra.js'), 'exports.extra = 1;\n');
    await expect(runBenchmark(dir, fakeApi().api, scratch())).rejects.toThrow(/fix.*digest/);
  });

  it('refuses to build a report when a run did not get the budget the task declares', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const fake = fakeApi({ edit: fixTheBug, limits: { maxSteps: 50, maxTotalTokens: 100000 } });
    await expect(runBenchmark(dir, fake.api, scratch())).rejects.toThrow(/maxSteps 50/);
  });
});
