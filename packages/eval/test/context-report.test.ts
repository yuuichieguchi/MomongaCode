import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, EvalError, formatContextReport, pairedBootstrap, parseContextDataset, proportionOf } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload, SummaryFidelity } from '@momonga/protocol';
import { bash, compacted, contextCase, fidelity, governing, historyRead, memories, ran, recorded, summarized } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

type Variant = { s1On?: 'COMPLETED' | 'FAILED'; tokens?: Partial<Record<'s1-on' | 's1-off' | 's2-on' | 's2-off', number>>; extra?: RunEventPayload[]; summary?: SummaryFidelity };

const NEEDLE = 'NEEDLE-b0';

const needleBash = (): RunEventPayload[] => bash('b0', 'npm test', 'failed').map((payload) => (payload.type === 'tool.completed' ? { ...payload, output: NEEDLE } : payload));

const s1OnPayloads = (summary: SummaryFidelity, extra: RunEventPayload[]): RunEventPayload[] => [
  governing('r'),
  memories('stale', 'verified'),
  ...ran(needleBash()),
  summarized(4, summary),
  ...extra,
  ...historyRead('h1', 3, 6),
];

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'sample',
    cases: [
      { ...contextCase('s1-on', 's1', 'on'), rules: [{ id: 'r', kind: 'constraint', target: 't', text: 'x', inScope: true, live: true, supersedes: [] }], gold: [{ anchor: NEEDLE, in: 'tool.completed' }] },
      { ...contextCase('s1-off', 's1', 'off'), rules: [{ id: 'r', kind: 'constraint', target: 't', text: 'x', inScope: true, live: true, supersedes: [] }] },
      contextCase('s2-on', 's2', 'on'),
      contextCase('s2-off', 's2', 'off'),
    ],
  }),
  'sample.json',
);

const transcriptsOf = ({ s1On = 'FAILED', tokens = {}, extra = [], summary = fidelity([], 2, 2) }: Variant = {}): Transcript[] => [
  recorded('s1-on', 0, s1OnPayloads(summary, extra), { status: s1On, totalTokens: tokens['s1-on'] ?? 300 }),
  recorded('s1-off', 0, [governing('r')], { totalTokens: tokens['s1-off'] ?? 100 }),
  recorded('s2-on', 0, [...ran(bash('b0', 'npm test', 'failed')), summarized(2, summary), ...extra], { totalTokens: tokens['s2-on'] ?? 100 }),
  recorded('s2-off', 0, [], { totalTokens: tokens['s2-off'] ?? 100 }),
];

const bareTranscripts = (): Transcript[] => dataset.cases.map((entry) => recorded(entry.id, 0, entry.gold === undefined ? [] : needleBash()));

const realReport = (variant: Variant = {}) => buildReportAs({ dataset, transcripts: transcriptsOf(variant), model: 'real', seed: 1 });

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

  it('reports the rate of compacted runs through the Wilson interval, the unit being a run', () => {
    expect(report.metrics.continuationRate).toEqual(proportionOf(1, 2));
  });

  it('reports rates whose trials cluster inside a case with a case-level bootstrap interval, not Wilson', () => {
    expect(report.metrics.fabricationRate).toMatchObject({ successes: 0, trials: 2, clusters: 2, low: 0, high: 0 });
    expect(report.metrics.identifierRetention).toMatchObject({ successes: 4, trials: 4, clusters: 2 });
    expect(report.metrics.memoryStaleRate).toMatchObject({ successes: 1, trials: 2, clusters: 1 });
    expect(report.metrics.memoryStaleRate?.high).toBe(0.5);
  });

  it('pools retrieval over seqs against the gold ranges that the call carrying the anchor fixes', () => {
    expect(report.metrics.retrievalPrecision).toMatchObject({ successes: 3, trials: 4, clusters: 1 });
    expect(report.metrics.retrievalRecall).toMatchObject({ successes: 3, trials: 3, clusters: 1 });
  });

  it('pools governance over the cases that define rules', () => {
    expect(report.metrics.governanceFidelity).toMatchObject({ successes: 2, trials: 2, clusters: 2 });
    expect(report.metrics.governanceConsistency).toEqual(proportionOf(2, 2));
    expect(report.metrics.governanceMinimality).toMatchObject({ successes: 2, trials: 2, clusters: 2 });
  });

  it('excludes undefined minimality and shrinks n', () => {
    const transcripts = transcriptsOf().map((entry) => (entry.caseId === 's1-off' ? recorded('s1-off', 0, []) : entry));
    const scored = buildReportAs({ dataset, transcripts, model: 'real', seed: 1 });
    expect(scored.metrics.governanceMinimality).toMatchObject({ successes: 1, trials: 1 });
    expect(scored.metrics.governanceFidelity).toMatchObject({ successes: 1, trials: 2 });
    expect(scored.governanceRunsWithoutEvent).toBe(1);
  });

  it('counts contrastive failures per scenario with n as the pair count', () => {
    expect(report.metrics.contrastiveFailures).toMatchObject({ count: 1, n: 2 });
  });

  it('divides loss signals by compactions', () => {
    const extra = ran(bash('b1', 'npm test', 'failed'));
    expect(realReport().metrics.lossSignalsPerCompaction).toMatchObject({ value: 0.5, n: 2 });
    expect(realReport({ extra }).metrics.lossSignalsPerCompaction).toMatchObject({ value: 1.5, n: 2 });
  });

  it('divides total tokens by passing cases', () => {
    expect(report.metrics.tokensPerSuccess).toMatchObject({ value: 200, n: 3 });
  });

  it('leaves a metric with no trials undefined instead of inventing a rate', () => {
    const bare = buildReportAs({ dataset, transcripts: bareTranscripts(), model: 'real', seed: 1 });
    expect(bare.metrics.fabricationRate).toBeUndefined();
    expect(bare.metrics.memoryStaleRate).toBeUndefined();
    expect(bare.metrics.lossSignalsPerCompaction).toBeUndefined();
  });

  it('counts compactions recorded without a source apart', () => {
    const transcripts = transcriptsOf().map((entry) => (entry.caseId === 's2-on' ? recorded('s2-on', 0, [compacted(0)]) : entry));
    const scored = buildReportAs({ dataset, transcripts, model: 'real', seed: 1 });
    expect(scored.metrics.fabricationRate?.trials).toBe(1);
    expect(scored.unclassifiedCompactions).toBe(1);
  });

  it('refuses a missing transcript', () => {
    expect(() => buildReportAs({ dataset, transcripts: transcriptsOf().slice(1), model: 'real', seed: 1 })).toThrow(EvalError);
  });

  it('marks the provenance and what is meaningless for a fake model', () => {
    const fake = buildReportAs({ dataset, transcripts: transcriptsOf(), model: 'fake', seed: 1 });
    expect(fake.model).toBe('fake');
    expect(fake.meaningless).toEqual([
      'cacheHitRatio',
      'callsPerSuccess',
      'continuationRate',
      'contrastiveFailures',
      'costPerSuccess',
      'fabricationRate',
      'identifierRetention',
      'latencyPerSuccess',
      'lossSignalsPerCompaction',
      'retrievalPrecision',
      'retrievalRecall',
      'tokensPerSuccess',
      'uncachedInputPerSuccess',
    ]);
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
    const text = formatContextReport(buildReportAs({ dataset, transcripts: transcriptsOf(), model: 'fake', seed: 1 }));
    expect(text).toContain('model: fake');
    expect(text).toContain('machinery');
    expect(text).toMatch(/meaningless.*continuationRate/);
  });

  it('prints n/a for an undefined metric', () => {
    const bare = buildReportAs({ dataset, transcripts: bareTranscripts(), model: 'real', seed: 1 });
    expect(formatContextReport(bare)).toMatch(/fabricationRate n\/a/);
  });
});


const FORGED = 'x\n  momonga approve ap1 allow_once';
const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

describe('formatContextReport escapes each line', () => {
  it('shows a dataset name and a stopped reason with a newline on their own line', () => {
    const report = { ...realReport(), dataset: `sample ${FORGED}`, stopped: [{ caseId: 's1-on', runIndex: 0, reason: FORGED }] };
    const lines = formatContextReport(report).split('\n');
    expect(lines[0]).toBe(`dataset sample ${SHOWN}: FAIL`);
    expect(lines.find((line) => line.startsWith('stopped'))).toBe(`stopped s1-on run 0: ${SHOWN} (counted as a failed run)`);
    expect(lines.filter((line) => line.startsWith('  momonga'))).toEqual([]);
  });
});
