import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_TOOL_BINARY, SECURITY_BINARY, KEYCHAIN_SERVICE, createJsonLogger, createUdsClient, systemClock, FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, anthropicErrorReply, anthropicTextReply, createFakeSecurityPort, openResponsesTextReply, registerCleanup, startFakeAnthropic, startFakeOpenResponses, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeSecurityPort, FakeUpstreamReply, FakeUpstreamServer } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, fakeSecretHost, homePaths, portOnSecretHost, writeSettings, prepareHome } from './gateway-process-helpers.ts';
import type { SecretHost } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED, expectNoCredential } from './credential-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SECRET = 'sk-ant-api03-stored-in-keychain-0001';
const SECRET_NAME = 'anthropic-main';
const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

type HostStore = {
  label: string;
  program: string;
  canonicalBinary: string;
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
    lookupArgs: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', SECRET_NAME, '-w'],
    missingExit: 44,
    storeCommand: `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${SECRET_NAME} -w`,
    extraEnv: {},
  },
  {
    label: 'Secret Service',
    program: 'secret-tool',
    canonicalBinary: SECRET_TOOL_BINARY,
    lookupArgs: ['lookup', 'service', KEYCHAIN_SERVICE, 'account', SECRET_NAME],
    missingExit: 1,
    storeCommand: `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${SECRET_NAME}`,
    extraEnv: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/momonga-test-bus' },
  },
];

const fakeHostPath = (context: CleanupContext, store: HostStore): SecretHost => fakeSecretHost(withTempDir(context), store);

type Stack = {
  home: string;
  client: UdsClient;
  handle: GatewayProcess;
  anthropic: FakeUpstreamServer;
  openResponses: FakeUpstreamServer;
  security: FakeSecurityPort;
  programPath: string;
  logText(): string;
};

const startStack = async (
  context: CleanupContext,
  store: HostStore,
  options: { secrets: Record<string, string>; anthropicScript: FakeUpstreamReply[]; aliasOrder?: string[]; env?: Record<string, string> },
): Promise<Stack> => {
  const anthropic = await startFakeAnthropic({ apiKey: SECRET, script: options.anthropicScript });
  registerCleanup(context, () => anthropic.close());
  const openResponses = await startFakeOpenResponses({ script: [openResponsesTextReply(['from the local target'])] });
  registerCleanup(context, () => openResponses.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, {
    models: {
      aliases: { fast: options.aliasOrder ?? ['claude'] },
      targets: {
        claude: { adapter: 'anthropic', model: 'claude-fake', socketPath: anthropic.socketPath, apiKeySecret: SECRET_NAME, capabilities: CAPABILITIES },
        local: { adapter: 'open-responses', provider: 'fake', model: 'local-fake', socketPath: openResponses.socketPath, capabilities: CAPABILITIES },
      },
    },
  });
  const host = fakeHostPath(context, store);
  const security = portOnSecretHost(createFakeSecurityPort(() => options.secrets), store, host);
  const lines: string[] = [];
  const handle = await startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, { ...host.env, ...options.env }),
    version: PROCESS_VERSION,
    execWithStdin: security,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: (chunk: string) => (lines.push(chunk), true) }, level: 'debug' }),
    stdout: { write: () => true },
  });
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(fixedSocket(handle.socketPath));
  registerCleanup(context, () => client.close());
  return { home, client, handle, anthropic, openResponses, security, programPath: host.programPath, logText: () => lines.join('') };
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

const request = { model: 'fast', input: userInput('hi') };

describe.each(HOST_STORES)('stored secrets in the gateway process, $label found on PATH', (store) => {
  it('resolves the referenced secret through the injected process port and sends it as the Anthropic key', async (context) => {
    const stack = await startStack(context, store, { secrets: { [SECRET_NAME]: SECRET, unreferenced: 'never-read-0000000000' }, anthropicScript: [anthropicTextReply(['hello'])] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).status).toBe('completed');
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls).toEqual([{ file: stack.programPath, args: store.lookupArgs, stdin: '' }]);
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
    expect(stack.security.calls).toHaveLength(1);
    const file = homePaths(stack.home).settings;
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { targets: Record<string, Record<string, unknown>> } };
    const claude = settings.models.targets['claude'] as Record<string, unknown>;
    const staging = `${file}.changed.tmp`;
    fs.writeFileSync(staging, JSON.stringify({ ...settings, models: { ...settings.models, targets: { ...settings.models.targets, claude: { ...claude, model: 'claude-fake-changed' } } } }), { mode: 0o600 });
    fs.renameSync(staging, file);
    expect((await post(stack.client, request)).status).toBe(200);
    expect(stack.security.calls).toHaveLength(2);
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
    expect(stack.security.calls).toHaveLength(1);
  });

  it('reads a secret that was added after start on the next request, then stops reading it', async (context) => {
    const secrets: Record<string, string> = {};
    const stack = await startStack(context, store, { secrets, anthropicScript: [anthropicTextReply(['a']), anthropicTextReply(['b'])] });
    expect(stack.security.calls).toEqual([]);
    expect((await post(stack.client, request)).status).toBe(401);
    expect(stack.security.calls).toHaveLength(1);
    secrets[SECRET_NAME] = SECRET;
    const added = await post(stack.client, request);
    expect(added.status).toBe(200);
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls).toHaveLength(2);
    expect((await post(stack.client, request)).status).toBe(200);
    expect(stack.security.calls).toHaveLength(2);
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
    const stack = await startStack(context, store, { secrets: {}, anthropicScript: [], aliasOrder: ['claude', 'local'] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    const resource = JSON.parse(response.text);
    expect(resource.momonga).toMatchObject({ target: 'local', fallbackFrom: ['claude'] });
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
      models: {
        aliases: { fast: ['claude'], other: ['local'] },
        targets: {
          claude: { adapter: 'anthropic', model: 'm', socketPath: anthropic.socketPath, apiKeySecret: SECRET_NAME, capabilities: CAPABILITIES },
          local: { adapter: 'open-responses', provider: 'fake', model: 'local-fake', socketPath: openResponses.socketPath, capabilities: CAPABILITIES },
        },
      },
    });
    let portCalls = 0;
    const handle = await startGatewayProcess({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home, fakeHostPath(context, store).env),
      version: PROCESS_VERSION,
      execWithStdin: async () => {
        portCalls += 1;
        throw new Error('spawn security ENOENT');
      },
      stdout: { write: () => true },
    });
    registerCleanup(context, async () => {
      await handle.close();
    });
    const client = createUdsClient(fixedSocket(handle.socketPath));
    registerCleanup(context, () => client.close());
    expect(portCalls).toBe(0);
    const failed = await post(client, request);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.text).toContain('spawn security ENOENT');
    expect(anthropic.requests).toEqual([]);
    expect(portCalls).toBe(1);
    const other = await post(client, { model: 'other', input: userInput('hi') });
    expect(other.status).toBe(200);
    expect(JSON.parse(other.text).momonga).toMatchObject({ target: 'local' });
  });

  it('never invokes the process port when no target references a secret', async (context) => {
    const openResponses = await startFakeOpenResponses({ script: [] });
    registerCleanup(context, () => openResponses.close());
    const home = withTempDir(context, { asHome: true });
    prepareHome(home);
    writeSettings(home, {
      models: { aliases: { fast: ['local'] }, targets: { local: { adapter: 'open-responses', provider: 'fake', model: 'm', socketPath: openResponses.socketPath, capabilities: CAPABILITIES } } },
    });
    const security = createFakeSecurityPort(() => ({}));
    const handle = await startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home, fakeHostPath(context, store).env), version: PROCESS_VERSION, execWithStdin: security, stdout: { write: () => true } });
    registerCleanup(context, async () => {
      await handle.close();
    });
    expect(security.calls).toEqual([]);
  });
});
