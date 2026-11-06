import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, foldFacts, formatReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport, ReportKind } from '@momonga/reliability';
import { T0, eventsOf, runInfo, started, terminal } from './streams.ts';

const SUITE_DIGEST = 'a'.repeat(64);
const CODE_DIGEST = 'b'.repeat(64);

type Harness = { suite: { name: string; digest: string }; answeredBy: protocol.AnsweredByView[]; unrecordedAnswers: number; codeDigest: string };

const HARNESS: Harness = {
  suite: { name: 'fixture', digest: SUITE_DIGEST },
  answeredBy: [{ target: 'fm', adapter: 'fm', upstreamModel: 'fm-1', answers: 'model' }],
  unrecordedAnswers: 0,
  codeDigest: CODE_DIGEST,
};

const rows = [foldFacts(eventsOf('r1', [[T0, started(1, { declared: true })], [T0 + 100, terminal('COMPLETED')]]), runInfo({ runId: 'r1', status: 'COMPLETED' }))];

const build = (kind: ReportKind, harness: Harness | null): ReliabilityReport =>
  (buildReliabilityReport as (input: unknown) => ReliabilityReport)({ kind, aggregate: aggregate(rows, { groupBy: 'model' }), harness });

const encodedWith = (kind: ReportKind, harness: unknown): string => {
  const encoded = JSON.parse(encodeReliabilityReport(build('real', null))) as Record<string, unknown>;
  return JSON.stringify({ ...encoded, kind, harness });
};

describe('decision 47: the harness field of momonga-reliability/1', () => {
  it('a benchmark report carries the suite, the answerers, the unrecorded count and the code digest, and the decoder keeps them', () => {
    const report = build('benchmark', HARNESS);
    expect((report as unknown as { harness: unknown }).harness).toEqual(HARNESS);
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });

  it('an injection report keeps a scripted answerer through the round trip', () => {
    const scripted = { ...HARNESS, answeredBy: [{ target: 'script', adapter: 'script', upstreamModel: 'script', answers: 'script' }] } satisfies Harness;
    const decoded = decodeReliabilityReport(encodeReliabilityReport(build('injection', scripted)));
    expect((decoded as unknown as { harness: unknown }).harness).toEqual(scripted);
  });

  it('a real report has harness null', () => {
    expect((build('real', null) as unknown as { harness: unknown }).harness).toBeNull();
  });

  it('the decoder requires harness for benchmark and injection', () => {
    expect(() => decodeReliabilityReport(encodedWith('benchmark', null))).toThrow(/harness/);
    expect(() => decodeReliabilityReport(encodedWith('injection', null))).toThrow(/harness/);
  });

  it('the decoder refuses harness on a real report', () => {
    expect(() => decodeReliabilityReport(encodedWith('real', HARNESS))).toThrow(/harness/);
  });

  it('the decoder refuses a harness without a code digest', () => {
    const withoutCode = { suite: HARNESS.suite, answeredBy: HARNESS.answeredBy, unrecordedAnswers: HARNESS.unrecordedAnswers };
    expect(() => decodeReliabilityReport(encodedWith('benchmark', withoutCode))).toThrow(/codeDigest/);
  });
});

describe('decision 47: modelKindOf lives in protocol', () => {
  const modelKindOf = (protocol as Record<string, unknown>)['modelKindOf'] as
    | ((answeredBy: readonly protocol.AnsweredByView[], unrecordedAnswers: number) => string)
    | undefined;

  it('is exported by @momonga/protocol', () => {
    expect(typeof modelKindOf).toBe('function');
  });

  it('any script answerer is fake; an unknown answerer or an unrecorded answer is unknown; declared models are real', () => {
    if (modelKindOf === undefined) throw new Error('@momonga/protocol does not export modelKindOf');
    const model = { target: 'm', adapter: 'a', upstreamModel: 'u', answers: 'model' as const };
    expect(modelKindOf([model, { ...model, target: 's', answers: 'script' }], 0)).toBe('fake');
    expect(modelKindOf([model, { ...model, target: 'x', answers: 'unknown' }], 0)).toBe('unknown');
    expect(modelKindOf([model], 1)).toBe('unknown');
    expect(modelKindOf([], 0)).toBe('unknown');
    expect(modelKindOf([model], 0)).toBe('real');
  });
});

describe('3.3 item 4 and 4.3: per-task rows, per-scenario rows and X3 witnessed', () => {
  const TASKS = [
    { task: 'fix-add', trials: 3, met: 2, difficulty: 'easy', taskType: 'bug_fix' },
    { task: 'lint', trials: 3, met: 0, difficulty: 'medium', taskType: 'lint_fix' },
  ];
  const SCENARIOS = [{ scenario: 'kill-after-effect', trials: 3, episodes: 3, recovered: 2 }];
  const WITNESSED = { k: 1, n: 3 };

  const buildWith = (kind: ReportKind, extra: Record<string, unknown>): ReliabilityReport =>
    (buildReliabilityReport as (input: unknown) => ReliabilityReport)({ kind, aggregate: aggregate(rows, { groupBy: 'model' }), harness: HARNESS, ...extra });

  it('a benchmark report carries its per-task rows through the round trip', () => {
    const report = buildWith('benchmark', { tasks: TASKS });
    expect((report as unknown as { tasks: unknown }).tasks).toEqual(TASKS);
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });

  it('an injection report carries its per-scenario rows and the witnessed duplicate rate through the round trip', () => {
    const report = buildWith('injection', { scenarios: SCENARIOS, witnessed: WITNESSED });
    expect((report as unknown as { scenarios: unknown; witnessed: unknown })).toMatchObject({ scenarios: SCENARIOS, witnessed: WITNESSED });
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });

  it('an injection report carries the scenarios that were not run, with their reasons, through the round trip and into its text', () => {
    const notRun = [{ id: 'disk-full', reason: 'linux-container: the scenario needs the Linux container' }];
    const report = buildWith('injection', { scenarios: SCENARIOS, notRun });
    expect(report.population).toEqual({ notRun });
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
    expect(formatReliabilityReport(report)).toContain('Not run: disk-full: linux-container');
  });

  it('the decoder refuses a population block on a benchmark report', () => {
    const encoded = JSON.parse(encodeReliabilityReport(buildWith('benchmark', { tasks: TASKS }))) as Record<string, unknown>;
    expect(() => decodeReliabilityReport(JSON.stringify({ ...encoded, population: { notRun: [] } }))).toThrow(/population/);
  });

  it('the decoder refuses a per-task row whose met exceeds its trials', () => {
    const encoded = JSON.parse(encodeReliabilityReport(buildWith('benchmark', { tasks: TASKS }))) as Record<string, unknown>;
    expect(() => decodeReliabilityReport(JSON.stringify({ ...encoded, tasks: [{ ...TASKS[0], met: 4 }] }))).toThrow(/met/);
  });
});
