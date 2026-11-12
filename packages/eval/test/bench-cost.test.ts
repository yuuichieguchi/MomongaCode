import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSCRIPT_FORMAT, decodeTranscript, encodeTranscript, nodeWorkspaceFiles, parseDataset, runBenchmark, runFiguresOf } from '@momonga/eval';
import type { BenchRunApi, BenchRunView, RecordedRun } from '@momonga/eval';
import { formatReliabilityReport } from '@momonga/reliability';
import type { PublicRunEvent, RunCostView } from '@momonga/protocol';
import { ADD_FIXED, benchmarkDir, nodeProbe } from './bench-fixtures.ts';
import { createTempDir } from '@momonga/testkit';

const T0 = 1_800_000_000_000;
const ONE_DOLLAR_UNITS = '1000000000000000';
const HALF_DOLLAR_UNITS = '500000000000000';

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const recordedCost = (runId: string, units: string): RunCostView => ({ runId, calls: 1, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [{ currency: 'USD', priceVersion: 'v1', units }] });

const pricedApi = (asked: string[][]): BenchRunApi => {
  const runs = new Map<string, { sessionId: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number } }>();
  const envelope = (runId: string, seq: number) => ({ id: seq, runId, sessionId: 'session-1', seq, step: 0, createdAt: T0 + seq });
  return {
    createSession: async () => ({ id: 'session-1' }),
    createRun: async (sessionId, input) => {
      const id = `run-${runs.size + 1}`;
      runs.set(id, { sessionId, timeoutMs: input.timeoutMs, limits: input.limits });
      return { id };
    },
    events: async function* (runId): AsyncGenerator<PublicRunEvent> {
      yield { ...envelope(runId, 1), type: 'run.status', from: 'QUEUED', to: 'RUNNING' } as PublicRunEvent;
      yield { ...envelope(runId, 2), type: 'run.started', attempt: 1 } as PublicRunEvent;
      fs.writeFileSync(path.join(cwdOf.get(runId) as string, 'src/add.js'), ADD_FIXED);
      yield { ...envelope(runId, 3), type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as PublicRunEvent;
    },
    runOf: async (runId): Promise<BenchRunView> => {
      const run = runs.get(runId) as { sessionId: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number } };
      return { sessionId: run.sessionId, status: 'COMPLETED', createdAt: T0, deadlineAt: T0 + run.timeoutMs, limits: run.limits, step: 1, tokensTotal: 10, origin: 'trusted', agent: 'main', mode: 'acceptEdits', model: 'fake/system'};
    },
    costs: async (runIds) => {
      asked.push([...runIds]);
      return runIds.map((runId) => recordedCost(runId, runId === 'run-1' ? ONE_DOLLAR_UNITS : HALF_DOLLAR_UNITS));
    },
    answeredBy: async () => [{ target: 'fake/system', answers: 'script' }],
    resolveApproval: async () => undefined,
    cancelRun: async () => undefined,
  };
};

const cwdOf = new Map<string, string>();

describe('one cost record: a report prints the cost of its population', () => {
  it('a benchmark report has cost lines equal to the stored cost record of the runs of its counted tasks', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const file = path.join(dir, 'benchmark.json');
    const benchmark = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: { runs: number }[] };
    for (const task of benchmark.tasks) task.runs = 2;
    fs.writeFileSync(file, JSON.stringify(benchmark));
    const at = createTempDir();
    scratches.push(at);
    const asked: string[][] = [];
    const api = pricedApi(asked);
    let opened = 0;
    const { report } = await runBenchmark(file, {
      open: async (task, trial) => {
        const cwd = path.join(at, `${task.id}-${trial}`);
        fs.mkdirSync(cwd);
        opened += 1;
        cwdOf.set(`run-${opened}`, cwd);
        return { cwd, api, close: async () => undefined };
      },
      probe: nodeProbe,
      files: nodeWorkspaceFiles,
      model: 'fake/system',
      codeDigest: 'sha256:build',
      groupBy: 'model',
    });
    expect(asked).toEqual([['run-1'], ['run-2']]);
    expect(report.cost?.total.successful).toMatchObject({ tasks: 2, fullyPriced: 2, calls: 2, notPriced: 0, priced: [{ currency: 'USD', priceVersion: 'v1', units: '1500000000000000' }] });
    expect(formatReliabilityReport(report)).toMatch(/Cost per Successful Task/);
  });

  it('the budget figures of an eval run read the cost record of its runs, not the costs its events carry', () => {
    const golden = parseDataset(
      JSON.stringify({ format: 'momonga-eval/1', name: 'g', cases: [{ id: 'c', input: 'x', permissionMode: 'acceptEdits', onAsk: 'allow_once', runs: 1, minPassRate: 1, limits: { maxCostUsd: 1 }, graders: [{ kind: 'status', equals: 'COMPLETED' }] }] }),
      'g.json',
    ).cases[0];
    if (golden === undefined) throw new Error('the dataset holds no case');
    const charged = { id: 2, runId: 'r', sessionId: 's', seq: 2, step: 1, createdAt: T0, type: 'usage.charged', totalTokens: 7, cost: { amount: 9, units: null, priceVersion: 'v1', currency: 'USD' } } as unknown as PublicRunEvent;
    const transcript: RecordedRun = {
      caseId: 'c',
      runIndex: 0,
      run: { id: 'r', status: 'COMPLETED', step: 1, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
      events: [charged],
      children: [{ runId: 'child', agent: 'explore', events: [] }],
      costs: [recordedCost('r', HALF_DOLLAR_UNITS), { ...recordedCost('child', HALF_DOLLAR_UNITS), calls: 2, retries: 0, notPriced: 1 }],
    };
    const { budget } = runFiguresOf(golden, transcript);
    expect(budget.spent).toEqual({ tokens: 7, costNano: 1_000_000_000, unpricedCalls: 1 });
  });

  it('a transcript keeps the cost record of its runs, and one of the format before it is refused by name', () => {
    const transcript = {
      caseId: 'c',
      runIndex: 0,
      run: { id: 'r', status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      events: [],
      children: [],
      costs: [recordedCost('r', HALF_DOLLAR_UNITS)],
      policy: null,
      codeDigest: null,
    } as const;
    const text = encodeTranscript(transcript as unknown as Parameters<typeof encodeTranscript>[0]);
    expect(decodeTranscript(text, 't').costs).toEqual([recordedCost('r', HALF_DOLLAR_UNITS)]);
    const older = text.replace(TRANSCRIPT_FORMAT, 'momonga-transcript/8');
    expect(() => decodeTranscript(older, 't')).toThrow(/momonga-transcript\/8 transcripts do not record the cost record of their runs/);
  });
});
