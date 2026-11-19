import { describe, expect, it } from 'vitest';
import { providerNameOf } from '@momonga/config';
import { GENERIC_SERVER_KIND, SERVER_KINDS } from '@momonga/protocol';
import { describeModel, detectLocalServers } from '../src/index.ts';
import { LMSTUDIO_ENTRY, OLLAMA_NAMES, genericRoutes, hostFetch, kindsAt, lmstudioRoutes, localOnly, noManagedHost, ollamaRoutes, serveRoutes } from './detect-kinds-support.ts';

const detect = async (candidates: readonly string[], kinds = SERVER_KINDS) =>
  localOnly(await detectLocalServers({ candidates, typed: [], signal: new AbortController().signal, fetch: hostFetch, kinds, ...noManagedHost }));

const lmstudioKind = () => {
  const kind = SERVER_KINDS.find((entry) => entry.kind === 'lmstudio');
  if (kind === undefined) throw new Error('the registry has no lmstudio kind');
  return kind;
};

describe('a server kind is recognised by what the server answers (design-model-names 2.8, 4.14)', () => {
  it('recognises LM Studio by its own listing and reads the window in force and the ceiling', async () => {
    const server = await serveRoutes(lmstudioRoutes());
    expect(await detect([server.origin])).toEqual([
      {
        kind: 'lmstudio',
        provider: `lmstudio-127.0.0.1-${server.port}`,
        address: `${server.origin}/v1`,
        models: [{ id: 'qwen2.5-coder-1.5b-instruct-mlx', tools: 'unknown', contextWindow: 4096, ceiling: 32768 }],
      },
    ]);
  });

  it('gives an LM Studio model that is not loaded no window, only its ceiling', async () => {
    const { loaded_context_length: _loaded, ...unloaded } = LMSTUDIO_ENTRY;
    const server = await serveRoutes(lmstudioRoutes([unloaded]));
    expect((await detect([server.origin]))[0]?.models).toEqual([{ id: 'qwen2.5-coder-1.5b-instruct-mlx', tools: 'unknown', ceiling: 32768 }]);
  });

  it('does not offer an LM Studio entry that is not a chat model', async () => {
    const server = await serveRoutes(lmstudioRoutes([LMSTUDIO_ENTRY, { ...LMSTUDIO_ENTRY, id: 'embedder', type: 'embeddings' }]));
    expect((await detect([server.origin]))[0]?.models.map((model) => model.id)).toEqual(['qwen2.5-coder-1.5b-instruct-mlx']);
  });

  it('recognises Ollama by /api/version and /api/tags, keeps its names verbatim and writes no suffix', async () => {
    const server = await serveRoutes(ollamaRoutes());
    expect(await detect([server.origin])).toEqual([
      { kind: 'ollama', provider: `ollama-127.0.0.1-${server.port}`, address: server.origin, models: OLLAMA_NAMES.map((id) => ({ id, tools: 'unknown' })) },
    ]);
  });

  it('chooses the kind by the answers and never by the port (I-N12)', async () => {
    const lmstudio = await serveRoutes(lmstudioRoutes());
    const ollama = await serveRoutes(ollamaRoutes());
    const generic = await serveRoutes(genericRoutes());
    expect((await detect([lmstudio.origin, ollama.origin, generic.origin])).map((server) => server.kind)).toEqual(['lmstudio', 'ollama', GENERIC_SERVER_KIND]);
    const atOllamaAddress = await detect([generic.origin], kindsAt('ollama', generic.port));
    expect(atOllamaAddress).toEqual([
      { kind: GENERIC_SERVER_KIND, provider: `srv-127.0.0.1-${generic.port}`, address: `${generic.origin}/v1`, models: [{ id: 'served-model', tools: 'unknown' }] },
    ]);
    const lmstudioAtItsAddress = await detect([lmstudio.origin], kindsAt('lmstudio', lmstudio.port));
    expect(lmstudioAtItsAddress.map((server) => [server.kind, server.provider])).toEqual([['lmstudio', 'lmstudio']]);
  });

  it('reads an LM Studio that lists no model as the generic kind with no model, which is not offered', async () => {
    const server = await serveRoutes(lmstudioRoutes([]));
    expect(await detect([server.origin])).toEqual([]);
    expect(server.requests).toContain('GET /v1/models');
  });

  it('answers for an LM Studio that lists no model only when the caller asks for every answer, and detection keeps dropping it otherwise', async () => {
    const server = await serveRoutes(lmstudioRoutes([]));
    expect(await detect([server.origin])).toEqual([]);
    const answered = localOnly(await detectLocalServers({ candidates: [], typed: [server.origin], signal: new AbortController().signal, fetch: hostFetch, ...noManagedHost, includeWithoutModels: true }));
    expect(answered).toHaveLength(1);
    expect(answered[0]?.models).toEqual([]);
  });

  it('asks Ollama for the details of a model only when that model is described, and once', async () => {
    const server = await serveRoutes(ollamaRoutes());
    const [found] = await detect([server.origin]);
    if (found === undefined) throw new Error('the Ollama fake was not found');
    expect(server.requests.filter((request) => request === 'POST /api/show')).toEqual([]);
    const [first] = found.models;
    if (first === undefined) throw new Error('the Ollama fake lists no model');
    const described = await describeModel({ server: found, model: first, signal: new AbortController().signal, fetch: hostFetch });
    expect(described).toEqual({ id: 'devstral-small-2:latest', tools: 'yes', ceiling: 131072 });
    expect(server.requests.filter((request) => request === 'POST /api/show')).toHaveLength(1);
  });

  it('names each result with the one provider-name function', async () => {
    const lmstudio = await serveRoutes(lmstudioRoutes());
    const ollama = await serveRoutes(ollamaRoutes());
    const generic = await serveRoutes(genericRoutes());
    const found = await detect([lmstudio.origin, ollama.origin, generic.origin]);
    const impliedLmstudio = [{ ...lmstudioKind(), impliedByAdapter: 'chat-completions' as const }];
    expect(found.map((server) => server.provider)).toEqual([
      providerNameOf({ adapter: 'chat-completions', baseUrl: `${lmstudio.origin}/v1` }, impliedLmstudio),
      providerNameOf({ adapter: 'ollama', baseUrl: ollama.origin }, SERVER_KINDS),
      providerNameOf({ adapter: 'chat-completions', baseUrl: `${generic.origin}/v1` }, SERVER_KINDS),
    ]);
  });
});
