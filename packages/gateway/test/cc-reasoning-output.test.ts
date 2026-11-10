import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import type { FakeChatCompletionsServer, FakeStreamChunk } from '@momonga/testkit';
import { postJson, readSse, startGateway, userInput } from './gateway-helpers.ts';
import { collect, expectSpecValid, lastCompletionBody, makeAdapter, ofType, outputTextOf, readFileTool, startFake, terminalOf, userText } from './cc-support.ts';
import { fixtureText } from './ollama-support.ts';

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;

const reasoningOf = (events: readonly any[]): string =>
  ofType(events, 'response.reasoning.delta')
    .map((event) => event.delta as string)
    .join('');

const recordedQwenStream = () => {
  const chunks: FakeStreamChunk[] = [];
  let usage: any;
  for (const line of fixtureText('qwen-v1-reasoning.sse').split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const parsed = JSON.parse(line.slice('data: '.length));
    if (parsed.usage !== undefined) usage = { prompt_tokens: parsed.usage.prompt_tokens, completion_tokens: parsed.usage.completion_tokens, total_tokens: parsed.usage.total_tokens };
    const choice = parsed.choices[0];
    if (choice !== undefined) chunks.push({ delta: choice.delta, finishReason: choice.finish_reason });
  }
  const deltas = chunks.map((chunk) => chunk.delta);
  return {
    chunks,
    usage,
    reasoning: deltas.map((delta) => (delta['reasoning'] as string | undefined) ?? '').join(''),
    text: deltas.map((delta) => (delta['content'] as string | undefined) ?? '').join(''),
  };
};

const fieldChunks = (field: string, parts: readonly string[]): FakeStreamChunk[] => [
  { delta: { role: 'assistant', content: '' } },
  ...parts.map((part) => ({ delta: { [field]: part } })),
  { delta: { content: 'I will read it.' } },
  { delta: { tool_calls: [{ index: 0, id: 'call_r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
  { delta: {}, finishReason: 'tool_calls' },
];

const firstTurn = async (fake: FakeChatCompletionsServer) => {
  const adapter = makeAdapter(fake);
  const { events, error } = await collect(adapter, { model: 'system', input: [userText('read a.txt')], tools: [readFileTool] });
  expect(error).toBeUndefined();
  return { adapter, events, output: terminalOf(events).response.output as any[] };
};

describe('chat-completions reasoning output (R2b)', () => {
  it('delivers the reasoning of a recorded Ollama /v1 stream as a reasoning item before the message and the call', async () => {
    const recorded = recordedQwenStream();
    expect(recorded.reasoning.length).toBeGreaterThan(0);
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: recorded.chunks, usage: recorded.usage }] });

    const { events, output } = await firstTurn(fake);

    expect(expectSpecValid(events)).toEqual([]);
    expect(terminalOf(events).response.usage.input_tokens_details).not.toHaveProperty('cached_tokens');
    expect(reasoningOf(events)).toBe(recorded.reasoning);
    expect(ofType(events, 'response.reasoning.done').map((event) => event.text)).toEqual([recorded.reasoning]);
    expect(outputTextOf(events)).toBe(recorded.text);
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
  });

  for (const field of REASONING_FIELDS) {
    it(`reads reasoning from ${field}`, async () => {
      const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: fieldChunks(field, ['Look at ', 'a.txt first.']) }] });
      const { events, output } = await firstTurn(fake);
      expect(expectSpecValid(events)).toEqual([]);
      expect(reasoningOf(events)).toBe('Look at a.txt first.');
      expect(output[0].type).toBe('reasoning');
    });

    it(`sends reasoning that arrived in ${field} back in ${field}`, async () => {
      const fake = await startFake({
        scenario: 'tools-ok',
        script: [{ kind: 'stream', chunks: fieldChunks(field, ['Look at ', 'a.txt first.']) }, { kind: 'stream', chunks: [{ delta: { content: 'done' } }, { delta: {}, finishReason: 'stop' }] }],
      });
      const { adapter, output } = await firstTurn(fake);

      const history = [userText('read a.txt'), ...(output as AdapterInputItem[]), { type: 'function_call_output' as const, call_id: 'call_r1', output: 'alpha' }];
      await collect(adapter, { model: 'system', input: history, tools: [readFileTool] });

      const messages: any[] = lastCompletionBody(fake).messages;
      const carriers = messages.filter((message) => REASONING_FIELDS.some((name) => name in message));
      expect(carriers).toHaveLength(1);
      expect(carriers[0].role).toBe('assistant');
      expect(carriers[0][field]).toBe('Look at a.txt first.');
      expect(REASONING_FIELDS.filter((name) => name in carriers[0])).toEqual([field]);
    });
  }

  it('fails with upstream_protocol_error when a later delta of the same item carries reasoning in another field', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', reasoning_content: 'first ' } }, { delta: { reasoning: 'second' } }, { delta: { content: 'x' } }, { delta: {}, finishReason: 'stop' }] }],
    });
    const { events, error } = await collect(makeAdapter(fake), { model: 'system', input: [userText('hi')] });
    expect(error).toBeUndefined();
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ type: 'model_error', code: 'upstream_protocol_error' });
    expect(reasoningOf(events)).toBe('first ');
  });
});

describe('chat-completions reasoning through the gateway (R2b input rule)', () => {
  it('keeps the reasoning item of a response in the history the next request sends upstream', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: fieldChunks('reasoning', ['Look at a.txt first.']) }, { kind: 'stream', chunks: [{ delta: { content: 'done' } }, { delta: {}, finishReason: 'stop' }] }],
    });
    const { client } = await startGateway({ adapters: { fm: makeAdapter(fake) }, config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } } });

    const first = await readSse(await postJson(client, '/v1/responses', { model: 'fast', stream: true, tools: [readFileTool], input: userInput('read a.txt') }));
    const output: any[] = first.at(-1)?.data.response.output;
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);

    await readSse(
      await postJson(client, '/v1/responses', {
        model: 'fast',
        stream: true,
        tools: [readFileTool],
        input: [...userInput('read a.txt'), ...output, { type: 'function_call_output', call_id: 'call_r1', output: 'alpha' }],
      }),
    );

    const messages: any[] = lastCompletionBody(fake).messages;
    expect(messages.filter((message) => message.reasoning === 'Look at a.txt first.')).toHaveLength(1);
  });
});
