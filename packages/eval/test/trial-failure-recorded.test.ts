import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeReliabilityReport, encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';
import { nodeWorkspaceFiles, runBenchmark } from '@momonga/eval';
import type { BenchRunApi } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { ADD_FIXED, benchmarkDir, nodeProbe } from './bench-fixtures.ts';
import { createTempDir } from '@momonga/testkit';

const T0 = 1_800_000_000_000;

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const apiFailingOn = (failing: number): BenchRunApi => {
  const runs = new Map<string, { timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number } }>();
  let created = 0;
  return {
    createSession: async () => ({ id: 'session-1' }),
    createRun: async (_sessionId, input) => {
      created += 1;
      if (created === failing) throw new Error('the daemon refused the run');
      const id = `run-${created}`;
      runs.set(id, { timeoutMs: input.timeoutMs, limits: input.limits });
      return { id };
    },
    events: async function* (runId): AsyncGenerator<PublicRunEvent> {
      yield { id: 1, runId, sessionId: 'session-1', seq: 1, step: 0, createdAt: T0, type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
    },
    runOf: async (runId) => {
      const run = runs.get(runId) as { timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number } };
      return { sessionId: 'session-1', status: 'COMPLETED', createdAt: T0, deadlineAt: T0 + run.timeoutMs, limits: run.limits, step: 1, tokensTotal: 1, origin: 'trusted', agent: 'main', mode: 'acceptEdits', model: 'fake/system', declared: false };
    },
    costs: async (runIds) => runIds.map((runId) => ({ runId, calls: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
    answeredBy: async () => [{ target: 'fake/system', adapter: 'chat-completions', upstreamModel: 'fake', answers: 'script' }],
    resolveApproval: async () => undefined,
    cancelRun: async () => undefined,
  };
};

const run = async (dir: string, api: BenchRunApi) => {
  const at = createTempDir();
  scratches.push(at);
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

describe('a trial that cannot be made is a recorded outcome of that trial', () => {
  it('one trial throws, the others run, and the report holds the failed trial as not run with its reason', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const { report } = await run(dir, apiFailingOn(2));
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 2 })]);
    expect(report.population?.notRun).toEqual([{ id: 'task fix trial 1', reason: 'the daemon refused the run' }]);
    expect(formatReliabilityReport(report)).toContain('Not run: task fix trial 1: the daemon refused the run');
    expect(decodeReliabilityReport(encodeReliabilityReport(report)).population?.notRun).toHaveLength(1);
  });

  it('a trial whose setup fails is a row of the report marked not run', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const file = path.join(dir, 'benchmark.json');
    const benchmark = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: { setup: unknown[] }[] };
    (benchmark.tasks[0] as { setup: unknown[] }).setup = [{ run: 'exit 3', timeoutMs: 5000 }];
    fs.writeFileSync(file, JSON.stringify(benchmark));
    const { report } = await run(dir, apiFailingOn(0));
    expect(report.population?.notRun).toEqual([0, 1, 2].map((trial) => ({ id: `task fix trial ${trial}`, reason: 'its setup did not exit 0' })));
    expect(report.tasks).toEqual([]);
  });
});
