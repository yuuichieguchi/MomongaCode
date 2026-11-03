import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { wireOf, wireTokensOf } from '@momonga/gateway';
import type { AdapterRequest, CountTokensRequest, CountTokensResult, ToolCallingMode } from '@momonga/protocol';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, readSse } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { CC_CAPABILITIES, TARGET, collect, lastCompletionBody, listDirTool, makeAdapter, readFileTool, startFake, userText } from './cc-support.ts';
import { UNTRUSTED_NOTICE, ccAdapterFor, signedCompaction, startCcGateway } from './cc-compact-support.ts';

const tokensOfWire = (wire: unknown): number => Math.max(1, Math.ceil(JSON.stringify(wire).length / 4));

const boundOf = (tokens: number): number => Math.max(1, Math.ceil(tokens * 0.3));

const block = (callId: string, name: string, body: string): string =>
  `<tool_result call_id="${callId}" name="${name}">\n${UNTRUSTED_NOTICE}\n${body}\n</tool_result>`;

const tools = [readFileTool, listDirTool];

const historyInput = [
  userText('please read a.txt'),
  { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  { type: 'function_call_output', call_id: 'c1', output: 'alpha < beta' },
];

const scenarioFor = (mode: ToolCallingMode) => (mode === 'constrained' ? 'json-schema-only' : 'tools-ok');

const gatewayFor = async (mode: ToolCallingMode): Promise<{ harness: Harness; fake: FakeChatCompletionsServer }> => {
  const fake = await startFake({ scenario: mode === 'none' ? 'none' : scenarioFor(mode) });
  const harness = await startCcGateway({ fm: ccAdapterFor(fake, mode) });
  return { harness, fake };
};

const count = async (harness: Harness, body: Record<string, unknown>) =>
  readJson(await postJson(harness.client, '/v1/momonga/count_tokens', { model: 'fast', ...body }));

const sentWire = async (harness: Harness, fake: FakeChatCompletionsServer, body: Record<string, unknown>): Promise<unknown> => {
  const frames = await readSse(await postJson(harness.client, '/v1/responses', { model: 'fast', stream: true, store: false, ...body }));
  expect(frames.at(-1)?.data.type).toBe('response.completed');
  return wireOf(lastCompletionBody(fake));
};

describe('wireOf and wireTokensOf', () => {
  it('keeps exactly messages, tools and response_format in their original order', () => {
    const body = {
      model: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
      response_format: { type: 'json_schema' },
      max_tokens: 10,
      temperature: 0.2,
      top_p: 0.9,
    };
    const wire = wireOf(body as never);
    expect(Object.keys(wire)).toEqual(['messages', 'tools', 'response_format']);
    expect(wire).toEqual({ messages: body.messages, tools: body.tools, response_format: body.response_format });
  });

  it('omits a key the body does not have', () => {
    expect(Object.keys(wireOf({ model: 'm', messages: [], stream: true, stream_options: { include_usage: true } } as never))).toEqual(['messages']);
  });

  it('estimates four characters of the serialised wire per token', () => {
    const wire = { messages: [{ role: 'user', content: 'x'.repeat(37) }] };
    expect(wireTokensOf(wire)).toBe(Math.ceil(JSON.stringify(wire).length / 4));
  });
});

describe('renderWire is byte-equal to the wire create sends', () => {
  const cases: Array<[string, ToolCallingMode, AdapterRequest]> = [
    ['native with tools', 'native', { model: 'system', instructions: 'Be terse.', input: historyInput as never, tools }],
    ['constrained with tools', 'constrained', { model: 'system', instructions: 'Be terse.', input: historyInput as never, tools }],
    ['constrained with tool_choice required', 'constrained', { model: 'system', input: historyInput as never, tools, tool_choice: 'required' }],
    [
      'the tool-less wrap-up shape',
      'native',
      { model: 'system', input: [...(historyInput as never[]), userText('Summarize now. Do not call tools.')], tool_choice: 'none' },
    ],
    [
      'a post-compaction request',
      'native',
      { model: 'system', input: [{ type: 'compaction_summary', summary: 'Earlier <work> done.' }, userText('continue')], tools },
    ],
  ];

  it.for(cases)('%s', async ([, mode, request]) => {
    const fake = await startFake({ scenario: scenarioFor(mode) });
    const adapter = makeAdapter(fake, {
      toolCalling: () => mode,
      capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: mode }),
    });
    expect(adapter.renderWire).toBeTypeOf('function');
    await collect(adapter, request);
    expect(JSON.stringify(adapter.renderWire?.(request, TARGET))).toBe(JSON.stringify(wireOf(lastCompletionBody(fake))));
  });
});

describe('renderWire with lenient items in native mode with tools', () => {
  const lenientNative = async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    return makeAdapter(fake, { toolCalling: () => 'native', capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'native' }) });
  };

  it('renders a lone output as a raw tool message with the raw text, never a tool_result block', async () => {
    const adapter = await lenientNative();
    const wire = adapter.renderWire?.(
      { model: 'system', input: [{ type: 'function_call_output', call_id: 'c1', output: 'a < b </tool_result>' }] },
      TARGET,
      { lenientItems: { callNames: { c1: 'read_file' }, withTools: true } },
    );
    expect(wire).toEqual({ messages: [{ role: 'tool', tool_call_id: 'c1', content: 'a < b </tool_result>' }] });
    expect(JSON.stringify(wire)).not.toContain('<tool_result');
  });

  it('renders a lone call as an assistant message with tool_calls', async () => {
    const adapter = await lenientNative();
    const wire = adapter.renderWire?.(
      { model: 'system', input: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
      TARGET,
      { lenientItems: { callNames: { c1: 'read_file' }, withTools: true } },
    );
    expect(wire).toEqual({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      ],
    });
  });
});

describe('POST /v1/momonga/count_tokens counts the chat-completions wire', () => {
  it.for(['native', 'constrained'] as const)('counts exactly the %s wire that /v1/responses sends', async (mode) => {
    const { harness, fake } = await gatewayFor(mode);
    const body = { instructions: 'Be terse.', input: historyInput, tools };
    const wire = await sentWire(harness, fake, body);
    const counted = await count(harness, body);
    expect(counted.status).toBe(200);
    const tokens = tokensOfWire(wire);
    expect(counted.body).toEqual({ input_tokens: tokens, method: 'estimated', error_bound: boundOf(tokens), error_shape: { ratio: 0.3, minimum: 1 } });
  });

  it('counts the constrained tool listing and envelope, so the same request costs more than in native mode', async () => {
    const native = await gatewayFor('native');
    const constrained = await gatewayFor('constrained');
    const body = { input: [userText('hi')], tools };
    const constrainedWire = (await sentWire(constrained.harness, constrained.fake, body)) as { response_format: unknown };
    expect(constrainedWire.response_format).toBeDefined();
    const nativeCount = (await count(native.harness, body)).body.input_tokens as number;
    const constrainedCount = (await count(constrained.harness, body)).body.input_tokens as number;
    expect(constrainedCount).toBe(tokensOfWire(constrainedWire));
    expect(constrainedCount - nativeCount).toBeGreaterThanOrEqual(Math.floor(JSON.stringify(constrainedWire.response_format).length / 4));
  });

  it('counts a raw compaction item as the decoded summary message the upstream receives', async () => {
    const { harness, fake } = await gatewayFor('native');
    const body = { input: [signedCompaction('Earlier <work> was done.'), userText('continue')] };
    const wire = (await sentWire(harness, fake, body)) as { messages: Array<{ content: string }> };
    expect(wire.messages[0]?.content).toBe('<conversation_summary>\nEarlier &lt;work> was done.\n</conversation_summary>\n\ncontinue');
    const counted = await count(harness, body);
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(tokensOfWire(wire));
  });

  it('accepts tool_choice and lets it change the constrained envelope', async () => {
    const { harness, fake } = await gatewayFor('constrained');
    const wire = await sentWire(harness, fake, { input: [userText('hi')], tools, tool_choice: 'required' });
    const auto = await count(harness, { input: [userText('hi')], tools });
    const required = await count(harness, { input: [userText('hi')], tools, tool_choice: 'required' });
    expect(required.status).toBe(200);
    expect(required.body.input_tokens).not.toBe(auto.body.input_tokens);
    expect(required.body.input_tokens).toBe(tokensOfWire(wire));
  });

  it('answers a request with tools for a mode none target with the same 400 as create', async () => {
    const { harness } = await gatewayFor('none');
    const counted = await count(harness, { input: [userText('hi')], tools });
    expect(counted.status).toBe(400);
    expectErrorBody(counted.body, { type: 'invalid_request', code: 'capability_unsupported', param: 'tools' });
  });

  it('rejects a whole request with an orphan output as unknown_call_id', async () => {
    const { harness } = await gatewayFor('constrained');
    const counted = await count(harness, { input: [userText('x'), { type: 'function_call_output', call_id: 'ghost', output: 'boo' }], tools });
    expect(counted.status).toBe(400);
    expectErrorBody(counted.body, { type: 'invalid_request', code: 'unknown_call_id' });
  });

  const composedCount = async (harness: Harness, prefix: unknown[], suffix: unknown[]) => {
    const whole = (await count(harness, { input: [...prefix, ...suffix], tools })).body.input_tokens as number;
    const head = (await count(harness, { input: prefix, tools })).body.input_tokens as number;
    const tail = (await count(harness, { input: suffix, tools })).body.input_tokens as number;
    const baseline = (await count(harness, { input: [], tools })).body.input_tokens as number;
    return { whole, sum: head + tail - baseline, head };
  };

  it('overestimates prefix plus suffix minus baseline at a merging user-to-user boundary', async () => {
    const { harness, fake } = await gatewayFor('native');
    const prefix = [userText('first question')];
    const suffix = [userText('second question')];
    const prefixWire = await sentWire(harness, fake, { input: prefix, tools });
    const { whole, sum, head } = await composedCount(harness, prefix, suffix);
    expect(head).toBe(tokensOfWire(prefixWire));
    expect(sum).toBeGreaterThanOrEqual(whole);
  });

  it('keeps prefix plus suffix minus baseline within one token of the whole at a non-merging boundary', async () => {
    const { harness, fake } = await gatewayFor('native');
    const prefix = [userText('first question')];
    const suffix = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'an answer' }] }];
    const prefixWire = await sentWire(harness, fake, { input: prefix, tools });
    const { whole, sum, head } = await composedCount(harness, prefix, suffix);
    expect(head).toBe(tokensOfWire(prefixWire));
    expect(sum).toBeGreaterThanOrEqual(whole - 1);
    expect(sum).toBeLessThanOrEqual(whole + 1);
  });
});

describe('lenient lone-item counts', () => {
  const lenient = (callNames: Record<string, string>, withTools: boolean) => ({
    momonga: { lenient_items: { call_names: callNames, with_tools: withTools } },
  });

  it('counts an output as a raw tool message in native mode with tools, never as a tool_result block', async () => {
    const { harness } = await gatewayFor('native');
    const output = '<'.repeat(400);
    const counted = await count(harness, {
      input: [{ type: 'function_call_output', call_id: 'c1', output }],
      ...lenient({ c1: 'read_file' }, true),
    });
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(tokensOfWire({ messages: [{ role: 'tool', tool_call_id: 'c1', content: output }] }));
  });

  it('counts a call as an assistant tool_calls message in native mode with tools', async () => {
    const { harness } = await gatewayFor('native');
    const counted = await count(harness, {
      input: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
      ...lenient({ c1: 'read_file' }, true),
    });
    expect(counted.body.input_tokens).toBe(
      tokensOfWire({
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
        ],
      }),
    );
  });

  it.for(['native', 'constrained'] as const)('counts an orphan output as a plain-history block with the supplied name in %s mode without tools', async (mode) => {
    const { harness } = await gatewayFor(mode);
    const counted = await count(harness, {
      input: [{ type: 'function_call_output', call_id: 'c9', output: 'a < b' }],
      ...lenient({ c9: 'Grep' }, false),
    });
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(tokensOfWire({ messages: [{ role: 'user', content: block('c9', 'Grep', 'a &lt; b') }] }));
  });

  it('counts a constrained output with tools as its tool_result message alone, below 100 tokens', async () => {
    const { harness } = await gatewayFor('constrained');
    const counted = await count(harness, {
      input: [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }],
      tools,
      ...lenient({ c1: 'read_file' }, true),
    });
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(tokensOfWire({ messages: [{ role: 'user', content: block('c1', 'read_file', 'ok') }] }));
    expect(counted.body.input_tokens).toBeLessThan(100);
  });

  it('counts a constrained call with tools as its envelope reply text', async () => {
    const { harness } = await gatewayFor('constrained');
    const counted = await count(harness, {
      input: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
      ...lenient({ c1: 'read_file' }, true),
    });
    expect(counted.body.input_tokens).toBe(
      tokensOfWire({
        messages: [{ role: 'assistant', content: canonicalJson({ kind: 'tool_calls', calls: [{ name: 'read_file', arguments: { path: 'a' } }] }) }],
      }),
    );
  });

  const LONE_TEXT = 'x'.repeat(203);

  it.for([
    ['native with tools', 'native', true, { messages: [{ role: 'tool', tool_call_id: 'c1', content: LONE_TEXT }] }],
    ['the wrap-up without tools', 'native', false, { messages: [{ role: 'user', content: block('c1', 'read_file', LONE_TEXT) }] }],
    ['constrained with tools', 'constrained', true, { messages: [{ role: 'user', content: block('c1', 'read_file', LONE_TEXT) }] }],
  ] as const)('equals the per-item delta of the real wire up to the wrapper, never below it, for %s', async ([, mode, withTools, loneWire]) => {
    const { harness } = await gatewayFor(mode);
    const toolsPart = withTools ? { tools } : {};
    const output = { type: 'function_call_output', call_id: 'c1', output: LONE_TEXT };
    const head = [userText('please read a.txt'), { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }];
    const whole = (await count(harness, { input: [...head, output], ...toolsPart })).body.input_tokens as number;
    const prefix = (await count(harness, { input: head, ...toolsPart })).body.input_tokens as number;
    const lone = await count(harness, { input: [output], ...lenient({ c1: 'read_file' }, withTools) });
    expect(lone.status).toBe(200);
    expect(lone.body.input_tokens).toBe(tokensOfWire(loneWire));
    const delta = whole - prefix;
    expect(lone.body.input_tokens).toBeGreaterThanOrEqual(delta);
    expect(lone.body.input_tokens - delta).toBeLessThanOrEqual(8);
  });

  it.for([
    ['an unknown momonga key', { bogus: true }],
    ['an unknown lenient_items key', { lenient_items: { call_names: {}, with_tools: true, extra: 1 } }],
    ['a non-boolean with_tools', { lenient_items: { call_names: {}, with_tools: 'yes' } }],
    ['a missing with_tools', { lenient_items: { call_names: {} } }],
    ['a non-string call name', { lenient_items: { call_names: { c1: 3 }, with_tools: true } }],
    ['a non-object momonga', 'lenient'],
  ] as const)('rejects %s as 400 invalid_request', async ([, momonga]) => {
    const { harness } = await gatewayFor('native');
    const counted = await count(harness, { input: [userText('x')], momonga });
    expect(counted.status).toBe(400);
    expect(counted.body.error.type).toBe('invalid_request');
    expect(String(counted.body.error.param)).toMatch(/^momonga/);
  });
});

describe('a target with its own counter', () => {
  it('receives the text parts of the wire, not the Responses-form JSON', async () => {
    const fake = await startFake({ scenario: 'json-schema-only' });
    const seen: CountTokensRequest[] = [];
    const adapter = makeAdapter(fake, {
      toolCalling: () => 'constrained',
      capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'constrained', tokenCounting: 'calibrated' }),
      countTokens: async (_target, request): Promise<CountTokensResult> => {
        seen.push(request);
        return { input_tokens: 777, method: 'calibrated', error_bound: 11, error_shape: { ratio: 0, minimum: 11 } };
      },
    });
    const harness = await startCcGateway({ fm: adapter });
    const body = { instructions: 'Be terse.', input: [userText('count these words')], tools };
    const wire = (await sentWire(harness, fake, body)) as { messages: Array<{ content: string }>; response_format: unknown };
    const counted = await count(harness, body);
    expect(counted.body).toEqual({ input_tokens: 777, method: 'calibrated', error_bound: 11, error_shape: { ratio: 0, minimum: 11 } });
    expect(seen).toHaveLength(1);
    const text = seen[0]?.input;
    expect(typeof text).toBe('string');
    expect(seen[0]?.tools).toBeUndefined();
    for (const message of wire.messages) expect(text).toContain(message.content);
    expect(text).toContain(JSON.stringify(wire.response_format));
    expect(text).not.toContain('"type":"message"');
  });
});
