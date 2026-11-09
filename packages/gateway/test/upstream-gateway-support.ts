import { keyAuthSource, unauthenticatedSource } from '@momonga/gateway';
import { expect } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { PriceTable } from '@momonga/observability';
import { DEFAULT_ANTHROPIC_API_VERSION } from '@momonga/protocol';
import type { AnthropicApiVersion, Capabilities, StreamEvent } from '@momonga/protocol';
import { createFakeClock, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import type { FakeAnthropicOptions, FakeOpenResponsesOptions, FakeUpstreamServer } from '@momonga/testkit';
import { START_MS, postJson, readSse, registerCleanup, startGateway, userInput, validator } from './gateway-helpers.ts';
import type { ConfigOverrides, Harness } from './gateway-helpers.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

export const FAKE_API_KEY = 'sk-ant-fake-0000000000000000';

export const REMOTE_CAPABILITIES: Capabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'config',
};

export const readFileTool = {
  type: 'function' as const,
  name: 'read_file',
  description: 'Read a file from the workspace',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

export type UpstreamGateway = Harness & { fake: FakeUpstreamServer };

const singleTarget = { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote' } } };

export const startAnthropicGateway = async (
  options: Omit<FakeAnthropicOptions, 'apiKey'> & {
    apiKey?: string;
    sentKey?: string;
    config?: ConfigOverrides;
    capabilities?: Capabilities;
    priceTable?: PriceTable;
    apiVersion?: AnthropicApiVersion;
  },
): Promise<UpstreamGateway> => {
  const fake = await startFakeAnthropic({ apiKey: options.apiKey ?? FAKE_API_KEY, ...options });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    authSource: keyAuthSource(async () => options.sentKey ?? FAKE_API_KEY),
    capabilities: async () => options.capabilities ?? REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    apiVersion: options.apiVersion ?? DEFAULT_ANTHROPIC_API_VERSION,
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({
    adapters: { remote: adapter },
    config: { ...singleTarget, ...options.config },
    ...(options.priceTable === undefined ? {} : { priceTable: options.priceTable }),
  });
  return { ...harness, fake };
};

export const startOpenResponsesGateway = async (
  options: FakeOpenResponsesOptions & { sentKey?: string; config?: ConfigOverrides; capabilities?: Capabilities; priceTable?: PriceTable },
): Promise<UpstreamGateway> => {
  const fake = await startFakeOpenResponses(options);
  const { sentKey } = options;
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    authSource: sentKey === undefined ? unauthenticatedSource : keyAuthSource(async () => sentKey),
    capabilities: async () => options.capabilities ?? REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({
    adapters: { remote: adapter },
    config: { ...singleTarget, ...options.config },
    ...(options.priceTable === undefined ? {} : { priceTable: options.priceTable }),
  });
  return { ...harness, fake };
};

const schemaNames = validator.streamEventSchemaNames();

export const specProblems = (frames: Array<{ data: any }>): string[] =>
  frames.flatMap((frame) => {
    const name = schemaNames.get(frame.data.type);
    if (name === undefined) return [`${frame.data.type}: unknown event`];
    return validator.validate(name, frame.data).errors.map((error) => `${frame.data.type}: ${error}`);
  });

export const streamResponse = async (gateway: UpstreamGateway, body: Record<string, unknown> = {}) => {
  const frames = await readSse(
    await postJson(gateway.client, '/v1/responses', { model: 'fast', stream: true, input: userInput('hello'), ...body }),
  );
  expect(specProblems(frames)).toEqual([]);
  return frames;
};

export const terminalOf = (frames: Array<{ data: any }>): any => {
  const last = frames.at(-1)?.data;
  expect(['response.completed', 'response.incomplete', 'response.failed']).toContain(last.type);
  return last;
};

export const typesOf = (frames: Array<{ data: any }>): string[] => frames.map((frame) => frame.data.type);

export const textOf = (resource: { output: Array<Record<string, any>> }): string =>
  resource.output
    .filter((item) => item['type'] === 'message')
    .flatMap((item) => item['content'] as Array<Record<string, any>>)
    .filter((part) => part['type'] === 'output_text')
    .map((part) => part['text'] as string)
    .join('');

export type { StreamEvent };
