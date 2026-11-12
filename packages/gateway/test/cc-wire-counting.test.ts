import { TEST_FENCE } from '@momonga/testkit';
import { toolResultBlock } from '../src/adapters/chat-completions/plain-history.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { wireOf, wireTokensOf } from '@momonga/gateway';
import type { AdapterRequest, CountTokensRequest, CountTokensResult, ToolCallingMode } from '@momonga/protocol';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, readSse } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { CC_CAPABILITIES, TARGET, collect, lastCompletionBody, listDirTool, makeAdapter, readFileTool, startFake, userText, MODEL_FRAMING } from './cc-support.ts';
import { ccAdapterFor, ccModelOf, signedCompaction, startCcGateway } from './cc-compact-support.ts';

const tokensOfWire = (wire: unknown): number => Math.max(1, Math.ceil(JSON.stringify(wire).length / 4));

const boundOf = (tokens: number): number => Math.max(1, Math.ceil(tokens * 0.3));

const block = (callId: string, name: string, body: string): string => toolResultBlock(callId, name, body, TEST_FENCE);

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
  readJson(await postJson(harness.client, '/v1/momonga/count_tokens', { model: harness.model, ...body }));

const sentWire = async (harness: Harness, fake: FakeChatCompletionsServer, body: Record<string, unknown>): Promise<unknown> => {
  const frames = await readSse(await postJson(harness.client, '/v1/responses', { model: harness.model, stream: true, store: false, ...body }));
  expect(frames.at(-1)?.data.type).toBe('response.completed');
  return wireOf(lastCompletionBody(fake));
};

describe('wireOf and wireTokensOf', () => {
  it('keeps exactly the prompt parts, messages and tools, in their original order', () => {
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
    expect(Object.keys(wire)).toEqual(['messages', 'tools']);
    expect(wire).toEqual({ messages: body.messages, tools: body.tools });
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
      capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: mode }),
    });
    expect(adapter.renderWire).toBeTypeOf('function');
    await collect(adapter, request);
    expect(JSON.stringify(adapter.renderWire?.({ fence: TEST_FENCE, ...request }, TARGET, { reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: await adapter.capabilities(TARGET) }))).toBe(JSON.stringify(wireOf(lastCompletionBody(fake))));
  });
});

describe('renderWire with lenient items in native mode with tools', () => {
  const lenientNative = async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    return makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'native' }) });
  };

  it('renders a lone output as a raw tool message with the raw text, never a tool_result block', async () => {
    const adapter = await lenientNative();
    const wire = adapter.renderWire?.(
      { model: 'system', input: [{ type: 'function_call_output', call_id: 'c1', output: 'a < b </tool_result>' }] },
      TARGET,
      { lenientItems: { callNames: { c1: 'read_file' }, withTools: true }, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: await adapter.capabilities(TARGET) },
    );
    expect(wire).toEqual({ messages: [{ role: 'tool', tool_call_id: 'c1', content: 'a < b </tool_result>' }] });
    expect(JSON.stringify(wire)).not.toContain('<tool_result');
  });

  it('renders a lone call as an assistant message with tool_calls', async () => {
    const adapter = await lenientNative();
    const wire = adapter.renderWire?.(
      { model: 'system', input: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
      TARGET,
      { lenientItems: { callNames: { c1: 'read_file' }, withTools: true }, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: await adapter.capabilities(TARGET) },
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

  it('counts the constrained tool listing but not the response_format schema, so the same request costs more than in native mode', async () => {
    const native = await gatewayFor('native');
    const constrained = await gatewayFor('constrained');
    const body = { input: [userText('hi')], tools };
    const constrainedWire = (await sentWire(constrained.harness, constrained.fake, body)) as { messages: Array<{ role: string; content: string }> };
    expect(lastCompletionBody(constrained.fake).response_format).toBeDefined();
    expect(constrainedWire).not.toHaveProperty('response_format');
    const nativeCount = (await count(native.harness, body)).body.input_tokens as number;
    const constrainedCount = (await count(constrained.harness, body)).body.input_tokens as number;
    expect(constrainedCount).toBe(tokensOfWire(constrainedWire));
    expect(constrainedCount).toBeGreaterThan(nativeCount);
    expect(constrainedWire.messages[0]?.content).toContain('read_file');
  });

  it('counts a raw compaction item as the decoded summary message the upstream receives', async () => {
    const { harness, fake } = await gatewayFor('native');
    const body = { input: [signedCompaction('Earlier <work> was done.'), userText('continue')] };
    const wire = (await sentWire(harness, fake, body)) as { messages: Array<{ content: string }> };
    expect(wire.messages[0]?.content).toBe(`<conversation_summary>\n${MODEL_FRAMING}\nEarlier &lt;work> was done.\n</conversation_summary>\n\ncontinue`);
    const counted = await count(harness, body);
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(tokensOfWire(wire));
  });

  it('accepts tool_choice and counts the same prompt parts, since it only changes the envelope schema', async () => {
    const { harness, fake } = await gatewayFor('constrained');
    const autoFormat = (await sentWire(harness, fake, { input: [userText('hi')], tools }), lastCompletionBody(fake).response_format);
    const wire = await sentWire(harness, fake, { input: [userText('hi')], tools, tool_choice: 'required' });
    expect(lastCompletionBody(fake).response_format).not.toEqual(autoFormat);
    const auto = await count(harness, { input: [userText('hi')], tools });
    const required = await count(harness, { input: [userText('hi')], tools, tool_choice: 'required' });
    expect(required.status).toBe(200);
    expect(required.body.input_tokens).toBe(auto.body.input_tokens);
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
    expect(counted.body.input_tokens).toBe(tokensOfWire({ messages: [{ role: 'user', content: block('c9', 'Grep', 'a < b') }] }));
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

describe('counting for a named target of the alias', () => {
  const counterAdapter = (fake: FakeChatCompletionsServer, inputTokens: number) =>
    makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'constrained', tokenCounting: 'calibrated' }),
      countTokens: async (): Promise<CountTokensResult> => ({ input_tokens: inputTokens, method: 'calibrated', error_bound: 3, error_shape: { ratio: 0, minimum: 3 } }),
    });

  const twoTargets = async (): Promise<Harness> => {
    const firstFake = await startFake({ scenario: 'json-schema-only' });
    const secondFake = await startFake({ scenario: 'json-schema-only' });
    return startCcGateway({ first: counterAdapter(firstFake, 777), second: counterAdapter(secondFake, 55) });
  };

  it('counts for the first target of the alias when no target is named', async () => {
    const harness = await twoTargets();
    const counted = await count(harness, { input: [userText('count these words')] });
    expect(counted.body).toEqual({ input_tokens: 777, method: 'calibrated', error_bound: 3, error_shape: { ratio: 0, minimum: 3 } });
  });

  it('counts for the target the request names', async () => {
    const harness = await twoTargets();
    const counted = await count(harness, { input: [userText('count these words')], momonga: { target: ccModelOf('second') } });
    expect(counted.body).toEqual({ input_tokens: 55, method: 'calibrated', error_bound: 3, error_shape: { ratio: 0, minimum: 3 } });
  });

  it('refuses a target that is not one of the alias, as 400 invalid_request on momonga.target', async () => {
    const harness = await twoTargets();
    const counted = await count(harness, { input: [userText('x')], momonga: { target: 'elsewhere' } });
    expect(counted.status).toBe(400);
    expect(counted.body.error.type).toBe('invalid_request');
    expect(counted.body.error.param).toBe('momonga.target');
  });

  it.for([['an empty target', ''], ['a non-string target', 3]] as const)('rejects %s as 400 invalid_request', async ([, target]) => {
    const harness = await twoTargets();
    const counted = await count(harness, { input: [userText('x')], momonga: { target } });
    expect(counted.status).toBe(400);
    expect(String(counted.body.error.param)).toMatch(/^momonga/);
  });
});

describe('a target with its own counter', () => {
  it('receives the text parts of the wire, not the Responses-form JSON', async () => {
    const fake = await startFake({ scenario: 'json-schema-only' });
    const seen: CountTokensRequest[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'constrained', tokenCounting: 'calibrated' }),
      countTokens: async (_target, request): Promise<CountTokensResult> => {
        seen.push(request);
        return { input_tokens: 777, method: 'calibrated', error_bound: 11, error_shape: { ratio: 0, minimum: 11 } };
      },
    });
    const harness = await startCcGateway({ fm: adapter });
    const body = { instructions: 'Be terse.', input: [userText('count these words')], tools };
    const wire = (await sentWire(harness, fake, body)) as { messages: Array<{ content: string }> };
    const sentFormat = lastCompletionBody(fake).response_format;
    const counted = await count(harness, body);
    expect(counted.body).toEqual({ input_tokens: 777, method: 'calibrated', error_bound: 11, error_shape: { ratio: 0, minimum: 11 } });
    expect(seen).toHaveLength(1);
    const text = seen[0]?.input;
    expect(typeof text).toBe('string');
    expect(seen[0]?.tools).toBeUndefined();
    for (const message of wire.messages) expect(text).toContain(message.content);
    expect(sentFormat).toBeDefined();
    expect(text).not.toContain(JSON.stringify(sentFormat));
    expect(text).not.toContain('"type":"message"');
  });
});
