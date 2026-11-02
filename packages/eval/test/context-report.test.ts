import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, EvalError, buildContextReport, compareContextReports, formatContextComparison, formatContextReport, pairedBootstrap, parseContextDataset, proportionOf } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload, SummaryFidelity } from '@momonga/protocol';
import { bash, compacted, contextCase, fidelity, governing, historyRead, memories, recorded } from './context-fixtures.ts';

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'sample',
    cases: [
      { ...contextCase('s1-on', 's1', 'on'), rules: [{ id: 'r', kind: 'constraint', target: 't', text: 'x', inScope: true, live: true, supersedes: [] }], gold: [{ seqFrom: 1, seqTo: 4 }] },
      { ...contextCase('s1-off', 's1', 'off'), rules: [{ id: 'r', kind: 'constraint', target: 't', text: 'x', inScope: true, live: true, supersedes: [] }] },
      contextCase('s2-on', 's2', 'on'),
      contextCase('s2-off', 's2', 'off'),
    ],
  }),
  'sample.json',
);

type Variant = { s1On?: 'COMPLETED' | 'FAILED'; tokens?: Partial<Record<'s1-on' | 's1-off' | 's2-on' | 's2-off', number>>; extra?: RunEventPayload[]; summary?: SummaryFidelity };

const transcriptsOf = ({ s1On = 'FAILED', tokens = {}, extra = [], summary = fidelity([], 2, 2) }: Variant = {}): Transcript[] => [
  recorded('s1-on', 0, [governing('r'), memories('stale', 'verified'), ...bash('b0', 'npm test', 'failed'), compacted(4, 'model', summary), ...extra, ...historyRead('h1', 3, 6)], { status: s1On, totalTokens: tokens['s1-on'] ?? 300 }),
  recorded('s1-off', 0, [governing('r')], { totalTokens: tokens['s1-off'] ?? 100 }),
  recorded('s2-on', 0, [...bash('b0', 'npm test', 'failed'), compacted(2, 'model', summary), ...extra], { totalTokens: tokens['s2-on'] ?? 100 }),
  recorded('s2-off', 0, [], { totalTokens: tokens['s2-off'] ?? 100 }),
];

const realReport = (variant: Variant = {}) => buildContextReport({ dataset, transcripts: transcriptsOf(variant), model: 'real' });

const checkOf = (name: string, baseline = realReport(), candidate = realReport({ s1On: 'COMPLETED' })) => compareContextReports(baseline, candidate, { seed: 1 }).gate.checks.find((check) => check.name === name);

describe('pairedBootstrap', () => {
  const spread = [1, -2, 3, 0, 5, -1, 2, 2, 7, -3];

  it('states n and the mean', () => {
    const interval = pairedBootstrap(spread, { seed: 1 });
    expect(interval.n).toBe(10);
    expect(interval.mean).toBeCloseTo(1.4, 12);
  });

  it('is reproducible under a fixed seed', () => {
    expect(pairedBootstrap(spread, { seed: 42 })).toEqual(pairedBootstrap(spread, { seed: 42 }));
  });

  it('uses the seed', () => {
    const intervals = new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(pairedBootstrap(spread, { seed }))));
    expect(intervals.size).toBeGreaterThan(1);
  });

  it('collapses on constant differences', () => {
    expect(pairedBootstrap([0, 0, 0], { seed: 1 })).toEqual({ mean: 0, low: 0, high: 0, n: 3 });
    expect(pairedBootstrap([2, 2], { seed: 1 })).toEqual({ mean: 2, low: 2, high: 2, n: 2 });
  });

  it('brackets the mean inside the observed range', () => {
    const { mean, low, high } = pairedBootstrap(spread, { seed: 9 });
    expect(low).toBeLessThan(mean);
    expect(high).toBeGreaterThan(mean);
    expect(low).toBeGreaterThanOrEqual(-3);
    expect(high).toBeLessThanOrEqual(7);
  });

  it('refuses no pairs', () => {
    expect(() => pairedBootstrap([], { seed: 1 })).toThrow(RangeError);
  });
});

describe('buildContextReport', () => {
  const report = realReport();

  it('reports rates through proportionOf', () => {
    expect(report.metrics.continuationRate).toEqual(proportionOf(1, 2));
    expect(report.metrics.fabricationRate).toEqual(proportionOf(0, 2));
    expect(report.metrics.identifierRetention).toEqual(proportionOf(4, 4));
    expect(report.metrics.memoryStaleRate).toEqual(proportionOf(1, 2));
  });

  it('pools retrieval over seqs against the gold ranges', () => {
    expect(report.metrics.retrievalPrecision).toEqual(proportionOf(2, 4));
    expect(report.metrics.retrievalRecall).toEqual(proportionOf(2, 4));
  });

  it('pools governance over the cases that define rules', () => {
    expect(report.metrics.governanceFidelity).toEqual(proportionOf(2, 2));
    expect(report.metrics.governanceConsistency).toEqual(proportionOf(2, 2));
    expect(report.metrics.governanceMinimality).toEqual(proportionOf(2, 2));
  });

  it('excludes undefined minimality and shrinks n', () => {
    const transcripts = transcriptsOf().map((entry) => (entry.caseId === 's1-off' ? recorded('s1-off', 0, []) : entry));
    const scored = buildContextReport({ dataset, transcripts, model: 'real' });
    expect(scored.metrics.governanceMinimality).toEqual(proportionOf(1, 1));
    expect(scored.metrics.governanceFidelity).toEqual(proportionOf(1, 2));
  });

  it('counts contrastive failures per scenario with n as the pair count', () => {
    expect(report.metrics.contrastiveFailures).toMatchObject({ count: 1, n: 2 });
  });

  it('divides loss signals by compactions', () => {
    const extra = bash('b1', 'npm test', 'failed');
    expect(realReport().metrics.lossSignalsPerCompaction).toMatchObject({ value: 0.5, n: 2 });
    expect(realReport({ extra }).metrics.lossSignalsPerCompaction).toMatchObject({ value: 1.5, n: 2 });
  });

  it('divides total tokens by passing cases', () => {
    expect(report.metrics.tokensPerSuccess).toMatchObject({ value: 200, n: 3 });
  });

  it('leaves a metric with no trials undefined instead of inventing a rate', () => {
    const bare = buildContextReport({ dataset, transcripts: dataset.cases.map((entry) => recorded(entry.id, 0, [])), model: 'real' });
    expect(bare.metrics.fabricationRate).toBeUndefined();
    expect(bare.metrics.memoryStaleRate).toBeUndefined();
    expect(bare.metrics.lossSignalsPerCompaction).toBeUndefined();
  });

  it('counts compactions recorded without a source apart', () => {
    const transcripts = transcriptsOf().map((entry) => (entry.caseId === 's2-on' ? recorded('s2-on', 0, [compacted(0)]) : entry));
    const scored = buildContextReport({ dataset, transcripts, model: 'real' });
    expect(scored.metrics.fabricationRate?.trials).toBe(1);
    expect(scored.unclassifiedCompactions).toBe(1);
  });

  it('refuses a missing transcript', () => {
    expect(() => buildContextReport({ dataset, transcripts: transcriptsOf().slice(1), model: 'real' })).toThrow(EvalError);
  });

  it('marks the provenance and what is meaningless for a fake model', () => {
    const fake = buildContextReport({ dataset, transcripts: transcriptsOf(), model: 'fake' });
    expect(fake.model).toBe('fake');
    expect(fake.meaningless).toEqual(['continuationRate', 'contrastiveFailures', 'fabricationRate', 'identifierRetention', 'lossSignalsPerCompaction', 'retrievalPrecision', 'retrievalRecall', 'tokensPerSuccess']);
    expect(report.model).toBe('real');
    expect(report.meaningless).toEqual([]);
  });
});

describe('formatContextReport', () => {
  it('states the provenance, the Wilson interval and n', () => {
    const text = formatContextReport(realReport());
    expect(text).toContain('model: real');
    expect(text).toMatch(/continuationRate 1\/2 = 50\.0% \(95% Wilson 9\.5%\.\.90\.5%\)/);
    expect(text).toMatch(/tokensPerSuccess 200.*n=3/);
    expect(text).toMatch(/contrastiveFailures 1.*n=2/);
  });

  it('says that a fake result proves only the machinery, and lists the meaningless metrics', () => {
    const text = formatContextReport(buildContextReport({ dataset, transcripts: transcriptsOf(), model: 'fake' }));
    expect(text).toContain('model: fake');
    expect(text).toContain('machinery');
    expect(text).toMatch(/meaningless.*continuationRate/);
  });

  it('prints n/a for an undefined metric', () => {
    const bare = buildContextReport({ dataset, transcripts: dataset.cases.map((entry) => recorded(entry.id, 0, [])), model: 'real' });
    expect(formatContextReport(bare)).toMatch(/fabricationRate n\/a/);
  });
});

describe('compareContextReports', () => {
  const fixed = realReport({ s1On: 'COMPLETED' });

  it('passes when contrastive failures drop and nothing else worsens', () => {
    const { gate } = compareContextReports(realReport(), fixed, { seed: 1 });
    expect(gate.checks.map((check) => [check.name, check.passed])).toEqual([
      ['real_model', true],
      ['contrastiveFailures', true],
      ['fabricationRate', true],
      ['lossSignalsPerCompaction', true],
      ['tokensPerSuccess', true],
    ]);
    expect(gate.passed).toBe(true);
  });

  it('reports paired differences with n', () => {
    const { differences } = compareContextReports(realReport(), realReport({ s1On: 'COMPLETED', tokens: { 's1-off': 150, 's2-on': 150, 's2-off': 150 } }), { seed: 1 });
    expect(differences.tokensPerSuccess).toEqual({ mean: 50, low: 50, high: 50, n: 3 });
    expect(differences.lossSignalsPerCompaction).toEqual({ mean: 0, low: 0, high: 0, n: 2 });
  });

  it('fails when contrastive failures are only equal', () => {
    const { gate } = compareContextReports(realReport(), realReport(), { seed: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((check) => check.name === 'contrastiveFailures')?.passed).toBe(false);
  });

  it('fails when contrastive failures rise', () => {
    expect(compareContextReports(fixed, realReport(), { seed: 1 }).gate.passed).toBe(false);
  });

  it('fails when the fabrication rate leaves the baseline Wilson interval', () => {
    expect(proportionOf(0, 2).high).toBeLessThan(1);
    const candidate = realReport({ s1On: 'COMPLETED', summary: fidelity(['ghost.ts'], 2, 2) });
    expect(checkOf('fabricationRate', realReport(), candidate)?.passed).toBe(false);
  });

  it('allows a fabrication rate inside the baseline Wilson interval', () => {
    const baseline = realReport({ summary: fidelity(['ghost.ts'], 2, 2) });
    expect(checkOf('fabricationRate', baseline, realReport({ s1On: 'COMPLETED', summary: fidelity(['ghost.ts'], 2, 2) }))?.passed).toBe(true);
  });

  it('fails when every paired compaction loses more', () => {
    const candidate = realReport({ s1On: 'COMPLETED', extra: bash('b1', 'npm test', 'failed') });
    expect(checkOf('lossSignalsPerCompaction', realReport(), candidate)?.passed).toBe(false);
  });

  it('fails when every paired success costs more tokens', () => {
    const candidate = realReport({ s1On: 'COMPLETED', tokens: { 's1-off': 150, 's2-on': 150, 's2-off': 150 } });
    expect(checkOf('tokensPerSuccess', realReport(), candidate)?.passed).toBe(false);
  });

  it('tolerates a token change whose interval spans zero', () => {
    const candidate = realReport({ s1On: 'COMPLETED', tokens: { 's1-off': 130, 's2-on': 70 } });
    expect(checkOf('tokensPerSuccess', realReport(), candidate)?.passed).toBe(true);
  });

  it('refuses reports over different cases, because they cannot be paired', () => {
    const other = { ...fixed, cases: fixed.cases.slice(1) };
    expect(() => compareContextReports(realReport(), other, { seed: 1 })).toThrow(EvalError);
  });

  it('never passes a fake model through the gate', () => {
    const fake = (s1On: 'COMPLETED' | 'FAILED') => buildContextReport({ dataset, transcripts: transcriptsOf({ s1On }), model: 'fake' });
    const { gate } = compareContextReports(fake('FAILED'), fake('COMPLETED'), { seed: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((check) => check.name === 'real_model')?.passed).toBe(false);
  });

  it('prints each difference with n, each check, and the verdict', () => {
    const passing = formatContextComparison(compareContextReports(realReport(), fixed, { seed: 1 }));
    expect(passing).toMatch(/tokensPerSuccess .*n=/);
    expect(passing).toMatch(/gate: PASS/);
    expect(formatContextComparison(compareContextReports(realReport(), realReport(), { seed: 1 }))).toMatch(/gate: FAIL[\s\S]*contrastiveFailures/);
  });
});
