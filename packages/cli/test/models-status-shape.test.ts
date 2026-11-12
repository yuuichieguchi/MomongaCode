import { describe, expect, it } from 'vitest';
import { detectModels, listModels } from '../src/commands/models.ts';
import { OLLAMA_ADDRESS, S2, homeWith, ollamaFound, shellOf } from './models-shell-harness.ts';

const MODEL_KEYS = ['address', 'billing', 'code', 'contextWindow', 'fallback', 'message', 'model', 'name', 'provider', 'state'];

describe('the JSON of the models commands is the settled shape of design-model-names 4.13 (cli-commands-C34)', () => {
  it('momonga models detect --json prints only the servers, each with the fields of a detected server and its models', async (context) => {
    const managed = { id: 'llama-server', binary: '/opt/llama/bin/llama-server' };
    const harness = shellOf(homeWith(context, undefined), { found: () => [ollamaFound(OLLAMA_ADDRESS, ['qwen3.8:27b']), managed as never] });

    await detectModels(harness.shell, { typed: [], json: true });

    const document = JSON.parse(harness.out()) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(['servers']);
    expect(document['servers']).toEqual([{ kind: 'ollama', provider: 'ollama', address: OLLAMA_ADDRESS, models: [{ id: 'qwen3.8:27b', tools: 'unknown' }] }]);
  });

  it('momonga models --json prints for each model only the fields the design names', async (context) => {
    const harness = shellOf(homeWith(context, S2));

    await listModels(harness.shell, { json: true });

    const document = JSON.parse(harness.out()) as { models: Record<string, unknown>[] };
    for (const model of document.models) expect(Object.keys(model).every((key) => MODEL_KEYS.includes(key)), Object.keys(model).join(',')).toBe(true);
  });
});
