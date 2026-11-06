import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';

type Kind = 'fm' | 'chat-completions' | 'ollama';

const ENDPOINT_KINDS: readonly Kind[] = ['chat-completions', 'ollama'];

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

const unprobedTarget = async (kind: Kind): Promise<{ target: Record<string, unknown>; fmBinary?: string }> => {
  if (kind === 'fm') {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(servePidsOf(dumpFile)));
    return { target: { adapter: 'fm' }, fmBinary: fm.binaryPath };
  }
  if (kind === 'ollama') {
    const fake = await startFakeOllama({ chat: [] });
    return { target: { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } } };
  }
  const fake = await startFake({ scenario: 'tools-ok' });
  return { target: ccTarget(fake.socketPath, { toolCalling: 'auto' }) };
};

const launch = async (kind: Kind, aliasTargets: readonly string[], extraTargets: Record<string, unknown>) => {
  const { target, fmBinary } = await unprobedTarget(kind);
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: aliasTargets }, targets: { local: target, ...extraTargets } } });
  const handle = await launchGateway({
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    measureFm: () => new Promise(() => undefined),
    ...(fmBinary === undefined ? {} : { fmBinary }),
  });
  return clientFor(handle.socketPath);
};

const completionRequests = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

describe.each(ENDPOINT_KINDS)('an unprobed auto %s target through the router', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, (kind) => {
  it('reports the needs-probe state with the probe remedy in the model listing', async () => {
    const client = await launch(kind, ['local'], {});

    const models = await getJson(client, '/v1/momonga/models');

    const entry = models.body.data.find((model: { id: string }) => model.id === 'fast');
    expect(entry.capabilities.toolCalling.state).toBe('needs_probe');
    expect(entry.targetCapabilities.local.toolCalling.state).toBe('needs_probe');
    expect(entry.targetCapabilities.local.toolCalling.remedy).toBe('run `momonga gateway probe local`');
  });

  it('refuses a request with tools with precondition_failed and the probe remedy', async () => {
    const client = await launch(kind, ['local'], {});

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe('precondition_failed');
    expect(response.body.error.message).toContain('momonga gateway probe local');
  });

  it('does not reroute a request with tools to the next target of the alias', async () => {
    const second = await startFake({ scenario: 'tools-ok' });
    const client = await launch(kind, ['local', 'backup'], { backup: ccTarget(second.socketPath, { toolCalling: 'native' }) });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe('precondition_failed');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(completionRequests(second)).toEqual([]);
  });
});

describe('an fm target with no probe record through the router', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('lists the alias as probing, with no capability', async () => {
    const client = await launch('fm', ['local'], {});
    await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] });

    const models = await getJson(client, '/v1/momonga/models');

    const entry = models.body.data.find((model: { id: string }) => model.id === 'fast');
    expect(entry.probing.message).toBe(TARGET_PROBING_MESSAGE);
    expect(entry).not.toHaveProperty('capabilities');
  });

  it('answers a request with tools 503 target_probing and does not reroute it to the next target of the alias', async () => {
    const second = await startFake({ scenario: 'tools-ok' });
    const client = await launch('fm', ['local', 'backup'], { backup: ccTarget(second.socketPath, { toolCalling: 'native' }) });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(completionRequests(second)).toEqual([]);
  });
});
