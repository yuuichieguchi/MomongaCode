import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakeExec } from '@momonga/testkit';
import { PRECONDITION_FAILED_CODE } from '@momonga/protocol';
import { getJson, postJson, readJson, userInput } from './gateway-helpers.ts';
import { startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, until, launchGateway, makeHome, modelOf, modelsOf, writeSettings } from './gateway-process-helpers.ts';
import { LMSTUDIO_ENTRY, OLLAMA_NAMES, genericRoutes, lmstudioRoutes, ollamaRoutes, serveRoutes } from './detect-kinds-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LOADED = 8192;

const launchWith = async (target: Record<string, unknown>) => launchServers({ local: target });

const launchServers = async (servers: Record<string, Record<string, unknown>>, home = makeHome()) => {
  writeSettings(home, { models: modelsOf(servers) });
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    measureEndpoint: () => new Promise(() => undefined),
    measureOllama: () => new Promise(() => undefined),
  });
  return { home, client: clientFor(handle.socketPath) };
};

const lmStudioTarget = async (contextWindow: number) => {
  const server = await serveRoutes(lmstudioRoutes([{ ...LMSTUDIO_ENTRY, loaded_context_length: LOADED }]));
  return {
    adapter: 'chat-completions',
    model: LMSTUDIO_ENTRY.id,
    baseUrl: `${server.origin}/v1`,
    billing: 'local',
    toolCalling: 'native',
    capabilities: { contextWindow, maxOutputTokens: 1024 },
  };
};

describe('a declared context window is checked against the window the server reports when the model is loaded', () => {
  it('starts the gateway, serves the other model, lists the model above its loaded length as unusable with both numbers, and answers a run on it with that text', async () => {
    const other = await startFake({ scenario: 'tools-ok' });
    const servers = { local: await lmStudioTarget(32768), other: ccTarget(other.socketPath, { toolCalling: 'native' }) };
    const { client } = await launchServers(servers);

    const served = await readJson(await postJson(client, '/v1/responses', { model: modelOf(servers, 'other'), input: userInput('hi') }));
    expect(served.status).toBe(200);

    const listing = await getJson(client, '/v1/momonga/models');
    const entry = listing.body.data.find((listed: { id: string }) => listed.id === modelOf(servers, 'local'));
    expect(entry.capabilities.toolCalling.state).toBe('unavailable');
    expect(entry.capabilities.toolCalling.code).toBe(PRECONDITION_FAILED_CODE);
    expect(entry.capabilities.toolCalling.message).toContain('32768');
    expect(entry.capabilities.toolCalling.message).toContain(String(LOADED));
    expect(entry.capabilities.toolCalling.message).toContain(`declare capabilities.contextWindow ${LOADED}`);

    const refused = await readJson(await postJson(client, '/v1/responses', { model: modelOf(servers, 'local'), input: userInput('hi') }));
    expect(refused.body.error.code).toBe(PRECONDITION_FAILED_CODE);
    expect(refused.body.error.message).toContain('32768');
    expect(refused.body.error.message).toContain(`declare capabilities.contextWindow ${LOADED}`);
  });

  it('applies a reload that brings a declaration above the loaded length: the other settings take effect', async () => {
    const other = await startFake({ scenario: 'tools-ok' });
    const extra = await startFake({ scenario: 'tools-ok' });
    const { home, client } = await launchServers({ other: ccTarget(other.socketPath, { toolCalling: 'native' }) });
    const reloaded = { other: ccTarget(other.socketPath, { toolCalling: 'native' }), local: await lmStudioTarget(32768), extra: ccTarget(extra.socketPath, { toolCalling: 'native' }) };
    writeSettings(home, { models: modelsOf(reloaded) });

    await until(async () => (await getJson(client, '/v1/momonga/models')).body.data.some((listed: { id: string }) => listed.id === modelOf(reloaded, 'extra')), 'the reloaded settings were applied');
    const served = await readJson(await postJson(client, '/v1/responses', { model: modelOf(reloaded, 'extra'), input: userInput('hi') }));
    expect(served.status).toBe(200);
  });

  it('loads a declaration below the loaded length as declared', async () => {
    const { client } = await launchWith(await lmStudioTarget(4096));

    const models = await getJson(client, '/v1/momonga/models');
    expect(models.status).toBe(200);
  });

  it('loads the declaration when the server reports no window', async () => {
    const server = await serveRoutes(genericRoutes());
    const { client } = await launchWith({ adapter: 'chat-completions', model: 'served-model', baseUrl: `${server.origin}/v1`, billing: 'local', toolCalling: 'native', capabilities: { contextWindow: 1_000_000, maxOutputTokens: 1024 } });

    expect((await getJson(client, '/v1/momonga/models')).status).toBe(200);
  });

  it('answers a run on an Ollama model declared above the context length its /api/show reports by the same rule', async () => {
    const server = await serveRoutes(ollamaRoutes());
    const servers = { local: { adapter: 'ollama', model: OLLAMA_NAMES[0], baseUrl: server.origin, capabilities: { contextWindow: 262144, maxOutputTokens: 2048 } } };
    const { client } = await launchServers(servers);

    const refused = await readJson(await postJson(client, '/v1/responses', { model: modelOf(servers, 'local'), input: userInput('hi') }));
    expect(refused.body.error.code).toBe(PRECONDITION_FAILED_CODE);
    expect(refused.body.error.message).toContain('262144');
    expect(refused.body.error.message).toContain('131072');
  });
});
