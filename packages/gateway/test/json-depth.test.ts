import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import type { AdapterRequest } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import type { FakeStreamChunk } from '@momonga/testkit';
import { parseUpstreamChunk } from '../src/adapters/chat-completions/upstream-chunk.ts';
import { collect, listDirTool, makeAdapter, ofType, startFake, terminalOf, userText } from './cc-support.ts';
import { postJson, readJson, startGateway } from './gateway-helpers.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const namesDepth = (text: string): boolean => /depth/i.test(text) && text.includes(String(MAX_JSON_DEPTH));

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
};

describe('gateway request bodies and the one JSON depth bound', () => {
  const bodyText = (depth: number, model = '"fast"'): string => `{"model":${model},"extra":${nestedArraysText(depth - 1)}}`;

  it(`answers 400 naming the depth for a body nested ${MAX_JSON_DEPTH + 1} deep`, async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', bodyText(MAX_JSON_DEPTH + 1)));
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request');
    expect(response.body.error.code).toBe('json_too_deep');
    expect(namesDepth(String(response.body.error.message))).toBe(true);
    expect(primary.calls).toHaveLength(0);
  });

  it(`passes a body nested exactly ${MAX_JSON_DEPTH} deep on to schema validation`, async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', bodyText(MAX_JSON_DEPTH, '1')));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_body');
    expect(/depth/i.test(String(response.body.error.message))).toBe(false);
    expect(primary.calls).toHaveLength(0);
  });
});

describe('upstream chat completion chunks and the one JSON depth bound', () => {
  const chunkText = (depth: number): string => `{"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2},"extra":${nestedArraysText(depth - 1)}}`;

  it(`accepts a chunk nested exactly ${MAX_JSON_DEPTH} deep`, () => {
    expect(parseUpstreamChunk(chunkText(MAX_JSON_DEPTH)).toolCalls).toEqual([]);
  });

  it(`refuses a chunk nested ${MAX_JSON_DEPTH + 1} deep with an error naming the depth`, () => {
    const error = thrownBy(() => parseUpstreamChunk(chunkText(MAX_JSON_DEPTH + 1)));
    expect(error).not.toBeInstanceOf(RangeError);
    expect(namesDepth(error.message)).toBe(true);
  });
});

describe('constrained model output and the one JSON depth bound', () => {
  const constrained = { toolCalling: () => 'constrained' as const };

  const envelopeOf = (depth: number): string => `{"kind":"tool_calls","calls":[{"name":"list_dir","arguments":{"dir":".","z":${nestedArraysText(depth - 4)}}}]}`;

  const contentChunks = (text: string): FakeStreamChunk[] => [
    { delta: { role: 'assistant', content: '' } },
    { delta: { content: text } },
    { delta: {}, finishReason: 'stop' },
  ];

  const request: AdapterRequest = { model: 'system', input: [userText('list')], tools: [listDirTool] };

  const outputOf = async (depth: number) => {
    const fake = await startFake({ scenario: 'json-schema-only', script: [{ kind: 'stream', chunks: contentChunks(envelopeOf(depth)) }] });
    return collect(makeAdapter(fake, constrained), request);
  };

  it('counts the envelope wrapping as four levels around the arguments value', () => {
    expect(envelopeOf(5)).toBe('{"kind":"tool_calls","calls":[{"name":"list_dir","arguments":{"dir":".","z":[]}}]}');
  });

  it(`decodes a tool call from an envelope nested exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const { events } = await outputOf(MAX_JSON_DEPTH);
    expect(terminalOf(events).type).toBe('response.completed');
    expect(ofType(events, 'response.output_item.done').map((event) => event.item.name)).toEqual(['list_dir']);
  });

  it(`fails the response with an error naming the depth for an envelope nested ${MAX_JSON_DEPTH + 1} deep`, async () => {
    const { events } = await outputOf(MAX_JSON_DEPTH + 1);
    const terminal = terminalOf(events);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ type: 'model_error', code: 'malformed_output' });
    expect(namesDepth(String(terminal.response.error.message))).toBe(true);
  });
});
