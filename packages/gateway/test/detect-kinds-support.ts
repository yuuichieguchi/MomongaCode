import type { DetectedLocalServer, LocalServerDetection, ServerKinds } from '@momonga/protocol';
import { SERVER_KINDS } from '@momonga/protocol';
import { readBody, sendJson, startLoopbackServer } from '@momonga/testkit';
import type { LoopbackServer } from '@momonga/testkit';
import type { DetectFetch } from '../src/index.ts';
import { registerCleanup } from './gateway-helpers.ts';

export type FakeRoute = (body: string) => { status: number; json?: unknown; text?: string };

export type FakeKindServer = { origin: string; port: number; requests: string[] };

export const serveRoutes = async (routes: Readonly<Record<string, FakeRoute>>): Promise<FakeKindServer> => {
  const requests: string[] = [];
  const server: LoopbackServer = await startLoopbackServer(async (req, res) => {
    const key = `${req.method ?? 'GET'} ${req.url ?? ''}`;
    requests.push(key);
    const body = await readBody(req);
    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    const reply = route === undefined ? { status: 404 } : route(body);
    if (reply.text !== undefined) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.text);
      return;
    }
    sendJson(res, reply.status, reply.json ?? {});
  });
  registerCleanup(() => server.close());
  return { origin: server.origin, port: server.port, requests };
};

export const LMSTUDIO_ENTRY = {
  id: 'qwen2.5-coder-1.5b-instruct-mlx',
  object: 'model',
  type: 'llm',
  publisher: 'lmstudio-community',
  arch: 'qwen2',
  compatibility_type: 'mlx',
  quantization: '8bit',
  state: 'loaded',
  max_context_length: 32768,
  loaded_context_length: 4096,
};

export const LMSTUDIO_V1_MODELS = { data: [{ id: 'qwen2.5-coder-1.5b-instruct-mlx', object: 'model', owned_by: 'organization_owner' }], object: 'list' };

export const LMSTUDIO_API_V1_MODELS = {
  models: [
    {
      type: 'llm',
      key: 'qwen2.5-coder-1.5b-instruct-mlx',
      display_name: 'Qwen2.5 Coder 1.5B Instruct',
      loaded_instances: [{ config: { context_length: 4096, parallel: 4 } }],
      max_context_length: 32768,
      format: 'mlx',
      capabilities: {},
    },
  ],
};

export const lmstudioRoutes = (entries: readonly unknown[] = [LMSTUDIO_ENTRY]): Record<string, FakeRoute> => ({
  'GET /api/v0/models': () => ({ status: 200, json: { data: entries, object: 'list' } }),
  'GET /v1/models': () => ({ status: 200, json: { data: entries.map((entry) => ({ id: (entry as { id: string }).id, object: 'model' })), object: 'list' } }),
});

export const OLLAMA_NAMES = ['devstral-small-2:latest', 'qwen3.8:27b'];

export const ollamaRoutes = (): Record<string, FakeRoute> => ({
  'GET /api/version': () => ({ status: 200, json: { version: '0.40.15' } }),
  'GET /api/tags': () => ({ status: 200, json: { models: OLLAMA_NAMES.map((name) => ({ name })) } }),
  'GET /v1/models': () => ({ status: 200, json: { object: 'list', data: OLLAMA_NAMES.map((id) => ({ id, object: 'model' })) } }),
  'POST /api/show': (body) => {
    const { model } = JSON.parse(body) as { model: string };
    return { status: 200, json: { capabilities: model === OLLAMA_NAMES[0] ? ['completion', 'tools'] : ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } } };
  },
});

export const genericRoutes = (): Record<string, FakeRoute> => ({
  'GET /v1/models': () => ({ status: 200, json: { object: 'list', data: [{ id: 'served-model', object: 'model' }] } }),
});

export const noManagedHost = {
  servers: [],
  exec: async () => {
    throw new Error('no process runs in this test');
  },
  exists: async () => false,
} as const;

export const hostFetch: DetectFetch = (url, init) => fetch(url, init) as ReturnType<DetectFetch>;

export const localOnly = (found: readonly LocalServerDetection[]): DetectedLocalServer[] => found.flatMap((server) => ('kind' in server ? [server] : []));

export const kindsAt = (kind: string, port: number): ServerKinds => SERVER_KINDS.map((entry) => (entry.kind === kind ? { ...entry, address: { host: '127.0.0.1', port } } : entry));
