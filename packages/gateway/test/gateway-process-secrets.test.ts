import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECURITY_BINARY, KEYCHAIN_SERVICE, createJsonLogger, createUdsClient, systemClock } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import {
  anthropicErrorReply,
  anthropicTextReply,
  createFakeSecurityPort,
  openResponsesTextReply,
  registerCleanup,
  startFakeAnthropic,
  startFakeOpenResponses,
  withTempDir,
} from '@momonga/testkit';
import type { CleanupContext, FakeSecurityPort, FakeUpstreamReply, FakeUpstreamServer } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, homePaths, writeSettings } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED, expectNoCredential } from './credential-support.ts';

const SECRET = 'sk-ant-api03-stored-in-keychain-0001';
const SECRET_NAME = 'anthropic-main';
const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

type Stack = {
  home: string;
  client: UdsClient;
  handle: GatewayProcess;
  anthropic: FakeUpstreamServer;
  openResponses: FakeUpstreamServer;
  security: FakeSecurityPort;
  logText(): string;
};

const startStack = async (
  context: CleanupContext,
  options: { secrets: Record<string, string>; anthropicScript: FakeUpstreamReply[]; aliasOrder?: string[]; env?: Record<string, string> },
): Promise<Stack> => {
  const anthropic = await startFakeAnthropic({ apiKey: SECRET, script: options.anthropicScript });
  registerCleanup(context, () => anthropic.close());
  const openResponses = await startFakeOpenResponses({ script: [openResponsesTextReply(['from the local target'])] });
  registerCleanup(context, () => openResponses.close());
  const home = withTempDir(context, { asHome: true });
  writeSettings(home, {
    models: {
      aliases: { fast: options.aliasOrder ?? ['claude'] },
      targets: {
        claude: { adapter: 'anthropic', model: 'claude-fake', socketPath: anthropic.socketPath, apiKeySecret: SECRET_NAME, capabilities: CAPABILITIES },
        local: { adapter: 'open-responses', model: 'local-fake', socketPath: openResponses.socketPath, capabilities: CAPABILITIES },
      },
    },
  });
  const security = createFakeSecurityPort(() => options.secrets);
  const lines: string[] = [];
  const handle = await startGatewayProcess({
    home,
    env: baseEnv(home, options.env),
    version: PROCESS_VERSION,
    execWithStdin: security,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: (chunk: string) => (lines.push(chunk), true) }, level: 'debug' }),
    stdout: { write: () => true },
  });
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(handle.socketPath);
  registerCleanup(context, () => client.close());
  return { home, client, handle, anthropic, openResponses, security, logText: () => lines.join('') };
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

describe('stored secrets in the gateway process', () => {
  it('resolves the referenced secret through the injected process port and sends it as the Anthropic key', async (context) => {
    const stack = await startStack(context, { secrets: { [SECRET_NAME]: SECRET, unreferenced: 'never-read-0000000000' }, anthropicScript: [anthropicTextReply(['hello'])] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).status).toBe('completed');
    expect(stack.anthropic.requests[0]?.headers['x-api-key']).toBe(SECRET);
    expect(stack.security.calls).toEqual([
      { file: SECURITY_BINARY, args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', SECRET_NAME, '-w'], stdin: '' },
    ]);
    expect(fs.readFileSync(homePaths(stack.home).settings, 'utf8')).not.toContain(SECRET);
  });

  it('reads each referenced secret once at startup, not per request', async (context) => {
    const stack = await startStack(context, { secrets: { [SECRET_NAME]: SECRET }, anthropicScript: [anthropicTextReply(['a']), anthropicTextReply(['b'])] });
    await post(stack.client, request);
    await post(stack.client, request);
    expect(stack.security.calls).toHaveLength(1);
  });

  it('redacts the resolved secret from upstream error text', async (context) => {
    const stack = await startStack(context, {
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
    const stack = await startStack(context, { secrets: {}, anthropicScript: [anthropicTextReply(['unreachable'])] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(401);
    const error = JSON.parse(response.text).error;
    expect(error).toMatchObject({ type: 'invalid_request', code: 'secret_unavailable', param: SECRET_NAME });
    expect(error.message).toContain('exit 44');
    expect(error.message).toContain(`security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${SECRET_NAME} -w`);
    expect(stack.anthropic.requests).toEqual([]);
    expect(stack.logText()).toContain(`secret ${SECRET_NAME} is unavailable`);
  });

  it('falls through to the next target of the alias when a target secret is unavailable', async (context) => {
    const stack = await startStack(context, { secrets: {}, anthropicScript: [], aliasOrder: ['claude', 'local'] });
    const response = await post(stack.client, request);
    expect(response.status).toBe(200);
    const resource = JSON.parse(response.text);
    expect(resource.momonga).toMatchObject({ target: 'local', fallbackFrom: ['claude'] });
    expect(stack.anthropic.requests).toEqual([]);
  });

  it('does not start when the process port itself fails', async (context) => {
    const anthropic = await startFakeAnthropic({ apiKey: SECRET, script: [] });
    registerCleanup(context, () => anthropic.close());
    const home = withTempDir(context, { asHome: true });
    writeSettings(home, {
      models: {
        aliases: { fast: ['claude'] },
        targets: { claude: { adapter: 'anthropic', model: 'm', socketPath: anthropic.socketPath, apiKeySecret: SECRET_NAME, capabilities: CAPABILITIES } },
      },
    });
    await expect(
      startGatewayProcess({
        home,
        env: baseEnv(home),
        version: PROCESS_VERSION,
        execWithStdin: async () => {
          throw new Error('spawn security ENOENT');
        },
        stdout: { write: () => true },
      }),
    ).rejects.toThrow('spawn security ENOENT');
  });

  it('never invokes the process port when no target references a secret', async (context) => {
    const openResponses = await startFakeOpenResponses({ script: [] });
    registerCleanup(context, () => openResponses.close());
    const home = withTempDir(context, { asHome: true });
    writeSettings(home, {
      models: { aliases: { fast: ['local'] }, targets: { local: { adapter: 'open-responses', model: 'm', socketPath: openResponses.socketPath, capabilities: CAPABILITIES } } },
    });
    const security = createFakeSecurityPort(() => ({}));
    const handle = await startGatewayProcess({ home, env: baseEnv(home), version: PROCESS_VERSION, execWithStdin: security, stdout: { write: () => true } });
    registerCleanup(context, async () => {
    await handle.close();
  });
    expect(security.calls).toEqual([]);
  });
});
