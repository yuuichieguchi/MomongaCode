import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, driveFakeTime, startLoopbackServer } from '@momonga/testkit';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';
import { outputText, postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { RECORDED_SERVER_VERSION, startFakeOllama } from './ollama-support.ts';
import type { FakeOllamaOptions } from './ollama-support.ts';

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const v1Target = (adapter: 'chat-completions' | 'open-responses', origin: string) => ({
  adapter,
  provider: 'fake',
  model: 'devstral-small-2',
  baseUrl: `${origin}/v1`,
  toolCalling: 'native',
  capabilities: CAPABILITIES,
});

const v1Requests = (fake: Awaited<ReturnType<typeof startFakeOllama>>) => fake.requests.filter((request) => request.path.startsWith('/v1/'));

const startedWith = async (adapter: 'chat-completions' | 'open-responses', options: FakeOllamaOptions) => {
  const fake = await startFakeOllama(options);
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: v1Target(adapter, fake.origin) } } });
  const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
  return { fake, handle };
};

const ask = async (socketPath: string) => readJson(await postJson(clientFor(socketPath), '/v1/responses', { model: 'fast', input: userInput('hi') }));

describe('decision 3: a chat-completions or open-responses target whose server is Ollama', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('asks the origin of the baseUrl for GET /api/version at start', async () => {
    const { fake } = await startedWith('chat-completions', { version: { status: 404, body: { error: 'not found' } } });
    expect(fake.requests.filter((request) => request.method === 'GET' && request.path === '/api/version')).toHaveLength(1);
  });

  for (const adapter of ['chat-completions', 'open-responses'] as const) {
    it(`fails every request of a ${adapter} target with precondition_failed naming adapter: "ollama" when the server answers in Ollama's form`, async () => {
      const { fake, handle } = await startedWith(adapter, { version: { status: 200, body: { version: RECORDED_SERVER_VERSION } } });

      const first = await ask(handle.socketPath);
      const second = await ask(handle.socketPath);

      for (const response of [first, second]) {
        expect(response.status).toBe(412);
        expect(response.body.error.code).toBe('precondition_failed');
        expect(response.body.error.message).toContain('adapter: "ollama"');
      }
      expect(v1Requests(fake)).toEqual([]);
    });
  }

  it('leaves the target as configured when /api/version answers 404', async () => {
    const { fake, handle } = await startedWith('chat-completions', { version: { status: 404, body: { error: 'not found' } } });

    const response = await ask(handle.socketPath);

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('configured path');
    expect(v1Requests(fake)).toHaveLength(1);
  });

  it('leaves the target as configured when /api/version answers in another form', async () => {
    const { handle } = await startedWith('chat-completions', { version: { status: 200, body: { name: 'vllm', build: '0.11.0' } } });

    const response = await ask(handle.socketPath);

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('configured path');
  });

  it('leaves the target as configured when nothing answers at start, and a request to it spends the whole retry budget', async () => {
    const closed = await startLoopbackServer((_req, res) => {
      res.end();
    });
    const origin = closed.origin;
    await closed.close();
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: v1Target('chat-completions', origin) } } });
    const clock = createFakeClock(Date.now());
    const timers = createFakeTimers(clock);
    const startedAt = clock.now();
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers, random: () => 0.5 });

    const pending = ask(handle.socketPath);
    let settled = false;
    const settle = (): void => {
      settled = true;
    };
    void pending.then(settle, settle);
    await driveFakeTime(timers, { done: () => settled, horizonAt: startedAt + GATEWAY_CONFIG_DEFAULTS.retry.totalWaitMs, description: 'the answer to a request against a closed upstream' });
    const response = await pending;

    expect(response.body.error.code).toBe('provider_unavailable');
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(83_625);
  });
});
