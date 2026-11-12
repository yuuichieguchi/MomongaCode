import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, unauthenticatedSource } from '@momonga/gateway';
import type { AdapterInputItem, AdapterRequest, FunctionTool, ToolCallingMode } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { buildCountTokensBody, buildMessagesBody } from '../src/adapters/anthropic/request.ts';
import { buildOllamaChatBody } from '../src/adapters/ollama/request.ts';
import { buildResponsesBody } from '../src/adapters/open-responses/request.ts';
import { CC_CAPABILITIES, TARGET } from './cc-support.ts';
import { START_MS } from './gateway-helpers.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const MALFORMED_ARGUMENTS: ReadonlyArray<[string, string]> = [
  ['a raw newline inside a JSON string (lms-1)', '{"file_path":"src/calc.js","content":"// src/calc.js\n\nimport { add } from \'./math\';"}'],
  [
    'a markdown fence where a JSON string belongs (lms-3)',
    '{"file_path": "src/calc.js", "content": ```javascript\nfunction mul(a, b) {\n  return a * b;\n}\n```\n```[END_TOOL_REQUEST]',
  ],
  ['no text at all', ''],
];

const WRITE_TOOL: FunctionTool = {
  type: 'function',
  name: 'Write',
  description: 'Write a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
};

const historyWith = (args: string): AdapterInputItem[] => [
  { type: 'message', role: 'user', content: 'add mul to src/calc.js' },
  { type: 'function_call', call_id: 'call_1', name: 'Write', arguments: args },
  { type: 'function_call_output', call_id: 'call_1', output: 'Invalid JSON arguments for Write: Unexpected token' },
];

const requestWith = (args: string, tools: FunctionTool[]): AdapterRequest => ({ model: 'm', input: historyWith(args), ...(tools.length === 0 ? {} : { tools }) });

const chatAdapter = (mode: ToolCallingMode) =>
  createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS, schemaDialect: () => 'json-schema-2020-12',
    resolveEndpoint: async () => {
      throw new Error('rendering a wire never reaches the upstream');
    },
    capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: mode }),
    clock: createFakeClock(START_MS),
  });

const renderChat = (mode: ToolCallingMode, request: AdapterRequest): { messages?: unknown[] } => {
  const adapter = chatAdapter(mode);
  const render = adapter.renderWire;
  if (render === undefined) throw new Error('the chat-completions adapter renders no wire');
  return render.call(adapter, request, TARGET, { reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: { ...CC_CAPABILITIES, toolCalling: mode } }) as { messages?: unknown[] };
};

type WireMessage = { tool_calls?: Array<{ function: { arguments: unknown } }> };

const chatToolCallArguments = (messages: readonly unknown[] | undefined): unknown[] =>
  (messages ?? []).flatMap((message) => ((message as WireMessage).tool_calls ?? []).map((call) => call.function.arguments));

describe('a history holding a model call with arguments that are a JSON object', () => {
  it('reaches a chat-completions upstream with the arguments the model wrote', () => {
    const args = '{"file_path":"src/calc.js","content":"x"}';
    const wire = renderChat('native', requestWith(args, [WRITE_TOOL]));

    expect(chatToolCallArguments(wire.messages)).toEqual([args]);
  });
});

const expectCutOff = (wire: unknown): void => {
  const text = JSON.stringify(wire);
  expect(text).toContain('cut_off_tool_call');
  expect(text).not.toContain('Invalid JSON arguments for Write');
};

describe.each(MALFORMED_ARGUMENTS)('a history holding a model call with %s', (_label, args) => {
  it('reaches a chat-completions upstream without the call and its output, with the cut-off note in their place', () => {
    const wire = renderChat('native', requestWith(args, [WRITE_TOOL]));

    expect(chatToolCallArguments(wire.messages)).toEqual([]);
    expectCutOff(wire);
  });

  it('renders for a chat-completions request that offers no tools, as the wrap-up request and its count do', () => {
    expectCutOff(renderChat('native', requestWith(args, [])));
  });

  it('renders for a chat-completions target in constrained tool calling', () => {
    expectCutOff(renderChat('constrained', requestWith(args, [WRITE_TOOL])));
  });

  it('reaches an Open Responses upstream without the call and its output', () => {
    const body = buildResponsesBody(requestWith(args, [WRITE_TOOL]), EVERY_REASONING_IS_OWN);

    const calls = (body.input as Array<{ type?: string }>).filter((item) => item.type === 'function_call' || item.type === 'function_call_output');
    expect(calls).toEqual([]);
    expectCutOff(body.input);
  });

  it('reaches an Ollama upstream without the call and its output', () => {
    const body = buildOllamaChatBody(requestWith(args, [WRITE_TOOL]), { contextWindow: 4096, maxOutputTokens: 1024 }, true, EVERY_REASONING_IS_OWN);

    const rendered = (body.messages as unknown[]).flatMap((message) => (message as { tool_calls?: unknown[] }).tool_calls ?? []);
    expect(rendered).toEqual([]);
    expectCutOff(body.messages);
  });

  it('reaches an Anthropic upstream, for a reply and for a token count, without a tool_use for the call', () => {
    const request = requestWith(args, [WRITE_TOOL]);
    const body = buildMessagesBody(request, 4096, { cache: undefined }, EVERY_REASONING_IS_OWN);

    expect(() => buildCountTokensBody(request, EVERY_REASONING_IS_OWN)).not.toThrow();
    const uses = body.messages.flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<{ type?: string }>) : []).filter((block) => block.type === 'tool_use' || block.type === 'tool_result'));
    expect(uses).toEqual([]);
    expectCutOff(body.messages);
  });
});
