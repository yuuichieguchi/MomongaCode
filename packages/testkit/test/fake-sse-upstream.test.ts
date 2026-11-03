import { afterEach, describe, expect, it } from 'vitest';
import { createUdsClient, decodeSse } from '@momonga/foundation';
import { anthropicErrorReply, anthropicTextReply, startFakeAnthropic, startFakeOpenResponses, openResponsesTextReply, openResponsesToolCallReply, usageOf } from '../src/index.ts';
import { canonicalJson } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
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

  it('sizes the input tokens of a reply without usage by the request it answers', async () => {
    const server = await startFakeOpenResponses({ script: [openResponsesTextReply(['a']), openResponsesTextReply(['a'])] });
    servers.push(server);
    const small = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: [] })));
    const large = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: ['x'.repeat(4000)] })));
    expect(small.output_tokens).toBe(small.estimated_output_tokens);
    expect(large.output_tokens).toBe(large.estimated_output_tokens);
    expect(small.input_tokens).toBeLessThan(20);
    expect(large.input_tokens).toBeGreaterThanOrEqual(1000);
    expect(large.total_tokens).toBe(large.input_tokens + large.output_tokens);
  });

  it('sizes a CJK request at least as large as the project estimator counts it', async () => {
    const server = await startFakeOpenResponses({ script: [openResponsesToolCallReply('call_1', 'T', ['{}'])] });
    servers.push(server);
    const body = JSON.stringify({ model: 'm', input: ['日本語のテキスト'.repeat(200)] });
    const usage = await completedUsage(await postBody(server, body));
    expect(usage.input_tokens).toBeGreaterThanOrEqual(tokensForText(JSON.stringify(JSON.parse(body))));
  });

  it('sizes a reply that was cloned after it was built', async () => {
    const server = await startFakeOpenResponses({ respond: () => structuredClone(openResponsesTextReply(['a'])) });
    servers.push(server);
    const usage = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: ['x'.repeat(4000)] })));
    expect(usage.input_tokens).toBeGreaterThanOrEqual(1000);
  });

  it('keeps an explicit null usage', async () => {
    const server = await startFakeOpenResponses({ script: [openResponsesTextReply(['a'], null)] });
    servers.push(server);
    const frames = await postBody(server, JSON.stringify({ model: 'm', input: [] }));
    const terminal = frames.find((frame) => frame.event === 'response.completed');
    expect((JSON.parse(terminal?.data ?? '{}') as { response: { usage: unknown } }).response.usage).toBeNull();
  });

  it('keeps an explicit usage whatever the request size', async () => {
    const server = await startFakeOpenResponses({ script: [openResponsesTextReply(['a'], usageOf(11, 3))] });
    servers.push(server);
    const usage = await completedUsage(await postBody(server, JSON.stringify({ model: 'm', input: ['x'.repeat(4000)] })));
    expect(usage.input_tokens).toBe(11);
  });

  it('refuses a script and a responder together', () => {
    expect(() => startFakeOpenResponses({ script: [], respond: () => undefined })).toThrow('a script or respond, not both');
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

const completedUsage = async (
  frames: Array<{ event: string | undefined; data: string }>,
): Promise<{ input_tokens: number; output_tokens: number; total_tokens: number; estimated_output_tokens: number }> => {
  const terminal = frames.find((frame) => frame.event === 'response.completed');
  if (terminal === undefined) throw new Error('the stream has no response.completed frame');
  const { response } = JSON.parse(terminal.data) as { response: { output: unknown; usage: { input_tokens: number; output_tokens: number; total_tokens: number } } };
  return { ...response.usage, estimated_output_tokens: tokensForText(canonicalJson(response.output)) };
};
