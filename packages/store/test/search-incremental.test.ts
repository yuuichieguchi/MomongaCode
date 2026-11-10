import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as eventLoopTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { SEARCH_DRAFT_DERIVATION } from '../src/append-records.ts';
import { DERIVATIONS } from '../src/derived-repair.ts';
import { MIGRATIONS } from '../src/schema.ts';
import type { RuntimeStore } from '../src/index.ts';
import { START_MS, enqueue, harness, makeStoreDir, newSession, openStoreAt, rawDb } from './helpers.ts';
import { FAKE_KEY, redactor, stepEvents } from './search-fixture.ts';
import type { Outcome, StepSpec } from './search-fixture.ts';
import { seeded } from './support/seeded.ts';
import type { Random } from './support/seeded.ts';
import { wholeExtraction } from './support/whole-extraction.ts';
import type { WholeDocument } from './support/whole-extraction.ts';

const DRAFT_TABLES = ['search_draft_runs', 'search_draft_steps', 'search_draft_parts', 'search_draft_paths'] as const;

const indexedDocuments = (dbPath: string, runId: string): WholeDocument[] =>
  rawDb(dbPath)
    .prepare('SELECT level, step, seq_from, seq_to, body, paths_json FROM search_docs WHERE run_id = ? ORDER BY id')
    .all(runId)
    .map((row) => ({
      level: row['level'] === 'run' ? 'run' : 'step',
      step: row['step'] === null ? null : Number(row['step']),
      seq_from: Number(row['seq_from']),
      seq_to: Number(row['seq_to']),
      body: String(row['body']),
      paths_json: String(row['paths_json']),
    }));

const draftRowsOf = (dbPath: string, runId: string): number[] =>
  DRAFT_TABLES.map((table) => Number(rawDb(dbPath).prepare(`SELECT count(*) AS held FROM ${table} WHERE run_id = ?`).get(runId)?.['held']));

const WORDS = ['parser', 'widget', '設定ファイル', '読み込み', 'handler', 'rename', '𝒜😀', 'migration', 'quoted "text"', 'tab\tseparated'];
const PATHS = ['/work/a/src/widget.ts', '/work/a/src/parser.ts', '/work/a/設定/読み込み.ts', '/work/a/.env', '/work/a/README.md'];
const TOOLS = ['Read', 'Grep', 'Edit'];
const OUTCOMES: readonly Outcome[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

const sentence = (random: Random, words: number): string => Array.from({ length: words }, () => random.pick(WORDS)).join(' ');

const outputOf = (random: Random): string => {
  if (random.chance(0.15)) return '';
  if (random.chance(0.25)) return Array.from({ length: random.int(300, 900) }, (_unused, line) => `${line} ${sentence(random, 4)} ${random.chance(0.05) ? FAKE_KEY : ''}`).join('\n');
  return `${sentence(random, random.int(1, 30))}${random.chance(0.2) ? ` API=${FAKE_KEY}` : ''}`;
};

const stepSpecOf = (random: Random): StepSpec => ({
  ...(random.chance(0.7) ? { text: random.chance(0.1) ? '' : sentence(random, random.int(1, 12)) } : {}),
  ...(random.chance(0.7) ? { tool: { name: random.pick(TOOLS), path: random.pick(PATHS), output: outputOf(random) } } : {}),
});

const journalOf = (random: Random): RunEventPayload[] => {
  const events: RunEventPayload[] = [];
  const steps = random.int(0, 14);
  for (let step = 1; step <= steps; step += 1) {
    events.push(...stepEvents(step, stepSpecOf(random)));
    if (random.chance(0.2)) events.push({ type: 'user.message', text: random.chance(0.2) ? '' : sentence(random, 5) });
    if (random.chance(0.3)) events.push({ type: 'notice', level: 'info', message: sentence(random, 3) });
    if (random.chance(0.15)) {
      const callId = `extra-${step}`;
      events.push({ type: 'tool.call', callId, providerCallId: callId, name: random.pick(TOOLS), kind: 'read', title: 'two places', rawInput: {}, locations: [{ path: random.pick(PATHS) }, { path: random.pick(PATHS) }] });
      events.push({ type: 'tool.completed', callId, status: 'completed', output: outputOf(random) });
    }
  }
  return events;
};

const chunksOf = <T,>(random: Random, values: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let from = 0; from < values.length; ) {
    const size = random.int(1, 7);
    chunks.push(values.slice(from, from + size));
    from += size;
  }
  return chunks;
};

const finish = async (store: RuntimeStore, claim: NonNullable<ReturnType<RuntimeStore['claim']>>, outcome: Outcome): Promise<void> => {
  if (outcome === 'CANCELLED') {
    expect((await store.transition(claim, ['RUNNING'], 'CANCELLING')).kind).toBe('ok');
    expect((await store.transition({ ...claim, status: 'CANCELLING' }, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');
    return;
  }
  expect((await store.transition(claim, ['RUNNING'], outcome, outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {})).kind).toBe('ok');
};

const generatedRun = async (store: RuntimeStore, random: Random, task: string): Promise<{ runId: string; outcome: Outcome }> => {
  const run = enqueue(store, newSession(store).id, task);
  const claim = store.claim(`worker-${run.id}`);
  if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
  for (const chunk of chunksOf(random, journalOf(random))) expect(store.append(claim, chunk).kind).toBe('ok');
  const outcome = random.pick(OUTCOMES);
  await finish(store, claim, outcome);
  return { runId: run.id, outcome };
};

const longRun = async (store: RuntimeStore, steps: number, outputChars: number): Promise<string> => {
  const run = enqueue(store, newSession(store).id, 'a long task');
  const claim = store.claim(`worker-${run.id}`);
  if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
  for (let step = 1; step <= steps; step += 1) {
    const events = stepEvents(step, { text: `step ${step} says widget`, tool: { name: 'Read', path: `/work/a/file${step}.ts`, output: `${step} `.repeat(outputChars).slice(0, outputChars) } });
    expect(store.append(claim, events).kind).toBe('ok');
  }
  await finish(store, claim, 'COMPLETED');
  return run.id;
};

describe('the search document of a run, kept at each append (row 12, O9 option c)', () => {
  it('is its own derivation among the records filled at append, added by the last migration', () => {
    expect(DERIVATIONS).toContain(SEARCH_DRAFT_DERIVATION);
    expect(Math.max(...MIGRATIONS.map((migration) => migration.version))).toBe(SEARCH_DRAFT_DERIVATION);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('gives, for generated journals of seed %i appended in chunks, the documents a whole re-extraction of the run gives', async (seed) => {
    const { store, dbPath } = harness();
    const random = seeded(seed);
    const runs: { runId: string; outcome: Outcome }[] = [];
    for (let index = 0; index < 6; index += 1) runs.push(await generatedRun(store, random, random.chance(0.2) ? `use ${FAKE_KEY}` : sentence(random, 6)));

    let indexed = 0;
    for (let batch = await store.search.indexBatch({ limit: 100, redactor, maxChars: 20_000 }); batch.runs > 0; batch = await store.search.indexBatch({ limit: 100, redactor, maxChars: 20_000 })) indexed += batch.runs;
    expect(indexed).toBe(runs.length);

    for (const { runId, outcome } of runs) {
      expect(indexedDocuments(dbPath, runId)).toEqual(wholeExtraction(rawDb(dbPath), runId, outcome, redactor));
      expect(draftRowsOf(dbPath, runId)).toEqual(DRAFT_TABLES.map(() => 0));
    }
    expect(rawDb(dbPath).prepare("SELECT count(*) AS held FROM search_docs WHERE body LIKE '%' || ? || '%'").get(FAKE_KEY)).toEqual({ held: 0 });
  });

  it('indexes a run above the budget of one batch in pages, the loop free between them, and ends with the documents of the whole run', async () => {
    const { store, dbPath } = harness();
    const steps = 12;
    const runId = await longRun(store, steps, 2000);
    const db = rawDb(dbPath);
    const held = (): number => Number(db.prepare('SELECT count(*) AS held FROM search_docs WHERE run_id = ?').get(runId)?.['held']);
    const seen = new Set<number>();
    let settled = false;

    const indexing = store.search.indexBatch({ limit: 10, redactor, maxChars: 5000 }).finally(() => {
      settled = true;
    });
    while (!settled) {
      seen.add(held());
      await eventLoopTurn();
    }

    expect(await indexing).toEqual({ runs: 1 });
    expect(held()).toBe(steps + 1);
    expect([...seen].filter((count) => count > 0 && count < steps + 1).length).toBeGreaterThan(1);
    expect(indexedDocuments(dbPath, runId)).toEqual(wholeExtraction(db, runId, 'COMPLETED', redactor));
    expect(store.search.query({ project: '/work/a', trusted: false }, { query: 'widget', scope: 'project' }).sessions).toHaveLength(1);
  });

  it('continues a run whose indexing failed between two pages, and writes each of its documents once', async () => {
    const { store, dbPath } = harness();
    const steps = 9;
    const runId = await longRun(store, steps, 2000);
    const db = rawDb(dbPath);
    let calls = 0;
    const failing = {
      ...redactor,
      whole: (text: string): string => {
        calls += 1;
        if (calls > 19) throw new Error('the redactor of the fixture fails');
        return redactor.whole(text);
      },
    };

    await expect(store.search.indexBatch({ limit: 10, redactor: failing, maxChars: 5000 })).rejects.toThrow(/redactor of the fixture/);
    const partial = Number(db.prepare('SELECT count(*) AS held FROM search_docs WHERE run_id = ?').get(runId)?.['held']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(steps + 1);

    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: 5000 })).toEqual({ runs: 1 });

    expect(indexedDocuments(dbPath, runId)).toEqual(wholeExtraction(db, runId, 'COMPLETED', redactor));
  });

  it('repairs, in pages, the document of a run whose watermark is behind its events, and then indexes it as the whole re-extraction does', async () => {
    const { store, dbPath } = harness();
    const { runId, outcome } = await generatedRun(store, seeded(41), 'a repaired task');
    const db = rawDb(dbPath);
    for (const table of DRAFT_TABLES) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
    db.prepare('UPDATE derived_through SET through_seq = 0 WHERE run_id = ? AND derivation = ?').run(runId, SEARCH_DRAFT_DERIVATION);

    expect(await store.search.indexBatch({ limit: 10, redactor })).toEqual({ runs: 1 });

    expect(indexedDocuments(dbPath, runId)).toEqual(wholeExtraction(db, runId, outcome, redactor));
  });
});

describe('the migration that adds the search document kept at append', () => {
  const before = MIGRATIONS.filter((migration) => migration.version < SEARCH_DRAFT_DERIVATION);
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const journal: RunEventPayload[] = [
    { type: 'user.message', text: 'rename the widget parser' },
    { type: 'run.started', attempt: 1, now: START_MS, pins: {}, mode: 'manual' },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'the parser is renamed' }] }], usage } },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'read', title: 'Read 設定', rawInput: {}, locations: [{ path: '/work/a/設定.ts' }] },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: `recorded ${FAKE_KEY} output` },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ];

  it('marks a run that is already indexed as current with no draft, and leaves a run not yet indexed to the paged repair, which gives the documents of a whole re-extraction', async () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, before);
      db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'manual', 'fm', START_MS);
      const insertRun = db.prepare(
        `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
         VALUES (?, 's1', ?, 'COMPLETED', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, ?, '{}', 0, ?)`,
      );
      const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
      ['done', 'waiting'].forEach((runId, ordinal) => {
        insertRun.run(runId, ordinal + 1, START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), journal.length, START_MS);
        journal.forEach((payload, index) => insertEvent.run(runId, 's1', index + 1, index < 2 ? 0 : 1, START_MS, payload.type, canonicalJson(payload)));
      });
      db.prepare(
        `INSERT INTO search_docs (level, session_id, run_id, step, project, origin, outcome, seq_from, seq_to, at, body, paths_json)
         VALUES ('run', 's1', 'done', NULL, '/work/a', 'untrusted', 'COMPLETED', 1, ?, ?, 'rename the widget parser', '[]')`,
      ).run(journal.length, START_MS);
      db.prepare("UPDATE search_cursor SET last_event_id = (SELECT MAX(id) FROM events WHERE run_id = 'done') WHERE id = 1").run();
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);

    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));

    const marks = rawDb(dbPath).prepare('SELECT run_id, through_seq FROM derived_through WHERE derivation = ? ORDER BY run_id').all(SEARCH_DRAFT_DERIVATION);
    expect(marks.map((row) => [row['run_id'], Number(row['through_seq'])])).toEqual([['done', journal.length]]);
    expect(draftRowsOf(dbPath, 'done')).toEqual(DRAFT_TABLES.map(() => 0));

    expect(await store.search.indexBatch({ limit: 10, redactor })).toEqual({ runs: 1 });

    expect(indexedDocuments(dbPath, 'waiting')).toEqual(wholeExtraction(rawDb(dbPath), 'waiting', 'COMPLETED', redactor));
    expect(indexedDocuments(dbPath, 'waiting').length).toBe(2);
    expect(indexedDocuments(dbPath, 'done')).toHaveLength(1);
  });
});
