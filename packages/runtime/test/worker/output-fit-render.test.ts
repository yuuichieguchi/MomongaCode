import { describe, expect, it } from 'vitest';
import { createTokenMeter } from '@momonga/context';
import type { TokenCounter, TokenMeter } from '@momonga/context';
import { createChatCompletionsAdapter, unauthenticatedSource } from '@momonga/gateway';
import { ESTIMATED_CHARACTERS_PER_TOKEN, ESTIMATED_ERROR_SHAPE, countReplyOf, TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import type { AdapterInputItem, AdapterTarget, Capabilities, InputItem, ToolCallingMode } from '@momonga/protocol';
import { UNDICI_DEFAULT_LIVENESS, createFakeClock } from '@momonga/testkit';
import { meteredOutputFit } from '../../src/worker/output-fit.ts';
import { TEST_FENCE } from '@momonga/testkit';

const TARGET: AdapterTarget = { name: 'apple/system', display: 'system', model: 'system' };
const ITEM_CAP = 160;
const CALL = { callId: 'call_grep_1', tool: 'Grep' } as const;
const HARNESS_CALL = { callId: 'call_plan_1', tool: 'UpdatePlan' } as const;
const HANDLE = 'a'.repeat(64);

const capabilitiesOf = (toolCalling: ToolCallingMode): Capabilities => ({
  contextWindow: 4096,
  maxOutputTokens: 1024,
  toolCalling,
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'config',
});

const renderingMeter = (toolCalling: ToolCallingMode): TokenMeter => {
  const capabilities = capabilitiesOf(toolCalling);
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource,
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => {
      throw new Error('a count renders the wire and never contacts the upstream');
    },
    capabilities: async () => capabilities,
    schemaDialect: () => capabilities.schemaDialect,
    clock: createFakeClock(0),
  });
  const counter: TokenCounter = {
    count: async (request) => {
      const lenient = request.momonga?.lenient_items;
      if (typeof request.input === 'string' || lenient === undefined) throw new Error('the output fit counts one item through the lenient render');
      const wire = adapter.renderWire?.(
        { model: TARGET.model, input: request.input as AdapterInputItem[], fence: TEST_FENCE },
        TARGET,
        { lenientItems: { callNames: lenient.call_names, withTools: lenient.with_tools }, reasoningOrigin: { own: (item) => item }, capabilities },
      );
      return countReplyOf(Math.ceil(JSON.stringify(wire).length / ESTIMATED_CHARACTERS_PER_TOKEN), 'estimated', ESTIMATED_ERROR_SHAPE);
    },
  };
  return createTokenMeter({ counter, model: 'default', capabilities });
};

const outputItemOf = (callId: string, output: string): InputItem => ({ type: 'function_call_output', call_id: callId, output });

const seenTokens = (meter: TokenMeter, call: { callId: string; tool: string }, output: string): Promise<number> =>
  meter.countItem(outputItemOf(call.callId, output), { callNames: { [call.callId]: call.tool }, withTools: true });

const longOutput = Array.from({ length: 200 }, (_, line) => `haystack.txt:${line + 1}:a needle in line ${line + 1}`).join('\n');

describe('the completion fit counts the output as the model sees it', () => {
  it.for(['native', 'constrained'] as const)('fits and cuts the output of a named call on a %s target', async (toolCalling) => {
    const fit = meteredOutputFit({ meter: renderingMeter(toolCalling), itemCap: async () => ITEM_CAP, harnessTools: new Set(['UpdatePlan']), fence: TEST_FENCE });

    await expect(fit.fits('short', CALL)).resolves.toBe(true);
    await expect(fit.fit(longOutput, HANDLE, CALL)).resolves.toContain(HANDLE);
  });

  it.for(['native', 'constrained'] as const)('leaves an external output that the render does not cut again on a %s target', async (toolCalling) => {
    const meter = renderingMeter(toolCalling);
    const fit = meteredOutputFit({ meter, itemCap: async () => ITEM_CAP, harnessTools: new Set(['UpdatePlan']), fence: TEST_FENCE });

    const fitted = await fit.fit(longOutput, HANDLE, CALL);

    expect(await seenTokens(meter, CALL, fenceUntrusted(TOOL_OUTPUT_TAG, { call: CALL.callId, tool: CALL.tool }, fitted, TEST_FENCE))).toBeLessThanOrEqual(ITEM_CAP);
  });

  it('counts a harness output bare, as the render shows it', async () => {
    const meter = renderingMeter('native');
    const fit = meteredOutputFit({ meter, itemCap: async () => ITEM_CAP, harnessTools: new Set(['UpdatePlan']), fence: TEST_FENCE });

    const fitted = await fit.fit(longOutput, HANDLE, HARNESS_CALL);

    const bare = await seenTokens(meter, HARNESS_CALL, fitted);
    expect(bare).toBeLessThanOrEqual(ITEM_CAP);
    expect(await seenTokens(meter, HARNESS_CALL, `${fitted}\n${'x'.repeat(ESTIMATED_CHARACTERS_PER_TOKEN * (ITEM_CAP - bare + 1))}`)).toBeGreaterThan(ITEM_CAP);
  });
});
