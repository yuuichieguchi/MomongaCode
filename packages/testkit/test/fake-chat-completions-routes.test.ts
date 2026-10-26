import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeScriptedReply } from '@momonga/testkit';

const servers: FakeChatCompletionsServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const MARKER = 'SUMMARISE-MARKER';

const streamOf = (text: string): FakeScriptedReply => ({
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content: text } }, { delta: {}, finishReason: 'stop' }],
});

const isSummaryRequest = (body: unknown): boolean => {
  const messages = (body as { messages?: Array<{ role?: unknown; content?: unknown }> }).messages ?? [];
  const first = messages[0];
  return first?.role === 'system' && typeof first.content === 'string' && first.content.includes(MARKER);
};

const summaryBody = {
  model: 'system',
  stream: true,
  messages: [
    { role: 'system', content: `${MARKER} write the note` },
    { role: 'user', content: 'transcript' },
  ],
};

const modelBody = { model: 'system', stream: true, messages: [{ role: 'user', content: 'hi' }] };

const post = (socketPath: string, body: unknown): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

const contentOf = (sse: string): string =>
  sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
    .join('');

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
};

describe('fake chat completions routes', () => {
  it('serves a matching request from its route without consuming the script, and counts the hit', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      script: [streamOf('scripted reply')],
      routes: [{ match: isSummaryRequest, reply: streamOf('routed summary') }],
    });
    servers.push(fake);
    const routed = await post(fake.socketPath, summaryBody);
    expect(routed.status).toBe(200);
    expect(contentOf(routed.text)).toBe('routed summary');
    expect(fake.routeHits).toEqual([1]);
    const scripted = await post(fake.socketPath, modelBody);
    expect(contentOf(scripted.text)).toBe('scripted reply');
    expect(fake.routeHits).toEqual([1]);
    expect(fake.requests.map((request) => request.body)).toEqual([summaryBody, modelBody]);
  });

  it('serves a route on every match, so one route answers repeated requests', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      routes: [{ match: isSummaryRequest, reply: streamOf('again') }],
    });
    servers.push(fake);
    expect(contentOf((await post(fake.socketPath, summaryBody)).text)).toBe('again');
    expect(contentOf((await post(fake.socketPath, summaryBody)).text)).toBe('again');
    expect(fake.routeHits).toEqual([2]);
  });

  it('counts hits per route and uses the first matching route', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      routes: [
        { match: () => false, reply: streamOf('never') },
        { match: isSummaryRequest, reply: streamOf('second') },
        { match: isSummaryRequest, reply: streamOf('third') },
      ],
    });
    servers.push(fake);
    expect(contentOf((await post(fake.socketPath, summaryBody)).text)).toBe('second');
    expect(fake.routeHits).toEqual([0, 1, 0]);
  });

  it('evaluates routes before holds, so a hold captures only the next unrouted request', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      maxConcurrency: 4,
      script: [streamOf('held model reply')],
      routes: [{ match: isSummaryRequest, reply: streamOf('routed while held') }],
    });
    servers.push(fake);
    const hold = fake.hold();
    const routed = post(fake.socketPath, summaryBody);
    expect(await settled(routed)).toBe(true);
    expect(contentOf((await routed).text)).toBe('routed while held');
    const held = post(fake.socketPath, modelBody);
    const arrived = await hold.waitForRequest();
    expect(arrived.body).toEqual(modelBody);
    expect(await settled(held)).toBe(false);
    hold.release();
    expect(contentOf((await held).text)).toBe('held model reply');
  });

  it('serves a routed reply whatever response_format and tools the request carries', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'none',
      routes: [{ match: isSummaryRequest, reply: streamOf('format ignored') }],
    });
    servers.push(fake);
    const constrained = {
      ...summaryBody,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } },
    };
    const routed = await post(fake.socketPath, constrained);
    expect(routed.status).toBe(200);
    expect(contentOf(routed.text)).toBe('format ignored');
    expect(fake.routeHits).toEqual([1]);
  });

  it('starts with zero hits per route and an empty list without routes', async () => {
    const routedFake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      routes: [{ match: isSummaryRequest, reply: streamOf('x') }, { match: isSummaryRequest, reply: streamOf('y') }],
    });
    servers.push(routedFake);
    expect(routedFake.routeHits).toEqual([0, 0]);
    const plain = await startFakeChatCompletions({ scenario: 'tools-ok' });
    servers.push(plain);
    expect(plain.routeHits).toEqual([]);
  });
});
