import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { createGateway } from '../src/index.ts';
import { createRouter } from '../src/core/router.ts';
import type { GatewayEpoch } from '../src/core/services.ts';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { remedyOf } from '../src/probe/remedy.ts';
import { HMAC_KEY, START_MS, TEST_VERSION, buildConfig, counterForTest, getJson, makeDir, postJson, readJson, registerCleanup, startGateway, userInput, stateDbPath } from './gateway-helpers.ts';
import type { ConfigOverrides } from './gateway-helpers.ts';
import path from 'node:path';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { createUdsClient, fixedRolePort, fixedSocket } from '@momonga/foundation';

const DEVSTRAL = 'ollama/devstral-small-2:latest';
const QWEN = 'ollama/qwen3.8:27b';
const OLLAMA_GEMMA = 'ollama/gemma-3-4b:latest';
const LMSTUDIO_GEMMA = 'lmstudio/gemma-3-4b';
const CHATGPT = 'chatgpt/gpt-5.5';
const OPENAI = 'openai/gpt-5.5';

const S1: ConfigOverrides = { targets: { [DEVSTRAL]: { defaultTag: 'latest' }, [QWEN]: { defaultTag: 'latest' } } };
const S2: ConfigOverrides = { targets: { [OLLAMA_GEMMA]: { defaultTag: 'latest' }, [LMSTUDIO_GEMMA]: {} } };
const S3: ConfigOverrides = {
  targets: { [CHATGPT]: { billing: 'plan' }, [OPENAI]: { billing: 'metered' } },
  chains: { [CHATGPT]: [CHATGPT, OPENAI], [OPENAI]: [OPENAI] },
  billingChanges: [{ from: 'plan', to: 'metered' }],
  start: CHATGPT,
};

const answering = (text = 'ok', calls = 8): ScriptedAdapter =>
  createScriptedAdapter({ calls: Array.from({ length: calls }, () => ({ events: textResponseEvents({ model: 'upstream', chunks: [text] }) })) });

const adaptersFor = (config: ConfigOverrides): Record<string, ScriptedAdapter> => Object.fromEntries(Object.keys(config.targets ?? {}).map((canon) => [canon, answering()]));

const gatewayOf = async (config: ConfigOverrides, adapters: Record<string, ScriptedAdapter> = adaptersFor(config)) => ({ ...(await startGateway({ adapters, config })), adapters });

const create = async (client: Parameters<typeof postJson>[0], model: string, extra: Record<string, unknown> = {}) =>
  readJson(await postJson(client, '/v1/responses', { model, input: userInput('hi'), ...extra }));

const routerOf = (config: ConfigOverrides, previous?: ReturnType<typeof createRouter>) => {
  const clock = createFakeClock(START_MS);
  const built = buildConfig(config);
  return createRouter({
    config: built,
    adapters: Object.fromEntries(Object.keys(built.models.targets).map((canon) => [canon, answering()])),
    clock,
    timers: createFakeTimers(clock),
    redactor: createRedactor({ credentials: [] }),
    reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
    ...(previous === undefined ? {} : { previous }),
  });
};

describe('the model of a request is typed text, resolved once by the leased router (design-model-names 4.11)', () => {
  it('serves every typed form of a model: short, own name, server/short and the full reference', async () => {
    const { client } = await gatewayOf(S1);
    for (const text of ['devstral-small-2', 'devstral-small-2:latest', 'ollama/devstral-small-2', DEVSTRAL]) {
      const response = await create(client, text);
      expect(response.status).toBe(200);
      expect(response.body.momonga.model).toBe(DEVSTRAL);
    }
  });

  it('answers 400 ambiguous_model for a name two servers hold and 404 model_not_found for a name none holds', async () => {
    const { client } = await gatewayOf(S2);
    const ambiguous = await create(client, 'gemma-3-4b');
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toEqual({
      type: 'invalid_request',
      code: 'ambiguous_model',
      param: 'model',
      message: 'The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.',
    });
    const unknown = await create(client, 'nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toEqual({
      type: 'not_found',
      code: 'model_not_found',
      param: 'model',
      message: 'The model "nope" is not configured. Configured models: ollama/gemma-3-4b, lmstudio/gemma-3-4b.',
    });
  });

  it('resolves only a full reference when momonga.exact_model is true', async () => {
    const { client } = await gatewayOf(S2);
    const exact = { momonga: { exact_model: true } };
    expect((await create(client, 'ollama/gemma-3-4b', exact)).status).toBe(404);
    expect((await create(client, 'ollama/gemma-3-4b')).body.momonga.model).toBe(OLLAMA_GEMMA);
    expect((await create(client, OLLAMA_GEMMA, exact)).body.momonga.model).toBe(OLLAMA_GEMMA);

    const renamed = await gatewayOf({ targets: { 'p1/p1/x': {} } });
    expect((await create(renamed.client, 'p1/x')).body.momonga.model).toBe('p1/p1/x');
    const stored = await create(renamed.client, 'p1/x', exact);
    expect(stored.status).toBe(404);
    expect(stored.body.error.code).toBe('model_not_found');
  });

  it('honours momonga.target for a member of the chain and refuses a model outside it', async () => {
    const { client } = await gatewayOf(S3);
    const count = async (target: string) => readJson(await postJson(client, '/v1/momonga/count_tokens', { model: CHATGPT, input: 'hi', momonga: { target } }));
    expect((await count(OPENAI)).status).toBe(200);
    const outside = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: OPENAI, input: 'hi', momonga: { target: CHATGPT } }));
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatchObject({ code: 'invalid_target', message: 'model "chatgpt/gpt-5.5" is not "openai/gpt-5.5" or one of its fallback models' });
    const unknown = await count('nope/x');
    expect(unknown.body.error).toMatchObject({ code: 'invalid_target', message: 'model "nope/x" is not "chatgpt/gpt-5.5" or one of its fallback models' });
  });

  it('names the resolved model, the member that answered and the members that failed by their full references', async () => {
    const failing = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'plan is down' } }] });
    const { client } = await gatewayOf({ ...S3, retry: { maxAttempts: 1, totalWaitMs: 1 } }, { [CHATGPT]: failing, [OPENAI]: answering() });
    const response = await create(client, 'chatgpt/gpt-5.5');
    expect(response.status).toBe(200);
    expect(response.body.momonga).toMatchObject({ model: CHATGPT, target: OPENAI, counter: counterForTest(OPENAI), fallbackFrom: [CHATGPT] });
    expect(response.body.momonga.fallbackCauses).toMatchObject([{ target: CHATGPT, name: 'chatgpt/gpt-5.5', fromBilling: 'plan', toBilling: 'metered' }]);
    expect(response.body.momonga).not.toHaveProperty('alias');
  });

  it('lists one entry per configured model with its chain, the start model and the roles; no model lists nothing', async () => {
    const { client } = await gatewayOf({ ...S3, roles: { compaction: OPENAI } });
    const listing = (await getJson(client, '/v1/momonga/models')).body;
    expect(listing.data.map((entry: { id: string }) => entry.id)).toEqual([CHATGPT, OPENAI]);
    expect(listing.data.map((entry: { chain: Array<{ model: string }> }) => entry.chain.map((member) => member.model))).toEqual([[CHATGPT, OPENAI], [OPENAI]]);
    expect(listing.data[0]).toMatchObject({ provider: 'chatgpt', ownName: 'gpt-5.5', billing: 'plan' });
    expect(listing.data[0].chain[1]).toMatchObject({ model: OPENAI, counter: counterForTest(OPENAI), billing: 'metered', adapter: 'scripted', answers: 'model', upstream: 'gpt-5.5' });
    expect(listing.start).toBe(CHATGPT);
    expect(listing.roles).toEqual({ compaction: OPENAI });

    const empty = await startGateway({ adapters: {}, config: { targets: {} } });
    expect((await getJson(empty.client, '/v1/momonga/models')).body).toEqual({ object: 'list', data: [], start: null, roles: {} });
  });

  it('allows a billing step only for a matching entry whose scope is the first model of the chain (I-N10)', () => {
    const scoped = routerOf({ ...S3, billingChanges: [{ from: 'plan', to: 'metered', model: CHATGPT }] });
    expect(scoped.billingWalkOf(CHATGPT).initial).toBe('plan');
    expect(scoped.billingWalkOf(CHATGPT).allows('plan', 'metered')).toBe(true);
    expect(scoped.billingWalkOf(CHATGPT).allows('metered', 'plan')).toBe(false);
    expect(scoped.billingWalkOf(OPENAI).allows('plan', 'metered')).toBe(false);
    expect(scoped.billingWalkOf(OPENAI).initial).toBe('metered');
    expect(routerOf(S3).billingWalkOf(OPENAI).allows('plan', 'metered')).toBe(true);
    expect(routerOf({ ...S3, billingChanges: [] }).billingWalkOf(CHATGPT).allows('plan', 'metered')).toBe(false);
  });

  it('carries breaker and gate by full reference and equal counter, whatever the order, the start model or the fallback (I-N7)', () => {
    const before = routerOf(S3);
    const reordered = routerOf({ ...S3, targets: { [OPENAI]: { billing: 'metered' }, [CHATGPT]: { billing: 'plan' } }, start: OPENAI, chains: { [OPENAI]: [OPENAI, CHATGPT], [CHATGPT]: [CHATGPT] } }, before);
    for (const canon of [CHATGPT, OPENAI]) {
      expect(reordered.target(canon)?.breaker).toBe(before.target(canon)?.breaker);
      expect(reordered.target(canon)?.gate).toBe(before.target(canon)?.gate);
    }
    const changed = routerOf({ ...S3, targets: { [CHATGPT]: { billing: 'plan', counter: counterForTest('another definition') }, [OPENAI]: { billing: 'metered' } } }, before);
    expect(changed.target(CHATGPT)?.breaker).not.toBe(before.target(CHATGPT)?.breaker);
    expect(changed.target(OPENAI)?.breaker).toBe(before.target(OPENAI)?.breaker);
    const renamed = routerOf({ targets: { 'chatgpt-2/gpt-5.5': { billing: 'plan', counter: counterForTest(CHATGPT) } } }, before);
    expect(renamed.target('chatgpt-2/gpt-5.5')?.breaker).not.toBe(before.target(CHATGPT)?.breaker);
  });

  it('builds a chain that names one model twice with that model once', () => {
    const router = routerOf({ ...S3, chains: { [CHATGPT]: [CHATGPT, OPENAI, OPENAI], [OPENAI]: [OPENAI] } });
    expect(router.chainOf(CHATGPT).map((target) => target.name)).toEqual([CHATGPT, OPENAI]);
  });

  it('refuses with the sentences that name the model and its fallback models, and remedies name what the user types', async () => {
    const plain = (capabilities: Record<string, unknown>): ScriptedAdapter => createScriptedAdapter({ calls: [], capabilities });
    const unsupported = await gatewayOf(S1, { [DEVSTRAL]: plain({ toolCalling: 'none', imageInput: false, outputBoundField: 'none' }), [QWEN]: answering() });
    const tools = await create(unsupported.client, 'devstral-small-2', { tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] });
    expect(tools.body.error.message).toBe('"devstral-small-2" and its fallback models do not support tool calling');
    const image = await create(unsupported.client, DEVSTRAL, { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] }] });
    expect(image.body.error.message).toBe('"devstral-small-2" and its fallback models do not support image input');
    const bound = await create(unsupported.client, DEVSTRAL, { max_output_tokens: 16 });
    expect(bound.body.error.message).toBe('"devstral-small-2" and its fallback models carry no output bound');
    const compact = await readJson(await postJson(unsupported.client, '/v1/responses/compact', { model: DEVSTRAL, input: userInput('hi') }));
    expect(compact.body.error.message).toBe('"devstral-small-2" and its fallback models do not support compaction');
    const unknownField = await create(unsupported.client, DEVSTRAL, { top_k: 4 });
    expect(unknownField.body.error.message).toBe('unknown request field top_k: neither it nor its fallback models relay a create request body upstream for model "devstral-small-2"');
    expect(remedyOf('devstral-small-2')).toBe('run `momonga gateway probe devstral-small-2`');
  });

  it('answers 400 invalid_exact_model for a momonga.exact_model that is not a boolean', async () => {
    const { client } = await gatewayOf(S1);
    const response = await create(client, DEVSTRAL, { momonga: { exact_model: 'yes' } });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ type: 'invalid_request', code: 'invalid_exact_model', message: 'momonga.exact_model must be a boolean' });
    const counted = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: DEVSTRAL, input: 'hi', momonga: { exact_model: 1 } }));
    expect(counted.body.error).toMatchObject({ code: 'invalid_exact_model' });
    const compacted = await readJson(await postJson(client, '/v1/responses/compact', { model: DEVSTRAL, input: userInput('hi'), momonga: { exact_model: null } }));
    expect(compacted.body.error).toMatchObject({ code: 'invalid_exact_model' });
  });

  it('lists full references on /v1/models, owned by their server, created at the start of the gateway', async () => {
    const { client, gateway } = await gatewayOf(S2);
    const created = Math.floor(Date.parse(gateway.startedAt) / 1000);
    expect((await getJson(client, '/v1/models')).body).toEqual({
      object: 'list',
      data: [
        { id: OLLAMA_GEMMA, object: 'model', created, owned_by: 'ollama' },
        { id: LMSTUDIO_GEMMA, object: 'model', created, owned_by: 'lmstudio' },
      ],
    });
  });

  it('keys the health of every model by its full reference under models', async () => {
    const { client } = await gatewayOf(S2);
    const health = (await getJson(client, '/v1/momonga/health')).body;
    expect(Object.keys(health.models)).toEqual([OLLAMA_GEMMA, LMSTUDIO_GEMMA]);
    expect(health).not.toHaveProperty('targets');
  });

  it('leases the router once for a request: a settings swap between resolution and retry changes neither the model nor the chain', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const shared = { redactor: createRedactor({ credentials: [] }), reasoningOrigin: createReasoningOriginCodec(HMAC_KEY) };
    const first = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'first is down' }, gate: { name: 'held', afterEvents: 0 } }] });
    const fallbackBefore = answering('from the chain of the lease');
    const fallbackAfter = answering('from the later settings');
    const epochOf = (fallback: string, adapter: ScriptedAdapter): GatewayEpoch => ({
      router: createRouter({
        config: buildConfig({ targets: { 'a/x': {}, [fallback]: {} }, chains: { 'a/x': ['a/x', fallback] }, retry: { maxAttempts: 1, totalWaitMs: 1 } }),
        adapters: { 'a/x': first, [fallback]: adapter },
        clock,
        timers,
        ...shared,
      }),
      priceTable: undefined,
      telemetry: undefined,
      planTargets: [],
    });
    const before = epochOf('b/x', fallbackBefore);
    const after = epochOf('c/x', fallbackAfter);
    let current = before;
    let leases = 0;
    const dir = makeDir();
    const socketPath = path.join(dir, 'gw.sock');
    const { retry, breaker, limits, idempotency, closeGraceMs, sseKeepAliveMs, detachedMaxMs, websocketConnectionMs } = buildConfig({ retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const gateway = await createGateway({
      limits: { retry, breaker, limits, idempotency, closeGraceMs, sseKeepAliveMs, detachedMaxMs, websocketConnectionMs },
      epochs: {
        acquire: async () => {
          leases += 1;
          return { value: current, release: () => undefined };
        },
        close: async () => undefined,
      },
      ...shared,
      credentials: [],
      clock,
      timers,
      random: () => 0.5,
      dbPath: stateDbPath(dir),
      hmacKey: HMAC_KEY,
      socketPath,
      pid: process.pid,
      version: TEST_VERSION,
      role: fixedRolePort('serving'),
    });
    registerCleanup(() => gateway.close());
    const client = createUdsClient(fixedSocket(socketPath));
    registerCleanup(() => client.close());

    const pending = postJson(client, '/v1/responses', { model: 'a/x', input: userInput('hi') });
    await waitFor(() => first.calls.length === 1, { description: 'the first attempt held open' });
    current = after;
    first.release('held');
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    expect(response.body.momonga).toMatchObject({ model: 'a/x', target: 'b/x', fallbackFrom: ['a/x'] });
    expect(leases).toBe(1);
    expect(fallbackBefore.calls).toHaveLength(1);
    expect(fallbackAfter.calls).toHaveLength(0);
  });
});
