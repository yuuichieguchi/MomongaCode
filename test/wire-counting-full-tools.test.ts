const EVERY_REASONING_IS_OWN = { own: (item: never) => item } as const;
import { afterEach, describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, estimateInputTokens, wireTokensOf } from '@momonga/gateway';
import type { AdapterRequest, Capabilities, FunctionTool, ToolCallingMode } from '@momonga/protocol';
import { buildSystemPrompt } from '@momonga/runtime';
import { createBuiltinTools, createToolRegistry } from '@momonga/tools';
import { createFakeClock } from '@momonga/testkit';

const CAPABILITIES: Capabilities = {
  contextWindow: 4096,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'config',
};

const fullToolSet = async (): Promise<FunctionTool[]> => {
  const registry = createToolRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  const snapshot = await registry.snapshot();
  return snapshot.forModel({ mode: 'default', rules: [] });
};

const firstRequest = async (): Promise<AdapterRequest> => ({
  model: 'system',
  input: [
    { type: 'message', role: 'system', content: buildSystemPrompt({ cwd: '/private/tmp/momonga-e2e-xxxxxxxx/project', platform: 'darwin' }) },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Search the haystack' }] },
  ],
  tools: await fullToolSet(),
  tool_choice: 'auto',
});

const adapters: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});

const adapterIn = (mode: ToolCallingMode) => {
  const adapter = createChatCompletionsAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: '/nonexistent/never-used.sock' }),
    toolCalling: () => mode,
    capabilities: async () => ({ ...CAPABILITIES, toolCalling: mode }),
    clock: createFakeClock(0),
  });
  adapters.push(adapter);
  return adapter;
};

const countedBefore = (request: AdapterRequest): number => estimateInputTokens({ input: request.input, tools: request.tools });

describe('wire counting for the full builtin tool set at fm\'s window', () => {
  it('counts the constrained wire with the tool listing and the envelope, above the count of the input and the tools', async () => {
    const request = await firstRequest();
    const tools = request.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep', 'ReadOutput', 'Write', 'Edit', 'Bash', 'UpdatePlan', 'BashOutput', 'KillBash']);
    const wire = adapterIn('constrained').renderWire?.(request, { name: 'fm', model: 'system' }, { reasoningOrigin: EVERY_REASONING_IS_OWN }) as { messages: Array<{ role: string; content: string }>; response_format: unknown };
    const system = wire.messages.find((message) => message.role === 'system')?.content ?? '';
    for (const tool of tools) expect(system).toContain(JSON.stringify(tool.description));
    const envelope = JSON.stringify(wire.response_format);
    for (const tool of tools) expect(envelope).toContain(JSON.stringify(tool.name));
    expect(wireTokensOf(wire as never)).toBeGreaterThan(countedBefore(request));
  });

  it('keeps the native wire within 1% of the count of the input and the tools', async () => {
    const request = await firstRequest();
    const counted = countedBefore(request);
    const native = wireTokensOf(adapterIn('native').renderWire?.(request, { name: 'fm', model: 'system' }, { reasoningOrigin: EVERY_REASONING_IS_OWN }) as never);
    expect(Math.abs(native - counted)).toBeLessThanOrEqual(Math.ceil(0.01 * counted));
  });

  it('puts the constrained first request above W - R = 3072 at a 4096 window', async () => {
    const request = await firstRequest();
    const constrained = wireTokensOf(adapterIn('constrained').renderWire?.(request, { name: 'fm', model: 'system' }, { reasoningOrigin: EVERY_REASONING_IS_OWN }) as never);
    expect(constrained).toBeGreaterThan(4096 - 1024);
  });
});
