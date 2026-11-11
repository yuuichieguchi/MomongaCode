import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter, unauthenticatedSource } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import { UNDICI_DEFAULT_LIVENESS, createFakeClock, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, outputText, postJson, readJson, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';
import { CC_CAPABILITIES, makeAdapter, startFake } from '../cc-support.ts';
import { REMOTE_CAPABILITIES } from '../upstream-gateway-support.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SEEING = { imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } } as const;
const SEEING_REMOTE: Capabilities = { ...REMOTE_CAPABILITIES, ...SEEING, structuredOutput: 'json_schema' };
const canonOf = (server: string): string => `${server}/system`;

const remoteMember = async () => {
  const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['from remote'])] });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    authSource: unauthenticatedSource,
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => SEEING_REMOTE,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return adapter;
};

const servedBy = async (first: ProviderAdapter, body: Record<string, unknown>) => {
  const second = await remoteMember();
  const harness = await startGateway({
    adapters: { [canonOf('first')]: first, [canonOf('second')]: second },
    config: {
      targets: { [canonOf('first')]: {}, [canonOf('second')]: {} },
      chains: { [canonOf('first')]: [canonOf('first'), canonOf('second')] },
      retry: { maxAttempts: 1, totalWaitMs: 1 },
    },
  });
  return readJson(await postJson(harness.client, '/v1/responses', { model: canonOf('first'), ...body }));
};

const referencingTool = {
  type: 'function',
  name: 'lookup',
  parameters: { type: 'object', properties: { item: { $ref: '#/$defs/item' } }, required: ['item'], additionalProperties: false, $defs: { item: { type: 'string' } } },
};

describe('one classifier decides that a chain member cannot carry a request', () => {
  it('serves from the second member when only it can render a tool schema', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    const first = makeAdapter(fake, { constructSupport: () => ({ ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' }) });
    const response = await servedBy(first, { input: userInput('look it up'), tools: [referencingTool] });
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from remote');
    expect(fake.requests).toHaveLength(0);
  });

  it('serves an image inside a tool result from the member whose wire carries it', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    const first = makeAdapter(fake, { capabilities: async (): Promise<Capabilities> => ({ ...CC_CAPABILITIES, ...SEEING }) });
    const response = await servedBy(first, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'take a screenshot' }] },
        { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: PNG }] },
      ],
      tools: [{ type: 'function', name: 'screenshot', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from remote');
    expect(fake.requests).toHaveLength(0);
  });

  it('serves a JSON reply with tools from the member that can combine them', async () => {
    const fake = await startFake({ scenario: 'json-schema-only', script: [] });
    const first = makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'constrained', structuredOutput: 'json_schema' }) }, 'constrained');
    const response = await servedBy(first, {
      input: userInput('answer in JSON'),
      tools: [{ type: 'function', name: 'noop', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } },
    });
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from remote');
    expect(fake.requests).toHaveLength(0);
  });
});
