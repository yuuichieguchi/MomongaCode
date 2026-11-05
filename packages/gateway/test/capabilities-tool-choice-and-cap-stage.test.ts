import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import { createFakeClock, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, getJson, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

type Harness = Awaited<ReturnType<typeof startGateway>>;

const ERROR_STATUS = 2;
const CAP = 200;
const OPEN_MS = 30_000;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SEEING: Capabilities = { ...CC_CAPABILITIES, imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } };
const SEEING_SMALL_CAP: Capabilities = { ...SEEING, maxOutputTokens: CAP - 1 };
const NO_LITERALS = { enum: false, anyOf: true, const: false, pattern: true, minimum: true, nested: true, additionalProperties: true };

const imageInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG }] }];

const tracedGatewayOf = async (adapters: Record<string, ProviderAdapter>) => {
  const clock = createFakeClock(START_MS);
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock,
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  const harness = await startGateway({
    clock,
    telemetry,
    adapters,
    config: {
      aliases: { fast: Object.keys(adapters) },
      targets: Object.fromEntries(Object.keys(adapters).map((name) => [name, { model: 'system' }])),
      retry: { maxAttempts: 1, totalWaitMs: 1 },
      breaker: { failureThreshold: 1, openMs: OPEN_MS },
    },
  });
  const failedSpansOf = async (name: string) => {
    await telemetry.forceFlush();
    return memory
      .getFinishedSpans()
      .filter((span) => span.attributes['gen_ai.operation.name'] === 'chat' && span.attributes['momonga.target'] === name && span.status.code === ERROR_STATUS);
  };
  return { harness, failedSpansOf };
};

const send = async (harness: Harness, path: string, body: Record<string, unknown>) => {
  const response = await postJson(harness.client, path, body);
  if (body['stream'] === true && response.status === 200) {
    const frames = await readSse(response);
    return { status: 200, body: frames.at(-1)?.data?.response ?? {} };
  }
  return readJson(response);
};

const breakerOf = async (harness: Harness, name: string) => (await getJson(harness.client, '/v1/momonga/health')).body.targets[name].breaker;

const openResponsesTarget = async () => {
  const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['from remote']), openResponsesTextReply(['from remote'])] });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const ollamaTarget = async () => {
  const fake = await startFakeOllama();
  const sent = () => fake.requests.filter((request) => request.path === '/api/chat' || request.path.endsWith('/chat/completions'));
  return { sent, adapter: makeOllamaAdapter(fake) };
};

const literallessConstrainedTarget = async () => {
  const fake = await startFake({ scenario: 'json-schema-only', script: [] });
  const adapter = makeAdapter(fake, { keywordSupport: () => NO_LITERALS }, 'constrained');
  return { sent: () => fake.requests, adapter };
};

const toolNamed = (name: string) => ({ type: 'function' as const, name, parameters: { type: 'object', properties: {}, additionalProperties: false } });
const TOOLS = [toolNamed('a'), toolNamed('b')];

const CHOICES = [
  { label: 'required', incapable: ollamaTarget, tool_choice: 'required' },
  { label: 'a named function', incapable: literallessConstrainedTarget, tool_choice: { type: 'function', name: 'a' } },
] as const;

const OPERATIONS = [
  { name: 'create', path: '/v1/responses', stream: false },
  { name: 'create streaming', path: '/v1/responses', stream: true },
  { name: 'count_tokens', path: '/v1/momonga/count_tokens', stream: false },
] as const;

const CASES = CHOICES.flatMap((choice) => OPERATIONS.map((operation) => ({ ...choice, operation, title: `${operation.name} with tool_choice ${choice.label}` })));

const bodyOf = (testCase: (typeof CASES)[number]) => ({
  model: 'fast',
  input: userInput('hi'),
  tools: TOOLS,
  tool_choice: testCase.tool_choice,
  ...(testCase.operation.stream ? { stream: true } : {}),
});

describe('the toolChoice stage judges every tool_choice that constrains the call', () => {
  it.for(CASES)('[incapable, remote] $title: the remote target serves and the incapable one is dropped', async (testCase) => {
    const incapable = await testCase.incapable();
    const remote = await openResponsesTarget();
    const { harness, failedSpansOf } = await tracedGatewayOf({ incapable: incapable.adapter, remote: remote.adapter });
    const response = await send(harness, testCase.operation.path, bodyOf(testCase));
    expect(response.body.error ?? null).toBeNull();
    expect(response.status).toBe(200);
    if (testCase.operation.path === '/v1/responses') {
      expect(response.body.momonga.target).toBe('remote');
      expect(response.body.momonga.fallbackFrom ?? []).not.toContain('incapable');
    }
    expect(incapable.sent()).toHaveLength(0);
    expect(await failedSpansOf('incapable')).toHaveLength(0);
    expect(await breakerOf(harness, 'incapable')).toBe('closed');
  });

  it.for(CASES)('[incapable] $title: 400 unsupported_tool_choice with no send and no failed span', async (testCase) => {
    const incapable = await testCase.incapable();
    const { harness, failedSpansOf } = await tracedGatewayOf({ incapable: incapable.adapter });
    const response = await readJson(await postJson(harness.client, testCase.operation.path, bodyOf(testCase)));
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('unsupported_tool_choice');
    expect(response.body.error?.param).toBe('tool_choice');
    expect(incapable.sent()).toHaveLength(0);
    expect(await failedSpansOf('incapable')).toHaveLength(0);
  });
});

describe('a summary cap forces judging at narrowing', () => {
  const withoutCompaction = async (capabilities: Capabilities): Promise<ProviderAdapter> => {
    const fake = await startFake({ scenario: 'tools-ok', imageInput: true, script: [] });
    const { compact: _compact, renderCompactWire: _render, ...rest } = makeAdapter(fake, { capabilities: async () => capabilities });
    return rest as ProviderAdapter;
  };

  it('no target supports compaction and the cap is too large: the answer is the same with or without an image', async () => {
    const reference = await tracedGatewayOf({ only: await withoutCompaction(SEEING_SMALL_CAP) });
    const expected = await readJson(await postJson(reference.harness.client, '/v1/responses/compact', { model: 'fast', input: imageInput, momonga: { max_summary_tokens: CAP } }));
    expect(expected.status).toBe(400);

    const { harness } = await tracedGatewayOf({ only: await withoutCompaction(SEEING_SMALL_CAP) });
    const response = await readJson(await postJson(harness.client, '/v1/responses/compact', { model: 'fast', input: userInput('summarise this'), momonga: { max_summary_tokens: CAP } }));
    expect({ status: response.status, code: response.body.error?.code, param: response.body.error?.param }).toEqual({
      status: expected.status,
      code: expected.body.error?.code,
      param: expected.body.error?.param,
    });
  });

  const halfOpenGateway = async () => {
    let calls = 0;
    const smallFake = await startFake({ scenario: 'tools-ok', imageInput: true, script: [textReply('from small'), textReply('from small')] });
    const small = makeAdapter(smallFake, {
      capabilities: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('small is restarting'), { code: 'ECONNREFUSED' });
        return SEEING_SMALL_CAP;
      },
    });
    const wideFake = await startFake({ scenario: 'tools-ok', imageInput: true, script: [textReply('from wide'), textReply('from wide'), textReply('from wide')] });
    const wide = makeAdapter(wideFake, { capabilities: async () => SEEING });
    const traced = await tracedGatewayOf({ small, wide });
    const opening = await send(traced.harness, '/v1/responses', { model: 'fast', input: userInput('hi') });
    expect(opening.body.momonga.target).toBe('wide');
    expect(await breakerOf(traced.harness, 'small')).toBe('open');
    traced.harness.clock.advance(OPEN_MS);
    return { ...traced, smallFake };
  };

  const afterCompact = async (input: unknown) => {
    const { harness, smallFake } = await halfOpenGateway();
    const sentBefore = smallFake.requests.length;
    const compacted = await readJson(await postJson(harness.client, '/v1/responses/compact', { model: 'fast', input, momonga: { max_summary_tokens: CAP } }));
    const breaker = await breakerOf(harness, 'small');
    const sentByCompact = smallFake.requests.length - sentBefore;
    const followUp = await send(harness, '/v1/responses', { model: 'fast', input: userInput('hi again') });
    return { status: compacted.status, breaker, sentByCompact, followUpTarget: followUp.body.momonga?.target };
  };

  it('a half-open target whose cap is too small keeps its trial, as when the cap is judged up front', async () => {
    const expected = await afterCompact(imageInput);
    expect(expected).toMatchObject({ status: 200, sentByCompact: 0, followUpTarget: 'small' });
    expect(await afterCompact(userInput('summarise this'))).toEqual(expected);
  });
});
