import { describe, expect, it } from 'vitest';
import type { ChatCompletionsAdapter } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter } from '../src/core/router.ts';
import { HMAC_KEY, START_MS, buildConfig, clientOfModel, getJson, postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

type Harness = Awaited<ReturnType<typeof gatewayOf>>;
type Operation = { name: string; path: string; body: Record<string, unknown> };
type Outcome = { kind: 'reject'; error: () => Error } | { kind: 'fulfil'; capabilities: Capabilities };

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SEEING: Capabilities = { ...CC_CAPABILITIES, imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } };
const BLIND: Capabilities = { ...CC_CAPABILITIES, toolCalling: 'none' };

const imageInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG }] }];

const CREATE: Operation = { name: 'create', path: '/v1/responses', body: { input: userInput('hi') } };
const CREATE_STREAMING: Operation = { name: 'create streaming', path: '/v1/responses', body: { stream: true, input: userInput('hi') } };
const CREATE_WITH_TOOLS: Operation = { name: 'create with tools', path: '/v1/responses', body: { input: userInput('please read a'), tools: [readFileTool] } };
const COUNT: Operation = { name: 'count_tokens', path: '/v1/momonga/count_tokens', body: { input: userInput('please read a'), tools: [readFileTool] } };
const COMPACT: Operation = { name: 'compact', path: '/v1/responses/compact', body: { input: userInput('summarise this') } };

const refused = (message: string) => (): Error => Object.assign(new Error(message), { code: 'ECONNREFUSED' });
const plain = (message: string) => (): Error => new Error(message);
const reject = (error: () => Error): Outcome => ({ kind: 'reject', error });
const fulfil = (capabilities: Capabilities): Outcome => ({ kind: 'fulfil', capabilities });

const resolverOf = (outcomes: readonly Outcome[]) => {
  const state = { calls: 0 };
  const resolve = async (): Promise<Capabilities> => {
    const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)];
    state.calls += 1;
    if (outcome === undefined) throw new Error('the resolver has no outcome');
    if (outcome.kind === 'reject') throw outcome.error();
    return outcome.capabilities;
  };
  return { state, resolve };
};

type Target = { fake: FakeChatCompletionsServer; adapter: ChatCompletionsAdapter; resolver: ReturnType<typeof resolverOf> };

const targetOf = async (outcomes: readonly Outcome[], replies = 2): Promise<Target> => {
  const fake = await startFake({ scenario: 'tools-ok', imageInput: true, script: Array.from({ length: replies }, () => textReply('served')) });
  const resolver = resolverOf(outcomes);
  return { fake, adapter: makeAdapter(fake, { capabilities: resolver.resolve }), resolver };
};

const RETRYING = { maxAttempts: 2, baseMs: 100, maxMs: 100, totalWaitMs: 500 };
const ONCE = { maxAttempts: 1, totalWaitMs: 1 };

const canonOf = (server: string): string => `${server}/system`;

const gatewayOf = async (targets: Record<string, Target>, retry: Record<string, number> = ONCE) => {
  const model = canonOf(Object.keys(targets)[0] as string);
  const harness = await startGateway({
    adapters: Object.fromEntries(Object.entries(targets).map(([name, target]) => [canonOf(name), target.adapter])),
    config: {
      chains: { [model]: Object.keys(targets).map(canonOf) },
      targets: Object.fromEntries(Object.keys(targets).map((name) => [canonOf(name), {}])),
      retry,
      breaker: { failureThreshold: 1, openMs: 30_000 },
    },
  });
  return { ...harness, client: clientOfModel(harness.client, model) };
};

const sendDriven = async (harness: Harness, operation: Operation) => {
  let settled = false;
  const pending = postJson(harness.client, operation.path, { ...operation.body, model: harness.client.model }).finally(() => {
    settled = true;
  });
  while (!settled) {
    await waitFor(() => settled || harness.timers.pending().length > 0, { description: 'the retry wait or the answer' });
    if (settled) break;
    harness.timers.advance(harness.timers.pending()[0]?.delayMs ?? 0);
  }
  const response = await pending;
  if (operation.body['stream'] === true) {
    const frames = await readSse(response);
    return { status: response.status, body: frames.at(-1)?.data?.response ?? {} };
  }
  return readJson(response);
};

const failureOf = (response: { status: number; body: any }) => ({ status: response.status, code: response.body.error?.code, param: response.body.error?.param });

const outcomeOf = (response: { status: number; body: any }) => ({
  status: response.status,
  code: response.body.error?.code,
  target: response.body.momonga?.target,
  fallbackFrom: response.body.momonga?.fallbackFrom,
  fallbackCauses: response.body.momonga?.fallbackCauses,
});

const isCreate = (operation: Operation) => operation.path === '/v1/responses';

describe('a retryable capabilities rejection gets a real retry on the same target', () => {
  it.for([CREATE_STREAMING, CREATE, CREATE_WITH_TOOLS, COUNT, COMPACT])('$name on a single-candidate alias resolves again and is served', async (operation) => {
    const only = await targetOf([reject(refused('the target is restarting')), fulfil(CC_CAPABILITIES)]);
    const harness = await gatewayOf({ only }, RETRYING);
    const response = await sendDriven(harness, operation);
    expect(response.body.error ?? null).toBeNull();
    expect(response.status).toBe(200);
    if (isCreate(operation)) {
      expect(response.body.status).toBe('completed');
      expect(response.body.momonga.target).toBe(canonOf('only'));
    }
    expect(only.resolver.state.calls).toBe(2);
    expect(completionBodies(only.fake)).toHaveLength(operation === COUNT ? 0 : 1);
  });
});

describe('a non-retryable capabilities rejection ends the attempt without a retry', () => {
  it.for([CREATE_STREAMING, CREATE, COUNT, COMPACT])('$name on a single-candidate alias ends 502 adapter_error after one resolution', async (operation) => {
    const only = await targetOf([reject(plain('the declaration is broken')), fulfil(CC_CAPABILITIES)]);
    const harness = await gatewayOf({ only }, RETRYING);
    const response = await readJson(await postJson(harness.client, operation.path, { ...operation.body, model: harness.client.model }));
    expect(response.status).toBe(502);
    expect(response.body.error?.code).toBe('adapter_error');
    expect(only.resolver.state.calls).toBe(1);
    expect(completionBodies(only.fake)).toHaveLength(0);
  });
});

describe('a fulfilled capabilities resolution is read by every later use in the request', () => {
  const imageCreate: Operation = { name: 'create with tools and an image', path: '/v1/responses', body: { input: imageInput, tools: [readFileTool] } };
  const imageCount: Operation = { name: 'count_tokens with an image', path: '/v1/momonga/count_tokens', body: { input: imageInput, tools: [readFileTool] } };
  const imageCompact: Operation = { name: 'compact with an image', path: '/v1/responses/compact', body: { input: imageInput } };

  it.for([CREATE_STREAMING, CREATE_WITH_TOOLS, COUNT, COMPACT, imageCreate, imageCount, imageCompact])('$name resolves the served target once', async (operation) => {
    const only = await targetOf([fulfil(SEEING)]);
    const harness = await gatewayOf({ only });
    const response = await sendDriven(harness, operation);
    expect(response.status).toBe(200);
    expect(only.resolver.state.calls).toBe(1);
  });
});

describe('a candidate first resolved inside an attempt is admitted by the narrowing predicate', () => {
  const lateCases: { operation: Operation; refusing: Capabilities; serving: Capabilities }[] = [
    { operation: CREATE_WITH_TOOLS, refusing: BLIND, serving: CC_CAPABILITIES },
    { operation: { ...CREATE_WITH_TOOLS, name: 'create streaming with tools', body: { ...CREATE_WITH_TOOLS.body, stream: true } }, refusing: BLIND, serving: CC_CAPABILITIES },
    { operation: { name: 'count_tokens with an image', path: '/v1/momonga/count_tokens', body: { input: imageInput } }, refusing: CC_CAPABILITIES, serving: SEEING },
    { operation: { name: 'compact with an image', path: '/v1/responses/compact', body: { input: imageInput } }, refusing: CC_CAPABILITIES, serving: SEEING },
  ];

  it.for(lateCases)('[a, b] $operation.name: a refused late is dropped as narrowing drops it and b serves', async ({ operation, refusing, serving }) => {
    const referenceA = await targetOf([fulfil(refusing)]);
    const referenceB = await targetOf([fulfil(serving)]);
    const reference = await gatewayOf({ a: referenceA, b: referenceB }, RETRYING);
    const expected = await sendDriven(reference, operation);
    const expectedHealth = await getJson(reference.client, '/v1/momonga/health');
    expect(expected.status).toBe(200);
    expect(outcomeOf(expected).fallbackFrom).toBeUndefined();

    const a = await targetOf([reject(refused('a is restarting')), fulfil(refusing)]);
    const b = await targetOf([fulfil(serving)]);
    const harness = await gatewayOf({ a, b }, RETRYING);
    const response = await sendDriven(harness, operation);
    expect(outcomeOf(response)).toEqual(outcomeOf(expected));
    if (isCreate(operation)) expect(response.body.momonga.target).toBe(canonOf('b'));
    expect(a.fake.requests).toHaveLength(0);
    expect(a.resolver.state.calls).toBe(2);
    const health = await getJson(harness.client, '/v1/momonga/health');
    expect(health.body.models[canonOf('a')].breaker).toBe(expectedHealth.body.models[canonOf('a')].breaker);
    expect(health.body.models[canonOf('a')].lastFailure ?? null).toEqual(expectedHealth.body.models[canonOf('a')].lastFailure ?? null);
  });

  it.for(lateCases)('[a] $operation.name: a refused late fails as narrowing refuses it', async ({ operation, refusing }) => {
    const reference = await gatewayOf({ a: await targetOf([fulfil(refusing)]) }, RETRYING);
    const expected = failureOf(await readJson(await postJson(reference.client, operation.path, { ...operation.body, model: reference.client.model })));
    expect(expected.status).toBe(400);
    expect(expected.code).toBe('capability_unsupported');

    const a = await targetOf([reject(refused('a is restarting')), fulfil(refusing)]);
    const harness = await gatewayOf({ a }, RETRYING);
    let settled = false;
    const pending = postJson(harness.client, operation.path, { ...operation.body, model: harness.client.model }).finally(() => {
      settled = true;
    });
    while (!settled) {
      await waitFor(() => settled || harness.timers.pending().length > 0, { description: 'the retry wait or the answer' });
      if (settled) break;
      harness.timers.advance(harness.timers.pending()[0]?.delayMs ?? 0);
    }
    expect(failureOf(await readJson(await pending))).toEqual(expected);
    expect(a.fake.requests).toHaveLength(0);
  });
});

describe('the per-request memo shares an in-flight resolution and forgets a rejected one', () => {
  it('two uses share the in-flight resolution, and a use after it rejects resolves again', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    let calls = 0;
    let rejectFirst: (error: Error) => void = () => undefined;
    const capabilities = (): Promise<Capabilities> => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Capabilities>((_, rejectWith) => {
          rejectFirst = rejectWith;
        });
      }
      return Promise.resolve(CC_CAPABILITIES);
    };
    const router = createRouter({
      config: buildConfig({ chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } }),
      adapters: { 'scripted/system': makeAdapter(fake, { capabilities }) },
      clock,
      timers,
      redactor: createRedactor({ credentials: [] }),
      reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
    });
    const narrowed = await router.narrow('scripted/system', router.chainOf('scripted/system'), {});
    const [target] = narrowed.targets;
    if (target === undefined) throw new Error('narrowing dropped the only target');
    const first = narrowed.capabilitiesOf(target);
    await waitFor(() => calls > 0, { description: 'the first resolution started' });
    const second = narrowed.capabilitiesOf(target);
    await Promise.resolve();
    expect(calls).toBe(1);
    rejectFirst(Object.assign(new Error('restarting'), { code: 'ECONNREFUSED' }));
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await expect(narrowed.capabilitiesOf(target)).resolves.toEqual(CC_CAPABILITIES);
    expect(calls).toBe(2);
  });
});
