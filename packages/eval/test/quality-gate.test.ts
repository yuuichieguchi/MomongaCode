import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, MINIMUM_PAIRS, QUALITY_METRICS, buildContextReport, compareContextReports, parseContextDataset } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { bash, contextCase, fidelity, recorded, summarized } from './context-fixtures.ts';

const SCENARIOS = ['a', 'b', 'c', 'd', 'e'] as const;

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'quality-gate',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'quality-gate.json',
);

const baseReport = (): ContextReport =>
  buildContextReport({
    dataset,
    transcripts: SCENARIOS.flatMap((scenario) => [
      answeredBy(recorded(`${scenario}-on`, 0, [...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))]), REAL_TARGET),
      answeredBy(recorded(`${scenario}-off`, 0, []), REAL_TARGET),
    ]),
    seed: 1,
  } as Parameters<typeof buildContextReport>[0]);

type Cell = { numerator: number; denominator: number };

const withQuality = (report: ContextReport, metric: string, cell: (caseId: string, index: number) => Cell): ContextReport => ({
  ...report,
  cases: report.cases.map((entry, index) => ({
    ...entry,
    quality: { ...((entry as unknown as { quality?: Record<string, Cell> }).quality ?? {}), [metric]: cell(entry.id, index) },
  })),
});

const otherCode = (report: ContextReport): ContextReport => ({ ...report, codeDigest: 'd'.repeat(64) });

const GATES = ['context', 'token'] as const;

const checkOf = (baseline: ContextReport, candidate: ContextReport, gate: (typeof GATES)[number], name: string) =>
  compareContextReports(baseline, otherCode(candidate), { seed: 1, gate }).gate.checks.find((check) => check.name === name);

const SPECIFIED = [
  { name: 'continuationRate', direction: 'higher' },
  { name: 'governanceFidelity', direction: 'higher' },
  { name: 'governanceConsistency', direction: 'higher' },
  { name: 'governanceMinimality', direction: 'higher' },
  { name: 'memoryStaleRate', direction: 'lower' },
  { name: 'retrievalPrecision', direction: 'higher' },
  { name: 'retrievalRecall', direction: 'higher' },
] as const;

const NAMES = SPECIFIED.map((metric) => metric.name);

const best = (direction: string): Cell => (direction === 'higher' ? { numerator: 4, denominator: 4 } : { numerator: 0, denominator: 4 });
const worst = (direction: string): Cell => (direction === 'higher' ? { numerator: 0, denominator: 4 } : { numerator: 4, denominator: 4 });

describe('QUALITY_METRICS, the one table of quality metrics', () => {
  it('names the seven quality metrics of S 534 with the side that is better', () => {
    expect(QUALITY_METRICS).toEqual(SPECIFIED);
  });
});

describe.each(GATES)('the %s gate has one paired case-level term per quality metric', (gate) => {
  it.each(SPECIFIED.map((metric) => [metric.name, metric.direction]))(
    'a candidate that is worse on %s over all paired cases fails the term',
    (name, direction) => {
      const baseline = withQuality(baseReport(), name, () => best(direction));
      const candidate = withQuality(baseReport(), name, () => worst(direction));
      const check = checkOf(baseline, candidate, gate, name);
      expect(check).toBeDefined();
      expect(check?.passed).toBe(false);
      expect(check?.detail).toMatch(/paired/);
    },
  );

  it.each(NAMES)('an equal candidate passes the %s term', (name) => {
    const cell = () => ({ numerator: 1, denominator: 4 });
    const check = checkOf(withQuality(baseReport(), name, cell), withQuality(baseReport(), name, cell), gate, name);
    expect(check?.passed).toBe(true);
  });

  it.each(NAMES)('fewer than MINIMUM_PAIRS cases measuring %s in both reports is no measure', (name) => {
    const cell = (_caseId: string, index: number): Cell => (index < MINIMUM_PAIRS - 1 ? { numerator: 1, denominator: 4 } : { numerator: 0, denominator: 0 });
    const check = checkOf(withQuality(baseReport(), name, cell), withQuality(baseReport(), name, cell), gate, name);
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/^no measure: /);
  });

  it.each(NAMES)('%s without data in either report fails with no measure', (name) => {
    const measured = withQuality(baseReport(), name, () => ({ numerator: 1, denominator: 4 }));
    const empty = withQuality(baseReport(), name, () => ({ numerator: 0, denominator: 0 }));
    expect(checkOf(measured, empty, gate, name)?.passed).toBe(false);
    expect(checkOf(measured, empty, gate, name)?.detail).toMatch(/no measure/);
    expect(checkOf(empty, measured, gate, name)?.passed).toBe(false);
  });

  it('pairs only the cases measured in both reports: a candidate that stops measuring three of ten cases is judged on the seven', () => {
    const name = 'governanceFidelity';
    const baseline = withQuality(baseReport(), name, () => ({ numerator: 4, denominator: 4 }));
    const candidate = withQuality(baseReport(), name, (_caseId, index) => (index < 3 ? { numerator: 0, denominator: 0 } : { numerator: 4, denominator: 4 }));
    const check = checkOf(baseline, candidate, gate, name);
    expect(check?.passed).toBe(true);
    expect(check?.detail).toMatch(/n=7/);
  });

  it('a candidate that recalls no memory at all cannot pass memoryStaleRate by having nothing stale', () => {
    const baseline = withQuality(baseReport(), 'memoryStaleRate', () => ({ numerator: 1, denominator: 4 }));
    const silent = withQuality(baseReport(), 'memoryStaleRate', () => ({ numerator: 0, denominator: 0 }));
    const check = checkOf(baseline, silent, gate, 'memoryStaleRate');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/no measure/);
  });

  it('a gate whose quality terms all pass still lists each of them once', () => {
    let baseline = baseReport();
    let candidate = baseReport();
    for (const name of NAMES) {
      baseline = withQuality(baseline, name, () => ({ numerator: 2, denominator: 4 }));
      candidate = withQuality(candidate, name, () => ({ numerator: 2, denominator: 4 }));
    }
    const names = compareContextReports(baseline, otherCode(candidate), { seed: 1, gate }).gate.checks.map((check) => check.name);
    for (const name of NAMES) expect(names.filter((entry) => entry === name)).toHaveLength(1);
  });
});
