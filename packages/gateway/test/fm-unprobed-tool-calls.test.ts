import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatCompletionsAdapter, createManagedFmTarget } from '@momonga/gateway';
import type { FmServe, ProbeRecordKey } from '@momonga/gateway';
import { TARGET_PROBING } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { START_MS, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { probingAnswer, recordKeyOptions } from './fm-record-support.ts';

const servingFake = (socketPath: string): FmServe => ({
  restarts: 0,
  start: async () => ({ kind: 'unix', socketPath }),
  ensureRunning: async () => ({ kind: 'unix', socketPath }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
});

const RECORD_KEY = { target: 'fm', binarySha256: 'ab'.repeat(32), osBuild: '25A100' };

const unprobedFm = async (toolCallingSetting: 'auto' | 'native') => {
  const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
  const starts: ProbeRecordKey[] = [];
  const managed = await createManagedFmTarget({
    fmServe: servingFake(fake.socketPath),
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '20\n', stderr: '' }),
    probeRecordDir: path.join(makeDir(), 'probe'),
    ...recordKeyOptions(RECORD_KEY, async (key) => {
      starts.push(key);
      return probingAnswer();
    }),
    toolCallingSetting,
  });
  const adapter = createChatCompletionsAdapter({ ...managed, clock: createFakeClock(START_MS) });
  registerCleanup(() => adapter.close());
  return { fake, managed, starts };
};

const completionRequests = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

describe('an fm target with no probe record', () => {
  it.each(['auto', 'native'] as const)('answers 503 target_probing under toolCalling %s, starts the probe of its key, and never calls fm', async (toolCallingSetting) => {
    const { fake, managed, starts } = await unprobedFm(toolCallingSetting);

    await expect(managed.capabilities({ name: 'fm', model: 'system' })).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });

    expect(starts).toEqual([RECORD_KEY]);
    expect(completionRequests(fake)).toEqual([]);
  });
});

describe('every other auto target with a probe and no probe record', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('answers a chat-completions target 503 target_probing and sends nothing upstream', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'auto' }) } } });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(completionRequests(fake)).toEqual([]);
  });

  it('answers an ollama target 503 target_probing and sends no chat', async () => {
    const fake = await startFakeOllama({ chat: [] });
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { fast: ['local'] },
        targets: { local: { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } } },
      },
    });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(fake.chatBodies()).toEqual([]);
  });
});
