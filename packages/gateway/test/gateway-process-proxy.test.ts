import { systemProcessPorts } from '../src/process-ports.ts';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, createUdsClient, systemClock, FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, driveFakeTime, registerCleanup, startFakeChatCompletions, withTempDir, registerOwned, testLocks } from '@momonga/testkit';
import type { CleanupContext, FakeScriptedReply } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, ccTarget, writeSettings, modelsOf, prepareHome, notTheRoleTick } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED } from './credential-support.ts';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROXY_PASSWORD = 'proxy-password-0123456789';
const body = { model: 'primary/system', input: userInput('hi') };

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

const PROXY_407 = 'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n';

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

const startRefusingProxy = async (context: CleanupContext): Promise<{ port: number; received: () => string }> => {
  let text = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.endsWith('\r\n\r\n') && socket.writable) socket.end(PROXY_407);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerCleanup(context, async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text };
};

type FakeTime = { clock: ReturnType<typeof createFakeClock>; timers: ReturnType<typeof createFakeTimers> };

const startGateway = async (context: CleanupContext, settings: unknown, env: Record<string, string> = {}, time?: FakeTime) => {
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, settings);
  const log = captureLog();
  const handle = await registerOwned(context, () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  platform: process.platform,
    locks: testLocks(),
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, env),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: log, level: 'debug' }),
    stdout: { write: () => true },
    ...(time === undefined ? {} : { clock: time.clock, timers: time.timers, random: () => 0.5 }),
  }));
  registerCleanup(context, async () => {
    await handle.close();
  });
  const client = createUdsClient(fixedSocket(handle.socketPath), { connectTimeoutMs: 0 });
  registerCleanup(context, () => client.close());
  return { handle, client, log };
};

const post = async (client: UdsClient, payload: unknown): Promise<{ status: number; text: string }> => {
  const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, text: await response.text() };
};

describe('gateway: the proxy password is a credential', () => {
  it.for([
    { label: 'the network.httpsProxy setting', network: { httpsProxy: `http://user:${PROXY_PASSWORD}@proxy.corp:3128` }, env: {} },
    { label: 'the HTTPS_PROXY variable', network: undefined, env: { HTTPS_PROXY: `http://user:${PROXY_PASSWORD}@proxy.corp:3128` } },
  ])('redacts a password from $label in upstream text', async ({ network, env }, context) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', routes: [{ match: () => true, reply: echo401(`proxy said ${PROXY_PASSWORD}`) }] });
    registerCleanup(context, () => fake.close());
    const { client, log } = await startGateway(
      context,
      { models: modelsOf({ primary: ccTarget(fake.socketPath) }), ...(network === undefined ? {} : { network }) },
      env,
    );

    const response = await post(client, body);

    expect(response.status).toBe(401);
    expect(response.text).not.toContain(PROXY_PASSWORD);
    expect(response.text).toContain(REDACTED);
    expect(log.text()).not.toContain(PROXY_PASSWORD);
  });
});

describe('gateway: a model call to a remote target goes through the configured proxy', () => {
  it('sends the CONNECT to the proxy from network.httpsProxy and names the proxy hop and its source when it refuses', async (context) => {
    const proxy = await startRefusingProxy(context);
    const remote = {
      adapter: 'chat-completions',
      model: 'system',
      baseUrl: 'https://model.example.test/v1',
      toolCalling: 'native',
      capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
    };
    const { client } = await startGateway(context, {
      models: modelsOf({ primary: remote }, { headersTimeoutMs: 300  }),
      network: { httpsProxy: `http://127.0.0.1:${proxy.port}` },
    });

    const response = await post(client, { ...body, stream: false });

    expect(proxy.received()).toContain('CONNECT model.example.test:443');
    const error = JSON.parse(response.text).error;
    expect(error.code).toBe('proxy_authentication_required');
    expect(error.message).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(error.message).toContain('network.httpsProxy');
  });
});

const ANTHROPIC_KEY_ENV = 'MOMONGA_TEST_ANTHROPIC_KEY';

const REMOTE_TARGET = {
  adapter: 'anthropic',
  model: 'model-a',
  baseUrl: 'https://model.example.test',
  apiKeyEnv: ANTHROPIC_KEY_ENV,
  capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
};

describe('gateway: a model call through a proxy that never answers CONNECT', () => {
  it('ends every attempt at the model headers bound and names the proxy hop and its source', async (context) => {
    const proxy = await startSilentProxy(context);
    const clock = createFakeClock(Date.now());
    const timers = createFakeTimers(clock);
    const startedAt = clock.now();
    const { client } = await startGateway(
      context,
      { models: modelsOf({ primary: REMOTE_TARGET }, { headersTimeoutMs: 300  }), network: { httpsProxy: `http://127.0.0.1:${proxy.port}` } },
      { [ANTHROPIC_KEY_ENV]: 'test-anthropic-key-0123456789' },
      { clock, timers },
    );

    const pending = post(client, { ...body, model: 'primary/model-a', stream: false });
    let settled = false;
    const settle = (): void => {
      settled = true;
    };
    void pending.then(settle, settle);
    await driveFakeTime(timers, { done: () => settled, considered: notTheRoleTick, horizonAt: startedAt + GATEWAY_CONFIG_DEFAULTS.retry.totalWaitMs, description: 'the answer to a request through a silent proxy' });
    const response = await pending;

    expect(proxy.received()).toContain('CONNECT model.example.test:443');
    const error = JSON.parse(response.text).error;
    expect(error.code).toBe('provider_unavailable');
    expect(error.message).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(error.message).toContain('network.httpsProxy');
  });
});
