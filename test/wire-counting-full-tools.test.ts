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

describe('wire counting for the full builtin tool set at fm\'s window', () => {
  it('counts the constrained wire with the tool listing and the envelope: 3460 tokens, not the 1986 counted before', async () => {
    const request = await firstRequest();
    expect(request.tools?.map((tool) => tool.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'ReadOutput', 'UpdatePlan']);
    const adapter = adapterIn('constrained');
    expect(estimateInputTokens({ input: request.input, tools: request.tools })).toBe(1986);
    expect(wireTokensOf(adapter.renderWire?.(request, { name: 'fm', model: 'system' }) as never)).toBe(3460);
  });

  it('keeps the native wire within 1% of the old count', async () => {
    const request = await firstRequest();
    const native = wireTokensOf(adapterIn('native').renderWire?.(request, { name: 'fm', model: 'system' }) as never);
    expect(native).toBe(1969);
    expect(Math.abs(native - 1986)).toBeLessThanOrEqual(Math.ceil(0.01 * 1986));
  });

  it('puts the constrained first request above W - R = 3072 at a 4096 window', async () => {
    const request = await firstRequest();
    const constrained = wireTokensOf(adapterIn('constrained').renderWire?.(request, { name: 'fm', model: 'system' }) as never);
    expect(constrained).toBeGreaterThan(4096 - 1024);
  });
});
