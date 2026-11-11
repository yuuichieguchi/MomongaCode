import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createReplayAdapter } from '@momonga/gateway';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { makeDir, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const corrupt = (dbPath: string, sql: string, ...params: string[]): void => {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
};

const events = (text: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text] });

describe('rows read back from gateway.db are validated', () => {

  it('names the idempotency table and key when stored frames are malformed', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('one') }] });
    const { client, dbPath } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const body = { model: 'scripted/scripted-primary', input: userInput('q') };
    await readJson(await postJson(client, '/v1/responses', body, { 'idempotency-key': 'k-corrupt' }));
    corrupt(dbPath, 'UPDATE idempotency SET frames_json = ? WHERE key = ?', '[{"type":"response.completed"}]', 'k-corrupt');
    const replayed = await readJson(await postJson(client, '/v1/responses', body, { 'idempotency-key': 'k-corrupt' }));
    expect(replayed.status).toBe(500);
    expect(replayed.body.error.message).toContain('idempotency');
    expect(replayed.body.error.message).toContain('k-corrupt');
  });
});

describe('replay recordings are validated', () => {
  it('names the file and line of a malformed entry in strict mode', () => {
    const file = path.join(makeDir(), 'broken.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ digest: 'd', events: [{ type: 'response.created' }] })}\n`, { mode: 0o600 });
    expect(() => createReplayAdapter({ path: file, mode: 'strict' })).toThrow(/broken\.jsonl:1/);
  });
});
