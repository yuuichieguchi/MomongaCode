import { describe, expect, it } from 'vitest';
import type { ChatCompletionsAdapter } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { getJson, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

const FIRST_FAILURE = 'the first target cannot be reached';
const SECOND_FAILURE = 'the second target cannot be reached';

const OPERATIONS = [
  { name: 'create without tools', path: '/v1/responses', body: { model: 'fast', input: userInput('hi') } },
  { name: 'create with tools', path: '/v1/responses', body: { model: 'fast', input: userInput('please read a'), tools: [readFileTool] } },
  { name: 'count_tokens', path: '/v1/momonga/count_tokens', body: { model: 'fast', input: userInput('please read a'), tools: [readFileTool] } },
  { name: 'compact', path: '/v1/responses/compact', body: { model: 'fast', input: userInput('summarise this') } },
];

const CREATES = OPERATIONS.filter((operation) => operation.path === '/v1/responses');

const okTarget = async (): Promise<{ fake: FakeChatCompletionsServer; adapter: ChatCompletionsAdapter }> => {
  const fake = await startFake({ scenario: 'tools-ok', script: [textReply('from ok'), textReply('from ok')] });
  return { fake, adapter: makeAdapter(fake) };
};

type Failure = (message: string) => Error;

const plainError: Failure = (message) => new Error(message);
const refusedConnection: Failure = (message) => Object.assign(new Error(message), { code: 'ECONNREFUSED' });

const rejectingTarget = async (message: string, failure: Failure = plainError): Promise<ChatCompletionsAdapter> => {
  const fake = await startFake({ scenario: 'tools-ok', script: [] });
  return makeAdapter(fake, {
    capabilities: async () => {
      throw failure(message);
    },
  });
};

const unreachableTarget = async (message: string, failure: Failure = plainError): Promise<ChatCompletionsAdapter> => {
  const fake = await startFake({ scenario: 'tools-ok', script: [] });
  return makeAdapter(fake, {
    resolveEndpoint: async () => {
      throw failure(message);
    },
  });
};

const gatewayOf = (adapters: Record<string, ChatCompletionsAdapter>, order: string[]) =>
  startGateway({
    adapters,
    config: {
      aliases: { fast: order },
      targets: Object.fromEntries(order.map((name) => [name, { model: 'system' }])),
      retry: { maxAttempts: 1, totalWaitMs: 1 },
      breaker: { failureThreshold: 1, openMs: 30_000 },
    },
  });

const send = async (client: Awaited<ReturnType<typeof startGateway>>['client'], operation: (typeof OPERATIONS)[number]) =>
  readJson(await postJson(client, operation.path, operation.body));

const expectServedByOk = (operation: (typeof OPERATIONS)[number], response: { status: number; body: any }, okFake: FakeChatCompletionsServer) => {
  expect(response.body.error ?? null).toBeNull();
  expect(response.status).toBe(200);
  if (operation.path === '/v1/responses') {
    expect(response.body.status).toBe('completed');
    expect(response.body.momonga.target).toBe('ok');
  }
  if (operation.path === '/v1/responses/compact') expect(completionBodies(okFake)).toHaveLength(1);
};

const failureOf = (response: { status: number; body: any }) => ({ status: response.status, code: response.body.error?.code, message: response.body.error?.message });

const outcomeOf = (response: { status: number; body: any }) => ({
  ...failureOf(response),
  target: response.body.momonga?.target,
  fallbackFrom: response.body.momonga?.fallbackFrom,
});

describe('a candidate whose capabilities cannot be resolved is a failed attempt, not a failed request', () => {
  it.for(OPERATIONS)('[ok, rejecting] $name is served by ok', async (operation) => {
    const ok = await okTarget();
    const { client } = await gatewayOf({ ok: ok.adapter, rejecting: await rejectingTarget(SECOND_FAILURE) }, ['ok', 'rejecting']);
    expectServedByOk(operation, await send(client, operation), ok.fake);
  });

  it.for(OPERATIONS)('[rejecting, ok] with a plain Error: $name ends as the same error thrown inside the attempt does', async (operation) => {
    const reference = await okTarget();
    const referenceGateway = await gatewayOf({ rejecting: await unreachableTarget(FIRST_FAILURE), ok: reference.adapter }, ['rejecting', 'ok']);
    const expected = outcomeOf(await send(referenceGateway.client, operation));
    const referenceOkCalls = completionBodies(reference.fake).length;

    const ok = await okTarget();
    const { client } = await gatewayOf({ rejecting: await rejectingTarget(FIRST_FAILURE), ok: ok.adapter }, ['rejecting', 'ok']);
    expect(outcomeOf(await send(client, operation))).toEqual(expected);
    expect(completionBodies(ok.fake)).toHaveLength(referenceOkCalls);
  });

  it.for(OPERATIONS)('[rejecting, ok] with a retryable rejection: $name falls back to ok', async (operation) => {
    const ok = await okTarget();
    const { client } = await gatewayOf({ rejecting: await rejectingTarget(FIRST_FAILURE, refusedConnection), ok: ok.adapter }, ['rejecting', 'ok']);
    expectServedByOk(operation, await send(client, operation), ok.fake);
  });

  it.for(OPERATIONS.filter((operation) => operation.path !== '/v1/momonga/count_tokens'))(
    '[rejecting, ok] with a retryable rejection: $name records the fallback and the breaker as a retryable attempt failure does',
    async (operation) => {
      const reference = await okTarget();
      const referenceGateway = await gatewayOf({ rejecting: await unreachableTarget(FIRST_FAILURE, refusedConnection), ok: reference.adapter }, ['rejecting', 'ok']);
      const expected = await send(referenceGateway.client, operation);
      const expectedHealth = await getJson(referenceGateway.client, '/v1/momonga/health');
      expect(expected.status).toBe(200);

      const ok = await okTarget();
      const { client } = await gatewayOf({ rejecting: await rejectingTarget(FIRST_FAILURE, refusedConnection), ok: ok.adapter }, ['rejecting', 'ok']);
      const response = await send(client, operation);
      expect(response.status).toBe(200);
      if (operation.path === '/v1/responses') expect(response.body.momonga?.fallbackFrom).toEqual(['rejecting']);
      expect(response.body.momonga?.fallbackFrom).toEqual(expected.body.momonga?.fallbackFrom);
      expect(response.body.momonga?.fallbackCauses).toEqual(expected.body.momonga?.fallbackCauses);
      const health = await getJson(client, '/v1/momonga/health');
      expect(health.body.targets.rejecting.breaker).toBe(expectedHealth.body.targets.rejecting.breaker);
      expect(health.body.targets.ok.breaker).toBe(expectedHealth.body.targets.ok.breaker);
    },
  );

  it.for(OPERATIONS)('[rejecting, rejecting] $name fails with the failure of the first target', async (operation) => {
    const { client } = await gatewayOf({ first: await rejectingTarget(FIRST_FAILURE), second: await rejectingTarget(SECOND_FAILURE) }, ['first', 'second']);
    const response = await send(client, operation);
    expect(response.status).not.toBe(200);
    expect(String(response.body.error?.message)).toContain(FIRST_FAILURE);
    expect(String(response.body.error?.message)).not.toContain(SECOND_FAILURE);
  });

  it.for(CREATES)('[rejecting, rejecting] $name fails as two failed attempts do', async (operation) => {
    const referenceGateway = await gatewayOf({ first: await unreachableTarget(FIRST_FAILURE), second: await unreachableTarget(SECOND_FAILURE) }, ['first', 'second']);
    const reference = failureOf(await send(referenceGateway.client, operation));
    expect(reference.status).not.toBe(200);

    const { client } = await gatewayOf({ first: await rejectingTarget(FIRST_FAILURE), second: await rejectingTarget(SECOND_FAILURE) }, ['first', 'second']);
    expect(failureOf(await send(client, operation))).toEqual(reference);
  });
});

describe('a request without tools, images or sampling resolves capabilities sparingly', () => {
  it('resolves the target it tries once and the untried target at most once', async () => {
    const counts = { tried: 0, untried: 0 };
    const counted = (name: keyof typeof counts): (() => Promise<Capabilities>) => async () => {
      counts[name] += 1;
      return CC_CAPABILITIES;
    };
    const triedFake = await startFake({ scenario: 'tools-ok', script: [textReply('from tried')] });
    const untriedFake = await startFake({ scenario: 'tools-ok', script: [] });
    const { client } = await startGateway({
      adapters: { tried: makeAdapter(triedFake, { capabilities: counted('tried') }), untried: makeAdapter(untriedFake, { capabilities: counted('untried') }) },
      config: { aliases: { fast: ['tried', 'untried'] }, targets: { tried: { model: 'system' }, untried: { model: 'system' } } },
    });
    const before = { ...counts };
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(response.body.momonga.target).toBe('tried');
    expect(counts.tried - before.tried).toBe(1);
    expect(counts.untried - before.untried).toBeLessThanOrEqual(1);
  });
});
