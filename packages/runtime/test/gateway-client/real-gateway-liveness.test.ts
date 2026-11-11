import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, modelSettings, startFakeChatCompletions, registerOwned, createTempDir, removeTempDir } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import { CLIENT_VERSION, callOptions, collect, expectGatewayError, fakeClock, settle, streamBody, userInput } from './fixtures.ts';
import { FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import { prepareGatewayHome } from './prepared-home.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const IDLE_BOUND_MS = 300;
const SILENCE_MS = 900;
const REPLY = {
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant', content: 'Hello' } }, { delta: { content: ' there' }, finishReason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const FAILURE = { kind: 'error' as const, status: 500, body: { error: { message: 'down', type: 'server_error', code: 'upstream_error' } } };

type Context = {
  home: string;
  primary: FakeChatCompletionsServer;
  secondary: FakeChatCompletionsServer;
  gateway: Awaited<ReturnType<typeof startGatewayProcess>>;
  client: ReturnType<typeof createGatewayClient>;
  restoreStdout: () => void;
};

let context: Context;
let suiteHome: string | undefined;
let closeGateway: () => Promise<void> = async () => undefined;

const PRIMARY = 'primary/system';
const SECONDARY = 'secondary/system';

const served = (provider: string, socketPath: string) => ({ provider, id: 'system', socketPath, capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } });

beforeAll(async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const home = createTempDir({ asHome: true });
  suiteHome = home;
  const primary = await startFakeChatCompletions({ scenario: 'tools-ok', script: [REPLY, FAILURE, FAILURE, FAILURE] });
  const secondary = await startFakeChatCompletions({ scenario: 'tools-ok', script: [REPLY] });
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify(modelSettings({ models: [served('primary', primary.socketPath), served('secondary', secondary.socketPath)], fallback: [SECONDARY] })),
    { mode: 0o600 },
  );
  await prepareGatewayHome(home);
  const gateway = await registerOwned(
    (cleanup) => {
      closeGateway = cleanup;
    },
    () => startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home },
    version: '1.10.0-test',
    random: () => 0,
  }),
  );
  const client = createGatewayClient({ resolveSocket: fixedSocket(gateway.socketPath), clock: fakeClock(), version: CLIENT_VERSION, streamIdleTimeoutMs: IDLE_BOUND_MS });
  context = { home, primary, secondary, gateway, client, restoreStdout: () => stdout.mockRestore() };
});

afterAll(async () => {
  await context?.client.destroy().catch(() => {});
  await closeGateway();
  await context?.primary.close();
  await context?.secondary.close();
  context?.restoreStdout();
  if (suiteHome !== undefined) await removeTempDir(suiteHome);
});

describe('a silent upstream behind a real gateway and the real gateway client', () => {
  it('completes a call whose upstream is silent for longer than the client idle bound', async () => {
    const hold = context.primary.hold();
    const pending = collect(context.client.stream(streamBody(PRIMARY), callOptions(fakeClock(), { idempotencyKey: 'silent-1' })));
    await hold.waitForRequest();
    await delay(SILENCE_MS);
    hold.release();

    const events = await pending;

    expect(events.at(-1)?.type).toBe('response.completed');
  });

  it('falls back to the next model of the fallback order after the first one stayed silent past the idle bound and then failed', async () => {
    const hold = context.primary.hold();
    const pending = collect(context.client.stream(streamBody(PRIMARY), callOptions(fakeClock(), { idempotencyKey: 'silent-2' })));
    await hold.waitForRequest();
    await delay(SILENCE_MS);
    hold.release();

    const events = await pending;

    const completed = events.at(-1);
    expect(completed?.type).toBe('response.completed');
    expect(completed?.type === 'response.completed' ? completed.response.momonga?.fallbackFrom : undefined).toEqual([PRIMARY]);
  });

  it('completes a compaction whose upstream is silent for longer than the client idle bound', async () => {
    const hold = context.primary.hold();
    const pending = context.client.compact({ model: PRIMARY, input: userInput('a long conversation') }, callOptions(fakeClock(), { idempotencyKey: 'silent-4' }));
    await hold.waitForRequest();
    await delay(SILENCE_MS);
    hold.release();

    expect(await pending).toMatchObject({ object: 'response.compaction', output: [{ type: 'compaction' }] });
  });

  it('streams the summary call to the upstream, so its liveness is per chunk', async () => {
    const before = context.primary.requests.length;
    await context.client.compact({ model: PRIMARY, input: userInput('another long conversation') }, callOptions(fakeClock(), { idempotencyKey: 'silent-5' }));

    const sent = context.primary.requests.slice(before).filter((request) => request.path === '/v1/chat/completions');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ stream: true });
  });

  it('still answers a request the gateway rejects before it opens the stream with that HTTP status', async () => {
    const error = await settle(collect(context.client.stream({ ...streamBody(), model: 'nope' }, callOptions(fakeClock(), { idempotencyKey: 'silent-3' }))));

    expectGatewayError(error, { status: 404, type: 'not_found', code: 'model_not_found' });
  });
});
