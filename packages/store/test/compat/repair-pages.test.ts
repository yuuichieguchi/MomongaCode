import { describe, expect, it } from 'vitest';
import { REPAIR_PAGE_EVENTS } from '../../src/derived-repair.ts';
import { LEASE_MS, enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const DERIVATIONS = [14, 20, 23, 24];

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
  it('repairs every page at claim and leaves each watermark at the last seq', () => {
    const { store, dbPath, clock } = harness();
    const run = enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    const before = watermarks(dbPath, run.id)[0] ?? 0;
    const lastSeq = lagOf(dbPath, run.id, 2 * REPAIR_PAGE_EVENTS + 200);
    clock.advance(LEASE_MS + 1);
    mustClaim(store, 'w-new');
    const after = store.getRun(run.id)?.lastSeq;
    expect(watermarks(dbPath, run.id)).toEqual(DERIVATIONS.map(() => after));
    expect(after).toBeGreaterThan(lastSeq - 1);
    expect(store.hasNoticeCode(run.id, 'old.0')).toBe(true);
    expect(store.hasNoticeCode(run.id, `old.${2 * REPAIR_PAGE_EVENTS + 199}`)).toBe(true);
    expect(before).toBeLessThan(lastSeq);
  });

  it('commits each page in its own transaction, so a stop between pages keeps the pages before it', () => {
    const { store, dbPath, clock } = harness();
    const run = enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    const start = Number(rawDb(dbPath).prepare('SELECT last_seq FROM runs WHERE id = ?').get(run.id)?.['last_seq']);
    lagOf(dbPath, run.id, REPAIR_PAGE_EVENTS + 50);
    const db = rawDb(dbPath);
    db.exec('DROP TRIGGER events_reject_update');
    db.prepare("UPDATE events SET payload_json = '{\"type\":\"mismatch\"}' WHERE run_id = ? AND seq = ?").run(run.id, start + REPAIR_PAGE_EVENTS + 10);
    clock.advance(LEASE_MS + 1);
    expect(() => store.claim('w-new')).toThrow(/payload_json type does not match/);
    expect(watermarks(dbPath, run.id)).toEqual(DERIVATIONS.map(() => start + REPAIR_PAGE_EVENTS));
    expect(store.hasNoticeCode(run.id, 'old.0')).toBe(true);
    expect(store.hasNoticeCode(run.id, `old.${REPAIR_PAGE_EVENTS - 1}`)).toBe(true);
    expect(store.hasNoticeCode(run.id, `old.${REPAIR_PAGE_EVENTS}`)).toBe(false);
  });
});
