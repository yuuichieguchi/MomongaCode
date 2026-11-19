import { describe, expect, it } from 'vitest';
import { maxOutputTokensFor } from '@momonga/protocol';
import type { MomongaModelList } from '@momonga/protocol';
import { listModels, modelDescriber, runModelsForm } from '../src/commands/models.ts';
import type { FormInput } from '../src/commands/models.ts';
import { formatTokens } from '../src/format-tokens.ts';
import { OLLAMA_ADDRESS, bytesOf, documentOf, homeWith, listingOf, ollamaFound, shellOf } from './models-shell-harness.ts';

const input = (args: readonly string[], options: FormInput['options'] = {}): FormInput => ({ args: [...args], options });

const SHOW_ANSWERS: Readonly<Record<string, unknown>> = {
  'long:7b': { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } },
  'bare:3b': { capabilities: ['completion'] },
};

const showFetch = async (url: string, init: { method: string; body?: string }) => {
  if (init.method !== 'POST' || !url.endsWith('/api/show')) return { ok: false, body: null };
  const { model } = JSON.parse(init.body ?? '{}') as { model: string };
  const text = JSON.stringify(SHOW_ANSWERS[model]);
  return {
    ok: true,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
};

const FOUND = () => [ollamaFound(OLLAMA_ADDRESS, ['long:7b', 'bare:3b'])];

const connectionModels = (file: string): unknown[] => {
  const models = documentOf(file)['models'] as { connections: { models: unknown[] }[] };
  return models.connections.flatMap((connection) => connection.models);
};

describe('momonga models add writes a complete entry from what the server reports (cli-commands-C07)', () => {
  it('writes no window for the picked Ollama model when none is given, though the server reports its maximum', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home, { found: FOUND, describe: modelDescriber(showFetch) });

    expect(await runModelsForm(harness.shell, 'add', input([], { model: 'long:7b', yes: true }))).toBe(0);

    expect(connectionModels(home.settingsFile)).toEqual([{ id: 'long:7b' }]);
  });

  it('writes the window given with --window for the picked Ollama model', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home, { found: FOUND, describe: modelDescriber(showFetch) });

    expect(await runModelsForm(harness.shell, 'add', input([], { model: 'long:7b', window: '8192', yes: true }))).toBe(0);

    expect(connectionModels(home.settingsFile)).toEqual([{ id: 'long:7b', capabilities: { contextWindow: 8192, maxOutputTokens: maxOutputTokensFor(8192) } }]);
  });

  it('writes an Ollama model whose window no one reports without a window, so the server chooses', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home, { found: FOUND, describe: modelDescriber(showFetch) });

    expect(await runModelsForm(harness.shell, 'add', input([], { model: 'bare:3b', yes: true }))).toBe(0);

    expect(connectionModels(home.settingsFile)).toEqual([{ id: 'bare:3b' }]);
  });

  it('lists the models of each found server with their names when no model is named', async (context) => {
    const harness = shellOf(homeWith(context, undefined), { found: FOUND, describe: modelDescriber(showFetch) });

    expect(await runModelsForm(harness.shell, 'add', input([]))).toBe(2);

    expect(harness.out()).toContain('long:7b');
    expect(harness.out()).toContain('bare:3b');
  });

  it('refuses by name a flag that a plan model cannot use', async (context) => {
    const harness = shellOf(homeWith(context, undefined));

    expect(await runModelsForm(harness.shell, 'add', input([], { plan: 'chatgpt', model: 'gpt-5.5', address: 'http://127.0.0.1:9', service: 'x' }))).toBe(2);

    expect(harness.err()).toContain('--address');
    expect(harness.err()).toContain('--service');
  });

  it('states the command that adds a model at an address where no server answered', async (context) => {
    const harness = shellOf(homeWith(context, undefined));

    expect(await runModelsForm(harness.shell, 'add', input([], { address: 'http://127.0.0.1:9' }))).toBe(1);

    expect(harness.err()).toContain('momonga models add --address http://127.0.0.1:9 --api <api> --model <id>');
    expect(harness.err()).not.toContain('?');
  });

  it.for([true, false])('refuses a model at an address where no server answered when no window is given (--yes %s), naming --window, and writes nothing', async (yes, context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home);

    expect(await runModelsForm(harness.shell, 'add', input([], { address: 'http://127.0.0.1:9', api: 'openai', model: 'deadmodel', ...(yes ? { yes: true } : {}) }))).toBe(1);

    expect(harness.err()).toContain(
      `The context window of deadmodel is needed, and no model server answered at http://127.0.0.1:9. Give it with --window <tokens>: momonga models add --address http://127.0.0.1:9 --api openai --model deadmodel${yes ? ' --yes' : ''} --window <tokens>`,
    );
    expect(harness.err()).not.toContain('invalid settings');
    expect(harness.out()).toBe('');
    expect(bytesOf(home.settingsFile)).toBeUndefined();
  });

  it('writes an Ollama model at an address where no server answered without a window when none is given, so the server chooses', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home);

    expect(await runModelsForm(harness.shell, 'add', input([], { address: 'http://127.0.0.1:9', api: 'ollama', model: 'deadmodel', yes: true }))).toBe(0);

    expect(connectionModels(home.settingsFile)).toEqual([{ id: 'deadmodel:latest' }]);
  });

  it('writes a model at an address where no server answered when its window is given', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home);

    expect(await runModelsForm(harness.shell, 'add', input([], { address: 'http://127.0.0.1:9', api: 'ollama', model: 'deadmodel', window: '8192', yes: true }))).toBe(0);

    expect(connectionModels(home.settingsFile)).toEqual([{ id: 'deadmodel:latest', capabilities: { contextWindow: 8192, maxOutputTokens: maxOutputTokensFor(8192) } }]);
  });

  it('shows the window a model is configured with while the gateway measures it', async (context) => {
    const home = homeWith(context, { models: { connections: [{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS, models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } });
    const measuring = { toolCalling: { state: 'probing', message: 'measuring', retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' } as const;
    const listed = listingOf(home.home);
    const listing: MomongaModelList = { ...listed, data: listed.data.map((entry) => ({ ...entry, capabilities: measuring })) };
    const harness = shellOf(home, { listing: () => listing });

    await listModels(harness.shell, { json: false });

    expect(harness.out()).toContain(`${formatTokens(32768)} tokens`);
    expect(harness.out()).not.toContain('window not known');
  });
});
