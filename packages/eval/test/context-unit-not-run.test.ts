import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, buildContextReport, formatContextReport, parseContextDataset } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { contextCase, padding, read, recorded } from './context-fixtures.ts';

const NEEDLE = 'NEEDLE-7f3a: the deploy key rotates on the 14th';

const dataset = () =>
  parseContextDataset(
    JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'gold', cases: [{ ...contextCase('g-on', 'g', 'on'), gold: [{ anchor: 'NEEDLE-7f3a', in: 'tool.completed' }] }, contextCase('g-off', 'g', 'off')] }),
    'gold.json',
  );

const reportOf = (payloads: RunEventPayload[]): ContextReport =>
  buildContextReport({
    dataset: dataset(),
    transcripts: [answeredBy(recorded('g-on', 0, payloads), REAL_TARGET), answeredBy(recorded('g-off', 0, []), REAL_TARGET)],
    seed: 1,
  } as Parameters<typeof buildContextReport>[0]);

describe('a run of eval context that cannot be measured is a not run row with its reason (DECISION-5)', () => {
  it('a run that never carried its gold anchor does not end the report: the run is listed with the reason and counted as failed', () => {
    const report = reportOf([...padding(3), ...read('r0', '/p/notes.txt', 'nothing here')]);
    expect(report.stopped).toEqual([{ caseId: 'g-on', runIndex: 0, reason: expect.stringMatching(/could not be measured: the gold anchor "NEEDLE-7f3a" is carried by 0 tool.completed event/) }]);
    expect(report.cases.find((entry) => entry.id === 'g-on')).toMatchObject({ runs: 1, passedRuns: 0 });
    expect(formatContextReport(report)).toContain('stopped g-on run 0: could not be measured');
  });

  it('a run that carries its anchor once is measured as before', () => {
    const report = reportOf([...padding(3), ...read('r0', '/p/notes.txt', `notes\n${NEEDLE}\nend`)]);
    expect(report.stopped).toEqual([]);
  });
});
