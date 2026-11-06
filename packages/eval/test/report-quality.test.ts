import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, buildContextReport, parseContextDataset } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { bash, contextCase, fidelity, governing, historyRead, marked, memories, padding, read, recorded, summarized } from './context-fixtures.ts';

const rule = (id: string, inScope: boolean) => ({ id, kind: 'constraint', target: `t-${id}`, text: `rule ${id}`, inScope, live: true, supersedes: [] });

const RULES = [rule('r1', true), rule('r2', true), rule('r3', false)];

const planted = (): RunEventPayload[] => [governing('r1', 'r3'), memories('stale', 'verified', 'verified'), ...read('r0', '/p/notes.txt', 'NEEDLE-5b1e lives here'), ...padding(2)];

const onPayloads = (): RunEventPayload[] => {
  const range = marked(planted(), 'r0');
  return [...planted(), ...historyRead('h0', range.seqFrom, range.seqTo + 2), ...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))];
};

const dataset = () => parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'quality-cells',
    cases: [
      { ...contextCase('q-on', 'q', 'on'), rules: RULES, gold: [{ anchor: 'NEEDLE-5b1e', in: 'tool.completed' }] },
      { ...contextCase('q-off', 'q', 'off'), rules: RULES },
    ],
  }),
  'quality-cells.json',
);

const report = (): ContextReport =>
  buildContextReport({
    dataset: dataset(),
    transcripts: [answeredBy(recorded('q-on', 0, onPayloads()), REAL_TARGET), answeredBy(recorded('q-off', 0, [governing('r1', 'r2')]), REAL_TARGET)],
    seed: 1,
  } as Parameters<typeof buildContextReport>[0]);

const qualityOf = (caseId: string): Record<string, { numerator: number; denominator: number }> | undefined =>
  (report().cases.find((entry) => entry.id === caseId) as unknown as { quality?: Record<string, { numerator: number; denominator: number }> }).quality;

describe('a case report carries numerator and denominator per quality metric', () => {
  it('the on case: one of two binding rules loaded among two loaded, one of three memories stale, two of four read events in gold, its one compacted run passed', () => {
    expect(qualityOf('q-on')).toEqual({
      continuationRate: { numerator: 1, denominator: 1 },
      governanceFidelity: { numerator: 1, denominator: 2 },
      governanceConsistency: { numerator: 0, denominator: 1 },
      governanceMinimality: { numerator: 1, denominator: 2 },
      memoryStaleRate: { numerator: 1, denominator: 3 },
      retrievalPrecision: { numerator: 2, denominator: 4 },
      retrievalRecall: { numerator: 2, denominator: 2 },
    });
  });

  it('the off case: both binding rules loaded and nothing else, nothing recalled, no gold and no compaction', () => {
    expect(qualityOf('q-off')).toEqual({
      continuationRate: { numerator: 0, denominator: 0 },
      governanceFidelity: { numerator: 2, denominator: 2 },
      governanceConsistency: { numerator: 1, denominator: 1 },
      governanceMinimality: { numerator: 2, denominator: 2 },
      memoryStaleRate: { numerator: 0, denominator: 0 },
      retrievalPrecision: { numerator: 0, denominator: 0 },
      retrievalRecall: { numerator: 0, denominator: 0 },
    });
  });

  it('the report metrics are the sums of the case cells', () => {
    const { metrics } = report();
    expect(metrics.governanceFidelity).toMatchObject({ successes: 3, trials: 4 });
    expect(metrics.memoryStaleRate).toMatchObject({ successes: 1, trials: 3 });
    expect(metrics.retrievalPrecision).toMatchObject({ successes: 2, trials: 4 });
    expect(qualityOf('q-on')).toBeDefined();
  });
});
