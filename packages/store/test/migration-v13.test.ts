import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

type Fields = Record<string, string | number | null>;

type Verb = 'INSERT' | 'INSERT OR REPLACE';

const insertRow = (db: DatabaseSync, table: string, fields: Fields, verb: Verb = 'INSERT'): void => {
  const names = Object.keys(fields);
  db.prepare(`${verb} INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...Object.values(fields));
};

const insertMemory = (db: DatabaseSync, id: string, text: string, verb: Verb = 'INSERT'): void => {
  const fields: Fields = {
    id,
    scope: 'project',
    origin: 'trusted',
    project: '/work/a',
    text,
    source_session_id: 's1',
    source_run_id: `run-${id}`,
    source_step: 1,
    source_call_id: `call-${id}`,
    source_seq: 1,
    created_at: START_MS,
    [db.prepare("SELECT name FROM pragma_table_info('memories') WHERE name = 'kept_at'").get() === undefined ? 'last_used_at' : 'kept_at']: START_MS + 1,
  };
  insertRow(db, 'memories', fields, verb);
};

const migratedDb = (): DatabaseSync => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 12));
    insertMemory(db, 'm-old', 'pandas lives in requirements.txt');
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  openStoreAt(dbPath, createFakeClock(START_MS + 2)).close();
  return rawDb(dbPath);
};

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map((row) => String(row['name']));

const insertFact = (db: DatabaseSync, overrides: Fields = {}, verb: Verb = 'INSERT'): void => {
  const fields: Fields = {
    id: 'g1',
    kind: 'constraint',
    target: 'pandas',
    text: 'do not use pandas',
    scope_level: 'user',
    project: null,
    paths_json: '[]',
    valid_from: 1,
    valid_until: null,
    retired_at: null,
    supersedes_json: '[]',
    enforcement_behavior: null,
    enforcement_rule: null,
    source_kind: 'command',
    source_at: 1,
    source_session_id: null,
    source_run_id: null,
    source_seq: null,
    source_call_id: null,
    ...overrides,
  };
  insertRow(db, 'governing_facts', fields, verb);
};

const insertDoc = (db: DatabaseSync, id: number, body: string, overrides: Fields = {}, verb: Verb = 'INSERT'): void => {
  const fields: Fields = {
    id,
    level: 'step',
    session_id: 's1',
    run_id: 'r1',
    step: 1,
    project: '/work/a',
    origin: 'trusted',
    outcome: 'COMPLETED',
    seq_from: 1,
    seq_to: 2,
    at: 1,
    body,
    paths_json: '[]',
    ...overrides,
  };
  insertRow(db, 'search_docs', fields, verb);
};

const insertEvidence = (db: DatabaseSync, fields: Fields): void => {
  insertRow(db, 'memory_evidence', { memory_id: 'm-old', ordinal: 0, ...fields });
};

const searchIds = (db: DatabaseSync, term: string): number[] =>
  db.prepare('SELECT rowid AS id FROM search_index WHERE search_index MATCH ? ORDER BY rowid').all(`"${term}"`).map((row) => Number(row['id']));

const memoryIds = (db: DatabaseSync, term: string): string[] =>
  db.prepare('SELECT memory_id FROM memories_index WHERE memories_index MATCH ? ORDER BY memory_id').all(`"${term}"`).map((row) => String(row['memory_id']));

describe('migration v13', () => {

  it('preserves an existing memory and gives it the defaults of the new columns', () => {
    const row = migratedDb().prepare('SELECT * FROM memories WHERE id = ?').get('m-old');
    expect({ ...row }).toEqual({
      id: 'm-old',
      scope: 'project',
      origin: 'trusted',
      project: '/work/a',
      text: 'pandas lives in requirements.txt',
      source_session_id: 's1',
      source_run_id: 'run-m-old',
      source_step: 1,
      source_call_id: 'call-m-old',
      source_seq: 1,
      created_at: START_MS,
      kept_at: START_MS + 1,
      kind: 'fact',
      state: 'active',
      duplicate_of: null,
      supersedes_json: '[]',
      retired_at: null,
      contributed_at: null,
      source_kind: 'tool',
      observed_status: null,
    });
  });

  it('creates the tables with the contract columns', () => {
    const db = migratedDb();
    expect(columnsOf(db, 'reflection_jobs')).toEqual(['run_id', 'state', 'attempts', 'last_error', 'created_at', 'updated_at', 'dropped_json']);
    expect(columnsOf(db, 'compaction_guidelines')).toEqual(['version', 'text', 'parent', 'created_at', 'adopted_at', 'report_json']);
    expect(columnsOf(db, 'search_docs')).toEqual(['id', 'level', 'session_id', 'run_id', 'step', 'project', 'origin', 'outcome', 'seq_from', 'seq_to', 'at', 'body', 'paths_json']);
    expect(columnsOf(db, 'runs')).toContain('origin');
    expect(columnsOf(db, 'memory_evidence')).toEqual(['memory_id', 'ordinal', 'kind', 'project', 'path', 'sha256', 'sha', 'run_id', 'call_id', 'condition_id', 'seq', 'command', 'exit_code']);
    expect(columnsOf(db, 'governing_facts')).not.toContain('polarity');
  });

  it('starts the search cursor before every event, so earlier runs are backfilled', () => {
    const rows = migratedDb().prepare('SELECT * FROM search_cursor').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([{ id: 1, last_event_id: 0 }]);
  });

  it('allows only one search cursor row', () => {
    expect(() => migratedDb().prepare('INSERT INTO search_cursor (id, last_event_id) VALUES (2, 0)').run()).toThrow(/CHECK/);
  });
});

describe('run origin', () => {
  it('gives a run recorded before the column the untrusted origin, because its trust state was not recorded', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const old = new DatabaseSync(dbPath);
    try {
      migrate(old, MIGRATIONS.filter((migration) => migration.version <= 12));
      insertRow(old, 'sessions', { id: 's1', cwd: '/work/a', env_json: '{}', permission_mode: 'default', model_alias: 'fm', created_at: START_MS });
      insertRow(old, 'runs', {
        id: 'r1',
        session_id: 's1',
        ordinal: 1,
        status: 'COMPLETED',
        version: 0,
        lease_token: 0,
        available_at: START_MS,
        attempts: 0,
        failed_attempts: 0,
        cancel_requested: 0,
        deadline_at: START_MS,
        limits_json: '{}',
        usage_json: '{}',
        step: 0,
        last_seq: 0,
        pins: '{}',
        dead_letter: 0,
        created_at: START_MS,
      });
    } finally {
      old.close();
    }
    fs.chmodSync(dbPath, 0o600);
    openStoreAt(dbPath, createFakeClock(START_MS + 2)).close();
    expect(rawDb(dbPath).prepare("SELECT origin FROM runs WHERE id = 'r1'").get()?.['origin']).toBe('untrusted');
  });
});

describe('search index', () => {
  it('uses the trigram tokenizer: a mid-word substring matches, in Japanese too', () => {
    const db = migratedDb();
    insertDoc(db, 1, 'refactor the tokenizer');
    insertDoc(db, 2, '日本語の仕様を確認');
    expect(searchIds(db, 'okeni')).toEqual([1]);
    expect(searchIds(db, '語の仕')).toEqual([2]);
    expect(searchIds(db, 'absent')).toEqual([]);
  });

  it('does not match a term shorter than three characters', () => {
    const db = migratedDb();
    insertDoc(db, 1, 'refactor the tokenizer');
    expect(searchIds(db, 'to')).toEqual([]);
  });

  it('follows a delete of a document', () => {
    const db = migratedDb();
    insertDoc(db, 1, 'refactor the tokenizer');
    expect(searchIds(db, 'tokenizer')).toEqual([1]);
    db.prepare('DELETE FROM search_docs WHERE id = 1').run();
    expect(searchIds(db, 'tokenizer')).toEqual([]);
  });

  it('follows an update of a document', () => {
    const db = migratedDb();
    insertDoc(db, 1, 'refactor the tokenizer');
    db.prepare("UPDATE search_docs SET body = 'rewrite the sweeper' WHERE id = 1").run();
    expect(searchIds(db, 'tokenizer')).toEqual([]);
    expect(searchIds(db, 'sweeper')).toEqual([1]);
  });

  it('holds its CHECK constraints', () => {
    const db = migratedDb();
    expect(() => insertDoc(db, 1, 'x', { level: 'event' })).toThrow(/CHECK/);
    expect(() => insertDoc(db, 2, 'x', { origin: 'unknown' })).toThrow(/CHECK/);
    expect(() => insertDoc(db, 3, 'x', { level: 'run', step: 1 })).toThrow(/CHECK/);
    expect(() => insertDoc(db, 4, 'x', { level: 'step', step: null })).toThrow(/CHECK/);
    insertDoc(db, 5, 'x', { level: 'run', step: null });
  });
});

describe('memories index', () => {
  it('holds memories saved before the migration', () => {
    expect(memoryIds(migratedDb(), 'requirements')).toEqual(['m-old']);
  });

  it('follows insert and update of memories, and a delete is refused', () => {
    const db = migratedDb();
    insertMemory(db, 'm-new', 'the trigram tokenizer is used');
    expect(memoryIds(db, 'igram')).toEqual(['m-new']);
    db.prepare("UPDATE memories SET text = 'the sweeper runs' WHERE id = 'm-new'").run();
    expect(memoryIds(db, 'igram')).toEqual([]);
    expect(memoryIds(db, 'sweeper')).toEqual(['m-new']);
    expect(() => db.prepare("DELETE FROM memories WHERE id = 'm-new'").run()).toThrow(/memories are retired, not deleted/);
    expect(memoryIds(db, 'sweeper')).toEqual(['m-new']);
  });

  it('survives VACUUM, because it is keyed by memory id', () => {
    const db = migratedDb();
    insertMemory(db, 'm-new', 'the trigram tokenizer is used');
    db.exec('VACUUM');
    expect(memoryIds(db, 'igram')).toEqual(['m-new']);
  });
});

describe('governing facts', () => {
  it('stores a project fact with enforcement from a proposal', () => {
    const db = migratedDb();
    insertFact(db, {
      scope_level: 'project',
      project: '/work/a',
      paths_json: '["src/**"]',
      enforcement_behavior: 'deny',
      enforcement_rule: 'Bash(rm:*)',
      source_kind: 'proposal',
      source_at: null,
      source_session_id: 's1',
      source_run_id: 'r1',
      source_seq: 4,
      source_call_id: 'c1',
    });
    expect(db.prepare('SELECT enforcement_behavior FROM governing_facts').get()?.['enforcement_behavior']).toBe('deny');
  });

  it.each<[string, Fields]>([
    ['an unknown kind', { kind: 'wish' }],
    ['an unknown scope level', { scope_level: 'team' }],
    ['a user fact with a project', { project: '/work/a' }],
    ['a project fact without a project', { scope_level: 'project' }],
    ['an allow enforcement', { enforcement_behavior: 'allow', enforcement_rule: 'Bash(ls:*)' }],
    ['a behavior without a rule', { enforcement_behavior: 'deny' }],
    ['a rule without a behavior', { enforcement_rule: 'Bash(ls:*)' }],
    ['an unknown source kind', { source_kind: 'model' }],
    ['a command source without its time', { source_at: null }],
    ['a proposal without its call', { source_kind: 'proposal', source_at: null, source_session_id: 's1', source_run_id: 'r1', source_seq: 4 }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => insertFact(migratedDb(), overrides)).toThrow(/CHECK/);
  });

  it('sets retired_at once and never again', () => {
    const db = migratedDb();
    insertFact(db);
    db.prepare("UPDATE governing_facts SET retired_at = 5 WHERE id = 'g1'").run();
    expect(() => db.prepare("UPDATE governing_facts SET retired_at = 6 WHERE id = 'g1'").run()).toThrow(/retired_at/);
    expect(() => db.prepare("UPDATE governing_facts SET retired_at = NULL WHERE id = 'g1'").run()).toThrow(/retired_at/);
    expect(db.prepare('SELECT retired_at FROM governing_facts').get()?.['retired_at']).toBe(5);
  });

  it.each([
    ['text', "text = 'changed'"],
    ['target', "target = 'numpy'"],
    ['valid_until', 'valid_until = 9'],
    ['supersedes_json', "supersedes_json = '[\"g0\"]'"],
  ])('rejects a rewrite of %s, also together with retiring', (_name, assignment) => {
    const db = migratedDb();
    insertFact(db);
    expect(() => db.prepare(`UPDATE governing_facts SET ${assignment} WHERE id = 'g1'`).run()).toThrow(/governing_facts/);
    expect(() => db.prepare(`UPDATE governing_facts SET ${assignment}, retired_at = 5 WHERE id = 'g1'`).run()).toThrow(/governing_facts/);
    const row = db.prepare('SELECT retired_at, text FROM governing_facts').get();
    expect({ ...row }).toEqual({ retired_at: null, text: 'do not use pandas' });
  });

  it('rejects a delete', () => {
    const db = migratedDb();
    insertFact(db);
    expect(() => db.prepare('DELETE FROM governing_facts').run()).toThrow(/governing_facts/);
  });
});

describe('memory columns', () => {
  it('rejects an unknown kind, state and source kind', () => {
    const db = migratedDb();
    expect(() => db.prepare("UPDATE memories SET kind = 'note'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE memories SET state = 'deleted'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE memories SET source_kind = 'model'").run()).toThrow(/CHECK/);
  });

  it('ties duplicate_of to the duplicate state', () => {
    const db = migratedDb();
    expect(() => db.prepare("UPDATE memories SET state = 'duplicate'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE memories SET duplicate_of = 'm0'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE memories SET state = 'duplicate', duplicate_of = 'm0'").run();
    expect({ ...db.prepare('SELECT state, duplicate_of FROM memories').get() }).toEqual({ state: 'duplicate', duplicate_of: 'm0' });
  });

  it('sets retired_at once and leaves use times writable', () => {
    const db = migratedDb();
    db.prepare('UPDATE memories SET retired_at = 5').run();
    expect(() => db.prepare('UPDATE memories SET retired_at = 6').run()).toThrow(/retired_at/);
    db.prepare('UPDATE memories SET kept_at = 7, contributed_at = 8').run();
    const row = db.prepare('SELECT retired_at, kept_at, contributed_at FROM memories').get();
    expect({ ...row }).toEqual({ retired_at: 5, kept_at: 7, contributed_at: 8 });
  });
});

describe('memory evidence', () => {
  it('stores each evidence kind', () => {
    const db = migratedDb();
    insertEvidence(db, { ordinal: 0, kind: 'file', project: '/work/a', path: 'a.ts', sha256: 'aa' });
    insertEvidence(db, { ordinal: 1, kind: 'commit', sha: 'bb' });
    insertEvidence(db, { ordinal: 2, kind: 'check', run_id: 'r1', call_id: 'c1', seq: 3, command: 'npm test', exit_code: 0 });
    expect(db.prepare('SELECT kind FROM memory_evidence ORDER BY ordinal').all().map((row) => row['kind'])).toEqual(['file', 'commit', 'check']);
  });

  it.each<[string, Fields]>([
    ['an unknown kind', { kind: 'url', project: '/work/a', path: 'a.ts', sha256: 'aa' }],
    ['a file without its hash', { kind: 'file', project: '/work/a', path: 'a.ts' }],
    ['a file without its project', { kind: 'file', path: 'a.ts', sha256: 'aa' }],
    ['a file with a commit', { kind: 'file', project: '/work/a', path: 'a.ts', sha256: 'aa', sha: 'bb' }],
    ['a commit without its sha', { kind: 'commit' }],
    ['a check without its exit code', { kind: 'check', run_id: 'r1', call_id: 'c1', seq: 3, command: 'npm test' }],
  ])('rejects %s', (_name, fields) => {
    expect(() => insertEvidence(migratedDb(), fields)).toThrow(/CHECK/);
  });

  it('rejects evidence of a memory that does not exist', () => {
    expect(() => insertEvidence(migratedDb(), { memory_id: 'absent', kind: 'commit', sha: 'bb' })).toThrow(/FOREIGN KEY/);
  });

  it('stays with its memory, because a memory row is never deleted', () => {
    const db = migratedDb();
    insertEvidence(db, { kind: 'commit', sha: 'bb' });
    expect(() => db.prepare("DELETE FROM memories WHERE id = 'm-old'").run()).toThrow(/memories are retired, not deleted/);
    expect(db.prepare('SELECT count(*) AS n FROM memory_evidence').get()?.['n']).toBe(1);
  });
});

describe('reflection jobs and guidelines', () => {
  it('rejects an unknown job state and a job of an unknown run', () => {
    const db = migratedDb();
    const job = { attempts: 0, created_at: 1, updated_at: 1 };
    expect(() => insertRow(db, 'reflection_jobs', { run_id: 'absent', state: 'pending', ...job })).toThrow(/FOREIGN KEY/);
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRow(db, 'reflection_jobs', { run_id: 'r1', state: 'queued', ...job })).toThrow(/CHECK/);
    for (const state of ['pending', 'running', 'done', 'failed']) insertRow(db, 'reflection_jobs', { run_id: state, state, ...job });
    expect(db.prepare('SELECT count(*) AS n FROM reflection_jobs').get()?.['n']).toBe(4);
  });

  it('chains guidelines by version and rejects an unknown parent', () => {
    const db = migratedDb();
    const guideline = (version: number, parent: number | null): Fields => ({ version, text: 'keep paths', parent, created_at: 1, adopted_at: null, report_json: '{}' });
    insertRow(db, 'compaction_guidelines', guideline(1, null));
    insertRow(db, 'compaction_guidelines', guideline(2, 1));
    expect(() => insertRow(db, 'compaction_guidelines', guideline(3, 9))).toThrow(/FOREIGN KEY/);
  });
});

const PROPOSAL: Fields = {
  source_kind: 'proposal',
  source_at: null,
  source_session_id: 's1',
  source_run_id: 'r1',
  source_seq: 4,
  source_call_id: 'c1',
};

describe('one proposal yields one governing fact', () => {
  it('refuses a second fact for the same proposal call', () => {
    const db = migratedDb();
    insertFact(db, { id: 'g1', ...PROPOSAL });
    expect(() => insertFact(db, { id: 'g2', ...PROPOSAL })).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) AS n FROM governing_facts').get()?.['n']).toBe(1);
  });

  it('allows proposals of different calls and any number of command facts', () => {
    const db = migratedDb();
    insertFact(db, { id: 'g1', ...PROPOSAL });
    insertFact(db, { id: 'g2', ...PROPOSAL, source_call_id: 'c2' });
    insertFact(db, { id: 'g3' });
    insertFact(db, { id: 'g4' });
    expect(db.prepare('SELECT count(*) AS n FROM governing_facts').get()?.['n']).toBe(4);
  });
});

describe('INSERT OR REPLACE cannot rewrite a row', () => {
  it('leaves a governing fact and its retirement untouched', () => {
    const db = migratedDb();
    insertFact(db);
    db.prepare("UPDATE governing_facts SET retired_at = 5 WHERE id = 'g1'").run();
    expect(() => insertFact(db, { text: 'rewritten' }, 'INSERT OR REPLACE')).toThrow(/governing_facts/);
    expect({ ...db.prepare('SELECT text, retired_at FROM governing_facts').get() }).toEqual({ text: 'do not use pandas', retired_at: 5 });
  });

  it('leaves a memory and its index untouched', () => {
    const db = migratedDb();
    expect(() => insertMemory(db, 'm-old', 'rewritten text', 'INSERT OR REPLACE')).toThrow(/memories/);
    expect(db.prepare("SELECT text FROM memories WHERE id = 'm-old'").get()?.['text']).toBe('pandas lives in requirements.txt');
    expect(memoryIds(db, 'requirements')).toEqual(['m-old']);
    expect(memoryIds(db, 'rewritten')).toEqual([]);
  });

  it('leaves a search document and its index untouched', () => {
    const db = migratedDb();
    insertDoc(db, 1, 'refactor the tokenizer');
    expect(() => insertDoc(db, 1, 'rewritten body', {}, 'INSERT OR REPLACE')).toThrow(/search_docs/);
    expect(searchIds(db, 'tokenizer')).toEqual([1]);
    expect(searchIds(db, 'rewritten')).toEqual([]);
  });

  it('refuses a second memory for one source call, also by replacing the first under another id', () => {
    const db = migratedDb();
    const second = (verb: string) =>
      db
        .prepare(
          `${verb} INTO memories (id, scope, origin, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, kept_at)
           VALUES ('m-second', 'user', 'trusted', NULL, 'again', 's1', 'run-m-old', 1, 'call-m-old', 1, 1, 1)`,
        )
        .run();
    expect(() => second('INSERT')).toThrow(/memories/);
    expect(() => second('INSERT OR REPLACE')).toThrow(/memories/);
    expect(db.prepare('SELECT id FROM memories').all().map((row) => row['id'])).toEqual(['m-old']);
    expect(memoryIds(db, 'requirements')).toEqual(['m-old']);
    expect(memoryIds(db, 'again')).toEqual([]);
  });
});

describe('context charges', () => {
  const charge = (overrides: Fields = {}): Fields => ({
    purpose: 'reflection',
    run_id: null,
    project: '/work/a',
    model: 'fm',
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    created_at: 1,
    ...overrides,
  });

  it('has the contract columns', () => {
    expect(columnsOf(migratedDb(), 'context_charges')).toEqual([
      'id',
      'purpose',
      'run_id',
      'project',
      'model',
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'created_at',
      'detail_json',
    ]);
  });

  it('records a reflection charge for a run and a guideline charge for none', () => {
    const db = migratedDb();
    db.exec('PRAGMA foreign_keys = OFF');
    insertRow(db, 'context_charges', charge({ run_id: 'r1' }));
    insertRow(db, 'context_charges', charge({ purpose: 'guideline' }));
    expect(db.prepare('SELECT purpose FROM context_charges ORDER BY id').all().map((row) => row['purpose'])).toEqual(['reflection', 'guideline']);
  });

  it('refuses an in-run purpose, a charge without project or model, and a run that does not exist', () => {
    const db = migratedDb();
    expect(() => insertRow(db, 'context_charges', charge({ purpose: 'compaction' }))).toThrow(/CHECK/);
    expect(() => insertRow(db, 'context_charges', charge({ project: null }))).toThrow(/NOT NULL/);
    expect(() => insertRow(db, 'context_charges', charge({ model: null }))).toThrow(/NOT NULL/);
    expect(() => insertRow(db, 'context_charges', charge({ run_id: 'absent' }))).toThrow(/FOREIGN KEY/);
  });
});

describe('memory source kinds', () => {
  const reflectionRow = (callId: string): Fields => ({ source_kind: 'reflection', source_call_id: callId, state: 'candidate' });

  const insertWith = (db: DatabaseSync, id: string, overrides: Fields): void => {
    insertMemory(db, id, `text ${id}`);
    const names = Object.keys(overrides);
    db.prepare(`UPDATE memories SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(overrides), id);
  };

  it('accepts a reflection memory whose call id names its ordinal', () => {
    const db = migratedDb();
    insertWith(db, 'm-r0', reflectionRow('reflection:0'));
    insertWith(db, 'm-r1', reflectionRow('reflection:1'));
    expect(db.prepare("SELECT count(*) AS n FROM memories WHERE source_kind = 'reflection'").get()?.['n']).toBe(2);
  });

  it('refuses a reflection memory with another call id, and a tool memory with a reflection call id', () => {
    const db = migratedDb();
    expect(() => insertWith(db, 'm-a', reflectionRow('call-1'))).toThrow(/CHECK/);
    expect(() => insertWith(db, 'm-b', reflectionRow('reflection:x'))).toThrow(/CHECK/);
    expect(() => insertWith(db, 'm-d', reflectionRow('reflection:1x'))).toThrow(/CHECK/);
    expect(() => insertWith(db, 'm-e', reflectionRow('reflection:'))).toThrow(/CHECK/);
    expect(() => insertWith(db, 'm-c', { source_call_id: 'reflection:3' })).toThrow(/CHECK/);
  });
});

describe('memory command source', () => {
  const commandRow = (id: string, overrides: Fields = {}): Fields => ({
    id,
    scope: 'user',
    origin: 'trusted',
    project: null,
    text: `text ${id}`,
    created_at: START_MS,
    kept_at: START_MS,
    source_kind: 'command',
    ...overrides,
  });

  it('accepts a memory a person added, whose run and call columns are all null', () => {
    const db = migratedDb();
    insertRow(db, 'memories', commandRow('m-c1'));
    insertRow(db, 'memories', commandRow('m-c2'));
    expect(db.prepare("SELECT count(*) AS n FROM memories WHERE source_kind = 'command'").get()?.['n']).toBe(2);
  });

  it('refuses a command memory that names a run or a call', () => {
    const db = migratedDb();
    expect(() => insertRow(db, 'memories', commandRow('m-a', { source_run_id: 'r1' }))).toThrow(/CHECK/);
    expect(() => insertRow(db, 'memories', commandRow('m-b', { source_call_id: 'c1' }))).toThrow(/CHECK/);
    expect(() => insertRow(db, 'memories', commandRow('m-c', { source_session_id: 's1' }))).toThrow(/CHECK/);
  });

  it('refuses a tool memory without its run, call, step, session or event', () => {
    const db = migratedDb();
    const tool = (id: string, overrides: Fields): Fields => ({ ...commandRow(id), source_kind: 'tool', source_session_id: 's1', source_run_id: `r-${id}`, source_step: 1, source_call_id: `c-${id}`, source_seq: 1, ...overrides });
    insertRow(db, 'memories', tool('m-ok', {}));
    for (const column of ['source_session_id', 'source_run_id', 'source_step', 'source_call_id', 'source_seq']) {
      expect(() => insertRow(db, 'memories', tool(`m-${column}`, { [column]: null }))).toThrow(/CHECK|NOT NULL/);
    }
  });

  it('keeps the memories that existed before the migration and still refuses an unknown source kind', () => {
    const db = migratedDb();
    expect(db.prepare("SELECT source_kind FROM memories WHERE id = 'm-old'").get()?.['source_kind']).toBe('tool');
    expect(() => insertRow(db, 'memories', commandRow('m-x', { source_kind: 'person' }))).toThrow(/CHECK/);
  });
});

describe('user-scope governing facts', () => {
  it('refuses paths on a user fact and accepts them on a project fact', () => {
    const db = migratedDb();
    expect(() => insertFact(db, { paths_json: '["src/**"]' })).toThrow(/CHECK/);
    insertFact(db, { id: 'g2', scope_level: 'project', project: '/work/a', paths_json: '["src/**"]' });
  });
});
