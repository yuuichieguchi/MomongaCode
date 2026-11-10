import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planProfileOf } from '@momonga/config';
import type { PlanProfile, PlanProfileOAuth } from '@momonga/config';
import { FIRST_GENERATION, createFileCredentialStore, createUdsClient, credentialFileFor, fixedSocket, momongaLayout, nodeFileSystem } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { saveEndpointRecord, startGatewayProcess } from '@momonga/gateway';
import { PLAN_API_PREFIX, PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecretStore, openResponsesTextReply, registerCleanup, startFakeSiwcAuth, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext, SiwcAuth } from '@momonga/testkit';
import { ensureHostIdentity } from '../src/plan/host-identity.ts';
import { getJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, homePaths, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { startFake } from './cc-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { makeReport } from './report-fixture.ts';
import { ACCOUNT, CALLBACK_PORT, accountRoute, begin, browse, sessionsDirectory, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { CONDITION_WAIT, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NO_GRACE = { closeGraceMs: 0, managedServerStopGraceMs: 0 };
const SPARE = 'spare';
const AUTH_HOST = 'auth.example.test';
const API_HOST = 'api.example.test';
const REMOTE_RESOURCE = `https://${API_HOST}/v1`;
const FAR_EXPIRY_MS = 4_102_444_800_000;
const PAST_EXPIRY_MS = 1;
const CHANGE_WAIT = { maxTurns: 20_000 } as const;

let settingsWrites = 0;

const replaceSettings = (home: string, value: unknown): void => {
  const { root, settings } = homePaths(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  settingsWrites += 1;
  const temporary = path.join(root, `.plan-settings-live-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}${' '.repeat(settingsWrites)}`, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

const replaceSettingsText = (home: string, text: string): void => {
  const { root, settings } = homePaths(home);
  settingsWrites += 1;
  const temporary = path.join(root, `.plan-settings-live-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

type Proxy = { port: number; connects(): string[]; openSockets(): number; refuseAll(): void };

const REFUSAL = 'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n';

const startProxy = async (context: CleanupContext, initial: 'silent' | 'refuse'): Promise<Proxy> => {
  let answer = initial;
  const connects: string[] = [];
  const sockets = new Set<net.Socket>();
  const waiting = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (!text.endsWith('\r\n\r\n')) return;
      connects.push(text.split('\r\n')[0] ?? '');
      text = '';
      if (answer === 'refuse' && socket.writable) socket.end(REFUSAL);
      else waiting.add(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerCleanup(context, async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: (server.address() as AddressInfo).port,
    connects: () => [...connects],
    openSockets: () => sockets.size,
    refuseAll: () => {
      answer = 'refuse';
      for (const socket of waiting) if (socket.writable) socket.end(REFUSAL);
      waiting.clear();
    },
  };
};

const proxied = (proxy: Proxy) => ({ httpsProxy: `http://127.0.0.1:${proxy.port}` });

const connectLine = (host: string): string => `CONNECT ${host}:443 HTTP/1.1`;

const remoteOAuth: Partial<PlanProfileOAuth> = {
  issuer: `https://${AUTH_HOST}`,
  discoveryUrl: `https://${AUTH_HOST}/.well-known/openid-configuration`,
  authorizeUrl: `https://${AUTH_HOST}/authorize`,
  tokenUrl: `https://${AUTH_HOST}/oauth/token`,
  jwksUrl: `https://${AUTH_HOST}/.well-known/jwks.json`,
  resource: REMOTE_RESOURCE,
};

const profileWith = (oauth: Partial<PlanProfileOAuth>): PlanProfile => {
  const shipped = planProfileOf(PROFILE_ID);
  return { ...shipped, oauth: { ...shipped.oauth, ...oauth }, targetDefaults: { ...shipped.targetDefaults, baseUrl: REMOTE_RESOURCE } };
};

const pinnedTargets = (accounts: readonly string[]) => ({
  aliases: Object.fromEntries(accounts.map((account) => [account, [`gpt-${account}`]])),
  targets: Object.fromEntries(
    accounts.map((account) => [
      `gpt-${account}`,
      { adapter: 'open-responses', model: 'plan-model', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: PROFILE_ID, account } },
    ]),
  ),
});

const activeRecord = (account: string, expiresAt: number, hostId: string) => ({
  version: 1,
  profile: PROFILE_ID,
  account,
  state: 'active',
  client_id: `client-of-${account}`,
  ext_agent_host_id: hostId,
  welcomeShown: true,
  subject: `subject-of-${account}`,
  email: `${account}@example.test`,
  access_token: `access-of-${account}`,
  refresh_token: `refresh-of-${account}`,
  expiresAt,
});

type Stack = { home: string; client: UdsClient; settingsWith(network: Record<string, unknown>): unknown };

const startRemoteStack = async (
  context: CleanupContext,
  options: { profile: PlanProfile; accounts: readonly string[]; records?: (hostId: string) => readonly Record<string, unknown>[]; network: Record<string, unknown> },
): Promise<Stack> => {
  const home = withTempDir(context, { asHome: true });
  const layout = momongaLayout(home);
  fs.mkdirSync(layout.planSessions, { recursive: true, mode: 0o700 });
  const { hostId } = await ensureHostIdentity(nodeFileSystem, layout.planHost, { accountsExist: false });
  const store = createFileCredentialStore(layout.planSessions);
  for (const record of options.records?.(hostId) ?? []) await store.write(`plan/${PROFILE_ID}/${String(record['account'])}`, JSON.stringify(record));
  const settingsWith = (network: Record<string, unknown>) => ({ credentials: { plaintextTokenFiles: true }, models: pinnedTargets(options.accounts), network });
  replaceSettings(home, settingsWith(options.network));
  const handle = await startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    stdout: { write: () => true },
    secretStore: createFakeSecretStore({}),
    planProfiles: { [PROFILE_ID]: options.profile },
  });
  registerCleanup(context, async () => {
    await handle.close(NO_GRACE);
  });
  const client = createUdsClient(fixedSocket(handle.socketPath));
  registerCleanup(context, () => client.destroy());
  return { home, client, settingsWith };
};

const send = (client: UdsClient, method: 'GET' | 'POST', route: string, body?: unknown): void => {
  void client
    .request({ method, path: route, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    .then((response) => response.text())
    .catch(() => undefined);
};

const postJsonOf = async (client: UdsClient, route: string, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await client.request({ method: 'POST', path: route, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

type Operation = (stack: Stack, account: string) => Promise<void>;

const keepsAndSwitches = async (context: CleanupContext, options: { profile: PlanProfile; records: (account: string, hostId: string) => readonly Record<string, unknown>[]; host: string; start: Operation }) => {
  const before = await startProxy(context, 'silent');
  const after = await startProxy(context, 'refuse');
  const stack = await startRemoteStack(context, { profile: options.profile, accounts: [ACCOUNT, SPARE], records: (hostId) => [...options.records(ACCOUNT, hostId), ...options.records(SPARE, hostId)], network: proxied(before) });
  try {
    await options.start(stack, ACCOUNT);
    await waitFor(() => before.connects().length === 1, { ...CHANGE_WAIT, description: 'the operation started before the change to reach the first proxy' });
    expect(before.connects()).toEqual([connectLine(options.host)]);
    replaceSettings(stack.home, stack.settingsWith(proxied(after)));
    await options.start(stack, SPARE);
    await waitFor(() => after.connects().length > 0, CHANGE_WAIT).catch(() => undefined);
    expect(after.connects().slice(0, 1)).toEqual([connectLine(options.host)]);
    expect(new Set(after.connects())).toEqual(new Set([connectLine(options.host)]));
    expect(before.connects()).toEqual([connectLine(options.host)]);
    expect(before.openSockets()).toBe(1);
  } finally {
    before.refuseAll();
  }
};

describe('O-R5-6 (K) 1: the plan operations take the network of the settings in force when each starts', () => {
  it('a sign-in exchange that starts after a network change goes through the new proxy; the one started before keeps its connection', async (context) => {
    await keepsAndSwitches(context, {
      profile: profileWith(remoteOAuth),
      records: () => [],
      host: AUTH_HOST,
      start: async (stack, account) => {
        const begun = await postJsonOf(stack.client, `${PLAN_API_PREFIX}${PLAN_ROUTES.signInBegin}`, { profile: PROFILE_ID, account, port: CALLBACK_PORT });
        expect(begun.status).toBe(200);
        const callback = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback?code=code-of-${account}&client_id=client-of-${account}&state=${encodeURIComponent(begun.body.state)}`;
        send(stack.client, 'POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signInComplete}`, { attemptId: begun.body.attemptId, callbackUrl: callback });
      },
    });
  });

  it('a token refresh that starts after a network change goes through the new proxy; the one started before keeps its connection', async (context) => {
    await keepsAndSwitches(context, {
      profile: profileWith(remoteOAuth),
      records: (account, hostId) => [activeRecord(account, PAST_EXPIRY_MS, hostId)],
      host: AUTH_HOST,
      start: async (stack, account) => {
        send(stack.client, 'POST', '/v1/responses', { model: account, input: userInput('hi'), stream: false });
      },
    });
  });

  it('a revocation that starts after a network change goes through the new proxy; the one started before keeps its connection', async (context) => {
    await keepsAndSwitches(context, {
      profile: profileWith(remoteOAuth),
      records: (account, hostId) => [activeRecord(account, FAR_EXPIRY_MS, hostId)],
      host: AUTH_HOST,
      start: async (stack, account) => {
        send(stack.client, 'POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signOut}`, { profile: PROFILE_ID, account });
      },
    });
  });

  it('a catalog read that starts after a network change goes through the new proxy; the one started before keeps its connection', async (context) => {
    await keepsAndSwitches(context, {
      profile: profileWith(remoteOAuth),
      records: (account, hostId) => [activeRecord(account, FAR_EXPIRY_MS, hostId)],
      host: API_HOST,
      start: async (stack, account) => {
        send(stack.client, 'GET', `${PLAN_API_PREFIX}${accountRoute(PLAN_ROUTES.accountModels, account)}?profile=${PROFILE_ID}`);
      },
    });
  });

  it('a JWKS read that starts after a network change goes through the new proxy and never through the old one', async (context) => {
    const auth: SiwcAuth = await startFakeSiwcAuth({ resource: REMOTE_RESOURCE });
    registerCleanup(context, () => auth.close());
    const profile = profileWith({ issuer: auth.issuer, discoveryUrl: auth.discoveryUrl, authorizeUrl: auth.authorizeUrl, tokenUrl: auth.tokenUrl, jwksUrl: `https://${AUTH_HOST}/.well-known/jwks.json`, resource: REMOTE_RESOURCE });
    const first = await startProxy(context, 'refuse');
    const second = await startProxy(context, 'refuse');
    const stack = await startRemoteStack(context, { profile, accounts: [ACCOUNT], network: proxied(first) });
    replaceSettings(stack.home, stack.settingsWith(proxied(second)));
    const begun = await postJsonOf(stack.client, `${PLAN_API_PREFIX}${PLAN_ROUTES.signInBegin}`, { profile: PROFILE_ID, account: ACCOUNT, port: CALLBACK_PORT });
    expect(begun.status).toBe(200);
    const callback = await browse(begun.body.authorizationUrl);
    send(stack.client, 'POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signInComplete}`, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
    await waitFor(() => second.connects().length > 0, CHANGE_WAIT).catch(() => undefined);
    expect(auth.calls.tokenAuthorizationCode).toBe(1);
    expect(second.connects().slice(0, 1)).toEqual([connectLine(AUTH_HOST)]);
    expect(first.connects()).toEqual([]);
  });
});

const planSettings = (accounts: readonly string[]) => ({ credentials: { plaintextTokenFiles: true }, models: pinnedTargets(accounts) });

const signInAs = async (gateway: PlanGateway, account: string): Promise<void> => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: account } });
};

const recordFile = (gateway: PlanGateway, account: string): string => credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${account}`);

const entryOf = async (gateway: PlanGateway, account: string): Promise<{ state: string; pinnedBy: string[] } | undefined> => {
  const listed = await gateway.get(PLAN_ROUTES.accounts);
  expect(listed.status).toBe(200);
  return (listed.body.accounts as { label: string; state: string; pinnedBy: string[] }[]).find((entry) => entry.label === account);
};

const askAlias = async (gateway: PlanGateway, alias: string): Promise<number> => {
  const response = await clientFor(gateway.socketPath).request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: alias, input: userInput('hi'), stream: false }),
  });
  await response.text();
  return response.status;
};

const withSpareSigningOut = async (): Promise<PlanGateway> => {
  const gateway = await startPlanGateway({ plaintextTokenFiles: true });
  replaceSettings(gateway.home, planSettings([ACCOUNT]));
  await signInAs(gateway, ACCOUNT);
  await signInAs(gateway, SPARE);
  await gateway.close();
  const file = recordFile(gateway, SPARE);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...record, state: 'signing_out' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  await gateway.restart();
  return gateway;
};

describe('O-R5-6 (K) 2: an account pinned for the first time by a later change gets what a pinned account gets at start', () => {
  it('a signing_out record pinned by a change resumes its sign-out before the first request of the new epoch that names it', async () => {
    const gateway = await withSpareSigningOut();
    expect(gateway.auth.calls.revoke).toBe(0);
    replaceSettings(gateway.home, planSettings([ACCOUNT, SPARE]));
    await askAlias(gateway, SPARE);
    await vi.waitFor(() => expect(gateway.auth.calls.revoke).toBe(1), CONDITION_WAIT);
    await vi.waitFor(async () => expect(await entryOf(gateway, SPARE)).toMatchObject({ state: 'registered', pinnedBy: [`gpt-${SPARE}`] }), CONDITION_WAIT);
    await gateway.close();
  });

  it('an account no longer pinned keeps its record and its state', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    replaceSettings(gateway.home, planSettings([ACCOUNT, SPARE]));
    await signInAs(gateway, ACCOUNT);
    await signInAs(gateway, SPARE);
    replaceSettings(gateway.home, planSettings([SPARE]));
    await askAlias(gateway, SPARE);
    expect(await entryOf(gateway, ACCOUNT)).toMatchObject({ state: 'active', pinnedBy: [] });
    expect(fs.existsSync(recordFile(gateway, ACCOUNT))).toBe(true);
    expect(gateway.auth.calls.revoke).toBe(0);
    await gateway.close();
  });
});

const catalogEntry = (contextWindow: number) => ({ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: contextWindow });

const listedTarget = async (gateway: PlanGateway): Promise<{ counter: string; contextWindow: unknown }> => {
  const listed = await getJson(clientFor(gateway.socketPath), '/v1/momonga/models');
  expect(listed.status).toBe(200);
  const entry = (listed.body.data as Array<{ id: string; targetCounters: Record<string, string>; targetCapabilities: Record<string, { contextWindow?: unknown }> }>).find((model) => model.id === 'default');
  if (entry === undefined) throw new Error('the models listing has no alias default');
  return { counter: String(entry.targetCounters['gpt']), contextWindow: entry.targetCapabilities['gpt']?.contextWindow };
};

describe('O-R5-6 (K) 4: the account a plan target serves is part of its part key and its target counter', () => {
  it('switching the active account of the profile gives a second incarnation at the next request, with the catalog capabilities of the new account', async () => {
    const listed: unknown[] = [catalogEntry(200000)];
    const gateway = await startPlanGateway({ models: listed, declaredCapabilities: false });
    await signInAs(gateway, ACCOUNT);
    expect((await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, ACCOUNT)}?profile=${PROFILE_ID}`)).status).toBe(200);
    listed.splice(0, listed.length, catalogEntry(100000));
    await signInAs(gateway, SPARE);
    expect((await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, SPARE)}?profile=${PROFILE_ID}`)).status).toBe(200);
    expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
    replaceSettings(gateway.home, { models: { aliases: { default: ['gpt'] }, targets: { gpt: { adapter: 'open-responses', model: 'plan-model', plan: { profile: PROFILE_ID } } } } });
    const onFirst = await listedTarget(gateway);
    expect(onFirst.contextWindow).toBe(200000);
    expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);
    const onSecond = await listedTarget(gateway);
    expect(onSecond.counter).not.toBe(onFirst.counter);
    expect(onSecond.contextWindow).toBe(100000);
    await gateway.close();
  });
});

describe('O-R5-6 (K) 5: the plan paths that read settings follow the one rule of settings-live 15 after the file breaks', () => {
  it('with the file broken after a valid start, the pinned accounts, the models listing and a sign-in that writes a record answer from the last applied settings', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    await signInAs(gateway, ACCOUNT);
    replaceSettingsText(gateway.home, '{ "models": ');
    expect(await entryOf(gateway, ACCOUNT)).toMatchObject({ state: 'active', pinnedBy: ['gpt'] });
    expect((await getJson(clientFor(gateway.socketPath), '/v1/momonga/models')).status).toBe(200);
    await signInAs(gateway, SPARE);
    expect(JSON.parse(fs.readFileSync(recordFile(gateway, SPARE), 'utf8'))).toMatchObject({ state: 'active', account: SPARE });
    await gateway.close();
  });
});

const NO_STOP_GRACE = { closeGraceMs: 0, managedServerStopGraceMs: 0 };

const unpinnedSettings = (capabilities: boolean) => ({
  credentials: { plaintextTokenFiles: true },
  gateway: NO_STOP_GRACE,
  models: {
    aliases: { default: ['gpt'] },
    targets: { gpt: { adapter: 'open-responses', model: 'plan-model', ...(capabilities ? { capabilities: { contextWindow: 128000, maxOutputTokens: 16000 } } : {}), plan: { profile: PROFILE_ID } } },
  },
});

const accessTokenOf = (gateway: PlanGateway, account: string): string => String((JSON.parse(fs.readFileSync(recordFile(gateway, account), 'utf8')) as Record<string, unknown>)['access_token']);

const responsePosts = (gateway: PlanGateway) => gateway.upstream.requests.filter((request) => request.method === 'POST');

const bearerOf = (request: { headers: Record<string, unknown> }): string => String(request.headers['authorization'] ?? '');

const askDefault = async (gateway: PlanGateway): Promise<{ status: number; body: any }> => {
  const response = await clientFor(gateway.socketPath).request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'default', input: userInput('hi'), stream: false }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
};

describe('O-R5-6 L3: the served account, the reported numbers and the output policy are components of the part key and the counter', () => {
  it('a request in flight keeps its part when the active account switches', async () => {
    let answered = 0;
    const gateway = await startPlanGateway({
      plaintextTokenFiles: true,
      respond: () => {
        answered += 1;
        return answered === 1 ? { kind: 'hang' } : openResponsesTextReply(['hi']);
      },
    });
    const heldClient = createUdsClient(fixedSocket(gateway.socketPath));
    try {
      await signInAs(gateway, ACCOUNT);
      await signInAs(gateway, SPARE);
      expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
      replaceSettings(gateway.home, unpinnedSettings(true));
      const onFirst = await listedTarget(gateway);
      void heldClient
        .request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'default', input: userInput('hi'), stream: false }) })
        .then((response) => response.text())
        .catch(() => undefined);
      await vi.waitFor(() => expect(responsePosts(gateway)).toHaveLength(1), CONDITION_WAIT);
      expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);
      expect((await askDefault(gateway)).status).toBe(200);
      const onSecond = await listedTarget(gateway);
      const [first, second] = responsePosts(gateway);
      expect(bearerOf(first ?? { headers: {} })).toBe(`Bearer ${accessTokenOf(gateway, ACCOUNT)}`);
      expect(bearerOf(second ?? { headers: {} })).toBe(`Bearer ${accessTokenOf(gateway, SPARE)}`);
      expect(onSecond.counter).not.toBe(onFirst.counter);
    } finally {
      heldClient.destroy();
      await gateway.close();
    }
  });

  it('a catalog read made after the part exists reaches a pinned target', async () => {
    const gateway = await startPlanGateway({ models: [catalogEntry(200000)], declaredCapabilities: false });
    await signInAs(gateway, ACCOUNT);
    const before = await getJson(clientFor(gateway.socketPath), '/v1/momonga/models');
    const reportedBefore = before.status === 200 ? (before.body.data as Array<{ id: string; targetCapabilities: Record<string, { contextWindow?: unknown }> }>).find((model) => model.id === 'default')?.targetCapabilities['gpt']?.contextWindow : undefined;
    expect(reportedBefore).toBeUndefined();
    expect((await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, ACCOUNT)}?profile=${PROFILE_ID}&refresh=1`)).status).toBe(200);
    const after = await listedTarget(gateway);
    expect(after.contextWindow).toBe(200000);
    await gateway.close();
  });

  it('a signed-out profile gives a part whose read fails sign_in_required and the first sign-in replaces the part', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true, respond: () => openResponsesTextReply(['hi']) });
    replaceSettings(gateway.home, unpinnedSettings(true));
    const signedOut = await askDefault(gateway);
    expect(signedOut.status).toBe(401);
    expect(signedOut.body?.error?.code).toBe('sign_in_required');
    expect(responsePosts(gateway)).toHaveLength(0);
    await signInAs(gateway, ACCOUNT);
    expect((await askDefault(gateway)).status).toBe(200);
    const [sent] = responsePosts(gateway);
    expect(bearerOf(sent ?? { headers: {} })).toBe(`Bearer ${accessTokenOf(gateway, ACCOUNT)}`);
    await gateway.close();
  });

  it('toggling context.unboundedOutputReserve gives a new counter for a probed target and a kept part for a keyed target', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    const models = {
      aliases: { probed: ['probed'], keyed: ['keyed'] },
      targets: { probed: ccTarget(fake.socketPath, { toolCalling: 'auto' }), keyed: ccTarget(fake.socketPath, { toolCalling: 'native' }) },
    };
    writeSettings(home, { models, context: { unboundedOutputReserve: false } });
    await saveEndpointRecord(path.join(homePaths(home).root, 'state', 'probe'), { endpoint: `unix:${fake.socketPath}`, model: 'system' }, 'identity-one', ['id', 'object', 'owned_by'], makeReport(1, 1) as never, CURRENT_DIALECTS);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    const countersOf = async (): Promise<Record<string, string>> => {
      const listed = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
      expect(listed.status).toBe(200);
      const entries = listed.body.data as Array<{ id: string; targetCounters: Record<string, string> }>;
      return Object.fromEntries(['probed', 'keyed'].map((alias) => [alias, String(entries.find((entry) => entry.id === alias)?.targetCounters[alias])]));
    };
    const off = await countersOf();
    replaceSettings(home, { models, context: { unboundedOutputReserve: true } });
    const on = await countersOf();
    expect(on['probed']).not.toBe(off['probed']);
    expect(on['keyed']).toBe(off['keyed']);
    await handle.close();
  });
});
