import { describe, expect, it } from 'vitest';
import { CALL_ID_PREFIX } from '@momonga/foundation';
import { expectSpecValid, terminalOf } from '../cc-support.ts';
import { chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from '../ollama-support.ts';

const readTool = {
  type: 'function' as const,
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

const request = { model: 'devstral-small-2', input: [{ type: 'message' as const, role: 'user' as const, content: 'go' }], tools: [readTool], max_output_tokens: 300 };

const streamOf = async (lines: readonly string[]) => {
  const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines }] });
  return collectOllama(makeOllamaAdapter(fake), request);
};

describe('ollama stream: a tool call without an id', () => {
  it.for([
    ['absent', {}],
    ['empty', { id: '' }],
    ['null', { id: null }],
  ] as const)('accepts an entry whose id is %s and gives the call a product id', async ([, idField]) => {
    const { events, error } = await streamOf([
      chunkLine({ content: 'reading' }),
      chunkLine({ tool_calls: [{ ...idField, function: { index: 0, name: 'Read', arguments: { file_path: 'a' } } }] }),
      chunkLine({ tool_calls: [{ ...idField, function: { index: 1, name: 'Read', arguments: { file_path: 'b' } } }] }),
      doneLine(),
    ]);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    const calls = terminal.response.output.filter((item: { type: string }) => item.type === 'function_call');
    expect(calls.map((call: { name: string; arguments: string }) => [call.name, JSON.parse(call.arguments)])).toEqual([
      ['Read', { file_path: 'a' }],
      ['Read', { file_path: 'b' }],
    ]);
    const ids = calls.map((call: { call_id: string }) => call.call_id);
    for (const id of ids) expect(id).toMatch(new RegExp(`^${CALL_ID_PREFIX}[0-9a-f]{32}$`));
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps the id the upstream sent', async () => {
    const { events } = await streamOf([chunkLine({ tool_calls: [{ id: 'call_x', function: { index: 0, name: 'Read', arguments: { file_path: 'a' } } }] }), doneLine()]);
    expect(terminalOf(events).response.output[0]).toMatchObject({ type: 'function_call', call_id: 'call_x' });
  });

  it.for([
    ['absent', { index: 0, arguments: { file_path: 'a' } }],
    ['empty', { index: 0, name: '', arguments: { file_path: 'a' } }],
  ] as const)('still refuses an entry whose function.name is %s', async ([, fn]) => {
    const { events, error } = await streamOf([chunkLine({ content: 'reading' }), chunkLine({ tool_calls: [{ function: fn }] }), doneLine()]);
    expect(error).toBeUndefined();
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ type: 'model_error', code: 'upstream_protocol_error' });
    expect(terminal.response.error.message).toContain('function.name');
  });

  it('still refuses an entry without arguments', async () => {
    const { events } = await streamOf([chunkLine({ content: 'reading' }), chunkLine({ tool_calls: [{ function: { index: 0, name: 'Read' } }] }), doneLine()]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.message).toContain('function.arguments');
  });
});
