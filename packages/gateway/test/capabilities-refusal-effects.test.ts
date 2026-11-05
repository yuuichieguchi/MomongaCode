import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import type { ChatCompletionsAdapter, ProviderAdapter } from '@momonga/gateway';
import type { Capabilities, NeedsProbe } from '@momonga/protocol';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createFakeClock, waitFor } from '@momonga/testkit';
import { estimatedCountOf } from '../src/core/estimate.ts';
import { START_MS, getJson, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

type Harness = Awaited<ReturnType<typeof startGateway>>;
type Outcome = { kind: 'reject'; error: () => Error } | { kind: 'fulfil'; capabilities: Capabilities };
type Target = { fake: FakeChatCompletionsServer; adapter: ProviderAdapter; resolver: { calls: number } };

const ERROR_STATUS = 2;
const CAP = 200;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SEEING: Capabilities = { ...CC_CAPABILITIES, imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } };
const SMALL_CAP: Capabilities = { ...CC_CAPABILITIES, maxOutputTokens: CAP - 1 };
const SEEING_SMALL_CAP: Capabilities = { ...SEEING, maxOutputTokens: CAP - 1 };
const BLIND: Capabilities = { ...CC_CAPABILITIES, toolCalling: 'none' };
const NO_SAMPLING: Capabilities = { ...CC_CAPABILITIES, sampling: { accepts: 'none' } };
const SEEING_NO_SAMPLING: Capabilities = { ...SEEING, sampling: { accepts: 'none' } };
const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'the target "a" sets toolCalling to auto, but no probe record exists',
  evidence: 'no record for the a binary',
  remedy: 'run `momonga gateway probe a`',
};
const UNPROBED: Capabilities = { ...CC_CAPABILITIES, toolCalling: NEEDS_PROBE };
const ALLOWED_NATIVE: Capabilities = { ...CC_CAPABILITIES, allowedTools: ['native'] };

const imageInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG }] }];

const refused = (message: string) => (): Error => Object.assign(new Error(message), { code: 'ECONNREFUSED' });
const reject = (error: () => Error): Outcome => ({ kind: 'reject', error });
const fulfil = (capabilities: Capabilities): Outcome => ({ kind: 'fulfil', capabilities });
const restarting = reject(refused('a is restarting'));

const targetOf = async (outcomes: readonly Outcome[], shape: (adapter: ChatCompletionsAdapter) => ProviderAdapter = (adapter) => adapter, extra: Parameters<typeof makeAdapter>[1] = {}): Promise<Target> => {
  const fake = await startFake({ scenario: 'tools-ok', imageInput: true, script: Array.from({ length: 3 }, () => textReply('served')) });
  const resolver = { calls: 0 };
  const capabilities = async (): Promise<Capabilities> => {
    const outcome = outcomes[Math.min(resolver.calls, outcomes.length - 1)];
    resolver.calls += 1;
    if (outcome === undefined) throw new Error('the resolver has no outcome');
    if (outcome.kind === 'reject') throw outcome.error();
    return outcome.capabilities;
  };
  return { fake, adapter: shape(makeAdapter(fake, { capabilities, ...extra })), resolver };
};

const RETRYING = { maxAttempts: 3, baseMs: 100, maxMs: 100, totalWaitMs: 1000 };
const ONCE = { maxAttempts: 1, totalWaitMs: 1 };

const tracedGatewayOf = async (targets: Record<string, Target>, retry: Record<string, number> = ONCE) => {
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
    adapters: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.adapter])),
    config: {
      aliases: { fast: Object.keys(targets) },
      targets: Object.fromEntries(Object.keys(targets).map((name) => [name, { model: 'system' }])),
      retry,
      breaker: { failureThreshold: 1, openMs: 30_000 },
    },
  });
  const attemptSpansOf = async (name: string) => {
    await telemetry.forceFlush();
    return memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat' && span.attributes['momonga.target'] === name);
  };
  const failedSpansOf = async (name: string) => (await attemptSpansOf(name)).filter((span) => span.status.code === ERROR_STATUS);
  return { harness, attemptSpansOf, failedSpansOf };
};

const send = async (harness: Harness, path: string, body: Record<string, unknown>) => {
  let settled = false;
  const pending = postJson(harness.client, path, body).finally(() => {
    settled = true;
  });
  while (!settled) {
    await waitFor(() => settled || harness.timers.pending().length > 0, { description: 'the retry wait or the answer' });
    if (settled) break;
    harness.timers.advance(harness.timers.pending()[0]?.delayMs ?? 0);
  }
  return readJson(await pending);
};

const failureOf = (response: { status: number; body: any }) => ({
  status: response.status,
  code: response.body.error?.code,
  param: response.body.error?.param,
  message: response.body.error?.message,
});

const breakerOf = async (harness: Harness, name: string) => (await getJson(harness.client, '/v1/momonga/health')).body.targets[name].breaker;

const COMPACT_PATH = '/v1/responses/compact';
const CREATE_PATH = '/v1/responses';
const COUNT_PATH = '/v1/momonga/count_tokens';
const compactBody = { model: 'fast', input: userInput('summarise this'), momonga: { max_summary_tokens: CAP } };
const toolsBody = { model: 'fast', input: userInput('please read a'), tools: [readFileTool] };

const causeOfRetryableFailure = async () => {
  const a = await targetOf([restarting]);
  const b = await targetOf([fulfil(CC_CAPABILITIES)]);
  const { harness } = await tracedGatewayOf({ a, b });
  const response = await send(harness, CREATE_PATH, { model: 'fast', input: userInput('hi') });
  expect(response.status).toBe(200);
  const [cause] = response.body.momonga.fallbackCauses;
  expect(cause.target).toBe('a');
  return cause;
};

describe('a refusal undoes only its own send', () => {
  it('[a] compact: a real failure then a summary-cap refusal keeps the failure and answers invalid_summary_cap', async () => {
    const a = await targetOf([restarting, restarting, fulfil(SMALL_CAP)]);
    const { harness, failedSpansOf } = await tracedGatewayOf({ a }, RETRYING);
    const response = await send(harness, COMPACT_PATH, compactBody);
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('invalid_summary_cap');
    expect(a.resolver.calls).toBe(3);
    expect(await failedSpansOf('a')).toHaveLength(1);
    expect(await breakerOf(harness, 'a')).toBe('open');
  });

  it('[a, b] compact: b serves, a keeps its failure record and is not a fallback', async () => {
    const expectedCause = await causeOfRetryableFailure();
    const a = await targetOf([restarting, restarting, fulfil(SMALL_CAP)]);
    const b = await targetOf([fulfil(CC_CAPABILITIES)]);
    const { harness, failedSpansOf } = await tracedGatewayOf({ a, b }, RETRYING);
    const response = await send(harness, COMPACT_PATH, compactBody);
    expect(response.status).toBe(200);
    expect(response.body.momonga?.fallbackFrom ?? []).not.toContain('a');
    expect(a.resolver.calls).toBe(3);
    expect(await failedSpansOf('a')).toHaveLength(1);
    expect(await breakerOf(harness, 'a')).toBe('open');
    const followUp = await send(harness, CREATE_PATH, { model: 'fast', input: userInput('hi') });
    expect(followUp.status).toBe(200);
    expect(followUp.body.momonga.target).toBe('b');
    expect(followUp.body.momonga.fallbackCauses).toEqual([expectedCause]);
  });

  it('[a] create with tools: a real failure then a tool-calling refusal keeps the failure and answers as narrowing does', async () => {
    const reference = await tracedGatewayOf({ a: await targetOf([fulfil(BLIND)]) });
    const expected = failureOf(await send(reference.harness, CREATE_PATH, toolsBody));
    expect(expected.code).toBe('capability_unsupported');

    const a = await targetOf([restarting, restarting, fulfil(BLIND)]);
    const { harness, failedSpansOf } = await tracedGatewayOf({ a }, RETRYING);
    expect(failureOf(await send(harness, CREATE_PATH, toolsBody))).toEqual(expected);
    expect(a.resolver.calls).toBe(3);
    expect(a.fake.requests).toHaveLength(0);
    expect(await failedSpansOf('a')).toHaveLength(1);
    expect(await breakerOf(harness, 'a')).toBe('open');
  });
});

describe('a needsProbe target first resolved in an attempt fails the request with 412', () => {
  it('[a, b] create with tools answers the 412 narrowing gives, and b is never called', async () => {
    const reference = await tracedGatewayOf({ a: await targetOf([fulfil(UNPROBED)]), b: await targetOf([fulfil(CC_CAPABILITIES)]) });
    const expected = failureOf(await send(reference.harness, CREATE_PATH, toolsBody));
    expect(expected.status).toBe(412);
    expect(expected.code).toBe('precondition_failed');

    const a = await targetOf([restarting, fulfil(UNPROBED)]);
    const b = await targetOf([fulfil(CC_CAPABILITIES)]);
    const { harness, failedSpansOf } = await tracedGatewayOf({ a, b });
    const response = await send(harness, CREATE_PATH, toolsBody);
    expect(failureOf(response)).toEqual(expected);
    expect(response.body.momonga?.fallbackFrom ?? []).not.toContain('a');
    expect(b.fake.requests).toHaveLength(0);
    expect(a.fake.requests).toHaveLength(0);
    expect(await failedSpansOf('a')).toHaveLength(0);
  });
});

describe("narrowing's refusals carry into the attempt loop", () => {
  const sampledImage = { model: 'fast', input: imageInput, temperature: 0.5 };
  const sampled = { model: 'fast', input: userInput('hi'), temperature: 0.5 };

  it('[A, B] A refused at sampling up front and B refused at images late answer as both refused up front', async () => {
    const reference = await tracedGatewayOf({ A: await targetOf([fulfil(SEEING_NO_SAMPLING)]), B: await targetOf([fulfil(CC_CAPABILITIES)]) });
    const expected = failureOf(await send(reference.harness, CREATE_PATH, sampledImage));
    expect(expected.code).toBe('sampling_not_accepted');

    const A = await targetOf([fulfil(SEEING_NO_SAMPLING)]);
    const B = await targetOf([restarting, fulfil(CC_CAPABILITIES)]);
    const { harness } = await tracedGatewayOf({ A, B });
    expect(failureOf(await send(harness, CREATE_PATH, sampledImage))).toEqual(expected);
    expect(B.resolver.calls).toBe(2);
    expect(A.fake.requests).toHaveLength(0);
    expect(B.fake.requests).toHaveLength(0);
  });

  it('[A, B] both refused at sampling, one up front and one late, name both as narrowing joins them', async () => {
    const reference = await tracedGatewayOf({ A: await targetOf([fulfil(NO_SAMPLING)]), B: await targetOf([fulfil(NO_SAMPLING)]) });
    const expected = failureOf(await send(reference.harness, CREATE_PATH, sampled));
    expect(expected.code).toBe('sampling_not_accepted');
    expect(String(expected.message)).toContain('"A"');
    expect(String(expected.message)).toContain('"B"');

    const A = await targetOf([fulfil(NO_SAMPLING)]);
    const B = await targetOf([restarting, fulfil(NO_SAMPLING)]);
    const { harness } = await tracedGatewayOf({ A, B });
    expect(failureOf(await send(harness, CREATE_PATH, sampled))).toEqual(expected);
    expect(B.resolver.calls).toBe(2);
  });
});

describe('one failed attempt span per real failure, none per refusal, in compact', () => {
  const plainCompact = { model: 'fast', input: userInput('summarise this') };

  it('a counter failure while sizing produces exactly one failed attempt span', async () => {
    const a = await targetOf([fulfil(CC_CAPABILITIES)], (adapter) => adapter, {
      countTokens: async () => {
        throw refused('the counter cannot be reached')();
      },
    });
    const { harness, failedSpansOf } = await tracedGatewayOf({ a });
    const response = await send(harness, COMPACT_PATH, plainCompact);
    expect(response.status).not.toBe(200);
    expect(await failedSpansOf('a')).toHaveLength(1);
  });

  it('a render failure while sizing produces exactly one failed attempt span', async () => {
    const a = await targetOf([fulfil(CC_CAPABILITIES)], (adapter) => ({
      ...adapter,
      renderCompactWire: () => {
        throw new Error('the compact wire cannot be rendered');
      },
    }));
    const { harness, failedSpansOf } = await tracedGatewayOf({ a });
    const response = await send(harness, COMPACT_PATH, plainCompact);
    expect(response.status).not.toBe(200);
    expect(await failedSpansOf('a')).toHaveLength(1);
  });

  it('a summary-cap refusal produces no attempt span', async () => {
    const a = await targetOf([fulfil(SMALL_CAP)]);
    const { harness, attemptSpansOf } = await tracedGatewayOf({ a });
    const response = await send(harness, COMPACT_PATH, compactBody);
    expect(response.body.error?.code).toBe('invalid_summary_cap');
    expect(await attemptSpansOf('a')).toHaveLength(0);
  });

  it('an input-size refusal produces no attempt span', async () => {
    const a = await targetOf([fulfil(CC_CAPABILITIES)], (adapter) => adapter, { countTokens: async () => estimatedCountOf(1_000_000) });
    const { harness, attemptSpansOf } = await tracedGatewayOf({ a });
    const response = await send(harness, COMPACT_PATH, plainCompact);
    expect(response.body.error?.code).toBe('compaction_input_too_large');
    expect(await attemptSpansOf('a')).toHaveLength(0);
  });
});

describe('the admission predicate decides the summary cap and allowed_tools', () => {
  it('[a, b] compact with an image: a whose cap is too small is dropped at narrowing and b serves', async () => {
    const a = await targetOf([fulfil(SEEING_SMALL_CAP)]);
    const b = await targetOf([fulfil(SEEING)]);
    const { harness, attemptSpansOf } = await tracedGatewayOf({ a, b });
    const response = await send(harness, COMPACT_PATH, { model: 'fast', input: imageInput, momonga: { max_summary_tokens: CAP } });
    expect(response.status).toBe(200);
    expect(response.body.momonga?.fallbackFrom ?? []).not.toContain('a');
    expect(a.fake.requests).toHaveLength(0);
    expect(await attemptSpansOf('a')).toHaveLength(0);
    expect(await breakerOf(harness, 'a')).toBe('closed');
  });

  const toolNamed = (name: string) => ({ type: 'function' as const, name, parameters: { type: 'object', properties: {}, additionalProperties: false } });
  const allowedBody = {
    model: 'fast',
    input: userInput('hi'),
    tools: [toolNamed('alpha'), toolNamed('beta'), toolNamed('gamma')],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'alpha' }, { type: 'function', name: 'beta' }] },
  };

  it.for([CREATE_PATH, COUNT_PATH])('[x, y] %s with allowed_tools: x that cannot carry the form is dropped and y serves', async (path) => {
    const x = await targetOf([fulfil(CC_CAPABILITIES)]);
    const y = await targetOf([fulfil(ALLOWED_NATIVE)]);
    const { harness, attemptSpansOf } = await tracedGatewayOf({ x, y });
    const response = await send(harness, path, allowedBody);
    expect(response.body.error ?? null).toBeNull();
    expect(response.status).toBe(200);
    if (path === CREATE_PATH) {
      expect(response.body.momonga.target).toBe('y');
      expect(response.body.momonga.fallbackFrom ?? []).not.toContain('x');
    }
    expect(x.fake.requests).toHaveLength(0);
    expect(await attemptSpansOf('x')).toHaveLength(0);
    expect(await breakerOf(harness, 'x')).toBe('closed');
  });

  it.for([CREATE_PATH, COUNT_PATH])('[x] %s with allowed_tools x cannot carry answers 400 unsupported_tool_choice', async (path) => {
    const x = await targetOf([fulfil(CC_CAPABILITIES)]);
    const { harness } = await tracedGatewayOf({ x });
    const response = await send(harness, path, allowedBody);
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('unsupported_tool_choice');
    expect(response.body.error?.param).toBe('tool_choice');
    expect(x.fake.requests).toHaveLength(0);
  });
});
