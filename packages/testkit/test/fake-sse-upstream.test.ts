import { afterEach, describe, expect, it } from 'vitest';
import { createUdsClient, decodeSse } from '@momonga/foundation';
import { anthropicErrorReply, anthropicTextReply, startFakeAnthropic, startFakeOpenResponses, openResponsesTextReply, usageOf } from '../src/index.ts';
import type { FakeUpstreamServer } from '../src/index.ts';

const servers: FakeUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const VALID_BODY = JSON.stringify({ model: 'm', max_tokens: 1, messages: [], input: [] });

const post = async (server: FakeUpstreamServer, path: string, headers: Record<string, string>) => {
  const client = createUdsClient(server.socketPath);
  try {
    const response = await client.request({ method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: VALID_BODY });
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

  it('reports input tokens in proportion to the request it answers when asked to', async () => {
    const server = await startFakeOpenResponses({ reportRequestSize: true, script: [openResponsesTextReply(['a'], usageOf(11, 3)), openResponsesTextReply(['a'], usageOf(11, 3))] });
    servers.push(server);
    const small = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: [] })));
    const large = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: ['x'.repeat(4000)] })));
    expect(small.output_tokens).toBe(3);
    expect(large.output_tokens).toBe(3);
    expect(small.input_tokens).toBeLessThan(20);
    expect(large.input_tokens).toBeGreaterThanOrEqual(1000);
    expect(large.total_tokens).toBe(large.input_tokens + 3);
  });

  it('keeps the scripted usage when not asked to', async () => {
    const server = await startFakeOpenResponses({ script: [openResponsesTextReply(['a'], usageOf(11, 3))] });
    servers.push(server);
    const usage = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: ['x'.repeat(4000)] })));
    expect(usage.input_tokens).toBe(11);
  });
});

const postBody = async (server: FakeUpstreamServer, body: string): Promise<Array<{ event: string | undefined; data: string }>> => {
  const client = createUdsClient(server.socketPath);
  try {
    const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body });
    const frames: Array<{ event: string | undefined; data: string }> = [];
    for await (const frame of decodeSse(response.body)) frames.push({ event: frame.event, data: frame.data });
    return frames;
  } finally {
    await client.close();
  }
};

const completedUsage = async (frames: Array<{ event: string | undefined; data: string }>): Promise<{ input_tokens: number; output_tokens: number; total_tokens: number }> => {
  const terminal = frames.find((frame) => frame.event === 'response.completed');
  if (terminal === undefined) throw new Error('the stream has no response.completed frame');
  return (JSON.parse(terminal.data) as { response: { usage: { input_tokens: number; output_tokens: number; total_tokens: number } } }).response.usage;
};
