import { afterEach, describe, expect, it } from 'vitest';
import { createUdsClient, decodeSse } from '@momonga/foundation';
import { anthropicErrorReply, anthropicTextReply, startFakeAnthropic, startFakeOpenResponses, openResponsesTextReply } from '../src/index.ts';
import type { FakeUpstreamServer } from '../src/index.ts';

const servers: FakeUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const post = async (server: FakeUpstreamServer, path: string, headers: Record<string, string>) => {
  const client = createUdsClient(server.socketPath);
  try {
    const response = await client.request({ method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: '{"q":1}' });
    const frames: Array<{ event: string | undefined; data: string }> = [];
    if (response.status === 200) for await (const frame of decodeSse(response.body)) frames.push({ event: frame.event, data: frame.data });
    return { status: response.status, frames, text: response.status === 200 ? '' : await response.text() };
  } finally {
    await client.close();
  }
};

describe('fake Anthropic upstream', () => {
  it('rejects a wrong key and a missing version, then serves the script in order', async () => {
    const server = await startFakeAnthropic({ apiKey: 'k', script: [anthropicTextReply(['hi']), anthropicErrorReply(529, 'overloaded_error', 'busy')] });
    servers.push(server);
    expect((await post(server, '/v1/messages', { 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' })).status).toBe(401);
    expect((await post(server, '/v1/messages', { 'x-api-key': 'k' })).status).toBe(400);
    const served = await post(server, '/v1/messages', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(served.frames[0]?.event).toBe('message_start');
    expect(served.frames.at(-1)?.event).toBe('message_stop');
    expect((await post(server, '/v1/messages', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })).status).toBe(529);
    expect((await post(server, '/v1/messages', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })).status).toBe(500);
    expect((await post(server, '/v1/other', {})).status).toBe(404);
    expect(server.requests).toHaveLength(6);
  });
});

describe('fake Open Responses upstream', () => {
  it('checks the bearer token and ends a text stream with the [DONE] marker', async () => {
    const server = await startFakeOpenResponses({ apiKey: 'k', script: [openResponsesTextReply(['a', 'b'])] });
    servers.push(server);
    expect((await post(server, '/v1/responses', { authorization: 'Bearer wrong' })).status).toBe(401);
    const served = await post(server, '/v1/responses', { authorization: 'Bearer k' });
    expect(served.frames[0]?.event).toBe('response.created');
    expect(served.frames.at(-1)?.data).toBe('[DONE]');
    expect(served.frames.filter((frame) => frame.event === 'response.output_text.delta')).toHaveLength(2);
  });
});
