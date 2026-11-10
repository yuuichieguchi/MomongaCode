import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createJournalReader } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb, registerCleanup } from './helpers.ts';

const TYPED_INDEX_COLUMNS = ['run_id', 'type', 'seq'];

const NON_MATCHING = 3_000;

const typedIndexesOf = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name, partial FROM pragma_index_list('events')")
    .all()
    .filter((row) => Number(row['partial']) === 0)
    .map((row) => String(row['name']))
    .filter((name) => {
      const columns = db.prepare('SELECT name FROM pragma_index_info(:name) ORDER BY seqno').all({ name }).map((row) => row['name']);
      return JSON.stringify(columns) === JSON.stringify(TYPED_INDEX_COLUMNS);
    });

const delta = (index: number): RunEventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_1', text: `piece ${index}` });

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input: [] } }) as RunEventPayload;

const responded = (step: number): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

const capturePrepared = (): { sql: string[]; restore: () => void } => {
  const sql: string[] = [];
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, text: string, ...rest: unknown[]) {
    sql.push(text);
    return (original as (...args: unknown[]) => ReturnType<DatabaseSync['prepare']>).call(this, text, ...rest);
  } as DatabaseSync['prepare'];
  const restore = (): void => {
    DatabaseSync.prototype.prepare = original;
  };
  registerCleanup(restore);
  return { sql, restore };
};

const SINGLE_TYPED_READ = /FROM events(?: [a-z])? WHERE (?:[a-z]\.)?run_id = :runId AND (?:[a-z]\.)?(?:seq [^]*?AND (?:[a-z]\.)?)?type (?:= |IN )/;

const SEEKS_ANOTHER_KEY = /\b(call_id|approval_id|tool_name|notice_code|pinned_digest)\b/;

const planOf = (db: DatabaseSync, text: string): string[] => db.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map((row) => String(row['detail']));

const typedReadsOfAStoreInUse = async () => {
  const dir = makeStoreDir();
  const dbPath = path.join(dir, 'runtime.db');
  const captured = capturePrepared();
  const store = openStoreAt(dbPath, createFakeClock(START_MS));
  const run = enqueue(store, newSession(store).id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [requested(1), ...Array.from({ length: NON_MATCHING }, (_unused, index) => delta(index)), responded(1), requested(2)]).kind).toBe('ok');
  const lastSeq = store.getRun(run.id)?.lastSeq ?? 0;
  const latest = store.readLatestRunEventBefore(run.id, 'model.requested', lastSeq + 1);
  const ofTypes = store.readRunEventsOfTypes(run.id, ['model.responded']);
  const calls = await store.readModelCallEvents(run.id);
  createJournalReader(rawDb(dbPath)).eventsOfTypes(run.id, ['model.responded', 'model.requested']);
  captured.restore();
  return { dbPath, sql: [...new Set(captured.sql)], lastSeq, latest, ofTypes, calls };
};

describe('migration 21 adds one general typed-read index on events (O4 option b)', () => {
  it('a new database has a non-partial index on events over exactly (run_id, type, seq)', async () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    openStoreAt(dbPath, createFakeClock(START_MS)).close();

    const db = rawDb(dbPath);
    expect(typedIndexesOf(db)).toHaveLength(1);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: 30 });
  });

  it('the migration list holds 21 and the migrations after it', async () => {
    expect(MIGRATIONS.map((migration) => migration.version).slice(20)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  it('a version-20 database with events upgrades, gains the index and keeps every event row', async () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const versionTwenty = new DatabaseSync(dbPath);
    migrate(versionTwenty, MIGRATIONS.filter((migration) => migration.version <= 20));
    versionTwenty.close();
    fs.chmodSync(dbPath, 0o600);
    const seeded = openStoreAt(dbPath, createFakeClock(START_MS));
    const run = enqueue(seeded, newSession(seeded).id);
    const claim = mustClaim(seeded, 'w1');
    expect(seeded.append(claim, [requested(1), delta(0), responded(1)]).kind).toBe('ok');
    seeded.close();
    const reopened = new DatabaseSync(dbPath);
    const eventsBefore = reopened.prepare('SELECT seq, type FROM events WHERE run_id = :runId ORDER BY seq').all({ runId: run.id });
    reopened.exec('DELETE FROM schema_migrations WHERE version = 21');
    for (const name of typedIndexesOf(reopened)) reopened.exec(`DROP INDEX "${name}"`);
    expect(typedIndexesOf(reopened)).toEqual([]);
    reopened.close();

    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();

    const db = rawDb(dbPath);
    expect(typedIndexesOf(db)).toHaveLength(1);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: 30 });
    expect(db.prepare('SELECT seq, type FROM events WHERE run_id = :runId ORDER BY seq').all({ runId: run.id })).toEqual(eventsBefore);
  });
});

describe('every typed read of the events of a run seeks by (run_id, type) (section 7, count form)', () => {
  it('captures the typed reads of the store and of the journal reader', async () => {
    const { sql } = await typedReadsOfAStoreInUse();
    const typed = sql.filter((text) => SINGLE_TYPED_READ.test(text));

    expect(typed.some((text) => text.includes('seq < :beforeSeq'))).toBe(true);
    expect(typed.some((text) => text.includes('model_call_json'))).toBe(true);
    expect(typed.some((text) => /type IN \(:type0/.test(text))).toBe(true);
  });

  it('no typed read scans events, and each one without a narrower id key seeks on run_id and type', async () => {
    const { dbPath, sql } = await typedReadsOfAStoreInUse();
    const db = rawDb(dbPath);
    const typed = sql.filter((text) => SINGLE_TYPED_READ.test(text));

    const partialByType = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql LIKE '% WHERE type = %'")
        .all()
        .map((row) => String(row['name'])),
    );
    const seeksByType = (detail: string): boolean => {
      const match = /^SEARCH (?:events|e) USING (?:COVERING )?INDEX (\S+) \((.*)\)$/.exec(detail);
      return match !== null && (match[2]?.startsWith('run_id=? AND type=?') === true || partialByType.has(match[1] ?? ''));
    };
    const offenders = typed
      .map((text) => ({ text, plan: planOf(db, text) }))
      .filter(({ text, plan }) => plan.some((detail) => /^SCAN (events|e)\b/.test(detail)) || (!SEEKS_ANOTHER_KEY.test(text) && !plan.some(seeksByType)));

    expect(typed.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('the latest event of a type before a seq, the events of some types and the model calls seek through the general index', async () => {
    const { dbPath, sql } = await typedReadsOfAStoreInUse();
    const db = rawDb(dbPath);
    const [index] = typedIndexesOf(db);
    expect(index).toBeTypeOf('string');
    const pick = (needle: RegExp): string => {
      const text = sql.find((candidate) => SINGLE_TYPED_READ.test(candidate) && needle.test(candidate));
      if (text === undefined) throw new Error(`no captured statement matches ${needle}`);
      return text;
    };

    for (const text of [pick(/seq < :beforeSeq/), pick(/model_call_json/), pick(/type IN \(:type0/)]) {
      expect(planOf(db, text).join('\n'), text).toContain(`INDEX ${index} (run_id=? AND type=?`);
    }
  });

  it('the typed reads still return only the matches among thousands of other events of the run', async () => {
    const { lastSeq, latest, ofTypes, calls } = await typedReadsOfAStoreInUse();

    expect(latest?.seq).toBe(lastSeq);
    expect(latest?.step).toBe(2);
    expect(ofTypes.map((event) => event.seq)).toEqual([NON_MATCHING + 3]);
    expect(calls.map((call) => call.seq)).toEqual([2, NON_MATCHING + 3, NON_MATCHING + 4]);
  });
});
