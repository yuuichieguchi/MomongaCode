import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PreconditionFailedError, createChatCompletionsAdapter, createManagedFmTarget } from '@momonga/gateway';
import type { FmServe } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { START_MS, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { collect, ofType, readFileTool, startFake, userText } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';

const servingFake = (socketPath: string): FmServe => ({
  restarts: 0,
  start: async () => ({ kind: 'unix', socketPath }),
  ensureRunning: async () => ({ kind: 'unix', socketPath }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
});

const unprobedFmAdapter = async (toolCallingSetting: 'auto' | 'native') => {
  const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
  const managed = await createManagedFmTarget({
    fmServe: servingFake(fake.socketPath),
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '20\n', stderr: '' }),
    probeRecordDir: path.join(makeDir(), 'probe'),
    recordKey: { target: 'fm', binarySha256: 'ab'.repeat(32), osBuild: '25A100' },
    toolCallingSetting,
  });
  const adapter = createChatCompletionsAdapter({ ...managed, clock: createFakeClock(START_MS) });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const toolRequest = { model: 'system', input: [userText('Please call read_file on README.md')], tools: [readFileTool] };

const completionRequests = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

describe('an fm target with no probe record', () => {
  it('refuses a tool request under toolCalling auto with precondition_failed and the probe remedy, without calling fm', async () => {
    const { fake, adapter } = await unprobedFmAdapter('auto');

    const { events, error } = await collect(adapter, toolRequest);

    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect((error as PreconditionFailedError).remediation).toBe('run `momonga gateway probe fm`');
    expect(ofType(events, 'response.output_item.done')).toEqual([]);
    expect(completionRequests(fake)).toEqual([]);
  });

  it('sends the tools natively when toolCalling is declared native, and fm answers in content as measured', async () => {
    const { fake, adapter } = await unprobedFmAdapter('native');

    const { events, error } = await collect(adapter, toolRequest);

    expect(error).toBeUndefined();
    const sent = completionRequests(fake).map((entry) => (entry.body as { tools?: { function: { name: string } }[] }).tools?.map((tool) => tool.function.name));
    expect(sent).toEqual([['read_file']]);
    const items = ofType(events, 'response.output_item.done').map((event) => event.item.type);
    expect(items).toEqual(['message']);
  });
});

describe('every other auto target with a probe and no probe record', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('refuses a chat-completions target with precondition_failed naming the probe command', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'auto' }) } } });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe('precondition_failed');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(completionRequests(fake)).toEqual([]);
  });

  it('refuses an ollama target with precondition_failed naming the probe command', async () => {
    const fake = await startFakeOllama({ chat: [] });
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { fast: ['local'] },
        targets: { local: { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } } },
      },
    });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe('precondition_failed');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(fake.chatBodies()).toEqual([]);
  });
});
