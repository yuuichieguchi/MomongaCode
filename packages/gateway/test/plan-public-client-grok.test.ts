import { describe, expect, it, vi } from 'vitest';
import { planProfileOf } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { FIRST_GENERATION, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import { PLAN_API_PREFIX, PLAN_ROUTES } from '@momonga/protocol';
import {
  REAL_PROCESS_TEST_TIMEOUT_MS,
  createFakeClock,
  createFakeSecretStore,
  openResponsesTextReply,
  readBody,
  sendJson,
  startFakeSiwcAuth,
  startLoopbackServer,
  testKernelLock,
} from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { getJson, listedEntryOf, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, modelsOf, writeSettings } from './gateway-process-helpers.ts';
import { browse } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const GROK_PROFILE_ID = 'grok';
const GROK_ACCOUNT = 'grok';
const GROK_CALLBACK_PORT = 56121;
const GROK_PUBLIC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

const GROK_MODELS_RESPONSE = {
  object: 'list',
  data: [
    {
      id: 'grok-4',
      object: 'model',
      context_length: 256000,
      completion_text_token_price: 150000,
      capabilities: {
        reasoning_effort: ['low', 'high'],
        default_reasoning_effort: 'high',
      },
    },
    {
      id: 'grok-imagine-image',
      object: 'model',
      context_length: 4096,
    },
    {
      id: 'not-a-model',
      object: 'other',
      completion_text_token_price: 1000,
    },
  ],
};

type RecordedXaiRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

const startGrokGateway = async (options: {
  clock?: ReturnType<typeof createFakeClock>;
  respond?: (request: RecordedXaiRequest) => FakeUpstreamReply;
  withheldScopes?: readonly string[];
  declaredCapabilities?: boolean;
} = {}) => {
  const home = makeHome();
  const requests: RecordedXaiRequest[] = [];
  const upstream = await startLoopbackServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
    const recorded: RecordedXaiRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
    requests.push(recorded);
    if (recorded.method === 'GET' && recorded.path === '/v1/models') {
      sendJson(res, 200, GROK_MODELS_RESPONSE);
      return;
    }
    if (recorded.method === 'POST' && recorded.path === '/v1/responses') {
      const reply = options.respond ? options.respond(recorded) : openResponsesTextReply(['grok ok']);
      if (reply.kind === 'error') {
        sendJson(res, reply.status, reply.body, reply.headers);
        return;
      }
      if (reply.kind === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...reply.headers });
        for (const frame of reply.frames) {
          const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
          res.write(`${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${data}\n\n`);
        }
        res.end();
        return;
      }
      sendJson(res, 200, reply.kind === 'json' ? reply.body : {});
      return;
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  });
  registerCleanup(() => upstream.close());

  const loopback = `${upstream.origin}/v1`;
  const auth = await startFakeSiwcAuth({
    resource: loopback,
    publicClientId: GROK_PUBLIC_CLIENT_ID,
    callbackPath: '/callback',
    requireResource: false,
    ...(options.clock === undefined ? {} : { now: options.clock.now }),
  });
  if (options.withheldScopes !== undefined) auth.withheldScopes = [...options.withheldScopes];
  registerCleanup(() => auth.close());

  const shipped = planProfileOf(GROK_PROFILE_ID);
  const profile: PlanProfile = {
    ...shipped,
    oauth: {
      ...shipped.oauth,
      issuer: auth.issuer,
      discoveryUrl: auth.discoveryUrl,
      authorizeUrl: auth.authorizeUrl,
      tokenUrl: auth.tokenUrl,
      jwksUrl: auth.jwksUrl,
      resource: loopback,
    },
    targetDefaults: { ...shipped.targetDefaults, baseUrl: loopback },
  };
  const secretStore = createFakeSecretStore({});
  writeSettings(home, {
    models: modelsOf({
      xai: {
        adapter: 'open-responses',
        model: 'grok-4',
        ...(options.declaredCapabilities === false ? {} : { capabilities: { contextWindow: 256000, maxOutputTokens: 16000 } }),
        plan: { profile: GROK_PROFILE_ID, account: GROK_ACCOUNT },
      },
    }),
  });
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    secretStore,
    planProfiles: { [GROK_PROFILE_ID]: profile },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await publishCurrentGeneration(
    momongaPaths(home, process.platform, {}),
    { generation: FIRST_GENERATION, version: PROCESS_VERSION, sockets: { ...generationLayout(home, FIRST_GENERATION).sockets, gateway: handle.socketPath } },
    { lock: testKernelLock() },
  );
  const post = async (route: string, body: unknown) => readJson(await postJson(clientFor(handle.socketPath), `${PLAN_API_PREFIX}${route}`, body));
  const get = (route: string) => getJson(clientFor(handle.socketPath), `${PLAN_API_PREFIX}${route}`);
  return { home, auth, upstream, requests, profile, socketPath: handle.socketPath, post, get, close: () => handle.close() };
};

const signInGrok = async (gateway: Awaited<ReturnType<typeof startGrokGateway>>) => {
  const begun = await gateway.post(PLAN_ROUTES.signInBegin, { profile: GROK_PROFILE_ID, account: GROK_ACCOUNT, port: GROK_CALLBACK_PORT });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const exchanged = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  const completed =
    exchanged.body?.outcome === 'identity_unconfirmed'
      ? await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, identityConfirmed: true })
      : exchanged;
  return { begun, callback, completed };
};

describe('public-client plan profile (Grok) end-to-end', () => {
  it('signs in with fixed public client_id, omits resource and dynamic registration params, exposes usesHostIdentity: false, and refreshes without resource', async () => {
    const clock = createFakeClock(1_800_000_000_000);
    const gateway = await startGrokGateway({ clock });
    const accountsBefore = await gateway.get(PLAN_ROUTES.accounts);
    expect(accountsBefore.status).toBe(200);
    expect(accountsBefore.body.profiles).toEqual([expect.objectContaining({ id: 'grok', usesHostIdentity: false })]);

    const { begun, callback, completed } = await signInGrok(gateway);
    const authUrl = new URL(begun.body.authorizationUrl);
    expect(authUrl.searchParams.get('client_id')).toBe(GROK_PUBLIC_CLIENT_ID);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${GROK_CALLBACK_PORT}/callback`);
    expect(authUrl.searchParams.get('resource')).toBeNull();
    expect(authUrl.searchParams.get('agent_name_hint')).toBeNull();
    expect(authUrl.searchParams.get('ext_agent_host_id')).toBeNull();
    expect(callback.searchParams.get('client_id')).toBeNull();
    expect(completed.status).toBe(200);
    expect(completed.body.outcome).toBe('signed_in');

    const exchangeReq = gateway.auth.records.find((entry) => entry.form['grant_type'] === 'authorization_code');
    expect(exchangeReq?.form['client_id']).toBe(GROK_PUBLIC_CLIENT_ID);
    expect(exchangeReq?.form['resource']).toBeUndefined();

    // Advance clock into refresh window and verify refresh POST also omits resource
    clock.advance(3600 * 1000);
    const answered = await readJson(await postJson(clientFor(gateway.socketPath), '/v1/responses', { model: 'xai/grok-4', input: userInput('hello') }));
    expect(answered.status).toBe(200);
    const refreshReq = gateway.auth.records.find((entry) => entry.form['grant_type'] === 'refresh_token');
    expect(refreshReq?.form['client_id']).toBe(GROK_PUBLIC_CLIENT_ID);
    expect(refreshReq?.form['resource']).toBeUndefined();
    await gateway.close();
  });

  it('rejects a callback with a mismatched client_id and reports plan_disabled when requiredScope api:access is absent', async () => {
    const gateway = await startGrokGateway();
    const begun = await gateway.post(PLAN_ROUTES.signInBegin, { profile: GROK_PROFILE_ID, account: GROK_ACCOUNT, port: GROK_CALLBACK_PORT });
    const callback = await browse(begun.body.authorizationUrl);
    callback.searchParams.set('client_id', 'wrong-client-id');
    const mismatched = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error.code).toBe('client_mismatch');
    await gateway.close();

    const noApiAccess = await startGrokGateway({ withheldScopes: ['api:access'] });
    const { completed } = await signInGrok(noApiAccess);
    expect(completed.status).toBe(200);
    expect(completed.body.outcome).toBe('plan_disabled');
    await noApiAccess.close();
  });

  it('reads xAI /v1/models (data list, nested reasoning paths, absent completion_text_token_price unusable, context_length) and sends identity wire without session headers', async () => {
    const gateway = await startGrokGateway({ declaredCapabilities: false });
    await signInGrok(gateway);

    const catalogRes = await gateway.get(`${PLAN_ROUTES.accountModels.replace(':account', GROK_ACCOUNT)}?profile=grok`);
    expect(catalogRes.body, `status=${catalogRes.status}`).toMatchObject({
      models: [
        { slug: 'grok-4', displayName: 'grok-4', usable: true, contextWindow: 256000 },
        { slug: 'grok-imagine-image', displayName: 'grok-imagine-image', usable: false, reason: 'not a text generation model' },
      ],
    });
    expect(catalogRes.status).toBe(200);

    const listed = listedEntryOf((await getJson(clientFor(gateway.socketPath), '/v1/momonga/models')).body, 'xai/grok-4') as ReturnType<typeof listedEntryOf> & { effort?: string };
    expect(listed.capabilities['contextWindow']).toBe(256000);
    expect(listed.capabilities['reasoning']).toEqual({ control: 'reasoning_effort', lowest: 'low', efforts: ['low', 'high'], default: 'high' });
    expect(listed.effort).toBe('high');

    const answered = await readJson(
      await postJson(clientFor(gateway.socketPath), '/v1/responses', {
        model: 'xai/grok-4',
        input: userInput('hi'),
        max_output_tokens: 1024,
        tools: [{ type: 'function', name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }],
      }),
    );
    expect(answered.status).toBe(200);
    const sent = gateway.requests.find((entry) => entry.method === 'POST' && entry.path === '/v1/responses');
    expect(sent?.headers['content-encoding']).toBeUndefined();
    expect(sent?.headers['session-id']).toBeUndefined();
    expect(sent?.headers['thread-id']).toBeUndefined();
    expect(sent?.headers['x-client-request-id']).toBeUndefined();
    expect((sent?.body as Record<string, unknown>)['max_output_tokens']).toBe(1024);
    expect((sent?.body as Record<string, unknown>)['tools']).toEqual([expect.objectContaining({ type: 'function', name: 'ping' })]);
    await gateway.close();
  });

  it('classifies xAI HTTP status errors (403, 429, 503, 401) via the Grok profile errorRules', async () => {
    const scripted: FakeUpstreamReply[] = [
      { kind: 'error', status: 403, body: { error: { message: 'subscription tier not eligible' } } },
      { kind: 'error', status: 429, body: { error: { message: 'rate limit exceeded' } } },
    ];
    const gateway = await startGrokGateway({ respond: () => scripted.shift() ?? { kind: 'error', status: 500, body: {} } });
    await signInGrok(gateway);

    const forbidden = await readJson(await postJson(clientFor(gateway.socketPath), '/v1/responses', { model: 'xai/grok-4', input: userInput('1') }));
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error.code).toBe('plan_not_eligible');

    const limited = await readJson(await postJson(clientFor(gateway.socketPath), '/v1/responses', { model: 'xai/grok-4', input: userInput('2') }));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('plan_usage_limit');
    await gateway.close();
  });
});
