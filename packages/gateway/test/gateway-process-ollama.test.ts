import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { codeDigestOfRunningProcess, momongaPaths } from '@momonga/foundation';
import { endpointKeyOf, probeOllamaTarget, targetCounterOf } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { getJson, outputText, postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import {
  OLLAMA_MODEL,
  DEVSTRAL_DIGEST,
  QWEN_DIGEST,
  chunkLine,
  doneLine,
  tagsWithDevstralDigest,
  startFakeOllama,
} from './ollama-support.ts';
import type { FakeOllamaOptions } from './ollama-support.ts';
import { TARGET_PROBING } from '@momonga/protocol';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';

const CONTEXT_WINDOW = 12288;

const ollamaTarget = (baseUrl: string) => ({
  adapter: 'ollama',
  model: OLLAMA_MODEL,
  baseUrl,
  capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 2048 },
});

const textReply = (text: string) => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: text }), doneLine({ prompt_eval_count: 33, eval_count: 4 })] });

const probedHome = async (options: FakeOllamaOptions) => {
  const fake = await startFakeOllama(options);
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ollamaTarget(fake.origin) } } });
  await probeOllamaTarget({
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL,
    contextWindow: CONTEXT_WINDOW,
  });
  fake.requests.length = 0;
  return { fake, home };
};

describe('an ollama target in a started gateway', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('answers a request 503 target_probing and starts the probe while no probe record exists, without calling /api/chat', async () => {
    const fake = await startFakeOllama({ chat: [textReply('never sent')] });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ollamaTarget(fake.origin) } } });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(fake.chatBodies()).toEqual([]);
  });

  it('answers through /api/chat with num_ctx equal to the configured contextWindow', async () => {
    const { fake, home } = await probedHome({ chat: [textReply('hello')] });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('hi'), max_output_tokens: 100 }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('hello');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].options).toMatchObject({ num_ctx: CONTEXT_WINDOW, num_predict: 100 });
  });

  it('derives the target counter from the digest of its probe record', async () => {
    const { home } = await probedHome({});
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === 'fast');
    const { settings } = await loadUserSettings({ home });
    const target = settings.models.targets['local'];
    if (target === undefined) throw new Error('the settings resolved no local target');

    expect(entry.targetCounters).toEqual({
      local: targetCounterOf({ target, codeDigest: await codeDigestOfRunningProcess(), upstreamIdentity: DEVSTRAL_DIGEST }),
    });
  });

  it('P6 RecordMatchesKey: once the model is pulled again under the same tag, answers 503 target_probing and measures the new digest, sending no chat', async () => {
    let digest = DEVSTRAL_DIGEST;
    const { fake, home } = await probedHome({ tags: () => tagsWithDevstralDigest(digest), chat: [textReply('never sent')] });
    const measured: unknown[] = [];
    const handle = await launchGateway({
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      measureOllama: ({ key }) => {
        measured.push(key);
        return new Promise(() => undefined);
      },
    });
    digest = QWEN_DIGEST;

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(measured).toEqual([{ endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }]);
    expect(fake.chatBodies()).toEqual([]);
  });
});
