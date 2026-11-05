import { describe, expect, it } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { JOURNAL_SCAN_RANGE_ROWS, createJournalReader } from '@momonga/store';
import type { TerminalContribution } from '@momonga/store';
import { enqueue, harness, mustClaim, mustRun, newSession, registerCleanup } from './helpers.ts';

const DELTAS = 6_000;

const responded = (step: number): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

const delta = (index: number): RunEventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_1', text: `piece ${index}` });

type Trace = { maxRowsBetweenUnits: number; rowsStepped: number; units: number };

const measuredRun = (hook: TerminalContribution): Trace & { journalRows: number } => {
  const h = harness();
  const run = enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  expect(h.store.append(claim, [responded(1), ...Array.from({ length: DELTAS }, (_unused, index) => delta(index)), responded(2)]).kind).toBe('ok');
  const journalRows = mustRun(h.store, run.id).lastSeq;
  const db = openDatabase(h.dbPath);
  registerCleanup(() => db.close());
  const trace: Trace = { maxRowsBetweenUnits: 0, rowsStepped: 0, units: 0 };
  let sinceUnit = 0;
  const reader = createJournalReader(db, {
    unit: () => {
      trace.units += 1;
      trace.maxRowsBetweenUnits = Math.max(trace.maxRowsBetweenUnits, sinceUnit);
      sinceUnit = 0;
    },
    onRowsStepped: (rows: number) => {
      trace.rowsStepped += rows;
      sinceUnit += rows;
    },
  });
  reader.measure(hook, { runId: run.id, leading: [] });
  trace.maxRowsBetweenUnits = Math.max(trace.maxRowsBetweenUnits, sinceUnit);
  return { ...trace, journalRows };
};

describe('the reader bounds the rows stepped between two unit() calls by a stated range size K (review of fd3c85df, finding 1)', () => {
  it('states K as a positive integer smaller than the run under test', () => {
    expect(Number.isInteger(JOURNAL_SCAN_RANGE_ROWS)).toBe(true);
    expect(JOURNAL_SCAN_RANGE_ROWS).toBeGreaterThan(0);
    expect(JOURNAL_SCAN_RANGE_ROWS).toBeLessThan(DELTAS);
  });

  it('a type IN read for model.responded across thousands of non-matching delta rows calls unit() at least once per K rows stepped', () => {
    const trace = measuredRun({ eventTypes: ['model.responded'], measure: () => undefined });

    expect(trace.rowsStepped).toBeGreaterThanOrEqual(DELTAS);
    expect(trace.maxRowsBetweenUnits).toBeLessThanOrEqual(JOURNAL_SCAN_RANGE_ROWS);
    expect(trace.units).toBeGreaterThanOrEqual(Math.floor(trace.rowsStepped / JOURNAL_SCAN_RANGE_ROWS));
  });

  it('a type NOT IN read of the replay across thousands of excluded delta rows calls unit() at least once per K rows stepped', () => {
    const trace = measuredRun({
      eventTypes: ['user.message', 'agent.message.delta'],
      measure: ({ replay }) => {
        replay(() => undefined);
        return undefined;
      },
    });

    expect(trace.rowsStepped).toBeGreaterThanOrEqual(2 * DELTAS);
    expect(trace.maxRowsBetweenUnits).toBeLessThanOrEqual(JOURNAL_SCAN_RANGE_ROWS);
    expect(trace.units).toBeGreaterThanOrEqual(Math.floor(trace.rowsStepped / JOURNAL_SCAN_RANGE_ROWS));
  });

  it('the range reads see every row of the run exactly as one statement over the whole run would', () => {
    const seen: string[] = [];
    measuredRun({
      eventTypes: ['model.responded'],
      measure: ({ events }) => {
        seen.push(...events.map((event) => `${event.type}:${event.seq}`));
        return undefined;
      },
    });

    expect(seen).toEqual([`model.responded:2`, `model.responded:${DELTAS + 3}`]);
  });
});
