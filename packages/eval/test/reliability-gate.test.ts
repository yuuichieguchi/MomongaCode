import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import * as protocol from '@momonga/protocol';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { AnsweredByView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport, ReportKind } from '@momonga/reliability';
import { modelKindOf } from '@momonga/eval';
import { ADD_FIXED, benchmarkDir, exported } from './bench-fixtures.ts';

const CREATED_AT = 1_800_000_000_000;
const FIXTURE_LIMITS = { maxSteps: 10, maxTotalTokens: 100000 };
const FIXTURE_TIMEOUT_MS = 60000;
const MODEL: AnsweredByView = { target: 'fm', adapter: 'fm', upstreamModel: 'fm-1', answers: 'model' };
const SCRIPT: AnsweredByView = { target: 'script', adapter: 'script', upstreamModel: 'script', answers: 'script' };

type Trial = { taskId: string; trial: number; facts: RunFactsView; children: RunFactsView[] };
type BenchmarkInput = { benchmark: unknown; trials: readonly Trial[]; answeredBy: readonly AnsweredByView[]; unrecordedAnswers: number; codeDigest: string; groupBy: 'model' };

const factsOf = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: `s-${runId}`,
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'fm',
  mode: 'acceptEdits',
  agent: 'build',
  origin: 'eval',
  status: 'COMPLETED',
  createdAt: CREATED_AT,
  endedAt: CREATED_AT + 1000,
  elapsedMs: 1000,
  humanWaitMs: 0,
  tokensTotal: 10,
  steps: 1,
  limits: FIXTURE_LIMITS,
  deadlineAt: CREATED_AT + FIXTURE_TIMEOUT_MS,
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const fixture = async (): Promise<{ text: string; benchmark: unknown }> => {
  const dir = await benchmarkDir([{ id: 'fix-add', reference: { 'src/add.js': ADD_FIXED } }]);
  const text = fs.readFileSync(path.join(dir, 'benchmark.json'), 'utf8');
  const parse = exported<(text: string, source: string) => unknown>('parseBenchmark');
  return { text, benchmark: parse(text, 'benchmark.json') };
};

const buildBenchmarkReport = (input: BenchmarkInput): ReliabilityReport => exported<(input: BenchmarkInput) => ReliabilityReport>('buildBenchmarkReport')(input);

const trialsWith = (third: Partial<RunFactsView>): Trial[] => [
  { taskId: 'fix-add', trial: 1, facts: factsOf('t1'), children: [] },
  { taskId: 'fix-add', trial: 2, facts: factsOf('t2'), children: [] },
  { taskId: 'fix-add', trial: 3, facts: factsOf('t3', third), children: [] },
];

const inputOf = (benchmark: unknown, trials: readonly Trial[]): BenchmarkInput => ({
  benchmark,
  trials,
  answeredBy: [MODEL],
  unrecordedAnswers: 0,
  codeDigest: 'c'.repeat(64),
  groupBy: 'model',
});

describe('decision 47: the benchmark report builder', () => {
  it('builds a benchmark report whose harness holds the suite name, the digest of the parsed file, the answerers and the code digest', async () => {
    const { text, benchmark } = await fixture();
    const report = buildBenchmarkReport(inputOf(benchmark, trialsWith({})));
    expect(report.kind).toBe('benchmark');
    expect((report as unknown as { harness: unknown }).harness).toEqual({
      suite: { name: 'fixture', digest: sha256Hex(canonicalJson(JSON.parse(text))) },
      answeredBy: [MODEL],
      unrecordedAnswers: 0,
      codeDigest: 'c'.repeat(64),
    });
  });

  const mismatches: [string, Partial<RunFactsView>][] = [
    ['the recorded mode differs from the task permissionMode', { mode: 'manual' }],
    ['the recorded maxSteps differs from budget.maxSteps', { limits: { ...FIXTURE_LIMITS, maxSteps: 50 } }],
    ['the recorded maxTotalTokens differs from budget.maxTotalTokens', { limits: { ...FIXTURE_LIMITS, maxTotalTokens: 1_000_000 } }],
    ['deadlineAt - createdAt differs from budget.timeoutMs', { deadlineAt: CREATED_AT + FIXTURE_TIMEOUT_MS + 1 }],
  ];

  for (const [name, third] of mismatches) {
    it(`refuses to build when ${name}, naming the task and the trial`, async () => {
      const { benchmark } = await fixture();
      const build = (): ReliabilityReport => buildBenchmarkReport(inputOf(benchmark, trialsWith(third)));
      expect(build).toThrow(/fix-add/);
      expect(build).toThrow(/t3/);
    });
  }
});

describe('decision 47: one modelKindOf', () => {
  it('the eval export is the protocol function', () => {
    const shared = (protocol as Record<string, unknown>)['modelKindOf'];
    expect(shared).toBeTypeOf('function');
    expect(modelKindOf).toBe(shared);
  });
});

type Harness = { suite: { name: string; digest: string }; answeredBy: AnsweredByView[]; unrecordedAnswers: number; codeDigest: string };
type GateResult = { gate: { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] } };

type TaskRow = { task: string; trials: number; met: number; difficulty: string; taskType: string };
type ScenarioRow = { scenario: string; trials: number; episodes: number; recovered: number };
type Rows = { tasks?: TaskRow[]; scenarios?: ScenarioRow[]; witnessed?: { k: number; n: number } };

const PAIRED_UNITS = 12;

const taskRows = (met: number): TaskRow[] =>
  Array.from({ length: PAIRED_UNITS }, (_, index) => ({ task: `task-${index}`, trials: 3, met, difficulty: 'easy', taskType: 'bug_fix' }));

const scenarioRows = (recovered: number): ScenarioRow[] =>
  Array.from({ length: PAIRED_UNITS }, (_, index) => ({ scenario: `scenario-${index}`, trials: 3, episodes: 3, recovered }));

const reportOf = (kind: ReportKind, harness: Partial<Harness> = {}, rows: Rows = {}): ReliabilityReport =>
  (buildReliabilityReport as (input: unknown) => ReliabilityReport)({
    kind,
    aggregate: aggregate([factsOf('t1')], { groupBy: 'model' }),
    harness: {
      suite: { name: 'fixture', digest: 'a'.repeat(64) },
      answeredBy: [kind === 'injection' ? SCRIPT : MODEL],
      unrecordedAnswers: 0,
      codeDigest: 'b'.repeat(64),
      ...harness,
    },
    ...(kind === 'benchmark' ? { tasks: rows.tasks ?? taskRows(3) } : { scenarios: rows.scenarios ?? scenarioRows(3), witnessed: rows.witnessed ?? { k: 0, n: PAIRED_UNITS } }),
  });

const compareReliability = (baseline: ReliabilityReport, candidate: ReliabilityReport): GateResult =>
  exported<(baseline: ReliabilityReport, candidate: ReliabilityReport, options: { seed: number }) => GateResult>('compareReliability')(baseline, candidate, { seed: 1 });

const candidateBuild = { codeDigest: 'c'.repeat(64) };

describe('decisions 47 and 48: --gate reliability refuses a pair it cannot judge', () => {
  it('refuses reports of different kinds', () => {
    expect(() => compareReliability(reportOf('benchmark'), reportOf('injection', candidateBuild))).toThrow(/kind/);
  });

  it('refuses a pair whose suite digests differ', () => {
    for (const kind of ['benchmark', 'injection'] as const) {
      expect(() => compareReliability(reportOf(kind), reportOf(kind, { ...candidateBuild, suite: { name: 'fixture', digest: 'd'.repeat(64) } }))).toThrow(/digest/);
    }
  });

  it('refuses a pair whose code digests are equal', () => {
    for (const kind of ['benchmark', 'injection'] as const) {
      expect(() => compareReliability(reportOf(kind), reportOf(kind))).toThrow(/code digest/);
    }
  });
});

describe('decision 48: the model term follows the kind', () => {
  const modelCheck = (result: GateResult) => {
    const check = result.gate.checks.find((entry) => entry.name === 'real_model');
    if (check === undefined) throw new Error('the gate has no real_model check');
    return check.passed;
  };

  it('benchmark: a scripted answerer fails the term on both sides', () => {
    const result = compareReliability(reportOf('benchmark', { answeredBy: [SCRIPT] }), reportOf('benchmark', { ...candidateBuild, answeredBy: [SCRIPT] }));
    expect(modelCheck(result)).toBe(false);
    expect(result.gate.passed).toBe(false);
  });

  it('benchmark: two different real models fail the term', () => {
    const other = { ...MODEL, target: 'other', upstreamModel: 'other-1' };
    expect(modelCheck(compareReliability(reportOf('benchmark'), reportOf('benchmark', { ...candidateBuild, answeredBy: [other] })))).toBe(false);
  });

  it('benchmark: the same real model passes the term', () => {
    expect(modelCheck(compareReliability(reportOf('benchmark'), reportOf('benchmark', candidateBuild)))).toBe(true);
  });

  it('injection: the same scripted answerer passes the term', () => {
    expect(modelCheck(compareReliability(reportOf('injection'), reportOf('injection', candidateBuild)))).toBe(true);
  });

  it('injection: different answerers fail the term', () => {
    const other = { ...SCRIPT, target: 'script-2' };
    expect(modelCheck(compareReliability(reportOf('injection'), reportOf('injection', { ...candidateBuild, answeredBy: [other] })))).toBe(false);
  });
});

describe('decision 48: no unpaired task or scenario', () => {
  it('benchmark: a task present on one side only is refused, naming it', () => {
    const fewer = taskRows(3).slice(1);
    expect(() => compareReliability(reportOf('benchmark'), reportOf('benchmark', candidateBuild, { tasks: fewer }))).toThrow(/task-0/);
  });

  it('injection: a scenario present on one side only is refused, naming it', () => {
    const fewer = scenarioRows(3).slice(1);
    expect(() => compareReliability(reportOf('injection'), reportOf('injection', candidateBuild, { scenarios: fewer }))).toThrow(/scenario-0/);
  });
});

const checkOf = (result: GateResult, name: string): boolean => {
  const check = result.gate.checks.find((entry) => entry.name === name);
  if (check === undefined) throw new Error(`the gate has no ${name} check: ${result.gate.checks.map((entry) => entry.name).join(', ')}`);
  return check.passed;
};

describe('decision 48 and 3.5: the interval terms, by the paired bootstrap of eval/src/bootstrap.ts over the per-unit differences (candidate - baseline) of the rate', () => {
  it('benchmark X1: every task falls from 3/3 to 0/3, every difference is -1, the interval is [-1, -1], wholly below 0, and the term fails', () => {
    const result = compareReliability(reportOf('benchmark'), reportOf('benchmark', candidateBuild, { tasks: taskRows(0) }));
    expect(checkOf(result, 'completionRate')).toBe(false);
    expect(result.gate.passed).toBe(false);
  });

  it('benchmark X1: identical rows give every difference 0, the interval [0, 0], and the term passes', () => {
    const result = compareReliability(reportOf('benchmark'), reportOf('benchmark', candidateBuild));
    expect(checkOf(result, 'completionRate')).toBe(true);
    expect(result.gate.passed).toBe(true);
  });

  it('injection X2: every scenario falls from 3/3 recovered to 0/3, the interval is [-1, -1], and the term fails', () => {
    const result = compareReliability(reportOf('injection'), reportOf('injection', candidateBuild, { scenarios: scenarioRows(0) }));
    expect(checkOf(result, 'recoveryRate')).toBe(false);
    expect(result.gate.passed).toBe(false);
  });

  it('injection X2: identical rows give the interval [0, 0], and the term passes', () => {
    const result = compareReliability(reportOf('injection'), reportOf('injection', candidateBuild));
    expect(checkOf(result, 'recoveryRate')).toBe(true);
    expect(result.gate.passed).toBe(true);
  });
});

describe('decision 48: the witnessed duplicates of the injection candidate are 0', () => {
  it('one witnessed duplicate in the candidate fails the term and the gate', () => {
    const result = compareReliability(reportOf('injection'), reportOf('injection', candidateBuild, { witnessed: { k: 1, n: PAIRED_UNITS } }));
    expect(checkOf(result, 'witnessedDuplicates')).toBe(false);
    expect(result.gate.passed).toBe(false);
  });

  it('a witnessed duplicate in the baseline only does not fail the term', () => {
    const result = compareReliability(reportOf('injection', {}, { witnessed: { k: 1, n: PAIRED_UNITS } }), reportOf('injection', candidateBuild));
    expect(checkOf(result, 'witnessedDuplicates')).toBe(true);
  });
});
