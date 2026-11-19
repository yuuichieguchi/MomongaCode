import { describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { codeDigestOfRunningProcess, momongaPaths, FIRST_GENERATION } from '@momonga/foundation';
import { endpointKeyOf, probeOllamaTarget, targetCounterOf } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { getJson, outputText, postJson, readJson, userInput, listedCountersOf } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import {
  OLLAMA_LISTED,
  OLLAMA_MODEL,
  DEVSTRAL_DIGEST,
  QWEN_DIGEST,
  chunkLine,
  doneLine,
  fixtureJson,
  tagsWithDevstralDigest,
  startFakeOllama,
} from './ollama-support.ts';
import type { FakeOllamaOptions } from './ollama-support.ts';
import { TARGET_PROBING } from '@momonga/protocol';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { hostProbePorts } from './probe-ports-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONTEXT_WINDOW = 12288;

const SHOW_WITHOUT_CAPABILITIES = { model_info: {} };

const ollamaTarget = (baseUrl: string) => ({
  adapter: 'ollama',
  model: OLLAMA_LISTED,
  baseUrl,
  capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 2048 },
});

const unstatedTarget = (baseUrl: string) => ({ adapter: 'ollama', model: OLLAMA_LISTED, baseUrl, capabilities: null });

const SHOW_WITHOUT_LENGTH = { capabilities: ['completion', 'tools'], model_info: {} };

const TRAINED_LENGTH = 393216;

const textReply = (text: string) => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: text }), doneLine({ prompt_eval_count: 33, eval_count: 4 })] });

const probedHome = async (options: FakeOllamaOptions) => {
  const fake = await startFakeOllama(options);
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ local: ollamaTarget(fake.origin) }) });
  await probeOllamaTarget({
    ports: hostProbePorts,
    lock: testKernelLock(),
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_LISTED }, model: OLLAMA_LISTED,
    contextWindow: CONTEXT_WINDOW,
  });
  fake.requests.length = 0;
  return { fake, home };
};

describe('an ollama target in a started gateway', () => {
  it('answers a request 503 target_probing and starts the probe while no probe record exists and the server reports no tool support, without calling /api/chat', async () => {
    const fake = await startFakeOllama({ chat: [textReply('never sent')], show: SHOW_WITHOUT_CAPABILITIES });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: ollamaTarget(fake.origin) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(fake.chatBodies()).toEqual([]);
  });

  it('answers through /api/chat with num_ctx equal to the configured contextWindow', async () => {
    const { fake, home } = await probedHome({ chat: [textReply('hello')] });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi'), max_output_tokens: 100 }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('hello');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].options).toMatchObject({ num_ctx: CONTEXT_WINDOW, num_predict: 100 });
  });

  it('answers through /api/chat without num_ctx when no window is stated, and lists the length /api/show reports', async () => {
    const fake = await startFakeOllama({ chat: [textReply('hello')] });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: unstatedTarget(fake.origin) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi'), max_output_tokens: 100 }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('hello');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].options).toEqual({ num_predict: 100 });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === `local/${OLLAMA_LISTED}`);
    expect(entry.capabilities.contextWindow).toBe(TRAINED_LENGTH);
    expect(fake.requests.filter((request) => request.path === '/api/generate' || request.path === '/api/ps')).toEqual([]);
  });

  it('reads /api/show again after a read that the server refused, and serves the model once it answers', async () => {
    let showAnswers = false;
    const fake = await startFakeOllama({ chat: [textReply('hello')], showStatus: () => (showAnswers ? 200 : 500) });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: unstatedTarget(fake.origin) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, measureOllama: () => new Promise(() => undefined) });
    const ask = async () => readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi'), max_output_tokens: 100 }));

    const measuring = await ask();
    showAnswers = true;
    const served = await ask();

    expect({ status: measuring.status, code: measuring.body.error?.code }).toEqual({ status: 503, code: TARGET_PROBING });
    expect(served.status).toBe(200);
    expect(outputText(served.body)).toBe('hello');
    expect(fake.chatBodies()).toHaveLength(1);
    expect(fake.chatBodies()[0].options).toEqual({ num_predict: 100 });
  });

  it('names ollama pull for a model with no stated window that the server does not list, whose /api/show is refused', async () => {
    const fake = await startFakeOllama({ chat: [textReply('never sent')], showStatus: () => 404, tags: () => ({ models: [] }) });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: unstatedTarget(fake.origin) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === `local/${OLLAMA_LISTED}`);

    expect(response.status).toBe(412);
    expect(response.body.error.message).toContain(`does not list the model "${OLLAMA_LISTED}"`);
    expect(response.body.error.message).toContain(`ollama pull ${OLLAMA_LISTED}`);
    expect(response.body.error.message).not.toContain('capabilities.contextWindow');
    expect(entry.capabilities.toolCalling.state).toBe('unavailable');
    expect(fake.chatBodies()).toEqual([]);
  });

  it('refuses a metered model with no stated window whose /api/show gives neither tools nor a context length, naming capabilities.contextWindow, and measures nothing', async () => {
    const fake = await startFakeOllama({ chat: [textReply('never sent')], show: SHOW_WITHOUT_CAPABILITIES });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: { ...unstatedTarget(fake.origin), billing: 'metered' } }) });
    const measured: unknown[] = [];
    const handle = await launchGateway({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      measureOllama: ({ key }) => {
        measured.push(key);
        return new Promise(() => undefined);
      },
    });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));

    expect(response.status).toBe(412);
    expect(response.body.error.message).toContain(`the model "local/${OLLAMA_MODEL}": the server reports no context window for this model`);
    expect(measured).toEqual([]);
    expect(fake.chatBodies()).toEqual([]);
  });

  describe('a metered model with no stated window and no window known starts no measurement and sends no chat', () => {
    const SHOW_WITHOUT_LENGTH_OR_TOOLS = { model_info: {} };
    const NO_WINDOW = 'the server reports no context window for this model';
    const cases: { name: string; options: FakeOllamaOptions; expected: string }[] = [
      { name: '/api/show answers no length', options: { show: SHOW_WITHOUT_LENGTH_OR_TOOLS }, expected: NO_WINDOW },
      { name: '/api/show hangs past its bound', options: { hangs: ['/api/show'] }, expected: 'did not answer within' },
      { name: '/api/show is refused', options: { showStatus: () => 500 }, expected: NO_WINDOW },
      { name: '/api/show answers no length and /api/tags hangs past the precondition bound', options: { show: SHOW_WITHOUT_LENGTH_OR_TOOLS, hangs: ['/api/tags'] }, expected: 'did not answer within' },
      { name: '/api/show is refused and the server does not list the model', options: { showStatus: () => 404, tags: () => ({ models: [] }) }, expected: `ollama pull ${OLLAMA_LISTED}` },
    ];
    it.each(cases)('$name', async ({ options, expected }) => {
      const fake = await startFakeOllama({ chat: [textReply('never sent')], ...options });
      const home = makeHome();
      writeSettings(home, { models: modelsOf({ local: { ...unstatedTarget(fake.origin), billing: 'metered' } }) });
      const measured: unknown[] = [];
      const handle = await launchGateway({
        generation: FIRST_GENERATION,
        home,
        env: baseEnv(home),
        version: PROCESS_VERSION,
        measureOllama: ({ key }) => {
          measured.push(key);
          return new Promise(() => undefined);
        },
      });

      const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.error.code).not.toBe(TARGET_PROBING);
      expect(measured).toEqual([]);
      expect(fake.requests.filter((request) => request.path === '/api/chat')).toEqual([]);
      expect(response.body.error.message).toContain(expected);
    });
  });

  it('counts with the length its probe record holds when a later /api/show is refused, and sends no num_ctx', async () => {
    let probed = false;
    const fake = await startFakeOllama({ chat: [textReply('hello')], showStatus: () => (probed ? 500 : 200) });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: unstatedTarget(fake.origin) }) });
    await probeOllamaTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: momongaPaths(home, process.platform, {}).probe,
      upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_LISTED }, model: OLLAMA_LISTED,
    });
    probed = true;
    fake.requests.length = 0;
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi'), max_output_tokens: 100 }));
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === `local/${OLLAMA_LISTED}`);

    expect(fake.requests.some((request) => request.path === '/api/show')).toBe(true);
    expect(response.status).toBe(200);
    expect(fake.chatBodies()[0].options).toEqual({ num_predict: 100 });
    expect(entry.capabilities.contextWindow).toBe(TRAINED_LENGTH);
  });

  it('refuses a model with no stated window whose /api/show gives no context length, naming capabilities.contextWindow, and sends no chat', async () => {
    const fake = await startFakeOllama({ chat: [textReply('never sent')], show: SHOW_WITHOUT_LENGTH });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ local: unstatedTarget(fake.origin) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === `local/${OLLAMA_LISTED}`);

    expect({ status: response.status, code: response.body.error.code }).toEqual({ status: 412, code: 'precondition_failed' });
    expect(response.body.error.message).toBe(`the model "local/${OLLAMA_MODEL}": the server reports no context window for this model
remedy: declare capabilities.contextWindow`);
    expect(entry.capabilities.toolCalling.state).toBe('unavailable');
    expect(fake.chatBodies()).toEqual([]);
  });

  it('derives the target counter from the digest of its probe record', async () => {
    const { home } = await probedHome({});
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });

    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === 'fast');
    const { settings } = await loadUserSettings({ env: process.env, home, signal: new AbortController().signal });
    const target = settings.models.models.get(`local/${OLLAMA_LISTED}`);
    if (target === undefined) throw new Error('the settings resolved no local target');

    expect(listedCountersOf(models.body, `local/${OLLAMA_LISTED}`)).toEqual({
      [`local/${OLLAMA_LISTED}`]: targetCounterOf({ target, codeDigest: await codeDigestOfRunningProcess(), upstreamIdentity: DEVSTRAL_DIGEST }),
    });
  });

  it('P6 RecordMatchesKey: once the model is pulled again under the same tag, answers 503 target_probing and measures the new digest while the server reports no tool support, sending no chat', async () => {
    let digest = DEVSTRAL_DIGEST;
    const show: Record<string, unknown> = { ...fixtureJson('api-show.json') };
    const { fake, home } = await probedHome({ tags: () => tagsWithDevstralDigest(digest), chat: [textReply('never sent')], show });
    delete show['capabilities'];
    const measured: unknown[] = [];
    const handle = await launchGateway({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      measureOllama: ({ key }) => {
        measured.push(key);
        return new Promise(() => undefined);
      },
    });
    digest = QWEN_DIGEST;

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi') }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(measured).toEqual([{ endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_LISTED }]);
    expect(fake.chatBodies()).toEqual([]);
  });
});
