import fs from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';

type RecordedReply = { name: string; schemaName: string; status: number; message: string | null; schema: unknown };

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/fm-schema-decoding.json', import.meta.url), 'utf8')) as {
  source: string;
  replies: RecordedReply[];
};

const post = (socketPath: string, body: unknown): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the fake fm decodes response_format schemas as the real fm serve does', () => {
  it.each(recorded.replies.map((reply) => [reply.name, reply] as const))('%s', async (_name, reply) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm' });
    servers.push(fake);

    const result = await post(fake.socketPath, {
      model: 'system',
      messages: [{ role: 'user', content: 'Give an example value.' }],
      max_completion_tokens: 64,
      response_format: { type: 'json_schema', json_schema: { name: reply.schemaName, strict: true, schema: reply.schema } },
    });

    expect(result.status).toBe(reply.status);
    if (reply.status === 400) {
      expect(JSON.parse(result.text)).toEqual({ error: { code: '400', message: reply.message, type: 'invalid_request_error' } });
    }
  });
});
