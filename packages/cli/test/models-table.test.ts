import { describe, expect, it } from 'vitest';
import { messageOf } from '@momonga/protocol';
import { checkModels, listModels } from '../src/commands/models.ts';
import { OLLAMA_ADDRESS, homeWith, ollamaFound, shellOf } from './models-shell-harness.ts';

const ollama = (models: readonly Record<string, unknown>[], baseUrl = OLLAMA_ADDRESS) => ({ adapter: 'ollama', baseUrl, models });
const QWEN = { id: 'qwen3.8:27b', capabilities: { contextWindow: 262144, maxOutputTokens: 32768 } };
const LUNA_PLAN = { adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-6-luna' }] };

const printed = async (settings: unknown, context: Parameters<typeof homeWith>[0], json = false): Promise<string> => {
  const harness = shellOf(homeWith(context, settings));
  await listModels(harness.shell, { json });
  return harness.out();
};

describe('momonga models prints one aligned table', () => {
  it('prints the header and a row per model for a local server and a plan', async (context) => {
    expect(await printed({ models: { connections: [ollama([QWEN]), LUNA_PLAN], start: 'ollama/qwen3.8:27b' } }, context)).toBe(
      [
        'model               window  billing  server                  state',
        'ollama/qwen3.8:27b  262.1k  local    http://127.0.0.1:11434  starts new sessions',
        'gpt-6-luna                  plan     chatgpt                 available',
        '',
      ].join('\n'),
    );
  });

  it('prints the text of an unknown window in the window column', async (context) => {
    expect(await printed({ models: { connections: [ollama([{ id: 'mystery:7b' }, QWEN])], start: 'ollama/qwen3.8:27b' } }, context)).toBe(
      [
        'model               window            billing  server                  state',
        'ollama/mystery:7b   window not known           http://127.0.0.1:11434',
        'ollama/qwen3.8:27b  262.1k            local    http://127.0.0.1:11434  starts new sessions',
        '',
      ].join('\n'),
    );
  });

  it('prints the mark of a model its server no longer lists in the state column of check', async (context) => {
    const harness = shellOf(homeWith(context, { models: { connections: [ollama([QWEN, { id: 'gone:1b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }])], start: 'ollama/qwen3.8:27b' } }), {
      found: () => [ollamaFound(OLLAMA_ADDRESS, ['qwen3.8:27b'])],
    });
    await checkModels(harness.shell, { json: false });
    expect(harness.out()).toBe(
      [
        'model               window  billing  server                  state',
        'ollama/qwen3.8:27b  262.1k  local    http://127.0.0.1:11434  starts new sessions',
        'ollama/gone:1b      4.1k    local    http://127.0.0.1:11434  not listed by the server',
        '',
      ].join('\n'),
    );
  });

  it('joins the states of a plan model that also starts new sessions', async (context) => {
    expect(await printed({ models: { connections: [LUNA_PLAN, ollama([QWEN])], start: 'chatgpt/gpt-6-luna' } }, context)).toBe(
      [
        'model               window  billing  server                  state',
        'gpt-6-luna                  plan     chatgpt                 available, starts new sessions',
        'ollama/qwen3.8:27b  262.1k  local    http://127.0.0.1:11434',
        '',
      ].join('\n'),
    );
  });

  it('aligns wide characters by their display width', async (context) => {
    const wideAddress = { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/日本', billing: 'local', models: [{ id: 'm', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }] };
    expect(await printed({ models: { connections: [ollama([{ id: '日本語:7b', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }, QWEN]), wideAddress], start: 'ollama/qwen3.8:27b' } }, context)).toBe(
      [
        'model               window  billing  server                      state',
        'ollama/日本語:7b    8.2k    local    http://127.0.0.1:11434',
        'ollama/qwen3.8:27b  262.1k  local    http://127.0.0.1:11434      starts new sessions',
        'lmstudio/m          4.1k    local    http://127.0.0.1:1234/日本',
        '',
      ].join('\n'),
    );
  });

  it('cannot hold a server without a model: the settings that name one are refused', async (context) => {
    await expect(printed({ models: { connections: [ollama([QWEN]), { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', billing: 'local', models: [] }] } }, context)).rejects.toThrow(
      'settings: models.connections[1]: models must list at least one model; run momonga models add to add one',
    );
  });

  it('says that no model is connected when nothing is configured', async (context) => {
    expect(await printed(undefined, context)).toBe(`${messageOf('noModelConnected', 'cli')}\n`);
  });

  it('keeps the JSON document', async (context) => {
    expect(await printed({ models: { connections: [ollama([QWEN]), LUNA_PLAN], start: 'ollama/qwen3.8:27b' } }, context, true)).toBe(
      '{"start":"ollama/qwen3.8:27b","roles":{},"models":[{"model":"ollama/qwen3.8:27b","name":"ollama/qwen3.8:27b","provider":"ollama","address":"http://127.0.0.1:11434","billing":"local","contextWindow":262144,"fallback":[],"state":"ready"},{"model":"chatgpt/gpt-6-luna","name":"gpt-6-luna","provider":"chatgpt","address":null,"billing":"plan","contextWindow":null,"fallback":[],"state":"unavailable","code":"capabilities_unknown","message":"the numbers of this model are not known"}]}\n',
    );
  });
});
