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

const parsesAsJsonObject = (text: unknown): boolean => {
  if (typeof text !== 'string') return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

const isPlainObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

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

describe.each(MALFORMED_ARGUMENTS)('a history holding a model call with %s', (_label, args) => {
  it('reaches a chat-completions upstream with tool_calls arguments that parse as a JSON object', () => {
    const wire = renderChat('native', requestWith(args, [WRITE_TOOL]));

    const rendered = chatToolCallArguments(wire.messages);
    expect(rendered).toHaveLength(1);
    expect(rendered.map(parsesAsJsonObject)).toEqual([true]);
  });

  it('renders for a chat-completions request that offers no tools, as the wrap-up request and its count do', () => {
    expect(() => renderChat('native', requestWith(args, []))).not.toThrow();
  });

  it('renders for a chat-completions target in constrained tool calling', () => {
    expect(() => renderChat('constrained', requestWith(args, [WRITE_TOOL]))).not.toThrow();
  });

  it('reaches an Open Responses upstream with function_call arguments that parse as a JSON object', () => {
    const body = buildResponsesBody(requestWith(args, [WRITE_TOOL]), EVERY_REASONING_IS_OWN);

    const calls = (body.input as Array<{ type?: string; arguments?: unknown }>).filter((item) => item.type === 'function_call');
    expect(calls.map((item) => parsesAsJsonObject(item.arguments))).toEqual([true]);
  });

  it('reaches an Ollama upstream with tool_calls arguments that are a JSON object', () => {
    const render = () => buildOllamaChatBody(requestWith(args, [WRITE_TOOL]), { contextWindow: 4096, maxOutputTokens: 1024 }, true, EVERY_REASONING_IS_OWN);

    expect(render).not.toThrow();
    const rendered = (render().messages as unknown[]).flatMap((message) =>
      ((message as { tool_calls?: Array<{ function: { arguments: unknown } }> }).tool_calls ?? []).map((call) => call.function.arguments),
    );
    expect(rendered.map(isPlainObject)).toEqual([true]);
  });

  it('reaches an Anthropic upstream, for a reply and for a token count, with a tool_use input that is a JSON object', () => {
    const request = requestWith(args, [WRITE_TOOL]);
    const render = () => buildMessagesBody(request, 4096, { cache: undefined }, EVERY_REASONING_IS_OWN);

    expect(render).not.toThrow();
    expect(() => buildCountTokensBody(request, EVERY_REASONING_IS_OWN)).not.toThrow();
    const inputs = render().messages.flatMap((message) =>
      (Array.isArray(message.content) ? (message.content as Array<{ type?: string; input?: unknown }>) : [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.input),
    );
    expect(inputs.map(isPlainObject)).toEqual([true]);
  });
});
