import { describe, expect, it } from 'vitest';
import { TARGET_PROBING_MESSAGE, messageOf } from '@momonga/protocol';
import type { MomongaModelList } from '@momonga/protocol';
import { detectModels, listModels } from '../src/commands/models.ts';
import { S2, bytesOf, homeWith, listingOf, ollamaFound, shellOf } from './models-shell-harness.ts';

const EMPTY: MomongaModelList = { object: 'list', data: [], start: null, roles: {} };

describe('momonga models', () => {
  it('prints one block per server with a row per model, the window written by formatTokens and the start model marked', async (context) => {
    const at = homeWith(context, S2);
    const harness = shellOf(at);

    const code = await listModels(harness.shell, { json: false });

    expect(code).toBe(0);
    expect(harness.out()).toBe(
      [
        'ollama  ·  http://127.0.0.1:11434',
        '  ollama/gemma-3-4b  ·  32.8k tokens  ·  local  ·  starts new sessions',
        'lmstudio  ·  http://127.0.0.1:1234/v1',
        '  lmstudio/gemma-3-4b  ·  4.1k tokens  ·  local',
        '',
      ].join('\n'),
    );
  });

  it('prints "window not known" for a model whose capabilities declare no window', async (context) => {
    const at = homeWith(context, S2);
    const listed = listingOf(at.home);
    const measuring = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' } as const;
    const harness = shellOf(at, { listing: () => ({ ...listed, data: listed.data.map((entry) => (entry.provider === 'lmstudio' ? { ...entry, capabilities: measuring } : entry)) }) });

    await listModels(harness.shell, { json: false });

    expect(harness.out().split('\n')).toContain('  lmstudio/gemma-3-4b  ·  window not known');
  });

  it('prints the one JSON document with the state named by the readiness state', async (context) => {
    const harness = shellOf(homeWith(context, S2));

    await listModels(harness.shell, { json: true });

    expect(harness.out()).toBe(
      `${'{"start":"ollama/gemma-3-4b:latest","roles":{},"models":[{"model":"ollama/gemma-3-4b:latest","name":"ollama/gemma-3-4b","provider":"ollama","address":"http://127.0.0.1:11434","billing":"local","contextWindow":32768,"fallback":[],"state":"ready"},{"model":"lmstudio/gemma-3-4b","name":"lmstudio/gemma-3-4b","provider":"lmstudio","address":"http://127.0.0.1:1234/v1","billing":"local","contextWindow":4096,"fallback":[],"state":"ready"}]}'}\n`,
    );
  });

  it('says that no model is connected, and prints the empty document with --json', async (context) => {
    const text = shellOf(homeWith(context, undefined), { listing: () => EMPTY });
    const json = shellOf(homeWith(context, undefined), { listing: () => EMPTY });

    await listModels(text.shell, { json: false });
    await listModels(json.shell, { json: true });

    expect(text.out()).toBe(`${messageOf('noModelConnected', 'cli')}\n`);
    expect(json.out()).toBe('{"start":null,"roles":{},"models":[]}\n');
  });
});

describe('momonga models detect', () => {
  it('prints a block per server found with its models as the server lists them and writes nothing', async (context) => {
    const at = homeWith(context, S2);
    const before = bytesOf(at.settingsFile);
    const harness = shellOf(at, { found: () => [ollamaFound('http://127.0.0.1:41434', ['devstral-small-2:latest'])] });

    const code = await detectModels(harness.shell, { typed: ['http://127.0.0.1:41434'], json: false });

    expect(code).toBe(0);
    expect(harness.out()).toBe('ollama-127.0.0.1-41434  ·  http://127.0.0.1:41434\n  devstral-small-2:latest\n');
    expect(bytesOf(at.settingsFile)).toBe(before);
  });

  it('says that no model server answered on this computer and exits 0', async (context) => {
    const harness = shellOf(homeWith(context, undefined));

    const code = await detectModels(harness.shell, { typed: [], json: false });

    expect(code).toBe(0);
    expect(harness.out()).toBe('No model server answered on this computer.\n');
  });
});
