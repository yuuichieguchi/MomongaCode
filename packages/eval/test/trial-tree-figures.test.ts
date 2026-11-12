import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeWorkspaceFiles, runBenchmark } from '@momonga/eval';
import type { BenchRunApi, BenchRunView } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { ADD_FIXED, benchmarkDir, nodeProbe } from './bench-fixtures.ts';
import { createTempDir } from '@momonga/testkit';

const T0 = 1_800_000_000_000;
const ROOT_TOKENS = 30;
const CHILD_TOKENS = 5;

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const withBudget = (dir: string, maxTotalTokens: number): void => {
  const file = path.join(dir, 'benchmark.json');
  const benchmark = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: { budget: { maxTotalTokens: number }; runs: number }[] };
  for (const task of benchmark.tasks) {
    task.budget.maxTotalTokens = maxTotalTokens;
    task.runs = 1;
  }
  fs.writeFileSync(file, JSON.stringify(benchmark));
};

const delegatingApi = (): BenchRunApi => {
  const timeouts = new Map<string, { sessionId: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number } }>();
  const envelope = (runId: string, sessionId: string, seq: number) => ({ id: seq, runId, sessionId, seq, step: 0, createdAt: T0 + seq });
  const view = (runId: string): BenchRunView => {
    const child = runId.startsWith('child-');
    const root = timeouts.get(child ? runId.slice('child-'.length) : runId);
    if (root === undefined) throw new Error(`no run ${runId}`);
    return {
      sessionId: child ? `child-session-${runId}` : root.sessionId,
      status: 'COMPLETED',
      createdAt: T0,
      deadlineAt: T0 + root.timeoutMs,
      limits: child ? {} : root.limits,
      step: 1,
      tokensTotal: child ? CHILD_TOKENS : ROOT_TOKENS,
      origin: 'trusted',
      agent: child ? 'explore' : 'main',
      mode: 'acceptEdits',
      model: 'fake/system',
      declared: false,
    };
  };
  return {
    createSession: async () => ({ id: 'session-1' }),
    createRun: async (sessionId, input) => {
      const id = `run-${timeouts.size + 1}`;
      timeouts.set(id, { sessionId, timeoutMs: input.timeoutMs, limits: input.limits });
      return { id };
    },
    events: async function* (runId): AsyncGenerator<PublicRunEvent> {
      if (runId.startsWith('child-')) {
        const sessionId = `child-session-${runId}`;
        yield { ...envelope(runId, sessionId, 1), type: 'run.status', from: 'QUEUED', to: 'RUNNING' } as PublicRunEvent;
        yield { ...envelope(runId, sessionId, 2), type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
        return;
      }
      yield { ...envelope(runId, 'session-1', 1), type: 'run.status', from: 'QUEUED', to: 'RUNNING' } as PublicRunEvent;
      yield { ...envelope(runId, 'session-1', 2), type: 'run.started', attempt: 1 } as PublicRunEvent;
      yield { ...envelope(runId, 'session-1', 3), type: 'tool.waiting', callId: 'call-agent', awaits: { kind: 'run', runId: `child-${runId}`, sessionId: `child-session-child-${runId}`, agent: 'explore' } } as PublicRunEvent;
      yield { ...envelope(runId, 'session-1', 4), type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
    },
    runOf: async (runId) => view(runId),
    costs: async (runIds) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
    answeredBy: async (runId) => (runId.startsWith('child-') ? [{ target: 'child/model', answers: 'model' }] : [{ target: 'root/model', answers: 'model' }]),
    resolveApproval: async () => undefined,
    cancelRun: async () => undefined,
  };
};

const run = async (maxTotalTokens: number) => {
  const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
  withBudget(dir, maxTotalTokens);
  const at = createTempDir();
  scratches.push(at);
  const api = delegatingApi();
  return runBenchmark(path.join(dir, 'benchmark.json'), {
    open: async (task, trial) => {
      const cwd = path.join(at, `${task.id}-${trial}`);
      fs.mkdirSync(cwd);
      return { cwd, api, close: async () => undefined };
    },
    probe: nodeProbe,
    files: nodeWorkspaceFiles,
    model: 'fake/system',
    codeDigest: 'sha256:build',
    groupBy: 'model',
  });
};

describe('the figures of a trial are read over its whole run tree', () => {
  it('counts the tokens of a child run in the token total of the trial', async () => {
    const over = await run(ROOT_TOKENS + CHILD_TOKENS - 1);
    expect(over.report.total.overrun).toMatchObject({ k: 1, n: 1 });
    const within = await run(ROOT_TOKENS + CHILD_TOKENS);
    expect(within.report.total.overrun).toMatchObject({ k: 0, n: 1 });
  });

  it('records the answerers of the child runs of a trial with those of its root', async () => {
    const { report } = await run(100000);
    expect(report.harness?.answeredBy.map((answerer) => answerer.target).sort()).toEqual(['child/model', 'root/model']);
    expect(report.harness?.unrecordedAnswers).toBe(0);
  });
});
