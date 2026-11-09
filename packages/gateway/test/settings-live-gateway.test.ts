import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FIRST_GENERATION, createJsonLogger, createUdsClient, fixedSocket, systemClock } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import {
  REAL_PROCESS_TEST_TIMEOUT_MS,
  decodeOtlpSpans,
  openResponsesTextReply,
  registerCleanup,
  startFakeChatCompletions,
  startFakeOpenResponses,
  startOtlpCollector,
  usageOf,
  waitFor,
  withTempDir,
} from '@momonga/testkit';
import type { CleanupContext, FakeChatCompletionsServer, FakeScriptedReply, OtlpCollector } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, ccTarget, homePaths } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import { REDACTED } from './credential-support.ts';

const NO_GRACE = { closeGraceMs: 0, managedServerStopGraceMs: 0 };

let settingsWrites = 0;

const replaceSettings = (home: string, value: unknown): void => {
  const { root, settings } = homePaths(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  settingsWrites += 1;
  const temporary = path.join(root, `.settings-live-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}${' '.repeat(settingsWrites)}`, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

const replaceSettingsText = (home: string, text: string): void => {
  const { root, settings } = homePaths(home);
  settingsWrites += 1;
  const temporary = path.join(root, `.settings-live-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

type Stack = { home: string; handle: GatewayProcess; client: UdsClient; logText(): string };

const startStack = async (context: CleanupContext, settings: unknown, env: Record<string, string> = {}): Promise<Stack> => {
  const home = withTempDir(context, { asHome: true });
  replaceSettings(home, settings);
  const chunks: string[] = [];
  const handle = await startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, env),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: { write: (chunk: string) => (chunks.push(chunk), true) }, level: 'debug' }),
    stdout: { write: () => true },
  });
  registerCleanup(context, async () => {
    await handle.close(NO_GRACE);
  });
  const client = createUdsClient(fixedSocket(handle.socketPath));
  registerCleanup(context, () => client.destroy());
  return { home, handle, client, logText: () => chunks.join('') };
};

const fakeUpstream = async (context: CleanupContext, routes: FakeScriptedReply[] = []): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', ...(routes.length === 0 ? {} : { routes: routes.map((reply) => ({ match: () => true, reply })) }) });
  registerCleanup(context, () => fake.close());
  return fake;
};

const post = async (client: UdsClient, payload: unknown): Promise<{ status: number; text: string }> => {
  const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, text: await response.text() };
};

const ask = (model = 'fast', extra: Record<string, unknown> = {}) => ({ model, input: userInput('hi'), ...extra });

const twoTargets = (a: FakeChatCompletionsServer, b: FakeChatCompletionsServer, alias: 'a' | 'b', extra: Record<string, unknown> = {}) => ({
  models: { aliases: { fast: [alias] }, targets: { a: ccTarget(a.socketPath), b: ccTarget(b.socketPath) } },
  ...extra,
});

const heldRequest = async (client: UdsClient, fake: FakeChatCompletionsServer, payload: unknown = ask()) => {
  const hold = fake.hold();
  const settled = post(client, payload).catch((error: unknown) => ({ status: -1, text: String(error) }));
  await hold.waitForRequest();
  return { hold, settled };
};

describe('S1 gateway: each request pins the router it started with (design-settings-live 3.1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a request in flight keeps its adapter after the alias is repointed; a request that starts after the change uses the new target', async (context) => {
    const a = await fakeUpstream(context);
    const b = await fakeUpstream(context);
    const stack = await startStack(context, twoTargets(a, b, 'a'));
    const first = await heldRequest(stack.client, a);
    replaceSettings(stack.home, twoTargets(a, b, 'b'));
    const second = await post(stack.client, ask());
    expect(second.status).toBe(200);
    expect(b.requests).toHaveLength(1);
    first.hold.release();
    expect((await first.settled).status).toBe(200);
    expect(a.requests).toHaveLength(1);
  });

  it('an invalid file after a valid change: the gateway serves on its last good epoch and refuses nothing', async (context) => {
    const a = await fakeUpstream(context);
    const b = await fakeUpstream(context);
    const stack = await startStack(context, twoTargets(a, b, 'a'));
    replaceSettings(stack.home, twoTargets(a, b, 'b'));
    replaceSettingsText(stack.home, '{ "models": ');
    const answered = await post(stack.client, ask());
    expect(answered.status).toBe(200);
    expect(b.requests).toHaveLength(1);
    expect(a.requests).toEqual([]);
  });

  it('an open WebSocket connection is not closed by a change, and its next frame sees the change', async (context) => {
    const a = await fakeUpstream(context);
    const b = await fakeUpstream(context);
    const stack = await startStack(context, twoTargets(a, b, 'a'));
    const socket = new WebSocket(`ws+unix://${stack.handle.socketPath}:/v1/responses`);
    registerCleanup(context, () => socket.terminate());
    const messages: Array<Record<string, unknown>> = [];
    let closed = false;
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    socket.on('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const terminals = (): number => messages.filter((message) => ['response.completed', 'response.failed', 'error'].includes(String(message['type']))).length;
    socket.send(JSON.stringify({ type: 'response.create', store: false, ...ask() }));
    await waitFor(() => terminals() === 1, { description: 'the first frame to complete' });
    replaceSettings(stack.home, twoTargets(a, b, 'b'));
    socket.send(JSON.stringify({ type: 'response.create', store: false, ...ask() }));
    await waitFor(() => terminals() === 2, { description: 'the second frame to complete' });
    expect(closed).toBe(false);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });
});

describe('S1 gateway: breaker and gate are carried over by the identity of the target (design-settings-live 3.1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  const gated = (fake: FakeChatCompletionsServer, extra: Record<string, unknown> = {}) => ccTarget(fake.socketPath, { maxConcurrency: 1, ...extra });

  it('a change that leaves the target unchanged keeps one gate: a request of the new epoch waits for the in-flight one of the old epoch', async (context) => {
    const a = await fakeUpstream(context);
    const stack = await startStack(context, { models: { aliases: { fast: ['a'] }, targets: { a: gated(a) } } });
    const first = await heldRequest(stack.client, a);
    replaceSettings(stack.home, { models: { aliases: { fast: ['a'], other: ['a'] }, targets: { a: gated(a) } }, network: { noProxy: 'example.invalid' } });
    let secondSettled = false;
    const second = post(stack.client, ask('other')).finally(() => {
      secondSettled = true;
    });
    for (let turn = 0; turn < 200; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled, 'the request of the new epoch through the added alias must wait at the carried gate').toBe(false);
    expect(a.requests).toHaveLength(1);
    first.hold.release();
    expect((await second).status).toBe(200);
    expect(a.requests).toHaveLength(2);
  });

  it('a changed definition of the target starts with a new gate: a request of the new epoch does not wait for the old one', async (context) => {
    const a = await fakeUpstream(context);
    const stack = await startStack(context, { models: { aliases: { fast: ['a'] }, targets: { a: gated(a) } } });
    const first = await heldRequest(stack.client, a);
    replaceSettings(stack.home, { models: { aliases: { fast: ['a'] }, targets: { a: gated(a, { model: 'system-changed' }) } } });
    const second = post(stack.client, ask()).catch((error: unknown) => ({ status: -1, text: String(error) }));
    await waitFor(() => a.requests.length === 2, { maxTurns: 20_000, description: 'the request of the changed definition to reach the upstream while the old one is in flight' });
    expect((a.requests[1]?.body as { model?: string } | undefined)?.model).toBe('system-changed');
    expect((await second).status).toBe(200);
    first.hold.release();
    await first.settled;
  });
});

describe('S1 gateway: the redactor learns the credentials of a target added by a change (design-settings-live 3.1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('redacts the apiKeyEnv value of a target added after start', async (context) => {
    const KEY_ENV = 'MOMONGA_TEST_ADDED_KEY';
    const KEY = 'added-target-credential-0123456789';
    const a = await fakeUpstream(context);
    const echo = await fakeUpstream(context, [{ kind: 'error', status: 400, body: { error: { message: `bad request, key ${KEY} was echoed`, type: 'invalid_request_error', param: null, code: null } } }]);
    const stack = await startStack(context, { models: { aliases: { fast: ['a'] }, targets: { a: ccTarget(a.socketPath) } } }, { [KEY_ENV]: KEY });
    replaceSettings(stack.home, { models: { aliases: { fast: ['a'], added: ['echo'] }, targets: { a: ccTarget(a.socketPath), echo: ccTarget(echo.socketPath, { apiKeyEnv: KEY_ENV }) } } });
    const answered = await post(stack.client, ask('added'));
    expect(echo.requests).toHaveLength(1);
    expect(answered.text).toContain(REDACTED);
    expect(answered.text).not.toContain(KEY);
    expect(stack.logText()).not.toContain(KEY);
  });
});

describe('S1 gateway: pricing applies from the next request (design-settings-live 3.3)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a request that starts after a pricing change is priced with the new table', async (context) => {
    const upstream = await startFakeOpenResponses({ script: [openResponsesTextReply(['priced'], usageOf(11, 3))] });
    registerCleanup(context, () => upstream.close());
    const target = { adapter: 'open-responses', provider: 'acme', model: 'local-fake', socketPath: upstream.socketPath, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } };
    const stack = await startStack(context, { models: { aliases: { fast: ['local'] }, targets: { local: target } } });
    replaceSettings(stack.home, {
      models: { aliases: { fast: ['local'] }, targets: { local: target } },
      pricing: [{ provider: 'acme', model: 'local-fake', effectiveFrom: '2026-01-01', inputPerMTok: 1_000_000, outputPerMTok: 2_000_000, currency: 'USD' }],
    });
    expect((await post(stack.client, ask('fast', { metadata: { run_id: 'run-1' } }))).status).toBe(200);
    const cost = await stack.client.request({
      method: 'POST',
      path: '/v1/momonga/cost',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [{ runId: 'run-1', sessionId: 'session-1' }], includeRunless: false }),
    });
    const { report } = (await cost.json()) as { report: { total: Record<string, unknown> } };
    expect(report.total).toMatchObject({ calls: 1, unpricedCalls: 0, amount: 17, currency: 'USD' });
  });
});

type Proxy = { port: number; connects(): string[]; openSockets(): number; dropConnections(): void };

const startProxy = async (context: CleanupContext, answer: 'silent' | 'refuse'): Promise<Proxy> => {
  const connects: string[] = [];
  const sockets = new Set<net.Socket>();
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
      if (answer === 'refuse' && socket.writable) socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
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
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
};

const REMOTE_KEY_ENV = 'MOMONGA_TEST_REMOTE_KEY';
const remoteTarget = {
  adapter: 'anthropic',
  model: 'model-a',
  baseUrl: 'https://model.example.test',
  apiKeyEnv: REMOTE_KEY_ENV,
  capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
};

describe('S1 gateway: a changed network applies from the next connection (design-settings-live 3.4)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a request that starts after the change goes through the new proxy, and the running request keeps its connection open', async (context) => {
    const before = await startProxy(context, 'silent');
    const after = await startProxy(context, 'refuse');
    const models = { aliases: { fast: ['remote'] }, targets: { remote: remoteTarget } };
    const stack = await startStack(context, { models, network: { httpsProxy: `http://127.0.0.1:${before.port}` } }, { [REMOTE_KEY_ENV]: 'remote-key-0123456789' });
    registerCleanup(context, () => {
      before.dropConnections();
      after.dropConnections();
    });
    void post(stack.client, ask('fast', { stream: false })).catch(() => undefined);
    await waitFor(() => before.connects().length === 1, { description: 'the first request to reach the first proxy' });
    replaceSettings(stack.home, { models, network: { httpsProxy: `http://127.0.0.1:${after.port}` } });
    void post(stack.client, ask('fast', { stream: false })).catch(() => undefined);
    await waitFor(() => after.connects().length > 0 || before.connects().length > 1, { maxTurns: 20_000, description: 'the second request to reach a proxy' });
    expect(after.connects()).toEqual(['CONNECT model.example.test:443 HTTP/1.1']);
    expect(before.connects()).toHaveLength(1);
    expect(before.openSockets()).toBe(1);
  });
});

const spanTraces = (collector: OtlpCollector): Set<string> => new Set(decodeOtlpSpans(collector.requests).map((span) => span.traceId));

describe('S1 gateway: the redactor learns the proxy password of a changed network (design-settings-live 3.1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('redacts the password of a proxy set by a change from the answer and the log', async (context) => {
    const PROXY_PASSWORD = 'changed-proxy-password-0123456789';
    const initial = await startProxy(context, 'refuse');
    const refusing = await startProxy(context, 'refuse');
    const models = { aliases: { fast: ['remote'] }, targets: { remote: remoteTarget } };
    const stack = await startStack(context, { models, network: { httpsProxy: `http://127.0.0.1:${initial.port}` } }, { [REMOTE_KEY_ENV]: 'remote-key-0123456789' });
    registerCleanup(context, () => {
      initial.dropConnections();
      refusing.dropConnections();
    });
    replaceSettings(stack.home, { models, network: { httpsProxy: `http://user:${PROXY_PASSWORD}@127.0.0.1:${refusing.port}` } });
    const answered = await post(stack.client, ask('fast', { stream: false }));
    expect(refusing.connects()).toEqual(['CONNECT model.example.test:443 HTTP/1.1']);
    expect(answered.text).not.toContain(PROXY_PASSWORD);
    expect(stack.logText()).not.toContain(PROXY_PASSWORD);
  });
});

describe('S2 gateway telemetry: a span ends on the provider it started on (design-settings-live 3.3)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a span started before the change is exported by the old provider; a request after the change is exported by the new one', async (context) => {
    const first = await startOtlpCollector();
    registerCleanup(context, () => first.close());
    const second = await startOtlpCollector();
    registerCleanup(context, () => second.close());
    const a = await fakeUpstream(context);
    const models = { aliases: { fast: ['a'] }, targets: { a: ccTarget(a.socketPath) } };
    const stack = await startStack(context, { models, telemetry: { otlp: { endpoint: first.endpoint } } });
    const held = await heldRequest(stack.client, a);
    replaceSettings(stack.home, { models, telemetry: { otlp: { endpoint: second.endpoint } } });
    expect((await post(stack.client, ask())).status).toBe(200);
    held.hold.release();
    expect((await held.settled).status).toBe(200);
    await stack.handle.close(NO_GRACE);
    expect(spanTraces(first).size).toBe(1);
    expect(spanTraces(second).size).toBe(1);
    expect([...spanTraces(first)].some((trace) => spanTraces(second).has(trace))).toBe(false);
  });
});
