import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createJsonLogger, createUdsClient, systemClock } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, startFakeChatCompletions, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeScriptedReply } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, ccTarget, writeSettings } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED } from './credential-support.ts';

const PROXY_PASSWORD = 'proxy-password-0123456789';
const body = { model: 'fast', input: userInput('hi') };

const echo401 = (message: string): FakeScriptedReply => ({
  kind: 'error',
  status: 401,
  body: { error: { message, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
});

const captureLog = (): { write: (chunk: string) => boolean; text: () => string } => {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
};

const startSilentProxy = async (context: CleanupContext): Promise<{ port: number; received: () => string }> => {
  let text = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerCleanup(context, async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text };
};

const startGateway = async (context: CleanupContext, settings: unknown, env: Record<string, string> = {}) => {
  const home = withTempDir(context, { asHome: true });
  writeSettings(home, settings);
  const log = captureLog();
  const handle = await startGatewayProcess({
    home,
    env: baseEnv(home, env),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: log, level: 'debug' }),
    stdout: { write: () => true },
  });
  registerCleanup(context, () => handle.close());
  const client = createUdsClient(handle.socketPath);
  registerCleanup(context, () => client.close());
  return { handle, client, log };
};

const post = async (client: UdsClient, payload: unknown): Promise<{ status: number; text: string }> => {
  const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, text: await response.text() };
};

describe('gateway: the proxy password is a credential', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.for([
    { label: 'the network.httpsProxy setting', network: { httpsProxy: `http://user:${PROXY_PASSWORD}@proxy.corp:3128` }, env: {} },
    { label: 'the HTTPS_PROXY variable', network: undefined, env: { HTTPS_PROXY: `http://user:${PROXY_PASSWORD}@proxy.corp:3128` } },
  ])('redacts a password from $label in upstream text', async ({ network, env }, context) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', routes: [{ match: () => true, reply: echo401(`proxy said ${PROXY_PASSWORD}`) }] });
    registerCleanup(context, () => fake.close());
    const { client, log } = await startGateway(
      context,
      { models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath) } }, ...(network === undefined ? {} : { network }) },
      env,
    );

    const response = await post(client, body);

    expect(response.status).toBe(401);
    expect(response.text).not.toContain(PROXY_PASSWORD);
    expect(response.text).toContain(REDACTED);
    expect(log.text()).not.toContain(PROXY_PASSWORD);
  });
});

describe('gateway: a model call through a proxy that never answers CONNECT', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('ends at the model headers bound and names the proxy hop and its source', async (context) => {
    const proxy = await startSilentProxy(context);
    const remote = {
      adapter: 'chat-completions',
      provider: 'fake',
      model: 'system',
      baseUrl: 'https://model.example.test/v1',
      toolCalling: 'native',
      capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
    };
    const { client } = await startGateway(context, {
      models: { aliases: { fast: ['primary'] }, targets: { primary: remote }, headersTimeoutMs: 300 },
      network: { httpsProxy: `http://127.0.0.1:${proxy.port}` },
    });

    const response = await post(client, { ...body, stream: false });

    expect(proxy.received()).toContain('CONNECT model.example.test:443');
    const error = JSON.parse(response.text).error;
    expect(error.code).toBe('provider_unavailable');
    expect(error.message).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(error.message).toContain('network.httpsProxy');
  });
});
