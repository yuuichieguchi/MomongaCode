import path from 'node:path';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport } from '@momonga/reliability';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { ReportPage, RunCostView, RunFactsView } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { emitReliability, reliabilityText } from '../src/commands/reliability.ts';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const NOW = T0 + DAY;

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const clientOf = (rows: readonly RunFactsView[]) => ({
  reportFacts: async (): Promise<ReportPage> => ({ rows: [...rows], unavailable: [], nextCursor: null }),
  reportCost: async (runIds: readonly string[]): Promise<RunCostView[]> => runIds.map((runId) => ({ runId, calls: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
});

describe('momonga reliability --json and --out', () => {
  it('--json prints the report as one JSON document the report decoder reads', async () => {
    const text = await reliabilityText(clientOf([row('run-1'), row('run-2', { model: 'ollama/qwen' })]), { groupBy: 'model', explain: false, days: 30, json: true }, NOW);
    const report = decodeReliabilityReport(text);
    expect(report.kind).toBe('real');
    expect(report.groupBy).toBe('model');
    expect(report.period?.days).toBe(30);
    expect(Object.keys(report.groups)).toEqual(['apple/fm', 'ollama/qwen']);
    expect(report.total.buckets.counted).toBe(2);
  });

  it('--out stores the JSON report in the file named from the working folder and prints the text', async () => {
    const stored = new Map<string, string>();
    const out: string[] = [];
    const sinks = {
      cwd: '/work',
      stdout: { write: (text: string): boolean => (out.push(text), true) },
      files: { writeText: async (file: string, text: string): Promise<void> => void stored.set(file, text) },
    };
    await emitReliability(sinks, clientOf([row('run-1')]), { groupBy: 'model', explain: false, days: 30, json: false, out: 'reports/r.json' }, NOW);
    const file = stored.get(path.resolve('/work', 'reports/r.json'));
    expect(file).toBeDefined();
    expect(decodeReliabilityReport(file as string).total.buckets.counted).toBe(1);
    expect(out.join('')).toContain('Reliability report');
  });
});

describe('grouping by the labels of the benchmark declarations', () => {
  const labels = new Map([
    ['run-a', { taskType: 'bug_fix', difficulty: 'easy' }],
    ['run-b', { taskType: 'add_test', difficulty: 'hard' }],
    ['run-c', { taskType: 'bug_fix', difficulty: 'hard' }],
  ]);
  const rows = [row('run-a'), row('run-b'), row('run-c', { met: false, status: 'FAILED' }), row('run-c-child', { rootRunId: 'run-c' })];

  it('groups by taskType, a subagent run under the label of its root task, and the JSON keeps the groups', () => {
    const report = decodeReliabilityReport(encodeReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate(rows, { groupBy: 'taskType', labels }) })));
    expect(report.groupBy).toBe('taskType');
    expect(Object.keys(report.groups)).toEqual(['add_test', 'bug_fix']);
    expect(report.groups['bug_fix']?.completion).toEqual({ k: 1, n: 2, undeclared: 0 });
  });

  it('groups by difficulty', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregate(rows, { groupBy: 'difficulty', labels }) });
    expect(Object.keys(report.groups)).toEqual(['easy', 'hard']);
  });

  it('refuses a task label grouping of a task that has no label', () => {
    expect(() => buildReliabilityReport({ kind: 'real', aggregate: aggregate([row('run-x')], { groupBy: 'taskType', labels }) })).toThrow(/run-x/);
  });
});
