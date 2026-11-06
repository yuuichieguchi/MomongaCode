import fs from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';

type RecordedOutcome = { kind: 'refused'; message: string } | { kind: 'streamed_error'; message: string } | { kind: 'content_only' };
type RecordedReply = { name: string; status: number; outcome: RecordedOutcome; request: Record<string, unknown> };

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/fm-tools-decoding.json', import.meta.url), 'utf8')) as {
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

const dataEventsOf = (text: string): unknown[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the fake fm answers native tool requests as the real fm serve does', () => {
  it.each(recorded.replies.map((reply) => [reply.name, reply] as const))('%s', async (_name, reply) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm' });
    servers.push(fake);

    const result = await post(fake.socketPath, reply.request);

    expect(result.status).toBe(reply.status);
    if (reply.outcome.kind === 'refused') {
      expect(JSON.parse(result.text)).toEqual({ error: { code: '400', message: reply.outcome.message, type: 'invalid_request_error' } });
      return;
    }
    const events = dataEventsOf(result.text);
    if (reply.outcome.kind === 'streamed_error') {
      expect(events).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ message: reply.outcome.message }) }));
      return;
    }
    expect(result.text).not.toContain('tool_calls');
    expect(events.some((event) => JSON.stringify(event).includes('"error"'))).toBe(false);
  });
});
