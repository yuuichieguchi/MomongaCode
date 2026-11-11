import { describe, expect, it } from 'vitest';
import { REPAIR_PAGE_EVENTS } from '../../src/derived-repair.ts';
import { LEASE_MS, enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const DERIVATIONS = [14, 20, 23, 24, 35, 36];

const watermarks = (dbPath: string, runId: string): number[] =>
  rawDb(dbPath)
    .prepare('SELECT through_seq FROM derived_through WHERE run_id = ? ORDER BY derivation')
    .all(runId)
    .map((row) => Number(row['through_seq']));

const lagOf = (dbPath: string, runId: string, count: number): number => {
  const db = rawDb(dbPath);
  db.exec('BEGIN');
  for (let index = 0; index < count; index += 1) appendForeignRunEvent(db, runId, 'notice', { level: 'info', message: `old ${index}`, code: `old.${index}` });
  db.exec('COMMIT');
  return Number(db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(runId)?.['last_seq']);
};

describe('the repair of a lag longer than one page (H7, 11.5; a bound per transaction)', () => {
  it('claim repairs one page in its transaction, and a read repairs the rest and leaves each watermark at the last seq', async () => {
    const { store, dbPath, clock } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    const start = watermarks(dbPath, run.id)[0] ?? 0;
    const lastSeq = lagOf(dbPath, run.id, 2 * REPAIR_PAGE_EVENTS + 200);
    clock.advance(LEASE_MS + 1);
    mustClaim(store, 'w-new');
    expect(watermarks(dbPath, run.id)).toEqual(DERIVATIONS.map(() => start + REPAIR_PAGE_EVENTS));
    expect(await store.hasNoticeCode(run.id, 'old.0')).toBe(true);
    const after = store.getRun(run.id)?.lastSeq;
    expect(watermarks(dbPath, run.id)).toEqual(DERIVATIONS.map(() => after));
    expect(after).toBeGreaterThan(lastSeq - 1);
    expect(await store.hasNoticeCode(run.id, `old.${2 * REPAIR_PAGE_EVENTS + 199}`)).toBe(true);
  });

  it('commits each page in its own transaction, so a stop between pages keeps the pages before it', async () => {
    const { store, dbPath, clock } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    const start = Number(rawDb(dbPath).prepare('SELECT last_seq FROM runs WHERE id = ?').get(run.id)?.['last_seq']);
    lagOf(dbPath, run.id, REPAIR_PAGE_EVENTS + 50);
    const db = rawDb(dbPath);
    db.exec('DROP TRIGGER events_reject_update');
    db.prepare("UPDATE events SET payload_json = '{\"type\":\"mismatch\"}' WHERE run_id = ? AND seq = ?").run(run.id, start + REPAIR_PAGE_EVENTS + 10);
    clock.advance(LEASE_MS + 1);
    mustClaim(store, 'w-new');
    await expect(store.hasNoticeCode(run.id, 'old.0')).rejects.toThrow(/payload_json type does not match/);
    expect(watermarks(dbPath, run.id)).toEqual(DERIVATIONS.map(() => start + REPAIR_PAGE_EVENTS));
    const noticeCodes = rawDb(dbPath).prepare('SELECT notice_code FROM events WHERE run_id = ? AND seq IN (?, ?, ?) ORDER BY seq').all(run.id, start + 1, start + REPAIR_PAGE_EVENTS, start + REPAIR_PAGE_EVENTS + 1);
    expect(noticeCodes).toEqual([{ notice_code: 'old.0' }, { notice_code: `old.${REPAIR_PAGE_EVENTS - 1}` }, { notice_code: null }]);
  });
});
