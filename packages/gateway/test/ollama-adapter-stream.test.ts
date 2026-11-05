import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { waitFor } from '@momonga/testkit';
import { expectSpecValid, ofType, outputTextOf, terminalOf, terminalsOf } from './cc-support.ts';
import {
  LONG_TEXT_THEN_TOOL_CALL,
  SHORT_TOOL_CALL,
  chunkLine,
  collectOllama,
  doneLine,
  fixtureLines,
  makeOllamaAdapter,
  startFakeOllama,
  usageFromCounts,
  withoutField,
} from './ollama-support.ts';

const readTool = {
  type: 'function' as const,
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

const request = { model: 'devstral-small-2', input: [{ type: 'message' as const, role: 'user' as const, content: 'go' }], tools: [readTool], max_output_tokens: 300 };

const streamOf = async (lines: readonly string[], extra: Record<string, unknown> = {}) => {
  const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines }] });
  return collectOllama(makeOllamaAdapter(fake), { ...request, ...extra });
};

const fixtureMessages = (name: string): any[] => fixtureLines(name).map((line) => JSON.parse(line).message);

describe('ollama stream: the recorded streams of Ollama 0.40.13', () => {
  it('turns the short stream into one function call item with the call id and the complete arguments, and the server counts as usage', async () => {
    const { events, error } = await streamOf(fixtureLines(SHORT_TOOL_CALL));
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output).toHaveLength(1);
    const [call] = terminal.response.output;
    expect(call).toMatchObject({ type: 'function_call', call_id: 'call_q6m8xkax', name: 'Read', status: 'completed' });
    expect(JSON.parse(call.arguments)).toEqual({ file_path: 'src/calc.js' });
    expect(terminal.response.usage).toEqual(usageFromCounts(2772, 14, 0));
  });

  it('turns the long stream into a message item and then a function call item, in that order', async () => {
    const messages = fixtureMessages(LONG_TEXT_THEN_TOOL_CALL);
    const expectedText = messages.map((message) => message.content as string).join('');
    const expectedArguments = messages.flatMap((message) => message.tool_calls ?? [])[0].function.arguments;
    const { events, error } = await streamOf(fixtureLines(LONG_TEXT_THEN_TOOL_CALL));
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    expect(outputTextOf(events)).toBe(expectedText);
    const terminal = terminalOf(events);
    expect(terminal.response.output.map((item: { type: string }) => item.type)).toEqual(['message', 'function_call']);
    expect(terminal.response.output[1]).toMatchObject({ call_id: 'call_7g69pxvt', name: 'Write' });
    expect(JSON.parse(terminal.response.output[1].arguments)).toEqual(expectedArguments);
    expect(terminal.response.usage).toEqual(usageFromCounts(3271, 222, 36));
  });
});

describe('ollama stream: done_reason', () => {
  it('maps done_reason stop to response.completed', async () => {
    const { events } = await streamOf([chunkLine({ content: 'hello' }), doneLine({ done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    expect(outputTextOf(events)).toBe('hello');
    expect(terminal.response.usage).toEqual(usageFromCounts(40, 9, 0));
  });

  it('maps done_reason length to response.incomplete with max_output_tokens', async () => {
    const { events, error } = await streamOf([chunkLine({ content: 'abc' }), chunkLine({ content: 'def' }), doneLine({ done_reason: 'length' })]);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(outputTextOf(events)).toBe('abcdef');
  });

  it('reports zero cached tokens when the done chunk carries no prompt_eval_cached_count', async () => {
    const { events } = await streamOf([chunkLine({ content: 'hi' }), withoutField(doneLine({ prompt_eval_count: 70, eval_count: 3 }), 'prompt_eval_cached_count')]);
    expect(terminalOf(events).response.usage).toEqual(usageFromCounts(70, 3, 0));
  });
});

describe('ollama stream: upstream protocol errors (nothing is defaulted)', () => {
  const expectProtocolError = (events: any[], error: unknown) => {
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ type: 'model_error', code: 'upstream_protocol_error' });
  };

  it('fails a tool call without an id', async () => {
    const { events, error } = await streamOf([
      chunkLine({ content: 'reading' }),
      chunkLine({ tool_calls: [{ function: { index: 0, name: 'Read', arguments: { file_path: 'a' } } }] }),
      doneLine(),
    ]);
    expectProtocolError(events, error);
    expect(ofType(events, 'response.output_item.done').filter((event) => event.item.type === 'function_call')).toEqual([]);
  });

  for (const field of ['done_reason', 'prompt_eval_count', 'eval_count']) {
    it(`fails a done chunk without ${field}`, async () => {
      const { events, error } = await streamOf([chunkLine({ content: 'hello' }), withoutField(doneLine(), field)]);
      expectProtocolError(events, error);
    });
  }

  it('fails a streamed tool call when the request set tool_choice none', async () => {
    const { events, error } = await streamOf(
      [chunkLine({ content: 'reading' }), chunkLine({ tool_calls: [{ id: 'call_x', function: { index: 0, name: 'Read', arguments: { file_path: 'a' } } }] }), doneLine()],
      { tool_choice: 'none' },
    );
    expectProtocolError(events, error);
  });

  it('fails a stream that ends without a done chunk', async () => {
    const { events, error } = await streamOf([chunkLine({ content: 'hello' })]);
    expectProtocolError(events, error);
  });
});

describe('ollama stream: cancellation', () => {
  it('closes the NDJSON response on abort and ends without a terminal event, so nothing is charged', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'hang', lines: [chunkLine({ content: 'partial' })] }] });
    const adapter = makeOllamaAdapter(fake);
    const controller = new AbortController();
    const events: any[] = [];
    let failure: unknown;
    try {
      for await (const event of adapter.create(request, { signal: controller.signal, target: { name: 'local', model: 'devstral-small-2' }, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN })) {
        events.push(event);
        if (event.type === 'response.output_text.delta') controller.abort(new Error('the client went away'));
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(outputTextOf(events)).toBe('partial');
    expect(terminalsOf(events)).toEqual([]);
    expect(events.some((event) => event.response?.usage !== undefined && event.response?.usage !== null)).toBe(false);
    await waitFor(() => fake.closedChats() === 1, { description: 'the fake to see the chat response closed' });
  });
});
