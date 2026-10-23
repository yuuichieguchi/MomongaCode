import { describe, expect, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY, usageOf } from '@momonga/testkit';
import type { FakeStreamChunk } from '@momonga/testkit';
import {
  collect,
  expectSpecValid,
  makeAdapter,
  ofType,
  outputTextOf,
  readFileTool,
  listDirTool,
  startFake,
  terminalOf,
  terminalsOf,
  userText,
} from './cc-support.ts';

const plain = { model: 'system', input: [userText('hi')] };

const textChunks = (parts: string[], finishReason: string): FakeStreamChunk[] => [
  { delta: { role: 'assistant', content: '' } },
  ...parts.map((part) => ({ delta: { content: part } })),
  { delta: {}, finishReason },
];

describe('native streaming: text', () => {
  it('converts content deltas into a message item with output_text deltas and done events', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { events, error } = await collect(makeAdapter(fake), plain);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    expect(events[0]?.type).toBe('response.created');
    expect(events[1]?.type).toBe('response.in_progress');
    const sequence = events.map((event) => event.sequence_number);
    expect(sequence).toEqual(sequence.map((_, index) => index));
    expect(outputTextOf(events)).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(ofType(events, 'response.output_text.delta').length).toBeGreaterThan(1);
    expect(ofType(events, 'response.output_text.done').map((event) => event.text)).toEqual([FAKE_DETERMINISTIC_REPLY]);
    const added = ofType(events, 'response.output_item.added');
    expect(added).toHaveLength(1);
    expect(added[0].item.type).toBe('message');
    expect(added[0].item.role).toBe('assistant');
    const done = ofType(events, 'response.output_item.done');
    expect(done).toHaveLength(1);
    expect(done[0].item).toMatchObject({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FAKE_DETERMINISTIC_REPLY }] });
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.status).toBe('completed');
    expect(terminal.response.output).toEqual([done[0].item]);
  });

  it('reports usage from the usage chunk', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: textChunks(['ok'], 'stop'), usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }],
    });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(terminalOf(events).response.usage).toEqual(usageOf(11, 7));
  });

  it('leaves usage null when the upstream sends none so the gateway estimates', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: textChunks(['ok'], 'stop') }] });
    const { events } = await collect(makeAdapter(fake), plain);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.usage).toBeNull();
  });

  it('maps finish_reason length to response.incomplete with max_output_tokens', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: textChunks(['abc', 'def'], 'length') }] });
    const { events, error } = await collect(makeAdapter(fake), plain);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.status).toBe('incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(outputTextOf(events)).toBe('abcdef');
  });

  it('maps finish_reason content_filter to response.incomplete with content_filter', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: textChunks(['abc'], 'content_filter') }] });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it('completes when the stream ends after a finish_reason without [DONE]', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'stream', chunks: textChunks(['abc'], 'stop'), done: false }] });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(terminalOf(events).type).toBe('response.completed');
  });

  it('fails with upstream_protocol_error when the stream ends without a finish_reason', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'abc' } }] }],
    });
    const { events, error } = await collect(makeAdapter(fake), plain);
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ type: 'model_error', code: 'upstream_protocol_error' });
  });

  it('emits exactly one terminal event as the last event', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { events } = await collect(makeAdapter(fake), plain);
    expect(terminalsOf(events)).toHaveLength(1);
    expect(events.at(-1)).toBe(terminalsOf(events)[0]);
  });
});

describe('native streaming: tool calls', () => {
  it('assembles tool_call fragments split across chunks into a function_call item', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { events, error } = await collect(makeAdapter(fake), { model: 'system', input: [userText('please use read_file')], tools: [readFileTool] });
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const done = ofType(events, 'response.output_item.done').map((event) => event.item);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: 'function_call', call_id: 'call_1_0', name: 'read_file', arguments: '{"path":"value"}', status: 'completed' });
    const added = ofType(events, 'response.output_item.added');
    expect(added[0].item).toMatchObject({ type: 'function_call', name: 'read_file', arguments: '', status: 'in_progress' });
    const deltas = ofType(events, 'response.function_call_arguments.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.every((event) => event.item_id === done[0].id)).toBe(true);
    expect(deltas.map((event) => event.delta).join('')).toBe('{"path":"value"}');
    expect(ofType(events, 'response.function_call_arguments.done').map((event) => event.arguments)).toEqual(['{"path":"value"}']);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output).toEqual(done);
  });

  it('separates parallel tool calls whose fragments interleave', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [
            { delta: { role: 'assistant', content: null } },
            { delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } },
            { delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_dir', arguments: '{"di' } }] } },
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
            { delta: { tool_calls: [{ index: 1, function: { arguments: 'r":"."}' } }] } },
            { delta: {}, finishReason: 'tool_calls' },
          ],
        },
      ],
    });
    const { events, error } = await collect(makeAdapter(fake), {
      model: 'system',
      input: [userText('go')],
      tools: [readFileTool, listDirTool],
    });
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    const done = ofType(events, 'response.output_item.done');
    expect(done.map((event) => [event.output_index, event.item.call_id, event.item.name, event.item.arguments])).toEqual([
      [0, 'call_a', 'read_file', '{"path":"a.txt"}'],
      [1, 'call_b', 'list_dir', '{"dir":"."}'],
    ]);
    for (const item of done.map((event) => event.item)) {
      const deltas = ofType(events, 'response.function_call_arguments.delta').filter((event) => event.item_id === item.id);
      expect(deltas.map((event) => event.delta).join('')).toBe(item.arguments);
    }
    expect(new Set(done.map((event) => event.item.id)).size).toBe(2);
    expect(terminalOf(events).response.output.map((item: any) => item.call_id)).toEqual(['call_a', 'call_b']);
  });
});
