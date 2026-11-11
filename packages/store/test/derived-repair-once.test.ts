import { describe, expect, it, vi } from 'vitest';
import { immediateTx } from '@momonga/foundation';
import { createAppendRecords } from '../src/append-records.ts';
import type { AppendRecords, RecordDerivation } from '../src/append-records.ts';
import { decodeContextOf, decodeRunEvents } from '../src/codec.ts';
import { DERIVATIONS, PINNED_DIGEST_DERIVATION, REPAIR_PAGE_EVENTS, createDerivedRepair } from '../src/derived-repair.ts';
import { enqueue, harness, newSession, rawDb } from './helpers.ts';
import { appendForeignRunEvent } from './compat/fixtures.ts';

vi.mock('../src/codec.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/codec.ts')>();
  return { ...original, decodeRunEvents: vi.fn(original.decodeRunEvents) };
});

const RECORD_DERIVATIONS = DERIVATIONS.filter((derivation): derivation is RecordDerivation => derivation !== PINNED_DIGEST_DERIVATION);

const laggingRun = async (events: number) => {
  const { store, dbPath } = harness();
  const run = await enqueue(store, newSession(store).id, 'task');
  const db = rawDb(dbPath);
  const start = Number(db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(run.id)?.['last_seq']);
  db.exec('BEGIN');
  for (let index = 0; index < events; index += 1) appendForeignRunEvent(db, run.id, 'notice', { level: 'info', message: `old ${index}`, code: `old.${index}` });
  db.exec('COMMIT');
  const lastSeq = Number(db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(run.id)?.['last_seq']);
  const applied: { derivation: number; seq: number }[] = [];
  const real = createAppendRecords(db);
  const records: AppendRecords = {
    ...real,
    recordFor: (derivation, event) => {
      applied.push({ derivation, seq: event.seq });
      real.recordFor(derivation, event);
    },
  };
  const repair = createDerivedRepair(db, records, decodeContextOf(db));
  const watermarks = (): Record<number, number> =>
    Object.fromEntries(db.prepare('SELECT derivation, through_seq FROM derived_through WHERE run_id = ? ORDER BY derivation').all(run.id).map((row) => [Number(row['derivation']), Number(row['through_seq'])]));
  const setWatermark = (derivation: number, seq: number): void => {
    db.prepare('UPDATE derived_through SET through_seq = ? WHERE run_id = ? AND derivation = ?').run(seq, run.id, derivation);
  };
  const repairPage = (): boolean => immediateTx(db, () => repair.repairPage(run.id, lastSeq));
  return { run, start, lastSeq, applied, watermarks, setWatermark, repairPage };
};

describe('a repair step reads and decodes its page of events once for every lagging derivation', () => {
  it('decodes the page once when all six derivations lag, and advances each watermark by the page', async () => {
    const { start, applied, watermarks, repairPage } = await laggingRun(REPAIR_PAGE_EVENTS + 20);
    expect(DERIVATIONS.length).toBe(6);
    vi.mocked(decodeRunEvents).mockClear();

    expect(repairPage()).toBe(false);

    expect(vi.mocked(decodeRunEvents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decodeRunEvents).mock.calls[0]?.[0]).toHaveLength(REPAIR_PAGE_EVENTS);
    expect(watermarks()).toEqual(Object.fromEntries(DERIVATIONS.map((derivation) => [derivation, start + REPAIR_PAGE_EVENTS])));
    for (const derivation of RECORD_DERIVATIONS) expect(applied.filter((entry) => entry.derivation === derivation)).toHaveLength(REPAIR_PAGE_EVENTS);
  });

  it('reaches the last seq in the step that reads the last events', async () => {
    const { lastSeq, watermarks, repairPage } = await laggingRun(REPAIR_PAGE_EVENTS + 20);

    expect(repairPage()).toBe(false);
    vi.mocked(decodeRunEvents).mockClear();
    expect(repairPage()).toBe(true);

    expect(vi.mocked(decodeRunEvents)).toHaveBeenCalledTimes(1);
    expect(watermarks()).toEqual(Object.fromEntries(DERIVATIONS.map((derivation) => [derivation, lastSeq])));
  });

  it('applies the decoded events to each derivation from its own watermark, and leaves a watermark beyond the page as it is', async () => {
    const { start, lastSeq, applied, watermarks, setWatermark, repairPage } = await laggingRun(REPAIR_PAGE_EVENTS + 20);
    const [behind, ahead, beyond] = RECORD_DERIVATIONS as [RecordDerivation, RecordDerivation, RecordDerivation, ...RecordDerivation[]];
    setWatermark(ahead, start + 100);
    setWatermark(beyond, start + REPAIR_PAGE_EVENTS + 5);
    vi.mocked(decodeRunEvents).mockClear();

    expect(repairPage()).toBe(false);

    expect(vi.mocked(decodeRunEvents)).toHaveBeenCalledTimes(1);
    const seqsOf = (derivation: number): number[] => applied.filter((entry) => entry.derivation === derivation).map((entry) => entry.seq);
    expect(seqsOf(behind)).toEqual(Array.from({ length: REPAIR_PAGE_EVENTS }, (_unused, index) => start + 1 + index));
    expect(seqsOf(ahead)).toEqual(Array.from({ length: REPAIR_PAGE_EVENTS - 100 }, (_unused, index) => start + 101 + index));
    expect(seqsOf(beyond)).toEqual([]);
    expect(watermarks()).toMatchObject({ [behind]: start + REPAIR_PAGE_EVENTS, [ahead]: start + REPAIR_PAGE_EVENTS, [beyond]: start + REPAIR_PAGE_EVENTS + 5 });

    expect(repairPage()).toBe(true);
    expect(seqsOf(beyond)).toEqual(Array.from({ length: 15 }, (_unused, index) => start + REPAIR_PAGE_EVENTS + 6 + index));
    expect(watermarks()).toEqual(Object.fromEntries(DERIVATIONS.map((derivation) => [derivation, lastSeq])));
  });
});
