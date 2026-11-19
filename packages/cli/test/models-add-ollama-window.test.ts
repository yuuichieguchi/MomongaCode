import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import type { EntryIo } from '@momonga/foundation';
import { FIRST_GENERATION, fixedSocket, momongaPaths } from '@momonga/foundation';
import { maxOutputTokensFor } from '@momonga/protocol';
import { DEFAULT_SAMPLES, MeasurementConsentRequiredError, endpointKeyOf, loadMeasurementConsent, measurementBoundOf } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testHostPath } from '@momonga/testkit';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import { listModels, modelsShellOf } from '../src/commands/models.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';
import { OLLAMA_LISTED, OLLAMA_MODEL, chunkLine, doneLine, startFakeOllama } from '../../gateway/test/ollama-support.ts';
import type { FakeOllama } from '../../gateway/test/ollama-support.ts';
import { lmstudioRoutes, genericRoutes, serveRoutes } from '../../gateway/test/detect-kinds-support.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome } from '../../gateway/test/gateway-process-helpers.ts';
import { postJson, readJson, userInput } from '../../gateway/test/gateway-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MAXIMUM_FROM_SHOW = 393216;

const runCli = async (home: string, args: readonly string[]): Promise<{ codes: number[]; stdout: string; stderr: string }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const codes: number[] = [];
  const ports: CliPorts = {
    ...nodePorts('9.9.9', new AbortController().signal, home),
    home,
    cwd: home,
    env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home },
    terminal: undefined,
    exec: async (file) => {
      throw new Error(`models add runs no program in this test, and was asked to run ${file}`);
    },
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
  };
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const program = buildProgram({
    ports,
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (entryArgs) => ({ argv: [...entryArgs] }) as unknown as EntryIo,
    complete: (code) => void codes.push(code),
  });
  program.exitOverride();
  await program.parseAsync([...args], { from: 'user' });
  return { codes, stdout: stdout.join(''), stderr: stderr.join('') };
};

const settingsTextOf = (home: string): string => fs.readFileSync(momongaPaths(home, process.platform, {}).settingsFile, 'utf8');

const entriesOf = (home: string): unknown[] => {
  const document = JSON.parse(settingsTextOf(home)) as { models: { connections: { models: unknown[] }[] } };
  return document.models.connections.flatMap((connection) => connection.models);
};

const canonOf = async (home: string): Promise<string> => {
  const { settings } = await loadUserSettings({ env: { HOME: home }, home, signal: new AbortController().signal });
  const [model] = settings.models.models.values();
  if (model === undefined) throw new Error('the settings resolved no model');
  return model.canon;
};

const textReply = (text: string) => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: text }), doneLine({ prompt_eval_count: 33, eval_count: 4 })] });

const countOf = (fake: FakeOllama, path: string): number => fake.requests.filter((request) => request.path === path).length;

const optionsOf = (body: unknown): Record<string, unknown> => (body as { options: Record<string, unknown> }).options;

const addedHome = async (fake: FakeOllama, extra: readonly string[]): Promise<string> => {
  const home = makeHome();
  const added = await runCli(home, ['models', 'add', '--address', fake.origin, '--model', OLLAMA_LISTED, '--yes', ...extra]);
  expect(added.stderr).toBe('');
  expect(added.codes).toEqual([0]);
  return home;
};

const askTwice = async (home: string, canon: string) => {
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
  const first = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: canon, input: userInput('hi'), max_output_tokens: 100 }));
  const second = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: canon, input: userInput('again'), max_output_tokens: 100 }));
  return { handle, answers: [first, second] };
};

const listedJsonOf = async (home: string, socketPath: string): Promise<{ models: { model: string; contextWindow: number | null }[] }> => {
  const out: string[] = [];
  const ports: CliPorts = { ...nodePorts('9.9.9', new AbortController().signal, home), home, env: { HOME: home }, stdout: { write: (text) => void out.push(text) }, stderr: { write: () => undefined } };
  const shell = {
    ...modelsShellOf(ports, momongaPaths(home, process.platform, {}), new AbortController().signal),
    listing: async () => {
      const gateway = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
      try {
        return await gateway.modelList(new AbortController().signal);
      } finally {
        await gateway.close();
      }
    },
  };
  expect(await listModels(shell, { json: true })).toBe(0);
  return JSON.parse(out.join('')) as { models: { model: string; contextWindow: number | null }[] };
};

describe('an Ollama model added without a window is sent no context size, and Ollama chooses', () => {
  it('writes no window, sends every chat without num_ctx, sends no load, asks one chat per model call, and lists the maximum /api/show reports', async () => {
    const fake = await startFakeOllama({ chat: [textReply('hello'), textReply('again')] });
    const home = await addedHome(fake, []);

    expect(entriesOf(home)).toEqual([{ id: OLLAMA_LISTED }]);

    const canon = await canonOf(home);
    fake.requests.length = 0;
    const { handle, answers } = await askTwice(home, canon);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(optionsOf(body)).not.toHaveProperty('num_ctx');
      expect(optionsOf(body)).toMatchObject({ num_predict: 100 });
    }
    expect(countOf(fake, '/api/chat')).toBe(2);
    expect(countOf(fake, '/api/generate')).toBe(0);
    expect(countOf(fake, '/api/ps')).toBe(0);

    const listed = await listedJsonOf(home, handle.socketPath);
    expect(listed.models.map((model) => ({ model: model.model, contextWindow: model.contextWindow }))).toEqual([{ model: canon, contextWindow: MAXIMUM_FROM_SHOW }]);
  });

  it('writes the window given with --window and sends it as num_ctx on every chat', async () => {
    const fake = await startFakeOllama({ chat: [textReply('hello'), textReply('again')] });
    const home = await addedHome(fake, ['--window', '8192']);

    expect(entriesOf(home)).toEqual([{ id: OLLAMA_LISTED, capabilities: { contextWindow: 8192, maxOutputTokens: maxOutputTokensFor(8192) } }]);

    fake.requests.length = 0;
    const { answers } = await askTwice(home, await canonOf(home));

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(optionsOf(body)).toMatchObject({ num_ctx: 8192, num_predict: 100 });
    expect(countOf(fake, '/api/generate')).toBe(0);
    expect(countOf(fake, '/api/ps')).toBe(0);
  });

  it('answers context_window_exceeded when Ollama refuses a chat as above the available context size', async () => {
    const overflow = 'request (2559 tokens) exceeds the available context size (2048 tokens), try increasing it';
    const fake = await startFakeOllama({ chat: [{ kind: 'error', status: 400, body: { error: overflow } }] });
    const home = await addedHome(fake, []);
    fake.requests.length = 0;
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });

    const answer = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: await canonOf(home), input: userInput('hi') }));

    expect({ status: answer.status, code: answer.body.error?.code }).toEqual({ status: 400, code: 'context_window_exceeded' });
    expect(answer.body.error.message).toContain(overflow);
    expect(countOf(fake, '/api/chat')).toBe(1);
    expect(optionsOf(fake.chatBodies()[0])).not.toHaveProperty('num_ctx');
    expect(countOf(fake, '/api/generate')).toBe(0);
    expect(countOf(fake, '/api/ps')).toBe(0);
  });
});

const METERED_SHOW = { model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } };

const meteredHome = (origin: string): string => {
  const home = makeHome();
  const root = momongaPaths(home, process.platform, {}).root;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(momongaPaths(home, process.platform, {}).settingsFile, JSON.stringify({ models: { connections: [{ adapter: 'ollama', provider: 'paid', baseUrl: origin, billing: 'metered', models: [{ id: OLLAMA_LISTED }] }] } }), { mode: 0o600 });
  return home;
};

describe('a metered Ollama model with no stated window is measured within the bound of the length /api/show reports', () => {
  it('asks consent in the gateway for the bound of the reported length, and gateway probe --yes saves that same bound', async () => {
    const fake = await startFakeOllama({ show: METERED_SHOW });
    const bound = measurementBoundOf(131072, DEFAULT_SAMPLES);
    const servedHome = meteredHome(fake.origin);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home: servedHome, env: baseEnv(servedHome), version: PROCESS_VERSION, measureOllama: () => new Promise(() => undefined) });

    const refused = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `paid/${OLLAMA_LISTED}`, input: userInput('hi') }));

    expect(refused.status).toBe(412);
    expect(refused.body.error.message).toContain(new MeasurementConsentRequiredError(`paid/${OLLAMA_MODEL}`, bound).message);

    const measured = await startFakeOllama({ show: { ...METERED_SHOW, capabilities: ['completion', 'tools'] }, cacheProbe: 'none' });
    const probedHome = meteredHome(measured.origin);
    const probed = await runCli(probedHome, ['gateway', 'probe', `paid/${OLLAMA_LISTED}`, '--yes', '--samples', String(DEFAULT_SAMPLES)]);

    expect(probed.stderr).toBe('');
    expect(probed.codes).toEqual([0]);
    const paths = momongaPaths(probedHome, process.platform, {});
    expect(await loadMeasurementConsent(paths.probe, { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: measured.origin }), model: OLLAMA_LISTED })).toEqual(bound);
    const chats = measured.requests.filter((request) => request.path === '/api/chat');
    expect(chats.length).toBeGreaterThan(0);
    for (const chat of chats) expect((chat.body as { options: object }).options).not.toHaveProperty('num_ctx');
    expect(probed.stdout).toContain('trained context length 131072 (reported)\n');
  });
});

describe('models add writes for a server other than Ollama what it wrote before', () => {
  it('writes the LM Studio entry with the loaded window', async () => {
    const server = await serveRoutes(lmstudioRoutes());
    const home = makeHome();

    const added = await runCli(home, ['models', 'add', '--address', server.origin, '--model', 'qwen2.5-coder-1.5b-instruct-mlx', '--yes']);

    expect(added.codes).toEqual([0]);
    expect(settingsTextOf(home).replaceAll(server.origin, '<origin>').replaceAll(String(server.port), '<port>')).toBe(LMSTUDIO_SETTINGS_ON_MAIN);
  });

  it('writes the chat-completions entry with the window given', async () => {
    const server = await serveRoutes(genericRoutes());
    const home = makeHome();

    const added = await runCli(home, ['models', 'add', '--address', server.origin, '--model', 'served-model', '--window', '4096', '--yes']);

    expect(added.codes).toEqual([0]);
    expect(settingsTextOf(home).replaceAll(server.origin, '<origin>').replaceAll(String(server.port), '<port>')).toBe(GENERIC_SETTINGS_ON_MAIN);
  });
});

const LMSTUDIO_SETTINGS_ON_MAIN = "{\n  \"models\": {\n    \"connections\": [\n      {\n        \"adapter\": \"chat-completions\",\n        \"baseUrl\": \"<origin>/v1\",\n        \"provider\": \"lmstudio-127.0.0.1-<port>\",\n        \"billing\": \"local\",\n        \"maxConcurrency\": 1,\n        \"models\": [\n          {\n            \"id\": \"qwen2.5-coder-1.5b-instruct-mlx\",\n            \"capabilities\": {\n              \"contextWindow\": 4096,\n              \"maxOutputTokens\": 1024\n            }\n          }\n        ]\n      }\n    ]\n  }\n}\n";
const GENERIC_SETTINGS_ON_MAIN = "{\n  \"models\": {\n    \"connections\": [\n      {\n        \"adapter\": \"chat-completions\",\n        \"baseUrl\": \"<origin>/v1\",\n        \"billing\": \"local\",\n        \"maxConcurrency\": 1,\n        \"models\": [\n          {\n            \"id\": \"served-model\",\n            \"capabilities\": {\n              \"contextWindow\": 4096,\n              \"maxOutputTokens\": 1024\n            }\n          }\n        ]\n      }\n    ]\n  }\n}\n";
