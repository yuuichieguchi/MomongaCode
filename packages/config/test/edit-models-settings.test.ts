import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '@momonga/config';
import { loadUserSettings } from '@momonga/config';
import { systemFileLockPorts, withFileLock } from '@momonga/foundation';
import { settingsLockPath } from '../src/file-lock.ts';
import { S1_FILE, S2, S2_LMSTUDIO, S3_PLAN, S4, S4_SERVER } from './model-fixtures.ts';
import { connectionsOf, documentOf, editModels, homeWith, idsOf, modelsOf, op, planModels, refusalOfEdit, textOf } from './models-edit.ts';
import type { Home, Operation, Planned } from './models-edit.ts';

const OLLAMA = { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
const DEVSTRAL = { id: 'devstral-small-2:latest', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } };
const QWEN = { id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } };
const GEMMA_WINDOW = { contextWindow: 4096, maxOutputTokens: 1024 };
const LMSTUDIO = { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', billing: 'local', maxConcurrency: 1 };

const DEVSTRAL_MODEL = 'ollama/devstral-small-2:latest';
const QWEN_MODEL = 'ollama/qwen3.8:27b';
const OLLAMA_GEMMA = 'ollama/gemma-3-4b:latest';
const LMSTUDIO_GEMMA = 'lmstudio/gemma-3-4b';
const LLAMA_MODEL = 'llama-server/qwen3-coder-30b';

const RESERVED_SENTENCE = '"ollama" is the name of Ollama servers, which use the Ollama API; this server uses the OpenAI-compatible API. Choose another name.';

const addModel = (connection: Record<string, unknown>, model: Record<string, unknown>): Operation => op('addModel', { choice: { connection, model } });

const BASE = {
  network: { httpsProxy: 'http://proxy.corp:3128' },
  models: {
    servers: { 'llama-server': S4_SERVER, 'spare-server': { command: '/opt/spare/bin/spare', args: ['{socket}'], readyPath: '/health' } },
    connections: [{ ...OLLAMA, models: [DEVSTRAL, QWEN] }, { ...LMSTUDIO, models: [{ id: 'gemma-3-4b', capabilities: GEMMA_WINDOW }] }, S4.models.connections[0]],
    billingChanges: [{ from: 'local', to: 'plan' }],
  },
};

const REFERRED = {
  autoMode: { classifier: LMSTUDIO_GEMMA },
  models: {
    connections: S2.models.connections,
    start: LMSTUDIO_GEMMA,
    fallback: [OLLAMA_GEMMA, LMSTUDIO_GEMMA],
    roles: { compaction: LMSTUDIO_GEMMA },
    billingChanges: [{ from: 'local', to: 'metered' }, { from: 'local', to: 'plan', model: LMSTUDIO_GEMMA }],
  },
};

type References = { start: unknown; fallback: unknown; roles: unknown; classifier: unknown; billingChanges: unknown; connections: unknown };

const referencesIn = (document: Record<string, unknown>): References => {
  const models = (document['models'] ?? {}) as Record<string, unknown>;
  const autoMode = (document['autoMode'] ?? {}) as Record<string, unknown>;
  return { start: models['start'], fallback: models['fallback'] ?? [], roles: models['roles'] ?? {}, classifier: autoMode['classifier'], billingChanges: models['billingChanges'] ?? [], connections: models['connections'] ?? [] };
};

const AFTER_REMOVAL: References = { start: undefined, fallback: [OLLAMA_GEMMA], roles: {}, classifier: undefined, billingChanges: [{ from: 'local', to: 'metered' }], connections: [S2.models.connections[0]] };

const FIVE_REFERENCES = [{ kind: 'start' }, { kind: 'fallback', position: 2 }, { kind: 'role', job: 'compaction' }, { kind: 'classifier' }, { kind: 'billing' }];

const loads = async (home: Home): Promise<string[]> => [...((await loadUserSettings({ home: home.tree.home })).settings.models as unknown as { models: ReadonlyMap<string, unknown> }).models.keys()];

const planned = (document: unknown, operations: readonly Operation[]): Planned => {
  const plan = planModels(document, operations);
  if ('refused' in plan) throw new Error(`the plan was refused: ${plan.refused.message}`);
  return plan;
};

const heldLock = (home: Home) => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lockPath = settingsLockPath(home.tree.home, home.file);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const holder = withFileLock(lockPath, () => released, { ports: systemFileLockPorts });
  return { release, holder };
};

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addModel: the one way a model enters the settings', () => {
  it('an Ollama model into an empty home writes exactly the file of the design, mode 0600, and waits for the settings lock under the signal it is given', async () => {
    const home = homeWith();
    const result = await editModels(home, [addModel(OLLAMA, DEVSTRAL)]);
    expect(result).toEqual({ wrote: true, summaries: ['Added devstral-small-2. It is used from the next request.'], model: DEVSTRAL_MODEL });
    expect(documentOf(home)).toEqual(S1_FILE);
    expect(Object.keys(modelsOf(home))).toEqual(['connections']);
    expect(fs.statSync(home.file).mode & 0o777).toBe(0o600);

    const waiting = homeWith();
    const { release, holder } = heldLock(waiting);
    const flow = new AbortController();
    const editing = editModels(waiting, [addModel(OLLAMA, DEVSTRAL)], flow.signal);
    const outcome = editing.then(
      () => 'written',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await turn();
    expect(fs.existsSync(waiting.file)).toBe(false);
    flow.abort(new Error('the flow was cancelled'));
    expect(await outcome).toBe('the flow was cancelled');
    release();
    await holder;
    expect(fs.existsSync(waiting.file)).toBe(false);
  });

  it('a second model of the same server is appended to its connection; the same id again writes nothing and says so', async () => {
    const home = homeWith(S1_FILE);
    const second = await editModels(home, [addModel({ ...OLLAMA, baseUrl: 'http://127.0.0.1:11434/' }, QWEN)]);
    expect(second).toEqual({ wrote: true, summaries: ['Added qwen3.8:27b. It is used from the next request.'], model: QWEN_MODEL });
    expect(connectionsOf(home)).toEqual([{ ...OLLAMA, models: [DEVSTRAL, QWEN] }]);
    const before = textOf(home);
    const again = await editModels(home, [addModel(OLLAMA, { ...DEVSTRAL, capabilities: { contextWindow: 8192, maxOutputTokens: 2048 } })]);
    expect(again.wrote).toBe(false);
    expect(again.summaries).toEqual(['devstral-small-2 is already in your settings.']);
    expect(textOf(home)).toBe(before);
  });

  it('a recognised LM Studio server keeps the name the search gave it, at its own address and at another one', async () => {
    const home = homeWith(S1_FILE);
    const result = await editModels(home, [addModel(LMSTUDIO, { id: 'gemma-3-4b', capabilities: GEMMA_WINDOW })]);
    expect(result.model).toBe(LMSTUDIO_GEMMA);
    expect(connectionsOf(home)[1]).toEqual(S2_LMSTUDIO);
    const remote = await editModels(home, [addModel({ ...LMSTUDIO, provider: 'lmstudio-192.168.1.20-1234', baseUrl: 'http://192.168.1.20:1234/v1' }, { id: 'gemma-3-4b', capabilities: GEMMA_WINDOW })]);
    expect(remote.model).toBe('lmstudio-192.168.1.20-1234/gemma-3-4b');
    expect(connectionsOf(home)[2]).toEqual({ ...LMSTUDIO, provider: 'lmstudio-192.168.1.20-1234', baseUrl: 'http://192.168.1.20:1234/v1', models: [{ id: 'gemma-3-4b', capabilities: GEMMA_WINDOW }] });
  });

  it('an Ollama server at another address gets no provider key: its name is derived from the adapter and the address', async () => {
    const home = homeWith();
    const result = await editModels(home, [addModel({ adapter: 'ollama', provider: 'ollama-192.168.1.20-11434', baseUrl: 'http://192.168.1.20:11434' }, DEVSTRAL)]);
    expect(result.model).toBe('ollama-192.168.1.20-11434/devstral-small-2:latest');
    expect(connectionsOf(home)).toEqual([{ adapter: 'ollama', baseUrl: 'http://192.168.1.20:11434', models: [DEVSTRAL] }]);
  });

  it('a server of no known kind gets no provider key: its name is derived from the address', async () => {
    const home = homeWith();
    const result = await editModels(home, [addModel({ adapter: 'chat-completions', provider: 'srv-127.0.0.1-8080', baseUrl: 'http://127.0.0.1:8080/v1' }, { id: 'm', capabilities: GEMMA_WINDOW })]);
    expect(result.model).toBe('srv-127.0.0.1-8080/m');
    expect(connectionsOf(home)).toEqual([{ adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:8080/v1', models: [{ id: 'm', capabilities: GEMMA_WINDOW }] }]);
  });

  it('a managed server is written with the id it lists, and a plan model as its account connection', async () => {
    const managed = homeWith();
    expect((await editModels(managed, [addModel({ adapter: 'managed', server: 'fm' }, { id: 'apple-fm-1' })])).model).toBe('apple/apple-fm-1');
    expect(documentOf(managed)).toEqual({ models: { connections: [{ adapter: 'managed', server: 'fm', models: [{ id: 'apple-fm-1' }] }] } });
    const plan = homeWith();
    expect((await editModels(plan, [addModel({ adapter: 'open-responses', plan: { profile: 'chatgpt' } }, { id: 'gpt-5.5' })])).model).toBe('chatgpt/gpt-5.5');
    expect(documentOf(plan)).toEqual({ models: { connections: [S3_PLAN] } });
  });

  it('an Ollama model without a window is refused and nothing is written', async () => {
    const home = homeWith();
    const refused = await refusalOfEdit(editModels(home, [addModel(OLLAMA, { id: 'llama3.2:latest' })]));
    expect(refused.code).toBe('invalid_value');
    expect(fs.existsSync(home.file)).toBe(false);
  });
});

describe('removing a model or a server removes every reference to it in the same write', () => {
  it('removeModel deletes the entry, the start key, its fallback entry and a billing entry scoped to it; the last model of a connection takes the connection with it', async () => {
    const home = homeWith(REFERRED);
    const result = await editModels(home, [op('removeModel', { model: LMSTUDIO_GEMMA })]);
    expect(result).toEqual({ wrote: true, summaries: ['Removed lmstudio/gemma-3-4b.'] });
    expect(referencesIn(documentOf(home))).toEqual(AFTER_REMOVAL);
    expect(await loads(home)).toEqual([OLLAMA_GEMMA]);
    const lastOfAll = await editModels(home, [op('removeModel', { model: OLLAMA_GEMMA })]);
    expect(lastOfAll.summaries).toEqual(['Removed gemma-3-4b.']);
    expect(connectionsOf(home)).toEqual([]);
    expect(modelsOf(home).fallback ?? []).toEqual([]);
    expect(await loads(home)).toEqual([]);
  });

  it('removeConnection removes the server with its models; a server program is forgotten only when no connection uses it', async () => {
    const home = homeWith(BASE);
    const used = await refusalOfEdit(editModels(home, [op('forgetServer', { id: 'llama-server' })]));
    expect(used).toEqual({ code: 'duplicate', message: 'llama-server is used by llama-server; remove that server first.' });
    const removed = await editModels(home, [op('removeConnection', { provider: 'llama-server' })]);
    expect(removed.summaries).toEqual(['Removed llama-server and its 1 model.']);
    expect(connectionsOf(home).map((connection) => connection['adapter'])).toEqual(['ollama', 'chat-completions']);
    expect(Object.keys(modelsOf(home).servers ?? {})).toEqual(['llama-server', 'spare-server']);
    expect((await editModels(home, [op('forgetServer', { id: 'llama-server' })])).summaries).toEqual(['Forgot the server program llama-server.']);
    expect(Object.keys(modelsOf(home).servers ?? {})).toEqual(['spare-server']);

    const both = homeWith(BASE);
    await editModels(both, [op('removeConnection', { provider: 'llama-server', forgetServer: true })]);
    expect(Object.keys(modelsOf(both).servers ?? {})).toEqual(['spare-server']);
    expect(await loads(both)).toEqual([DEVSTRAL_MODEL, QWEN_MODEL, LMSTUDIO_GEMMA]);
    expect((await refusalOfEdit(editModels(both, [op('removeConnection', { provider: 'nowhere' })]))).code).toBe('unresolved');
  });
});

describe('the references a user sets', () => {
  it('setStart writes the full reference, and null deletes the key', async () => {
    const home = homeWith(BASE);
    await editModels(home, [op('setStart', { model: QWEN_MODEL })]);
    expect(modelsOf(home).start).toBe(QWEN_MODEL);
    await editModels(home, [op('setStart', { model: null })]);
    expect(modelsOf(home)).not.toHaveProperty('start');
    expect(modelsOf(home).connections).toEqual(BASE.models.connections);
  });

  it('setFallback rewrites the whole list as full references, dropping a repeated model and keeping its first place', async () => {
    const home = homeWith(BASE);
    const result = await editModels(home, [op('setFallback', { models: [LMSTUDIO_GEMMA, QWEN_MODEL, LMSTUDIO_GEMMA] })]);
    expect(modelsOf(home).fallback).toEqual([LMSTUDIO_GEMMA, QWEN_MODEL]);
    expect(result.summaries).toEqual(['Fallback order saved: gemma-3-4b → qwen3.8:27b']);
    expect((await editModels(home, [op('setFallback', { models: [] })])).summaries).toEqual(['Fallback order cleared.']);
    expect(modelsOf(home).fallback ?? []).toEqual([]);
    expect((await refusalOfEdit(editModels(home, [op('setFallback', { models: [QWEN_MODEL, 'ollama/nope'] })]))).code).toBe('unresolved');
  });

  it('allowBillingChange adds an entry once, with its scope as a full reference; forbidBillingChange removes it', async () => {
    const home = homeWith(BASE);
    await editModels(home, [op('allowBillingChange', { from: 'local', to: 'metered' }), op('allowBillingChange', { from: 'metered', to: 'plan', model: QWEN_MODEL })]);
    expect(modelsOf(home).billingChanges).toEqual([{ from: 'local', to: 'plan' }, { from: 'local', to: 'metered' }, { from: 'metered', to: 'plan', model: QWEN_MODEL }]);
    expect((await refusalOfEdit(editModels(home, [op('allowBillingChange', { from: 'local', to: 'metered' })]))).code).toBe('duplicate');
    await editModels(home, [op('forbidBillingChange', { from: 'local', to: 'metered' })]);
    expect(modelsOf(home).billingChanges).toEqual([{ from: 'local', to: 'plan' }, { from: 'metered', to: 'plan', model: QWEN_MODEL }]);
    await editModels(home, [op('forbidBillingChange', { from: 'metered', to: 'plan', model: QWEN_MODEL })]);
    expect(modelsOf(home).billingChanges).toEqual([{ from: 'local', to: 'plan' }]);
  });

  it('setRole and setClassifier write a full reference under their key, and null deletes the key', async () => {
    const home = homeWith(BASE);
    await editModels(home, [op('setRole', { job: 'compaction', model: QWEN_MODEL }), op('setRole', { job: 'analysis', model: LMSTUDIO_GEMMA }), op('setClassifier', { model: DEVSTRAL_MODEL })]);
    expect(modelsOf(home).roles).toEqual({ compaction: QWEN_MODEL, analysis: LMSTUDIO_GEMMA });
    expect(documentOf(home)['autoMode']).toEqual({ classifier: DEVSTRAL_MODEL });
    await editModels(home, [op('setRole', { job: 'compaction', model: null }), op('setClassifier', { model: null })]);
    expect(modelsOf(home).roles).toEqual({ analysis: LMSTUDIO_GEMMA });
    expect((documentOf(home)['autoMode'] ?? {}) as Record<string, unknown>).not.toHaveProperty('classifier');
    expect((await refusalOfEdit(editModels(home, [op('setRole', { job: 'reflection', model: 'ollama/nope' })]))).code).toBe('unresolved');
  });
});

type FieldChange = readonly [string[], unknown];

const REFUSED_VALUE_CODES = ['invalid_value', 'would_not_load'];

const FIELD_FAMILIES: readonly (readonly FieldChange[])[] = [
  [[['toolCalling'], 'constrained']],
  [[['maxConcurrency'], 3]],
  [[['admissionTimeoutMs'], 0]],
  [[['capabilities', 'contextWindow'], 8192]],
  [[['capabilities', 'maxOutputTokens'], 512]],
  [[['capabilities', 'structuredOutput'], 'json_schema']],
  [[['capabilities', 'jsonMode'], 'none']],
  [[['capabilities', 'tokenCounting'], 'estimated']],
  [[['capabilities', 'source'], 'declared']],
  [[['capabilities', 'streaming'], false]],
  [[['capabilities', 'stopSequences'], false]],
  [[['capabilities', 'parallelToolCalls'], true]],
  [[['capabilities', 'usageReported'], false]],
  [
    [['capabilities', 'imageTokens'], { pixelsPerToken: 750, maxTokens: 1600, minTokens: 85 }],
    [['capabilities', 'imageInput'], true],
  ],
  [[['capabilities', 'allowedTools'], ['native', 'envelope']]],
  [[['capabilities', 'schemaDialect'], 'strict-closed']],
  [[['capabilities', 'tokenErrorRatio'], 0.25]],
  [[['capabilities', 'reasoning'], { control: 'reasoning_effort', lowest: 'low' }]],
  [[['capabilities', 'promptCache'], { kind: 'automatic' }]],
  [[['capabilities', 'sampling'], { accepts: 'without_thinking', topP: { min: 0.1, max: 1 } }]],
  [[['capabilities', 'outputBoundField'], 'max_completion_tokens']],
];

const valueAt = (entry: Record<string, unknown>, keyPath: readonly string[]): unknown => keyPath.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], entry);

describe('the fields of a model entry and of a connection', () => {
  it('setModelField writes every field family of a model entry under its path, and undefined removes the key', async () => {
    const home = homeWith(BASE);
    for (const family of FIELD_FAMILIES) {
      const where = family.map(([keyPath]) => keyPath.join('.')).join(' with ');
      const result = await editModels(home, family.map(([keyPath, value]) => op('setModelField', { model: LMSTUDIO_GEMMA, path: keyPath, value })));
      expect(result.wrote, where).toBe(true);
      expect(result.summaries, where).toHaveLength(family.length);
      const entry = (connectionsOf(home)[1]?.['models'] as Record<string, unknown>[])[0] as Record<string, unknown>;
      for (const [keyPath, value] of family) expect(valueAt(entry, keyPath), keyPath.join('.')).toEqual(value);
      expect(await loads(home), where).toEqual([DEVSTRAL_MODEL, QWEN_MODEL, LMSTUDIO_GEMMA, LLAMA_MODEL]);
    }
    const alone = await refusalOfEdit(editModels(homeWith(BASE), [op('setModelField', { model: LMSTUDIO_GEMMA, path: ['capabilities', 'imageInput'], value: true })]));
    expect(REFUSED_VALUE_CODES).toContain(alone.code);
    await editModels(home, [op('setModelField', { model: LMSTUDIO_GEMMA, path: ['toolCalling'], value: undefined }), op('setModelField', { model: LMSTUDIO_GEMMA, path: ['capabilities', 'tokenErrorRatio'], value: undefined })]);
    const entry = (connectionsOf(home)[1]?.['models'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty('toolCalling');
    expect(entry['capabilities']).not.toHaveProperty('tokenErrorRatio');
    expect((entry['capabilities'] as Record<string, unknown>)['contextWindow']).toBe(8192);
    const before = textOf(home);
    expect(REFUSED_VALUE_CODES).toContain((await refusalOfEdit(editModels(home, [op('setModelField', { model: LMSTUDIO_GEMMA, path: ['capabilities', 'contextWindow'], value: -1 })]))).code);
    expect(textOf(home)).toBe(before);
  });

  it('setConnectionField: a key reference replaces the other one, an address replaces the socket, and a new API renormalises the ids and re-checks the server name', async () => {
    const keyed = homeWith({ models: { connections: [{ adapter: 'chat-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeySecret: 'openai-key', models: [{ id: 'gpt-5.5', capabilities: GEMMA_WINDOW }] }] } });
    await editModels(keyed, [op('setConnectionField', { provider: 'openai', path: ['apiKeyEnv'], value: 'OPENAI_API_KEY' })]);
    expect(connectionsOf(keyed)[0]).toMatchObject({ apiKeyEnv: 'OPENAI_API_KEY' });
    expect(connectionsOf(keyed)[0]).not.toHaveProperty('apiKeySecret');

    const socket = homeWith({ models: { connections: [{ adapter: 'chat-completions', provider: 'home', socketPath: '/run/llm/x.sock', models: [{ id: 'x', capabilities: GEMMA_WINDOW }] }] } });
    await editModels(socket, [op('setConnectionField', { provider: 'home', path: ['baseUrl'], value: 'http://127.0.0.1:8080/v1' })]);
    expect(connectionsOf(socket)[0]).toMatchObject({ baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(connectionsOf(socket)[0]).not.toHaveProperty('socketPath');

    const result = await editModels(socket, [op('setConnectionField', { provider: 'home', path: ['adapter'], value: 'ollama' })]);
    expect(result.summaries).toEqual(['Set API of home to Ollama API.']);
    expect(connectionsOf(socket)[0]).toMatchObject({ adapter: 'ollama', provider: 'home' });
    expect(idsOf(connectionsOf(socket)[0])).toEqual(['x:latest']);
    expect(await loads(socket)).toEqual(['home/x:latest']);

    const named = homeWith({ models: { connections: [{ adapter: 'ollama', provider: 'ollama', baseUrl: 'http://192.168.1.20:11434', models: [DEVSTRAL] }] } });
    const before = textOf(named);
    const refused = await refusalOfEdit(editModels(named, [op('setConnectionField', { provider: 'ollama', path: ['adapter'], value: 'chat-completions' })]));
    expect(refused).toEqual({ code: 'reserved_name', message: RESERVED_SENTENCE });
    expect(textOf(named)).toBe(before);
  });

  it('setProvider rewrites every reference to the models of the server in the same write; null removes the key; a taken or reserved name is refused', async () => {
    const home = homeWith(REFERRED);
    const renamed = await editModels(home, [op('setProvider', { provider: 'lmstudio', name: 'studio' })]);
    expect(renamed.summaries).toEqual(['Renamed lmstudio to studio.']);
    expect(documentOf(home)).toEqual({
      autoMode: { classifier: 'studio/gemma-3-4b' },
      models: {
        connections: [S2.models.connections[0], { ...S2_LMSTUDIO, provider: 'studio' }],
        start: 'studio/gemma-3-4b',
        fallback: [OLLAMA_GEMMA, 'studio/gemma-3-4b'],
        roles: { compaction: 'studio/gemma-3-4b' },
        billingChanges: [{ from: 'local', to: 'metered' }, { from: 'local', to: 'plan', model: 'studio/gemma-3-4b' }],
      },
    });
    const cleared = await editModels(home, [op('setProvider', { provider: 'studio', name: null })]);
    expect(cleared.summaries).toEqual(['studio is now named srv-127.0.0.1-1234.']);
    expect(connectionsOf(home)[1]).not.toHaveProperty('provider');
    expect(modelsOf(home).start).toBe('srv-127.0.0.1-1234/gemma-3-4b');
    expect(modelsOf(home).fallback).toEqual([OLLAMA_GEMMA, 'srv-127.0.0.1-1234/gemma-3-4b']);
    expect(await loads(home)).toEqual([OLLAMA_GEMMA, 'srv-127.0.0.1-1234/gemma-3-4b']);

    const before = textOf(home);
    expect(await refusalOfEdit(editModels(home, [op('setProvider', { provider: 'srv-127.0.0.1-1234', name: 'ollama' })]))).toEqual({ code: 'name_taken', message: 'ollama is already used by another server.' });
    expect((await refusalOfEdit(editModels(home, [op('setProvider', { provider: 'srv-127.0.0.1-1234', name: 'Studio' })]))).code).toBe('invalid_value');
    expect(textOf(home)).toBe(before);
    const alone = homeWith({ models: { connections: [S2_LMSTUDIO] } });
    expect(await refusalOfEdit(editModels(alone, [op('setProvider', { provider: 'lmstudio', name: 'ollama' })]))).toEqual({ code: 'reserved_name', message: RESERVED_SENTENCE });
  });
});

describe('server programs, wait limits and dialects', () => {
  it('one call with a server declaration and its model writes the file of the design', async () => {
    const home = homeWith();
    const result = await editModels(home, [
      op('declareServer', { id: 'llama-server', ...S4_SERVER }),
      addModel({ adapter: 'managed', server: 'llama-server' }, { id: 'qwen3-coder-30b', capabilities: { contextWindow: 65536, maxOutputTokens: 16384 } }),
    ]);
    expect(result).toEqual({ wrote: true, summaries: ['Declared the server program llama-server.', 'Added qwen3-coder-30b. It is used from the next request.'], model: LLAMA_MODEL });
    expect(documentOf(home)).toEqual(S4);
  });

  it('setServerField changes one field of a declared program and refuses a value the declaration cannot hold', async () => {
    const home = homeWith(BASE);
    expect((await editModels(home, [op('setServerField', { id: 'llama-server', field: 'readyPath', value: '/ready' })])).summaries).toEqual(['Set readyPath of llama-server.']);
    await editModels(home, [op('setServerField', { id: 'llama-server', field: 'args', value: ['--listen', '{socket}'] })]);
    expect(modelsOf(home).servers?.['llama-server']).toEqual({ ...S4_SERVER, readyPath: '/ready', args: ['--listen', '{socket}'] });
    const before = textOf(home);
    expect((await refusalOfEdit(editModels(home, [op('setServerField', { id: 'llama-server', field: 'readyPath', value: 'ready' })]))).code).toBe('invalid_value');
    expect((await refusalOfEdit(editModels(home, [op('setServerField', { id: 'llama-server', field: 'command', value: 'llama-server' })]))).code).toBe('invalid_value');
    expect(textOf(home)).toBe(before);
  });

  it('setTimeouts writes milliseconds, accepts 0 as never cut, and says the values in force', async () => {
    const home = homeWith(BASE);
    expect((await editModels(home, [op('setTimeouts', { headersTimeoutMs: 600000 })])).summaries).toEqual(['Waits saved: first reply 10 min, no data 5 min.']);
    expect(modelsOf(home)).toMatchObject({ headersTimeoutMs: 600000 });
    expect(modelsOf(home)).not.toHaveProperty('idleTimeoutMs');
    expect((await editModels(home, [op('setTimeouts', { headersTimeoutMs: 0, idleTimeoutMs: 90000 })])).summaries).toEqual(['Waits saved: first reply never cut, no data 90 s.']);
    expect(modelsOf(home)).toMatchObject({ headersTimeoutMs: 0, idleTimeoutMs: 90000 });
    expect((await refusalOfEdit(editModels(home, [op('setTimeouts', { idleTimeoutMs: -1 })]))).code).toBe('invalid_value');
  });

  it('setDialects refuses an object that is no dialect table and leaves the file as it was', async () => {
    const home = homeWith(BASE);
    const before = textOf(home);
    expect((await refusalOfEdit(editModels(home, [op('setDialects', { dialects: { mine: 5 } })]))).code).toBe('invalid_value');
    expect(textOf(home)).toBe(before);
    expect((await editModels(home, [op('setDialects', { dialects: {} })])).summaries).toEqual(['Schema dialects saved.']);
  });
});

describe('what the writer never does', () => {
  it('an operation whose result would not load is refused with the sentence of the loader, and the bytes of the file stay', async () => {
    const home = homeWith({ models: { connections: [{ adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:8080/a', models: [{ id: 'm', capabilities: GEMMA_WINDOW }] }] } });
    const before = textOf(home);
    const refused = await refusalOfEdit(editModels(home, [addModel({ adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:8080/b' }, { id: 'n', capabilities: GEMMA_WINDOW })]));
    expect(refused.code).toBe('would_not_load');
    expect(refused.message.startsWith('Not saved: ')).toBe(true);
    expect(refused.message.endsWith('models.connections[0] and models.connections[1] both resolve to the server name "srv-127.0.0.1-8080"; write "provider" on one of them')).toBe(true);
    expect(textOf(home)).toBe(before);
    const unresolved = await refusalOfEdit(editModels(home, [op('setStart', { model: 'ollama/nope' })]));
    expect(unresolved).toEqual({ code: 'unresolved', message: 'The model "ollama/nope" is not configured. Configured models: m.' });
    expect(textOf(home)).toBe(before);
  });

  it('every other key of the file is kept as written', async () => {
    const other = { network: { httpsProxy: 'http://proxy.corp:3128' }, permissions: { defaultMode: 'plan' }, models: { headersTimeoutMs: 120000 } };
    const home = homeWith(other);
    await editModels(home, [addModel(OLLAMA, DEVSTRAL)]);
    expect(documentOf(home)).toEqual({ ...other, models: { headersTimeoutMs: 120000, connections: [{ ...OLLAMA, models: [DEVSTRAL] }] } });
    expect(Object.keys(documentOf(home))).toEqual(['network', 'permissions', 'models']);
    expect(fs.statSync(home.file).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['addModel', addModel(OLLAMA, { id: 'llama3.2:latest', capabilities: GEMMA_WINDOW }), 'Added llama3.2. It is used from the next request.'],
    ['addModel of a model that is there', addModel(OLLAMA, DEVSTRAL), 'devstral-small-2 is already in your settings.'],
    ['removeModel', op('removeModel', { model: QWEN_MODEL }), 'Removed qwen3.8:27b.'],
    ['removeConnection with two models', op('removeConnection', { provider: 'ollama' }), 'Removed ollama and its 2 models.'],
    ['removeConnection with one model', op('removeConnection', { provider: 'lmstudio' }), 'Removed lmstudio and its 1 model.'],
    ['setStart', op('setStart', { model: LMSTUDIO_GEMMA }), 'New sessions start with gemma-3-4b.'],
    ['setStart cleared', op('setStart', { model: null }), 'New sessions start with the first model in your settings.'],
    ['setFallback', op('setFallback', { models: [LMSTUDIO_GEMMA, QWEN_MODEL] }), 'Fallback order saved: gemma-3-4b → qwen3.8:27b'],
    ['setFallback cleared', op('setFallback', { models: [] }), 'Fallback order cleared.'],
    ['allowBillingChange', op('allowBillingChange', { from: 'local', to: 'metered' }), 'Requests may now fall from local to metered.'],
    ['allowBillingChange for one model', op('allowBillingChange', { from: 'local', to: 'metered', model: DEVSTRAL_MODEL }), 'Requests may now fall from local to metered for devstral-small-2.'],
    ['forbidBillingChange', op('forbidBillingChange', { from: 'local', to: 'plan' }), 'Requests may no longer fall from local to plan.'],
    ['setRole compaction', op('setRole', { job: 'compaction', model: QWEN_MODEL }), 'Summaries now uses qwen3.8:27b.'],
    ['setRole reflection cleared', op('setRole', { job: 'reflection', model: null }), "Reflection now uses the session's model."],
    ['setRole analysis', op('setRole', { job: 'analysis', model: LMSTUDIO_GEMMA }), 'Analysis now uses gemma-3-4b.'],
    ['setClassifier', op('setClassifier', { model: LMSTUDIO_GEMMA }), 'The auto-mode classifier is now gemma-3-4b.'],
    ['setClassifier cleared', op('setClassifier', { model: null }), "The auto-mode classifier is now the session's model."],
    ['setModelField', op('setModelField', { model: DEVSTRAL_MODEL, path: ['capabilities', 'contextWindow'], value: 65536 }), 'Set Context window of devstral-small-2 to 65536.'],
    ['setModelField cleared', op('setModelField', { model: LMSTUDIO_GEMMA, path: ['toolCalling'], value: undefined }), 'Cleared Tool calling of gemma-3-4b.'],
    ['setConnectionField', op('setConnectionField', { provider: 'lmstudio', path: ['maxConcurrency'], value: 2 }), 'Set Concurrent requests of lmstudio to 2.'],
    ['setProvider', op('setProvider', { provider: 'lmstudio', name: 'studio' }), 'Renamed lmstudio to studio.'],
    ['setProvider cleared', op('setProvider', { provider: 'lmstudio', name: null }), 'lmstudio is now named srv-127.0.0.1-1234.'],
    ['declareServer', op('declareServer', { id: 'second-server', command: '/opt/second/bin/serve', args: ['{socket}'], readyPath: '/health' }), 'Declared the server program second-server.'],
    ['setServerField', op('setServerField', { id: 'llama-server', field: 'command', value: '/usr/local/bin/llama-server' }), 'Set command of llama-server.'],
    ['forgetServer', op('forgetServer', { id: 'spare-server' }), 'Forgot the server program spare-server.'],
    ['setTimeouts', op('setTimeouts', { headersTimeoutMs: 600000, idleTimeoutMs: 0 }), 'Waits saved: first reply 10 min, no data never cut.'],
    ['setDialects', op('setDialects', { dialects: {} }), 'Schema dialects saved.'],
  ] as const)('the summary line of %s', async (_name, operation, summary) => {
    const home = homeWith(BASE);
    expect((await editModels(home, [operation])).summaries).toEqual([summary]);
    expect(documentOf(home)['network']).toEqual(BASE.network);
    await loads(home);
  });

  it('planModelsEdit lists what a removal and a rename change, builds the new document and leaves the one it was given', () => {
    const given = structuredClone(REFERRED);
    const removal = planned(given, [op('removeModel', { model: LMSTUDIO_GEMMA })]);
    expect(given).toEqual(REFERRED);
    expect(removal.references).toHaveLength(FIVE_REFERENCES.length);
    expect(removal.references).toEqual(expect.arrayContaining(FIVE_REFERENCES));
    expect(removal.summaries).toEqual(['Removed lmstudio/gemma-3-4b.']);
    expect(referencesIn(removal.document)).toEqual(AFTER_REMOVAL);
    const rename = planned(given, [op('setProvider', { provider: 'lmstudio', name: 'studio' })]);
    expect(rename.references).toHaveLength(FIVE_REFERENCES.length);
    expect(rename.references).toEqual(expect.arrayContaining(FIVE_REFERENCES));
    expect(rename.summaries).toEqual(['Renamed lmstudio to studio.']);
    expect(planned(given, [op('removeModel', { model: OLLAMA_GEMMA })]).references).toEqual([{ kind: 'fallback', position: 1 }]);
    expect(planModels(given, [op('removeModel', { model: 'ollama/nope' })])).toEqual({ refused: { code: 'unresolved', message: 'The model "ollama/nope" is not configured. Configured models: ollama/gemma-3-4b, lmstudio/gemma-3-4b.' } });
  });

  it('the edit is planned again on the file read under the lock', async () => {
    const home = homeWith(S1_FILE);
    const { release, holder } = heldLock(home);
    const outcome = editModels(home, [op('setStart', { model: QWEN_MODEL })]).then(
      (result) => result.summaries,
      (error: unknown) => [error instanceof Error ? error.message : String(error)],
    );
    await turn();
    fs.writeFileSync(home.file, JSON.stringify({ models: { connections: [{ ...OLLAMA, models: [DEVSTRAL, QWEN] }] } }), { mode: 0o600 });
    release();
    await holder;
    expect(await outcome).toEqual(['New sessions start with qwen3.8:27b.']);
    expect(documentOf(home)).toEqual({ models: { connections: [{ ...OLLAMA, models: [DEVSTRAL, QWEN] }], start: QWEN_MODEL } });
  });

  it('a change made by hand between the plan and the write is judged on the file as it is', async () => {
    const withBoth = { models: { connections: [{ ...OLLAMA, models: [DEVSTRAL, QWEN] }] } };
    const home = homeWith(withBoth);
    expect(planned(documentOf(home), [op('setStart', { model: QWEN_MODEL })]).summaries).toEqual(['New sessions start with qwen3.8:27b.']);
    fs.writeFileSync(home.file, JSON.stringify(S1_FILE), { mode: 0o600 });
    const before = textOf(home);
    const refused = await refusalOfEdit(editModels(home, [op('setStart', { model: QWEN_MODEL })]));
    expect(refused).toEqual({ code: 'unresolved', message: 'The model "ollama/qwen3.8:27b" is not configured. Configured models: devstral-small-2.' });
    expect(textOf(home)).toBe(before);
  });

  it('the writer of an earlier build is gone: one writer, with its plan function and its refusal class', () => {
    const exportsOf = config as Record<string, unknown>;
    expect(['addModelConnection', 'connectionTargetName'].filter((name) => name in exportsOf)).toEqual([]);
    expect(['editModelsSettings', 'planModelsEdit', 'ModelsEditRefused', 'editUserSettings'].filter((name) => typeof exportsOf[name] !== 'function')).toEqual([]);
  });

  it('a service with an API key is added with the reference to its key and its written name, never a key value', async () => {
    const home = homeWith(S1_FILE);
    const hosted = { adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' };
    const entry = { id: 'gpt-5.5', capabilities: { contextWindow: 400000, maxOutputTokens: 128000 } };
    const result = await editModels(home, [addModel(hosted, entry)]);
    expect(result.model).toBe('openai/gpt-5.5');
    expect(connectionsOf(home)[1]).toEqual({ ...hosted, models: [entry] });
    expect(Object.keys(connectionsOf(home)[1] ?? {}).filter((key) => /key/i.test(key))).toEqual(['apiKeyEnv']);
    expect(await loads(home)).toEqual([DEVSTRAL_MODEL, 'openai/gpt-5.5']);
  });

  it('a list of operations is one write: the file is replaced once and the summaries come back in the order of the operations', async () => {
    const home = homeWith(S1_FILE);
    const renames = vi.spyOn(fs.promises, 'rename');
    const result = await editModels(home, [
      op('declareServer', { id: 'llama-server', ...S4_SERVER }),
      addModel({ adapter: 'managed', server: 'llama-server' }, { id: 'qwen3-coder-30b', capabilities: { contextWindow: 65536, maxOutputTokens: 16384 } }),
    ]);
    expect(renames.mock.calls.filter(([, to]) => String(to) === home.file)).toHaveLength(1);
    expect(result.summaries).toEqual(['Declared the server program llama-server.', 'Added qwen3-coder-30b. It is used from the next request.']);
    expect(result.model).toBe(LLAMA_MODEL);
    expect(await loads(home)).toEqual([DEVSTRAL_MODEL, LLAMA_MODEL]);
  });

  it('a refused operation refuses the whole list: the file keeps its bytes and the model of the first operation is not in it', async () => {
    const home = homeWith(S1_FILE);
    const before = textOf(home);
    const renames = vi.spyOn(fs.promises, 'rename');
    const refused = await refusalOfEdit(editModels(home, [addModel(OLLAMA, QWEN), op('setStart', { model: 'ollama/nope' })]));
    expect(refused.code).toBe('unresolved');
    expect(refused.message).toBe('The model "ollama/nope" is not configured. Configured models: devstral-small-2, qwen3.8:27b.');
    expect(textOf(home)).toBe(before);
    expect(renames.mock.calls.filter(([, to]) => String(to) === home.file)).toEqual([]);
    expect(await loads(home)).toEqual([DEVSTRAL_MODEL]);
  });
});
