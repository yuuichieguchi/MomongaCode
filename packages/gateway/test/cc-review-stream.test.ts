import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { collect, expectSpecValid, makeAdapter, ofType, startFake, terminalOf, userText } from './cc-support.ts';
import { registerCleanup } from './gateway-helpers.ts';

const plain = { model: 'system', input: [userText('hi')] };

describe('failed terminals close open items', () => {
  it('finishes an open message as incomplete before response.failed', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'abc' } }] }],
    });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(expectSpecValid(events)).toEqual([]);
    const done = ofType(events, 'response.output_item.done');
    expect(done).toHaveLength(1);
    expect(done[0].item).toMatchObject({ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: 'abc' }] });
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.output).toEqual([done[0].item]);
  });

  it('finishes a partial tool call as incomplete before response.failed', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }],
        },
      ],
    });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(expectSpecValid(events)).toEqual([]);
    const done = ofType(events, 'response.output_item.done');
    expect(done.map((event) => [event.item.type, event.item.status, event.item.arguments])).toEqual([['function_call', 'incomplete', '{"pa']]);
    expect(terminalOf(events).type).toBe('response.failed');
  });
});

describe('refusals', () => {
  it('maps delta.refusal to a refusal content part', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [
            { delta: { role: 'assistant', content: null } },
            { delta: { refusal: 'I can' } },
            { delta: { refusal: 'not help' } },
            { delta: {}, finishReason: 'stop' },
          ],
        },
      ],
    });
    const { events, error } = await collect(makeAdapter(fake), plain);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    expect(ofType(events, 'response.output_text.delta')).toEqual([]);
    expect(ofType(events, 'response.refusal.delta').map((event) => event.delta)).toEqual(['I can', 'not help']);
    expect(ofType(events, 'response.refusal.done').map((event) => event.refusal)).toEqual(['I cannot help']);
    const done = ofType(events, 'response.output_item.done');
    expect(done[0].item).toMatchObject({ type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help' }] });
    expect(terminalOf(events).response.output).toEqual([done[0].item]);
  });

  it('keeps text and refusal as separate content parts of one message', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [{ delta: { content: 'Sure. ' } }, { delta: { refusal: 'But no.' } }, { delta: {}, finishReason: 'stop' }],
        },
      ],
    });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(expectSpecValid(events)).toEqual([]);
    const done = ofType(events, 'response.output_item.done');
    expect(done).toHaveLength(1);
    expect(done[0].item.content).toEqual([
      { type: 'output_text', text: 'Sure. ', annotations: [] },
      { type: 'refusal', refusal: 'But no.' },
    ]);
  });
});

describe('tcp endpoint paths', () => {
  const pathSeenFor = async (suffix: string): Promise<string> => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? '');
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    registerCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake, { resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `http://127.0.0.1:${port}${suffix}` }) });
    const { error } = await collect(adapter, plain);
    expect(error).toBeUndefined();
    return paths[0] as string;
  };

  it.each([['/v1'], ['/v1/'], ['/custom/v1']])('appends /chat/completions to a baseUrl ending in %s', async (suffix) => {
    expect(await pathSeenFor(suffix)).toBe(`${suffix.replace(/\/$/, '')}/chat/completions`);
  });
});
