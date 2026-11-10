import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, harness, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const servers = { fx: { command: '/usr/bin/node', args: ['server.js'], env: { TOKEN: 'literal' } }, docs: { type: 'http', url: 'https://example.com/mcp', headers: {} } };

describe('session mcpServers', () => {
  it('stores and returns the servers a session was created with', () => {
    const { store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm', mcpServers: servers });

    expect(created.mcpServers).toEqual(servers);
    expect(store.getSession(created.id)?.mcpServers).toEqual(servers);
    expect(store.listSessions().map((session) => session.mcpServers)).toEqual([servers]);
  });

  it('defaults to no servers', () => {
    const { dbPath, store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });

    expect(created.mcpServers).toEqual({});
    expect(rawDb(dbPath).prepare('SELECT mcp_servers_json FROM sessions').all()).toEqual([{ mcp_servers_json: '{}' }]);
  });

  it('replaces the servers as a whole and leaves the other fields alone', () => {
    const { store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: { PATH: '/usr/bin' }, permissionMode: 'plan', model: 'fm', mcpServers: servers });

    const replaced = store.setSessionMcpServers(created.id, { only: { command: 'x' } });

    expect(replaced).toEqual({ kind: 'ok', session: { ...created, mcpServers: { only: { command: 'x' } } } });
    expect(store.getSession(created.id)).toEqual({ ...created, mcpServers: { only: { command: 'x' } } });
    expect(store.setSessionMcpServers(created.id, {})).toMatchObject({ kind: 'ok', session: { mcpServers: {} } });
  });

  it('reports a missing session', () => {
    const { store } = harness();

    expect(store.setSessionMcpServers('missing', {})).toEqual({ kind: 'not_found' });
  });

  it('migrates a v7 database to sessions without servers', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 7));
      db.prepare(
        `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
         VALUES ('sess-old', '/work/old', '{}', 'default', 'fm', ?)`,
      ).run(START_MS);
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);

    const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));

    expect(store.getSession('sess-old')?.mcpServers).toEqual({});
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a server that is not an object', '{"fx":"node"}'],
  ])('a malformed mcp_servers_json is reported as corrupt (%s)', (_label, value) => {
    const { dbPath, store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });
    rawDb(dbPath).prepare('UPDATE sessions SET mcp_servers_json = ? WHERE id = ?').run(value, created.id);

    expect(() => store.getSession(created.id)).toThrow(/corrupt/);
  });
});
