import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, harness, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const OLD_ID = '018f4a2b-0000-7000-8000-00000000abcd';

describe('the fence boundary of a session', () => {
  it('is drawn once through the random port when the session is created and read back unchanged', () => {
    const { store, dbPath } = harness();
    const first = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });
    const second = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });
    expect(first.fenceNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(second.fenceNonce).not.toBe(first.fenceNonce);
    expect(store.getSession(first.id)?.fenceNonce).toBe(first.fenceNonce);
    expect(rawDb(dbPath).prepare('SELECT fence_nonce FROM sessions WHERE id = ?').get(first.id)).toEqual({ fence_nonce: first.fenceNonce });
  });

  it('a session created before migration 47 keeps the hex digits of its id as its boundary', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 46));
    db.prepare("INSERT INTO sessions (id, cwd, env_json, permission_mode, model, created_at) VALUES (?, '/work/old', '{}', 'manual', 'fm', ?)").run(OLD_ID, START_MS);
    db.close();
    fs.chmodSync(dbPath, 0o600);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));
    expect(store.getSession(OLD_ID)?.fenceNonce).toBe(OLD_ID.replaceAll('-', ''));
  });
});
