import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Kind = 'fm' | 'chat-completions' | 'ollama';

const KINDS: readonly Kind[] = ['fm', 'chat-completions', 'ollama'];

const servePidsOf = (dumpFile: string): number[] =>
  fs.existsSync(dumpFile)
    ? fs
        .readFileSync(dumpFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((record) => record.argv[0] === 'serve')
        .map((record) => record.pid)
    : [];

const unprobedTarget = async (kind: Kind): Promise<{ target: Record<string, unknown> }> => {
  if (kind === 'fm') {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile, serve: { stallNativeSamples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], stallMs: 600_000 } });
    registerCleanup(() => killGroupsForCleanup(servePidsOf(dumpFile)));
    return { target: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath } };
  }
  if (kind === 'ollama') {
    const fake = await startFakeOllama({ chat: [] });
    return { target: { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } } };
  }
  const fake = await startFake({ scenario: 'tools-ok' });
  return { target: ccTarget(fake.socketPath, { toolCalling: 'auto' }) };
};

const launch = async (kind: Kind, aliasTargets: readonly string[], extraTargets: Record<string, unknown>) => {
  const { target } = await unprobedTarget(kind);
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ local: target, ...extraTargets }) });
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    measureEndpoint: () => new Promise(() => undefined),
    measureOllama: () => new Promise(() => undefined),
  });
  return clientFor(handle.socketPath);
};

const completionRequests = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

describe.each(KINDS)('an auto %s target with no probe record through the router', (kind) => {
  it('lists the alias with the probing readiness state and no capability numbers', async () => {
    const client = await launch(kind, ['local'], {});
    await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] });

    const models = await getJson(client, '/v1/momonga/models');

    const entry = models.body.data.find((model: { id: string }) => model.id === 'fast');
    expect(entry.capabilities).toEqual({ toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' });
  });

  it('answers a request with tools 503 target_probing and does not reroute it to the next target of the alias', async () => {
    const second = await startFake({ scenario: 'tools-ok' });
    const client = await launch(kind, ['local', 'backup'], { backup: ccTarget(second.socketPath, { toolCalling: 'native' }) });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(completionRequests(second)).toEqual([]);
  });
});
