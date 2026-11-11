import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_TOOL_NAME_CHARS, TOOL_NAME_PATTERN, isToolName } from '@momonga/protocol';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock, anthropicTextReply, anthropicToolUseBlock, createFakeClock, functionCallEvents, messageEvents, openResponsesStream, openingEvents, terminalEvent } from '@momonga/testkit';
import { ResponseEmitter } from '../../src/adapters/shared/response-emitter.ts';
import { MalformedOutputError } from '../../src/adapters/shared/failures.ts';
import { START_MS, userInput } from '../gateway-helpers.ts';
import { chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from '../ollama-support.ts';
import { readFileTool, startAnthropicGateway, startOpenResponsesGateway, streamResponse, terminalOf } from '../upstream-gateway-support.ts';

const VENDORED_SPEC = new URL('../../../protocol/vendor/open-responses/2026-04-24/openapi.json', import.meta.url);

const OUT_OF_BOUND = [
  ['a dotted name', 'functions.Read'],
  ['a name with a trailing space', 'Read '],
  ['a name with a trailing line feed', 'Read\n'],
  ['a name of 65 characters', 'a'.repeat(65)],
] as const;

const emitterOf = (): ResponseEmitter =>
  new ResponseEmitter({ clock: createFakeClock(START_MS), model: 'm', request: { model: 'm', input: [{ type: 'message', role: 'user', content: 'go' }] } });

describe('the bound of a tool name', () => {
  it('is the bound the vendored Open Responses schema puts on the name of a function call given as input', () => {
    const spec = JSON.parse(fs.readFileSync(VENDORED_SPEC, 'utf8'));
    const bound = spec.components.schemas.FunctionCallItemParam.properties.name;
    expect(bound).toMatchObject({ pattern: '^[a-zA-Z0-9_-]+$', minLength: 1, maxLength: MAX_TOOL_NAME_CHARS });
    expect(TOOL_NAME_PATTERN.source).toBe(`^[a-zA-Z0-9_-]{1,${bound.maxLength}}$`);
    expect(TOOL_NAME_PATTERN.flags).toBe('');
  });

  it('accepts names inside the bound and refuses names outside it', () => {
    expect(isToolName('Read')).toBe(true);
    expect(isToolName('mcp__server__list-files_2')).toBe(true);
    expect(isToolName('a'.repeat(64))).toBe(true);
    expect(isToolName('')).toBe(false);
    for (const [, name] of OUT_OF_BOUND) expect(isToolName(name)).toBe(false);
  });
});

describe('a tool name the model writes: the response emitter', () => {
  it.for(OUT_OF_BOUND)('refuses %s as malformed output and opens no item for it', ([, name]) => {
    const emitter = emitterOf();
    emitter.start();
    expect(() => emitter.beginCall(0, 'call_1', name)).toThrow(MalformedOutputError);
    expect(emitter.callCount).toBe(0);
    emitter.fail('malformed_output', 'model_error', 'x');
    const events = emitter.take();
    expect(events.filter((event) => event.type === 'response.output_item.added' || event.type === 'response.output_item.done')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { output: [] } });
  });

  it('keeps a name of 64 characters with hyphens and underscores', () => {
    const emitter = emitterOf();
    emitter.start();
    const name = `mcp__server__${'x-'.repeat(25)}y`;
    expect(name).toHaveLength(64);
    emitter.beginCall(0, 'call_1', name);
    emitter.appendCallArguments(0, '{}');
    emitter.complete(undefined);
    expect(emitter.take().at(-1)).toMatchObject({ type: 'response.completed', response: { output: [{ type: 'function_call', name }] } });
  });
});

describe('a tool name the model writes: through the gateway', () => {
  it.for(OUT_OF_BOUND)('fails the response for %s, stores nothing invalid, and accepts the next request of the run', async ([, name]) => {
    const gateway = await startAnthropicGateway({
      respond: (request) =>
        JSON.stringify(request.body).includes('second turn')
          ? anthropicTextReply(['fine'])
          : anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['reading']), ...anthropicToolUseBlock(1, 'toolu_01', name, ['{"path": "a"}']), ...anthropicMessageEnd('tool_use')]),
    });
    const frames = await streamResponse(gateway, { tools: [readFileTool] });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'malformed_output', type: 'model_error' });
    expect(terminal.response.error.message).toContain('tool name');
    expect(JSON.stringify(frames.map((frame) => frame.data.item ?? frame.data.response?.output ?? null))).not.toContain(JSON.stringify(name).slice(1, -1));
    expect(terminal.response.output.filter((item: { type: string }) => item.type === 'function_call')).toEqual([]);

    const next = terminalOf(await streamResponse(gateway, { tools: [readFileTool], input: [...userInput('hello'), ...terminal.response.output, ...userInput('second turn')] }));
    expect(next.type).toBe('response.completed');
  });
});

describe('a tool name the model writes: the Open Responses adapter through the gateway', () => {
  it('fails the response as malformed output with no call in its output', async () => {
    const message = messageEvents(['reading']);
    const call = functionCallEvents('call_1', 'functions.read_file', ['{"path": "a"}'], 1);
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, ...call.events, terminalEvent({ kind: 'completed' }, [message.item, call.item])])],
    });
    const terminal = terminalOf(await streamResponse(gateway, { tools: [readFileTool] }));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'malformed_output', type: 'model_error' });
    expect(terminal.response.output.filter((item: { type: string }) => item.type === 'function_call')).toEqual([]);
  });
});

describe('a tool name the model writes: the Ollama adapter', () => {
  it('fails the response as malformed output', async () => {
    const fake = await startFakeOllama({
      chat: [{ kind: 'ndjson', lines: [chunkLine({ content: 'reading' }), chunkLine({ tool_calls: [{ id: 'call_x', function: { index: 0, name: 'functions.Read', arguments: { file_path: 'a' } } }] }), doneLine()] }],
    });
    const { events, error } = await collectOllama(makeOllamaAdapter(fake), { model: 'devstral-small-2', input: [{ type: 'message', role: 'user', content: 'go' }], max_output_tokens: 300 });
    expect(error).toBeUndefined();
    const terminal = events.at(-1) as { type: string; response: { error: unknown; output: Array<{ type: string }> } };
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'malformed_output', type: 'model_error' });
    expect(terminal.response.output.filter((item) => item.type === 'function_call')).toEqual([]);
  });
});
