import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakeExec } from '@momonga/testkit';
import { getJson } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, modelOf, modelsOf, writeSettings } from './gateway-process-helpers.ts';
import { LMSTUDIO_ENTRY, OLLAMA_NAMES, genericRoutes, lmstudioRoutes, ollamaRoutes, serveRoutes } from './detect-kinds-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LOADED = 8192;

const launchWith = async (target: Record<string, unknown>) => {
  const home = makeHome();
  const servers = { local: target };
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
  return { client: clientFor(handle.socketPath), model: modelOf(servers, 'local') };
};

const launchFailure = (target: Record<string, unknown>): Promise<string> =>
  launchWith(target).then(
    () => 'launched',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

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
  it('refuses the load when the declaration is above the length LM Studio has loaded, naming both numbers, the setting and the way forward', async () => {
    const message = await launchFailure(await lmStudioTarget(32768));

    expect(message).toContain('32768');
    expect(message).toContain(String(LOADED));
    expect(message).toContain('capabilities.contextWindow');
    expect(message).toContain(`declare capabilities.contextWindow ${LOADED}`);
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

  it('refuses an Ollama declaration above the context length its /api/show reports by the same rule', async () => {
    const server = await serveRoutes(ollamaRoutes());
    const message = await launchFailure({ adapter: 'ollama', model: OLLAMA_NAMES[0], baseUrl: server.origin, capabilities: { contextWindow: 262144, maxOutputTokens: 2048 } });

    expect(message).toContain('262144');
    expect(message).toContain('131072');
  });
});
