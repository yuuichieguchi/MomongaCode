import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import { openGatewayStore } from '../src/core/store.ts';
import { STORE_WORKER_CODE } from '../src/core/store-worker-code.generated.ts';
import { makeDir, postJson, readJson, startGateway } from './gateway-helpers.ts';

const OPEN = new AbortController().signal;

const exec = (dbPath: string, sql: string): void => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
};

const column = (dbPath: string, sql: string): unknown[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => Object.values(row)[0]);
  } finally {
    db.close();
  }
};

const seed = (dbPath: string): void =>
  exec(
    dbPath,
    `INSERT INTO sends (call_key, target, run_id, step, sent_at_ms) VALUES ('k1', 't', 'run-old', 1, 5000), ('k2', 't', 'run-new', 1, 5000);
     INSERT INTO responses (id, input_json, output_json, created_at_ms) VALUES ('resp_old', '[]', '[]', 100), ('resp_new', '[]', '[]', 9000);`,
  );

describe('the gateway side of retention', () => {
  it('deletes the rows of the given runs and the stored responses older than the cutoff', async () => {
    const dbPath = path.join(makeDir(), 'gateway.db');
    const store = await openGatewayStore({ dbPath, code: STORE_WORKER_CODE, signal: OPEN });
    seed(dbPath);

    await store.purgeRetained({ runIds: ['run-old'], cutoffMs: 1000 }, OPEN);
    await store.close(OPEN);

    expect(column(dbPath, 'SELECT run_id FROM sends ORDER BY seq')).toEqual(['run-new']);
    expect(column(dbPath, 'SELECT id FROM responses ORDER BY id')).toEqual(['resp_new']);
  });

  it('answers the retention purge on its internal channel and hands the run ids to the trace store', async () => {
    const handed: { runIds: readonly string[]; cutoffMs: number }[] = [];
    const h = await startGateway({
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      retentionPurge: async (runIds, cutoffMs) => {
        handed.push({ runIds, cutoffMs });
      },
    });
    seed(h.dbPath);

    const reply = await readJson(await postJson(h.client, '/v1/momonga/retention/purge', { runIds: ['run-old'], cutoffMs: 1000 }));

    expect(reply).toMatchObject({ status: 200, body: { purged: 2 } });
    expect(handed).toEqual([{ runIds: ['run-old'], cutoffMs: 1000 }]);
    expect(column(h.dbPath, 'SELECT run_id FROM sends ORDER BY seq')).toEqual(['run-new']);
  });

  it('refuses a purge whose run ids are not a list of text', async () => {
    const h = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) } });
    const reply = await readJson(await postJson(h.client, '/v1/momonga/retention/purge', { runIds: [1], cutoffMs: 1000 }));
    expect(reply.status).toBe(400);
  });
});
