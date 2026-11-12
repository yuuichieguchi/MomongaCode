import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { BUSY_WAIT_LIMIT_MS, migrate, openDatabase } from '@momonga/foundation';
import { MIGRATIONS, openGatewayStore } from '../src/core/store.ts';
import { STORE_WORKER_CODE } from '../src/core/store-worker-code.generated.ts';
import { PRIMARY, getJson, makeDir, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const OPEN = new AbortController().signal;

const tablesOf = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
};

const responseIdsOf = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT id FROM responses ORDER BY id').all() as { id: string }[]).map((row) => row.id);
  } finally {
    db.close();
  }
};

const USAGE_TABLE_REMOVED_IN = 4;

const writeDatabaseOfAnEarlierBuild = (dbPath: string): void => {
  const db = openDatabase(dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version < USAGE_TABLE_REMOVED_IN));
    db.exec(`
      INSERT INTO responses (id, input_json, output_json, created_at_ms) VALUES ('resp_old', '[]', '[]', 1);
      INSERT INTO usage (response_id, run_id, step, target, input_tokens, output_tokens, total_tokens, usage_source, recorded_at_ms) VALUES ('resp_old', 'run-1', 1, 'scripted', 10, 2, 12, 'reported', 1);
    `);
  } finally {
    db.close();
  }
};

describe('the gateway keeps no usage table', () => {
  it('opens a new database without a usage table', async () => {
    const dbPath = path.join(makeDir(), 'gateway.db');
    await (await openGatewayStore({ dbPath, code: STORE_WORKER_CODE, signal: OPEN })).close(OPEN);

    expect(tablesOf(dbPath)).not.toContain('usage');
  });

  it('opens the database of an earlier build, removes its usage table and keeps its stored responses', async () => {
    const earlierPath = path.join(makeDir(), 'gateway.db');
    writeDatabaseOfAnEarlierBuild(earlierPath);
    expect(tablesOf(earlierPath)).toContain('usage');

    await (await openGatewayStore({ dbPath: earlierPath, code: STORE_WORKER_CODE, signal: OPEN })).close(OPEN);

    expect(responseIdsOf(earlierPath)).toEqual(['resp_old']);
    expect(tablesOf(earlierPath)).not.toContain('usage');
    expect(tablesOf(earlierPath)).toContain('sends');
  });

  it('answers a model call of a run with its cost in the reply and serves no usage route and no cost report route', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['one'], usage: usageOf(10, 2) }) }] });
    const { client, dbPath } = await startGateway({ adapters: { [PRIMARY]: primary } });

    const reply = await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), metadata: { run_id: 'run-1', step: '1' } }));

    expect(reply.status).toBe(200);
    expect(reply.body.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    expect(reply.body.momonga.cost !== undefined || reply.body.momonga.unpriced !== undefined).toBe(true);
    expect((await getJson(client, '/v1/momonga/usage?run_id=run-1')).status).toBe(404);
    expect((await postJson(client, '/v1/momonga/cost', { runs: [], includeRunless: false })).status).toBe(404);
    expect(tablesOf(dbPath)).not.toContain('usage');
  });
});
