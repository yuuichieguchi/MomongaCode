import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_TOOL_BINARY, SECURITY_BINARY, KEYCHAIN_SERVICE, createJsonLogger, createUdsClient, systemClock, FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import {
  READY_CONTROL,
  REAL_PROCESS_TEST_TIMEOUT_MS,
  anthropicErrorReply,
  anthropicTextReply,
  createFakeClock,
  createFakeSecurityPort,
  createFakeTimers,
  openResponsesTextReply,
  registerCleanup,
  startFakeAnthropic,
  startFakeOpenResponses,
  withTempDir,
  registerOwned,
  testLocks,
} from '@momonga/testkit';
import type { CleanupContext, FakeControl, FakeTimers, FakeUpstreamReply, FakeUpstreamServer } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, fakeSecretHost, givenStoreOnHost, homePaths, portOnSecretHost, writeSettings, prepareHome, modelsOf } from './gateway-process-helpers.ts';
import type { HostPort, SecretHost } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED, expectNoCredential } from './credential-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SECRET = 'sk-ant-api03-stored-in-keychain-0001';
const SECRET_NAME = 'anthropic-main';
const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };
const PATIENT_CLIENT_MS = 3_600_000;

type HostStore = {
  label: string;
  program: string;
  canonicalBinary: string;
  readinessCalls: ReadonlyArray<readonly string[]>;
  lookupArgs: readonly string[];
  missingExit: number;
  storeCommand: string;
  extraEnv: Record<string, string>;
};

const HOST_STORES: readonly HostStore[] = [
  {
    label: 'Keychain',
    program: 'security',
    canonicalBinary: SECURITY_BINARY,
    readinessCalls: [['default-keychain']],
    lookupArgs: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', SECRET_NAME, '-w'],
    missingExit: 44,
    storeCommand: `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${SECRET_NAME} -w`,
    extraEnv: {},
  },
  {
    label: 'Secret Service',
    program: 'secret-tool',
    canonicalBinary: SECRET_TOOL_BINARY,
    readinessCalls: [],
    lookupArgs: ['lookup', 'service', KEYCHAIN_SERVICE, 'account', SECRET_NAME],
    missingExit: 1,
    storeCommand: `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${SECRET_NAME}`,
    extraEnv: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/momonga-test-bus' },
  },
];

const callsPerRead = (store: HostStore): number => store.readinessCalls.length + 1;

const fakeHostPath = async (context: CleanupContext, store: HostStore): Promise<SecretHost> => await fakeSecretHost(withTempDir(context), store);

type Stack = {
  home: string;
  client: UdsClient;
  handle: GatewayProcess;
  anthropic: FakeUpstreamServer;
  openResponses: FakeUpstreamServer;
  security: HostPort;
  control: FakeControl;
  patient: UdsClient;
  programPath: string;
  logText(): string;
};

const startStack = async (
  context: CleanupContext,
  store: HostStore,
  options: {
    secrets: Record<string, string>;
    anthropicScript: FakeUpstreamReply[];
    fallbackTo?: string[];
    env?: Record<string, string>;
    secretName?: string;
    control?: Partial<FakeControl>;
    headersTimeoutMs?: number;
    timers?: FakeTimers;
  },
): Promise<Stack> => {
  const anthropic = await startFakeAnthropic({ apiKey: SECRET, script: options.anthropicScript });
  registerCleanup(context, () => anthropic.close());
  const openResponses = await startFakeOpenResponses({ script: [openResponsesTextReply(['from the local target'])] });
  registerCleanup(context, () => openResponses.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, {
    models: modelsOf(
      {
        claude: { adapter: 'anthropic', model: 'claude-fake', socketPath: anthropic.socketPath, apiKeySecret: options.secretName ?? SECRET_NAME, capabilities: CAPABILITIES },
        local: { adapter: 'open-responses', provider: 'fake', model: 'local-fake', socketPath: openResponses.socketPath, capabilities: CAPABILITIES },
      },
      { ...(options.fallbackTo === undefined ? {} : { fallbackTo: options.fallbackTo }), ...(options.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: options.headersTimeoutMs }) },
    ),
  });
  const host = await fakeHostPath(context, store);
  const control: FakeControl = { ...READY_CONTROL, ...options.control };
  const security = portOnSecretHost(createFakeSecurityPort(() => options.secrets, undefined, { control: () => control }), store, host);
  const lines: string[] = [];
  const handle = await registerOwned(context, async () => startGatewayProcess({
    locks: testLocks(),
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, { ...host.env, ...options.env }),
    version: PROCESS_VERSION,
    execWithStdin: security,
    secretStore: givenStoreOnHost(security, host),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: (chunk: string) => (lines.push(chunk), true) }, level: 'debug' }),
    stdout: { write: () => true },
  }));
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(fixedSocket(handle.socketPath), { connectTimeoutMs: 0 });
  registerCleanup(context, () => client.close());
  const patient = createUdsClient(fixedSocket(handle.socketPath), { connectTimeoutMs: 0, headersTimeoutMs: PATIENT_CLIENT_MS, bodyTimeoutMs: PATIENT_CLIENT_MS });
  registerCleanup(context, () => patient.destroy());
  return { home, client, handle, anthropic, openResponses, security, control, patient, programPath: host.programPath, logText: () => lines.join('') };
};

const post = async (client: UdsClient, payload: unknown): Promise<{ status: number; text: string }> => {
  const response = await client.request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, text: await response.text() };
};

const request = { model: 'claude/claude-fake', input: userInput('hi') };

describe.each(HOST_STORES)('stored secrets in the gateway process, $label found on PATH', (store) => {
  it('resolves the referenced secret through the injected process port and sends it as the Anthropic key', async (context) => {
    const stack = await startStack(context, store, { secrets: { [SECRET_NAME]: SECRET, unreferenced: 'never-read-0000000000' }, anthropicScript: [anthropicTextReply(['hello'])] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).status).toBe('completed');
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls).toEqual([...store.readinessCalls, store.lookupArgs].map((args) => ({ file: stack.programPath, args, stdin: '' })));
    expect(fs.readFileSync(homePaths(stack.home).settings, 'utf8')).not.toContain(SECRET);
  });

  it('reads a referenced secret at its first use, not at start, once while the definition is unchanged, and again after the definition changed', async (context) => {
    const stack = await startStack(context, store, {
      secrets: { [SECRET_NAME]: SECRET },
      anthropicScript: [anthropicTextReply(['a']), anthropicTextReply(['b']), anthropicTextReply(['c'])],
    });
    expect(stack.security.calls).toEqual([]);
    expect((await post(stack.client, request)).status).toBe(200);
    expect((await post(stack.client, request)).status).toBe(200);
    expect(stack.security.calls).toHaveLength(callsPerRead(store));
    const file = homePaths(stack.home).settings;
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { connections: Array<Record<string, unknown>> } };
    const connections = settings.models.connections.map((connection) => (connection['provider'] === 'claude' ? { ...connection, maxConcurrency: 2 } : connection));
    const staging = `${file}.changed.tmp`;
    fs.writeFileSync(staging, JSON.stringify({ ...settings, models: { ...settings.models, connections } }), { mode: 0o600 });
    fs.renameSync(staging, file);
    expect((await post(stack.client, request)).status).toBe(200);
    expect(stack.security.calls).toHaveLength(2 * callsPerRead(store));
  });

  it('redacts the resolved secret from upstream error text', async (context) => {
    const stack = await startStack(context, store, {
      secrets: { [SECRET_NAME]: SECRET },
      anthropicScript: [anthropicErrorReply(400, 'invalid_request_error', `bad request, key ${SECRET} was echoed`)],
    });
    const response = await post(stack.client, request);
    expect(response.status).toBe(400);
    expectNoCredential(response.text, SECRET);
    expect(response.text).toContain(REDACTED);
    expectNoCredential(stack.logText(), SECRET);
  });

  it('fails the request with a typed secret_unavailable error when the secret is missing, and does not call the upstream', async (context) => {
    const stack = await startStack(context, store, { secrets: {}, anthropicScript: [anthropicTextReply(['unreachable'])] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(401);
    const error = JSON.parse(response.text).error;
    expect(error).toMatchObject({ type: 'invalid_request', code: 'secret_unavailable', param: SECRET_NAME });
    expect(error.message).toContain(`exit ${store.missingExit}`);
    expect(error.message).toContain(store.storeCommand);
    expect(error.message).toContain('reads a missing secret again on the next request');
    expect(stack.anthropic.requests).toEqual([]);
    expect(stack.security.calls).toHaveLength(callsPerRead(store));
  });

  it('reads a secret that was added after start on the next request, then stops reading it', async (context) => {
    const secrets: Record<string, string> = {};
    const stack = await startStack(context, store, { secrets, anthropicScript: [anthropicTextReply(['a']), anthropicTextReply(['b'])] });
    expect(stack.security.calls).toEqual([]);
    expect((await post(stack.client, request)).status).toBe(401);
    expect(stack.security.calls).toHaveLength(callsPerRead(store));
    secrets[SECRET_NAME] = SECRET;
    const added = await post(stack.client, request);
    expect(added.status).toBe(200);
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls).toHaveLength(2 * callsPerRead(store));
    expect((await post(stack.client, request)).status).toBe(200);
    expect(stack.security.calls).toHaveLength(2 * callsPerRead(store));
  });

  it('redacts a secret that was resolved after start from upstream error text', async (context) => {
    const secrets: Record<string, string> = {};
    const stack = await startStack(context, store, {
      secrets,
      anthropicScript: [anthropicErrorReply(400, 'invalid_request_error', `bad request, key ${SECRET} was echoed`)],
    });
    expect((await post(stack.client, request)).status).toBe(401);
    secrets[SECRET_NAME] = SECRET;
    const response = await post(stack.client, request);
    expect(response.status).toBe(400);
    expectNoCredential(response.text, SECRET);
    expect(response.text).toContain(REDACTED);
    expect(stack.logText()).not.toContain(SECRET);
  });

  it('falls through to the next target of the alias when a target secret is unavailable', async (context) => {
    const stack = await startStack(context, store, { secrets: {}, anthropicScript: [], fallbackTo: ['local'] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    const resource = JSON.parse(response.text);
    expect(resource.momonga).toMatchObject({ target: 'fake/local-fake', fallbackFrom: ['claude/claude-fake'] });
    expect(stack.anthropic.requests).toEqual([]);
  });

  it('starts when the process port itself fails, fails the first call that needs the secret with the port message, and keeps other targets working', async (context) => {
    const anthropic = await startFakeAnthropic({ apiKey: SECRET, script: [] });
    registerCleanup(context, () => anthropic.close());
    const openResponses = await startFakeOpenResponses({ script: [openResponsesTextReply(['from the local target'])] });
    registerCleanup(context, () => openResponses.close());
    const home = withTempDir(context, { asHome: true });
    prepareHome(home);
    writeSettings(home, {
      models: modelsOf({
          claude: { adapter: 'anthropic', model: 'claude-fake', socketPath: anthropic.socketPath, apiKeySecret: SECRET_NAME, capabilities: CAPABILITIES },
          local: { adapter: 'open-responses', provider: 'fake', model: 'local-fake', socketPath: openResponses.socketPath, capabilities: CAPABILITIES },
        }),
    });
    let portCalls = 0;
    const handle = await registerOwned(context, async () => startGatewayProcess({
      locks: testLocks(),
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home, (await fakeHostPath(context, store)).env),
      version: PROCESS_VERSION,
      execWithStdin: async () => {
        portCalls += 1;
        throw new Error('spawn security ENOENT');
      },
      stdout: { write: () => true },
    }));
    registerCleanup(context, async () => {
      await handle.close();
    });
    const client = createUdsClient(fixedSocket(handle.socketPath), { connectTimeoutMs: 0 });
    registerCleanup(context, () => client.close());
    expect(portCalls).toBe(0);
    const failed = await post(client, request);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.text).toContain('spawn security ENOENT');
    expect(anthropic.requests).toEqual([]);
    expect(portCalls).toBe(1);
    const other = await post(client, { model: 'fake/local-fake', input: userInput('hi') });
    expect(other.status).toBe(200);
    expect(JSON.parse(other.text).momonga).toMatchObject({ target: 'fake/local-fake' });
  });

  it('never invokes the process port when no target references a secret', async (context) => {
    const openResponses = await startFakeOpenResponses({ script: [] });
    registerCleanup(context, () => openResponses.close());
    const home = withTempDir(context, { asHome: true });
    prepareHome(home);
    writeSettings(home, {
      models: modelsOf({ local: { adapter: 'open-responses', provider: 'fake', model: 'm', socketPath: openResponses.socketPath, capabilities: CAPABILITIES } }),
    });
    const security = createFakeSecurityPort(() => ({}));
    const handle = await registerOwned(context, async () => startGatewayProcess({ locks: testLocks(), generation: FIRST_GENERATION, home, env: baseEnv(home, (await fakeHostPath(context, store)).env), version: PROCESS_VERSION, execWithStdin: security, stdout: { write: () => true } }));
    registerCleanup(context, async () => {
      await handle.close();
    });
    expect(security.calls).toEqual([]);
  });
});

describe('a Keychain that cannot answer, in the gateway process', () => {
  const KEYCHAIN = HOST_STORES[0] as HostStore;
  const K = 'k';
  const ADVICE = 'the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain';
  const NEXT_REQUEST_TAIL = 'the gateway reads the secret again on the next request';
  const NO_DEFAULT_REASON = 'security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)';
  const ANSWER_WAIT = { timeout: 5_000 };

  type Answer = { state(): 'pending' | 'fulfilled' | 'rejected'; value(): { status: number; text: string } | undefined };

  const answerOf = (pending: Promise<{ status: number; text: string }>): Answer => {
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    let value: { status: number; text: string } | undefined;
    pending.then(
      (response) => {
        state = 'fulfilled';
        value = response;
      },
      () => {
        state = 'rejected';
      },
    );
    return { state: () => state, value: () => value };
  };

  const gatewayTimers = (): FakeTimers => createFakeTimers(createFakeClock(0));

  const answerAtLimit = async (stack: Stack, timers: FakeTimers, limitMs: number): Promise<{ status: number; text: string }> => {
    const answer = answerOf(post(stack.patient, request));
    await stack.security.arrived('find-generic-password');
    await timers.advanceAsync(limitMs - 1);
    expect(answer.state()).toBe('pending');
    timers.advance(1);
    await vi.waitFor(() => expect(answer.state()).toBe('fulfilled'), ANSWER_WAIT);
    return answer.value() as { status: number; text: string };
  };

  it.for([
    { title: 'the default of 300000 ms', headersTimeoutMs: undefined, limitMs: 300_000, label: 'the request limit' },
    { title: 'a configured 5000 ms', headersTimeoutMs: 5000, limitMs: 5000, label: 'the request limit' },
  ])('a hung key read ends at models.headersTimeoutMs ($title)', async ({ headersTimeoutMs, limitMs, label }, context) => {
    const timers = gatewayTimers();
    const stack = await startStack(context, KEYCHAIN, {
      secrets: { [K]: SECRET },
      secretName: K,
      anthropicScript: [anthropicTextReply(['unreachable'])],
      control: { calls: 'hang' },
      timers,
      ...(headersTimeoutMs === undefined ? {} : { headersTimeoutMs }),
    });

    const response = await answerAtLimit(stack, timers, limitMs);

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text).error).toMatchObject({
      type: 'invalid_request',
      code: 'secret_unavailable',
      param: K,
      message: `the read of the secret "k" did not finish within ${label} of ${limitMs} ms; ${ADVICE}; ${NEXT_REQUEST_TAIL}`,
    });
    expect(stack.anthropic.requests).toEqual([]);
  });

  it('an absent store is secret_unavailable', async (context) => {
    const stack = await startStack(context, KEYCHAIN, { secrets: { [K]: SECRET }, secretName: K, anthropicScript: [anthropicTextReply(['unreachable'])], control: { readiness: 'none' } });

    const response = await post(stack.client, request);

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text).error).toMatchObject({
      type: 'invalid_request',
      code: 'secret_unavailable',
      param: K,
      message: `the secret "k" could not be read: no secret store was found on this host (${NO_DEFAULT_REASON}); make a default keychain available, then store it with: security add-generic-password -s momonga -a k -w; ${NEXT_REQUEST_TAIL}`,
    });
    expect(stack.security.calls).toEqual([{ file: stack.programPath, args: ['default-keychain'], stdin: '' }]);
    expect(stack.anthropic.requests).toEqual([]);
  });

  it('an unknown readiness answer is secret_unavailable', async (context) => {
    const stack = await startStack(context, KEYCHAIN, { secrets: { [K]: SECRET }, secretName: K, anthropicScript: [anthropicTextReply(['unreachable'])], control: { readiness: 'garbage' } });

    const response = await post(stack.client, request);

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text).error).toMatchObject({
      type: 'invalid_request',
      code: 'secret_unavailable',
      param: K,
      message: `the Keychain readiness answer was not understood (exit 0): garbage; ${NEXT_REQUEST_TAIL}`,
    });
    expect(stack.security.calls).toEqual([{ file: stack.programPath, args: ['default-keychain'], stdin: '' }]);
    expect(stack.anthropic.requests).toEqual([]);
  });

  it('after a limit the next request reads again and nothing is cached', async (context) => {
    const timers = gatewayTimers();
    const stack = await startStack(context, KEYCHAIN, { secrets: { [K]: SECRET }, secretName: K, anthropicScript: [anthropicTextReply(['hello'])], control: { calls: 'hang' }, timers });

    expect((await answerAtLimit(stack, timers, 300_000)).status).toBe(401);
    stack.control.calls = 'answer';
    const next = answerOf(post(stack.patient, request));
    await vi.waitFor(() => expect(next.state()).toBe('fulfilled'), ANSWER_WAIT);

    expect(next.value()?.status).toBe(200);
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls.filter((call) => call.args[0] === 'find-generic-password')).toHaveLength(2);
  });

  it('a secret_unavailable limit lets the model fall to its fallback', async (context) => {
    const timers = gatewayTimers();
    const stack = await startStack(context, KEYCHAIN, { secrets: { [K]: SECRET }, secretName: K, anthropicScript: [], fallbackTo: ['local'], control: { calls: 'hang' }, timers });

    const response = await answerAtLimit(stack, timers, 300_000);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).momonga).toMatchObject({ target: 'fake/local-fake', fallbackFrom: ['claude/claude-fake'] });
    expect(stack.anthropic.requests).toEqual([]);
  });
});
