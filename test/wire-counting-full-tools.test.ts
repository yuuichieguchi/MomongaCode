const NO_REASONING_IS_OWN = { own: () => undefined };
import { afterEach, describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, estimateInputTokens, wireTokensOf, unauthenticatedSource } from '@momonga/gateway';
import type { AdapterRequest, Capabilities, FunctionTool, ToolCallingMode } from '@momonga/protocol';
import { buildSystemPrompt } from '@momonga/runtime';
import { createBuiltinTools, createToolRegistry } from '@momonga/tools';
import { TEST_BUILTIN_TOOL_OFFER, createFakeClock } from '@momonga/testkit';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

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
  for (const tool of createBuiltinTools(TEST_BUILTIN_TOOL_OFFER)) registry.register(tool);
  const snapshot = await registry.snapshot();
  return snapshot.forModel({ mode: 'manual', rules: [] }).map((tool) => Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'fitRank' && key !== 'fitTier')) as FunctionTool);
};

const firstRequest = async (): Promise<AdapterRequest> => ({
  model: 'system',
  input: [
    { type: 'message', role: 'system', content: buildSystemPrompt({ cwd: '/private/tmp/momonga-e2e-xxxxxxxx/project', platform: 'darwin', fence: TEST_FENCE }) },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Search the haystack' }] },
  ],
  tools: await fullToolSet(),
  tool_choice: 'auto',
  fence: TEST_FENCE,
});

const adapters: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});

const adapterIn = (mode: ToolCallingMode) => {
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS,
    schemaDialect: () => 'json-schema-2020-12',
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: '/nonexistent/never-used.sock' }),
    capabilities: async () => ({ ...CAPABILITIES, toolCalling: mode }),
    clock: createFakeClock(0),
  });
  adapters.push(adapter);
  return adapter;
};

const countedBefore = (request: AdapterRequest): number => estimateInputTokens({ input: request.input, tools: request.tools });

describe('wire counting for the full builtin tool set at fm\'s window', () => {
  it('counts the constrained wire with the tool listing in the system message, above the count of the input and the tools', async () => {
    const request = await firstRequest();
    const tools = request.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['Glob', 'Grep', 'Read', 'ReadOutput', 'Bash', 'BashOutput', 'KillBash', 'Edit', 'UpdatePlan', 'Write']);
    const wire = adapterIn('constrained').renderWire?.(request, { name: 'apple/system', display: 'system', model: 'system' }, { reasoningOrigin: NO_REASONING_IS_OWN, capabilities: { ...CAPABILITIES, toolCalling: 'constrained' } }) as { messages: Array<{ role: string; content: string }> };
    expect(wire).not.toHaveProperty('response_format');
    const system = wire.messages.find((message) => message.role === 'system')?.content ?? '';
    for (const tool of tools) {
      expect(system).toContain(JSON.stringify(tool.name));
      expect(system).toContain(JSON.stringify(tool.description));
    }
    expect(wireTokensOf(wire as never)).toBeGreaterThan(countedBefore(request));
  });

  it('keeps the native wire within 1% of the count of the input and the tools', async () => {
    const request = await firstRequest();
    const counted = countedBefore(request);
    const native = wireTokensOf(adapterIn('native').renderWire?.(request, { name: 'apple/system', display: 'system', model: 'system' }, { reasoningOrigin: NO_REASONING_IS_OWN, capabilities: { ...CAPABILITIES, toolCalling: 'native' } }) as never);
    expect(Math.abs(native - counted)).toBeLessThanOrEqual(Math.ceil(0.01 * counted));
  });

  it('counts the constrained first request from its prompt parts alone, with no schema term', async () => {
    const request = await firstRequest();
    const wire = adapterIn('constrained').renderWire?.(request, { name: 'apple/system', display: 'system', model: 'system' }, { reasoningOrigin: NO_REASONING_IS_OWN, capabilities: { ...CAPABILITIES, toolCalling: 'constrained' } }) as { messages: unknown[] };
    const counted = wireTokensOf(wire as never);
    expect(counted).toBe(wireTokensOf({ messages: wire.messages } as never));
    const schema = { type: 'json_schema', json_schema: { name: 'envelope', strict: true, schema: { type: 'object', properties: { tool: { enum: (request.tools ?? []).map((tool) => tool.name) } } } } };
    expect(wireTokensOf({ ...wire, response_format: schema } as never)).toBe(counted);
    expect(wireTokensOf({ ...wire, format: schema } as never)).toBe(counted);
  });
});
