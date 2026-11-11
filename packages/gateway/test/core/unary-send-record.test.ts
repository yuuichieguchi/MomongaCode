import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { anthropicCountTokensReply, anthropicErrorReply, anthropicTextReply, waitFor } from '@momonga/testkit';
import { postJson, readJson, userInput } from '../gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway } from '../upstream-gateway-support.ts';

const KEY_HEADER = 'x-upstream-key';
const CAPABILITIES = { ...REMOTE_CAPABILITIES, idempotencyKey: { header: KEY_HEADER } };
const MODEL = 'scripted/upstream-model';

const sendsOf = (dbPath: string): Array<{ call_key: string; target: string; run_id: string | null }> => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT call_key, target, run_id FROM sends ORDER BY seq').all() as Array<{ call_key: string; target: string; run_id: string | null }>;
  } finally {
    db.close();
  }
};

describe('compaction and count-tokens write a send record and send a key (gateway-core-C28)', () => {
  it('writes one send record per upstream call of a compaction and sends each call its key', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(80), anthropicTextReply(['summary'])], capabilities: CAPABILITIES });

    const response = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: MODEL, input: userInput('do X') }, { 'idempotency-key': 'compact-c28' }));

    expect(response.status).toBe(200);
    const sends = sendsOf(gateway.dbPath);
    expect(sends.map((send) => send.target)).toEqual([MODEL, MODEL]);
    expect(new Set(sends.map((send) => send.call_key)).size).toBe(2);
    const keys = gateway.fake.requests.map((request) => request.headers[KEY_HEADER]);
    expect(keys).toEqual(sends.map((send) => send.call_key));
  });

  it('writes one send record for a count and sends its key', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(321)], capabilities: CAPABILITIES });

    const response = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', { model: MODEL, input: userInput('hello') }));

    expect(response.status).toBe(200);
    const sends = sendsOf(gateway.dbPath);
    expect(sends).toHaveLength(1);
    expect(gateway.fake.requests[0]?.headers[KEY_HEADER]).toBe(sends[0]?.call_key);
  });

  it('sends the same key when a compaction is tried again', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicCountTokensReply(80), anthropicErrorReply(529, 'overloaded_error', 'busy'), anthropicCountTokensReply(80), anthropicTextReply(['summary'])],
      capabilities: CAPABILITIES,
      config: { retry: { maxAttempts: 2 } },
    });

    const pending = postJson(gateway.client, '/v1/responses/compact', { model: MODEL, input: userInput('do X') }, { 'idempotency-key': 'compact-c28-retry' });
    await waitFor(() => gateway.fake.requests.length === 2 && gateway.timers.pending().length > 0, { description: 'the first summary call to fail and its retry to wait' });
    gateway.timers.advance(gateway.timers.pending().at(-1)?.delayMs ?? 0);
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    const summaryKeys = gateway.fake.requests.filter((request) => request.path !== '/v1/messages/count_tokens').map((request) => request.headers[KEY_HEADER]);
    expect(summaryKeys).toHaveLength(2);
    expect(summaryKeys[0]).toBeDefined();
    expect(summaryKeys[1]).toBe(summaryKeys[0]);
  });
});
