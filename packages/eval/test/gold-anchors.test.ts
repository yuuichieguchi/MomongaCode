import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, DatasetError, EvalError, buildContextReport, goldRangesOf, parseContextDataset, retrievalOf } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { contextCase, historyRead, marked, padding, read, recorded } from './context-fixtures.ts';
import { publicEventsOf } from './fixtures.ts';

const NEEDLE = 'NEEDLE-7f3a: the deploy key rotates on the 14th';
const OTHER = 'NEEDLE-91c2: the cache warms at 06:00';

const planted = (): RunEventPayload[] => [...padding(3), ...read('r0', '/p/notes.txt', `notes\n${NEEDLE}\nend`), ...padding(2), ...read('r1', '/p/other.txt', 'nothing here')];

const userPlanted = (): RunEventPayload[] => [...padding(2), { type: 'user.message', text: `remember ${OTHER}` }, ...padding(2)];

const toolGold = [{ anchor: 'NEEDLE-7f3a', in: 'tool.completed' }] as const;

describe('gold anchors resolve to the event that carries them', () => {
  it('a tool.completed anchor resolves to the seq range of its call and its completion', () => {
    const events = publicEventsOf(planted());
    expect(goldRangesOf(toolGold, events)).toEqual([marked(planted(), 'r0')]);
  });

  it('a user.message anchor resolves to the seq of that message', () => {
    const events = publicEventsOf(userPlanted());
    const message = events.find((event) => event.type === 'user.message' && event.text.includes('NEEDLE-91c2'));
    const seq = (message as { seq: number }).seq;
    expect(goldRangesOf([{ anchor: 'NEEDLE-91c2', in: 'user.message' }], events)).toEqual([{ seqFrom: seq, seqTo: seq }]);
  });

  it('an anchor carried by no event of the run is an EvalError', () => {
    expect(() => goldRangesOf([{ anchor: 'NEEDLE-absent', in: 'tool.completed' }], publicEventsOf(planted()))).toThrow(EvalError);
  });

  it('an anchor carried by two events is an EvalError, never a guess', () => {
    const twice = [...planted(), ...read('r2', '/p/copy.txt', NEEDLE)];
    expect(() => goldRangesOf(toolGold, publicEventsOf(twice))).toThrow(EvalError);
  });

  it('an anchor in a user message does not match a tool.completed gold entry', () => {
    expect(() => goldRangesOf([{ anchor: 'NEEDLE-91c2', in: 'tool.completed' }], publicEventsOf(userPlanted()))).toThrow(EvalError);
  });

  it('retrieval precision and recall over resolved ranges', () => {
    const range = marked(planted(), 'r0');
    const payloads = [...planted(), ...historyRead('h0', range.seqFrom, range.seqTo + 2)];
    const events = publicEventsOf(payloads);
    expect(retrievalOf(goldRangesOf(toolGold, events), events)).toEqual({ relevant: 2, retrieved: 4, gold: 2 });
  });
});

describe('a case states its gold as anchors, and the report resolves them', () => {
  const datasetWith = (gold: unknown) =>
    parseContextDataset(
      JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'gold', cases: [{ ...contextCase('g-on', 'g', 'on'), gold }, contextCase('g-off', 'g', 'off')] }),
      'gold.json',
    );

  it('accepts gold anchors and refuses the old seq ranges', () => {
    expect(() => datasetWith([{ anchor: 'NEEDLE-7f3a', in: 'tool.completed' }])).not.toThrow();
    expect(() => datasetWith([{ seqFrom: 1, seqTo: 4 }])).toThrow(DatasetError);
    expect(() => datasetWith([{ anchor: 'NEEDLE-7f3a', in: 'model.requested' }])).toThrow(DatasetError);
  });

  it('measures retrieval wherever the run placed the anchor, whatever its seq', () => {
    const range = marked(planted(), 'r0');
    const early = [...planted(), ...historyRead('h0', range.seqFrom, range.seqTo)];
    const late = [...padding(9), ...planted(), ...historyRead('h0', range.seqFrom + 9, range.seqTo + 9)];
    const reportOf = (payloads: RunEventPayload[]): ContextReport =>
      buildContextReport({
        dataset: datasetWith(toolGold),
        transcripts: [answeredBy(recorded('g-on', 0, payloads), REAL_TARGET), answeredBy(recorded('g-off', 0, []), REAL_TARGET)],
        seed: 1,
      } as Parameters<typeof buildContextReport>[0]);
    for (const payloads of [early, late]) {
      const metrics = reportOf(payloads).metrics;
      expect(metrics.retrievalRecall).toMatchObject({ successes: 2, trials: 2 });
      expect(metrics.retrievalPrecision).toMatchObject({ successes: 2, trials: 2 });
    }
  });
});
