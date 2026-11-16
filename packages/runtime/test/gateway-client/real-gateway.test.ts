import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, modelSettings, startFakeChatCompletions, registerOwned, createTempDir, removeTempDir, testLocks } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import { CLIENT_VERSION, callOptions, collect, expectGatewayError, fakeClock, settle, streamBody, userInput } from './fixtures.ts';

const MODEL = 'fake/system';
import { FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import { prepareGatewayHome } from './prepared-home.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const GATEWAY_VERSION = '1.10.0-test';
const REPLY_TEXT = 'Hello there';

type Context = {
  home: string;
  fake: FakeChatCompletionsServer;
  gateway: Awaited<ReturnType<typeof startGatewayProcess>>;
  client: ReturnType<typeof createGatewayClient>;
  restoreStdout: () => void;
};

let context: Context;
let suiteHome: string | undefined;
let closeGateway: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const home = createTempDir({ asHome: true });
  suiteHome = home;
  const fake = await startFakeChatCompletions({
    scenario: 'tools-ok',
    script: [
      {
        kind: 'stream',
        chunks: [{ delta: { role: 'assistant', content: 'Hello' } }, { delta: { content: ' there' }, finishReason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
  });
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify(modelSettings({ models: [{ provider: 'fake', id: 'system', socketPath: fake.socketPath, capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }] })),
    { mode: 0o600 },
  );
  await prepareGatewayHome(home);
  const gateway = await registerOwned(
    (cleanup) => {
      closeGateway = cleanup;
    },
    () => startGatewayProcess({ platform: process.platform, locks: testLocks(), generation: FIRST_GENERATION, home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home }, version: GATEWAY_VERSION }),
  );
  expect(Buffer.byteLength(gateway.socketPath)).toBeLessThan(104);
  const client = createGatewayClient({ resolveSocket: fixedSocket(gateway.socketPath), clock: fakeClock(), version: CLIENT_VERSION });
  context = { home, fake, gateway, client, restoreStdout: () => stdout.mockRestore() };
});

afterAll(async () => {
  await context?.client.destroy().catch(() => {});
  await closeGateway();
  await context?.fake.close();
  context?.restoreStdout();
  if (suiteHome !== undefined) await removeTempDir(suiteHome);
});

describe('gateway client against a real gateway', () => {
  it('streams the response events in order and the fake receives the user input', async () => {
    const clock = fakeClock();
    const events = await collect(context.client.stream(streamBody(MODEL), callOptions(clock, { idempotencyKey: 'real-stream-1' })));
    const types = events.map((event) => event.type);

    expect(types.slice(0, 2)).toEqual(['response.created', 'response.in_progress']);
    expect(types.at(-1)).toBe('response.completed');
    const text = events.flatMap((event) => (event.type === 'response.output_text.delta' ? [event.delta] : [])).join('');
    expect(text).toBe(REPLY_TEXT);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_event, index) => index));
  });

  it('lists the models with their capabilities', async () => {
    const listed = await context.client.models();
    expect(listed.map((model) => model.id)).toEqual([MODEL]);
    const models = listed.flatMap((model) => ('probing' in model ? [] : [model]));
    expect(models[0]?.capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
    expect(Object.keys(models[0] ?? {}).sort()).toEqual(['canon', 'capabilities', 'chain', 'id', 'ownName', 'provider']);
    expect(models[0]?.chain.map((member) => member.model)).toEqual([models[0]?.id]);
    expect(models[0]?.chain[0]?.counter).toMatch(/^[0-9a-f]{64}$/);
  });

  it('looks up the capabilities of a member of the chain of the model', async () => {
    const [ready] = (await context.client.models()).flatMap((model) => ('probing' in model ? [] : [model]));
    const target = ready?.chain[0]?.model;
    const capabilities = await context.client.capabilities(MODEL, { signal: new AbortController().signal, target: String(target) });
    expect(capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
  });

  it('looks up capabilities by model', async () => {
    const capabilities = await context.client.capabilities(MODEL, { signal: new AbortController().signal });
    expect(capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
  });

  it('synthesises model_not_found for a model the gateway does not list', async () => {
    const error = await settle(context.client.capabilities('missing', { signal: new AbortController().signal }));
    expectGatewayError(error, { status: 404, type: 'not_found', code: 'model_not_found' });
  });

  it('reports health', async () => {
    expect(await context.client.health()).toMatchObject({ version: GATEWAY_VERSION, apiVersion: 1, pid: process.pid, state: 'running' });
  });

  it('maps the gateway JSON error for an unknown model', async () => {
    const clock = fakeClock();
    const error = await settle(collect(context.client.stream({ model: 'nope', input: userInput('hi'), stream: true }, callOptions(clock, { idempotencyKey: 'real-stream-2' }))));
    expectGatewayError(error, { status: 404, type: 'not_found', code: 'model_not_found', param: 'model' });
  });

  it('answers false when cancelling a key the gateway does not know', async () => {
    expect(await context.client.cancel('never-sent', { signal: new AbortController().signal })).toBe(false);
  });
});
