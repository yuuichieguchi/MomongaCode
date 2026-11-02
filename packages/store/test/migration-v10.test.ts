import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const insertSession = (db: DatabaseSync, id: string, cwd: string): void => {
  db.prepare(
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at, additional_directories_json, mcp_servers_json)
     VALUES (?, ?, '{}', 'default', 'fm', ?, '[]', '{}')`,
  ).run(id, cwd, START_MS);
};

const insertMemory = (db: DatabaseSync, id: string, scope: 'user' | 'project', sessionId: string): void => {
  db.prepare(
    `INSERT INTO memories (id, scope, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at)
     VALUES (?, ?, ?, 'a note', ?, ?, 1, ?, 1, ?, ?)`,
  ).run(id, scope, scope === 'project' ? '/work/trusted' : null, sessionId, `run-${id}`, `call-${id}`, START_MS, START_MS);
};

describe('migration v10', () => {
  it('marks memories saved in a trusted folder or a folder below one as trusted, every other user memory as untrusted, and project memories as trusted', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 9));
      db.prepare("INSERT INTO trust (path, decision, decided_at) VALUES ('/work/trusted', 'trusted', ?)").run(START_MS);
      db.prepare("INSERT INTO trust (path, decision, decided_at) VALUES ('/work/refused', 'untrusted', ?)").run(START_MS);
      insertSession(db, 'in-trusted', '/work/trusted');
      insertSession(db, 'below-trusted', '/work/trusted/sub');
      insertSession(db, 'sibling-prefix', '/work/trusted-other');
      insertSession(db, 'refused', '/work/refused');
      insertSession(db, 'unknown', '/work/unknown');
      insertMemory(db, 'm-in', 'user', 'in-trusted');
      insertMemory(db, 'm-below', 'user', 'below-trusted');
      insertMemory(db, 'm-sibling', 'user', 'sibling-prefix');
      insertMemory(db, 'm-refused', 'user', 'refused');
      insertMemory(db, 'm-unknown', 'user', 'unknown');
      insertMemory(db, 'm-project', 'project', 'unknown');
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);

    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();

    const origins = Object.fromEntries(rawDb(dbPath).prepare('SELECT id, origin FROM memories').all().map((row) => [row['id'], row['origin']]));
    expect(origins).toEqual({
      'm-in': 'trusted',
      'm-below': 'trusted',
      'm-sibling': 'untrusted',
      'm-refused': 'untrusted',
      'm-unknown': 'untrusted',
      'm-project': 'trusted',
    });
  });
});
