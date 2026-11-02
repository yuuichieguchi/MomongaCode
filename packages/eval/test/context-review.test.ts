import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_TAIL_RANK, CONTEXT_DATASET_FORMAT, EvalError, MINIMUM_PAIRS, buildContextReport, formatContextReport, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { compacted, contextCase, fidelity, governing, historyRead, marked, padding, read, recorded, summarized } from './context-fixtures.ts';

const sample = (both: Record<string, unknown> = {}, onOnly: Record<string, unknown> = {}) =>
  parseContextDataset(
    JSON.stringify({
      format: CONTEXT_DATASET_FORMAT,
      name: 'sample',
      cases: [
        { ...contextCase('s1-on', 's1', 'on'), ...both, ...onOnly },
        { ...contextCase('s1-off', 's1', 'off'), ...both },
        contextCase('s2-on', 's2', 'on'),
        contextCase('s2-off', 's2', 'off'),
      ],
    }),
    'sample.json',
  );

const build = (dataset: ReturnType<typeof sample>, transcripts: Transcript[]) => buildContextReport({ dataset, transcripts, model: 'real', seed: 1 });

const base = (s1On: RunEventPayload[], s2On: RunEventPayload[] = [summarized(2, fidelity([], 1, 1))], s1Off: RunEventPayload[] = [], s2Off: RunEventPayload[] = []): Transcript[] => [
  recorded('s1-on', 0, s1On),
  recorded('s1-off', 0, s1Off),
  recorded('s2-on', 0, s2On),
  recorded('s2-off', 0, s2Off),
];

describe('the constants of the bootstrap', () => {
  it('derives the tail rank from the resample count', () => {
    expect(BOOTSTRAP_TAIL_RANK).toBe((BOOTSTRAP_RESAMPLES + 1) / 40);
  });

  it('requires the smallest number of pairs whose resamples are not single observations', () => {
    expect(MINIMUM_PAIRS).toBe(4);
    expect(3 ** -3).toBeGreaterThan(0.025);
    expect(4 ** -4).toBeLessThan(0.025);
  });
});

describe('what a compacted run is', () => {
  it('counts the runs that compacted, not the runs of an on case', () => {
    const report = build(sample(), base([summarized(2, fidelity([], 1, 1))], []));
    expect(report.metrics.continuationRate).toMatchObject({ successes: 1, trials: 1 });
  });

  it('leaves the rate undefined when no run compacted', () => {
    const report = build(sample(), base([], []));
    expect(report.metrics.continuationRate).toBeUndefined();
  });

  it('refuses a run of an off case that holds a compaction, because the comparison would be void', () => {
    expect(() => build(sample(), base([summarized(2, fidelity([], 1, 1))], undefined, [compacted(1, 'model')]))).toThrow(EvalError);
  });

  it('refuses it in a child run too', () => {
    const child = { runId: 'child-1', agent: 'explore', events: recorded('s1-off', 0, [compacted(1, 'model')]).events };
    const transcripts = base([summarized(2, fidelity([], 1, 1))]).map((entry) => (entry.caseId === 's1-off' ? { ...entry, children: [child] } : entry));
    expect(() => build(sample(), transcripts)).toThrow(/off/);
  });

  it('scores a scenario as contrastive only when its on case compacted', () => {
    const noCompaction = build(sample(), base([], [summarized(2, fidelity([], 1, 1))]));
    expect(noCompaction.metrics.contrastiveFailures).toEqual({ count: 0, n: 1 });
    const failing = base([], [summarized(2, fidelity([], 1, 1))]).map((entry) => (entry.caseId === 's2-on' ? recorded('s2-on', 0, [summarized(2, fidelity([], 1, 1))], { status: 'FAILED' }) : entry));
    expect(build(sample(), failing).metrics.contrastiveFailures).toEqual({ count: 1, n: 1 });
  });
});

describe('what a run is made of', () => {
  it('counts the compactions and loss signals of child runs, each judged against its own seqs', () => {
    const childEvents = recorded('x', 0, [...read('r1', '/p/a.ts', 'same'), summarized(2, fidelity(['ghost.ts'], 2, 1)), ...read('r2', '/p/a.ts', 'same')]).events;
    const child = { runId: 'child-1', agent: 'explore', events: childEvents };
    const transcripts = base([summarized(2, fidelity([], 1, 1))]).map((entry) => (entry.caseId === 's1-on' ? { ...entry, children: [child] } : entry));
    const report = build(sample(), transcripts);
    expect(report.metrics.fabricationRate).toMatchObject({ successes: 1, trials: 3 });
    expect(report.metrics.lossSignalsPerCompaction).toMatchObject({ signals: 1, compactions: 3 });
  });

  it('refuses a gold range beyond the last seq of a run, which would inflate recall', () => {
    const dataset = sample({}, { gold: [{ seqFrom: 1, seqTo: 50 }] });
    expect(() => build(dataset, base([summarized(2, fidelity([], 1, 1)), ...padding(2)]))).toThrow(EvalError);
  });

  it('measures retrieval against a range a marked call fixes', () => {
    const early = [...read('r1', '/p/a.ts', 'one'), ...padding(1)];
    const dataset = sample({}, { gold: [marked(early, 'r1')] });
    const report = build(dataset, base([...early, summarized(3, fidelity([], 1, 1)), ...historyRead('h1', 1, 2)]));
    expect(report.metrics.retrievalRecall).toMatchObject({ successes: 2, trials: 2 });
  });
});

describe('provenance of a report', () => {
  it('carries a digest of the dataset and the model aliases the runs pinned', () => {
    const transcripts = base([summarized(3, fidelity([], 1, 1))], [summarized(3, fidelity([], 1, 1))]).map((entry) =>
      entry.caseId === 's1-on' ? { ...entry, run: { ...entry.run, modelAlias: 'alias-b' } } : entry.caseId === 's2-on' ? { ...entry, run: { ...entry.run, modelAlias: 'alias-a' } } : entry,
    );
    const report = build(sample(), transcripts);
    expect(report.datasetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.datasetDigest).not.toBe(build(sample({ input: 'another task' }), base([summarized(2, fidelity([], 1, 1))])).datasetDigest);
    expect(report.modelAliases).toEqual(['alias-a', 'alias-b']);
  });

  it('says that the kind of model is declared by the operator', () => {
    expect(formatContextReport(build(sample(), base([summarized(2, fidelity([], 1, 1))])))).toMatch(/declared by the operator/);
  });
});

describe('rates whose trials cluster inside a case', () => {
  it('spreads the interval over cases, not over the identifiers inside them', () => {
    const transcripts = base([summarized(2, fidelity([], 500, 500))], [summarized(2, fidelity([], 500, 0))]);
    const retention = build(sample(), transcripts).metrics.identifierRetention;
    expect(retention).toMatchObject({ successes: 500, trials: 1000, clusters: 2, low: 0, high: 1 });
  });

  it('prints the unit of the interval', () => {
    expect(formatContextReport(build(sample(), base([summarized(2, fidelity([], 2, 2))], [])))).toMatch(/identifierRetention 2\/2 = 100\.0% \(95% bootstrap over 1 case\(s\)/);
  });
});

describe('what governance reads', () => {
  it('counts a run with rules and no loaded set as measured, and says how many had no event', () => {
    const rules = [{ id: 'r', kind: 'constraint', target: 't', text: 'x', inScope: true, live: true, supersedes: [] }];
    const dataset = sample({ rules });
    const report = build(dataset, base([summarized(2, fidelity([], 1, 1))], undefined, [governing('r')]));
    expect(report.governanceRunsWithoutEvent).toBe(1);
    expect(report.metrics.governanceFidelity).toMatchObject({ successes: 1, trials: 2 });
  });
});
