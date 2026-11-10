import { describe, expect, it } from 'vitest';
import { checkModels, listModels } from '../src/commands/models.ts';
import { LMSTUDIO_ADDRESS, OLLAMA_ADDRESS, S2, homeWith, ollamaFound, shellOf } from './models-shell-harness.ts';
import type { ShellFakes } from './models-shell-harness.ts';

const NOT_LISTED_MESSAGE = 'The server of ollama/gemma-3-4b does not list "gemma-3-4b:latest". Remove the model, or check that the server serves it.';

const ollamaLostItsModel: ShellFakes['found'] = (request) =>
  request.typed[0] === OLLAMA_ADDRESS
    ? [ollamaFound(OLLAMA_ADDRESS, ['other:latest'])]
    : [{ kind: 'lmstudio', provider: 'lmstudio', address: LMSTUDIO_ADDRESS, models: [{ id: 'gemma-3-4b', tools: 'unknown' }] }];

describe('momonga models check', () => {
  it('asks each configured server once under the interrupt signal and marks the model its server no longer lists', async (context) => {
    const interrupt = new AbortController().signal;
    const at = homeWith(context, S2);
    const text = shellOf(at, { found: ollamaLostItsModel, interrupt });
    const json = shellOf(at, { found: ollamaLostItsModel, interrupt });

    const code = await checkModels(text.shell, { json: false });
    await checkModels(json.shell, { json: true });

    expect(code).toBe(0);
    expect(text.detections).toEqual([
      { candidates: [], typed: [OLLAMA_ADDRESS], signal: interrupt },
      { candidates: [], typed: [LMSTUDIO_ADDRESS], signal: interrupt },
    ]);
    expect(text.out().split('\n')).toEqual([
      'ollama  ·  http://127.0.0.1:11434',
      '  ollama/gemma-3-4b  ·  32.8k tokens  ·  local  ·  starts new sessions  ·  not listed by the server',
      'lmstudio  ·  http://127.0.0.1:1234/v1',
      '  lmstudio/gemma-3-4b  ·  4.1k tokens  ·  local',
      '',
    ]);
    const document = JSON.parse(json.out()) as { models: Record<string, unknown>[] };
    expect(document.models[0]).toMatchObject({ model: 'ollama/gemma-3-4b:latest', state: 'unavailable', code: 'model_not_listed', message: NOT_LISTED_MESSAGE });
    expect(document.models[1]).toMatchObject({ model: 'lmstudio/gemma-3-4b', state: 'ready' });
    expect(document.models[1]).not.toHaveProperty('code');
  });

  it('keeps no mark after the check: the listing that follows shows none', async (context) => {
    const harness = shellOf(homeWith(context, S2), { found: ollamaLostItsModel });
    await checkModels(harness.shell, { json: false });
    harness.stdout.length = 0;

    await listModels(harness.shell, { json: false });

    expect(harness.out()).not.toContain('not listed by the server');
  });

  it('momonga models asks no server and shows no mark', async (context) => {
    const harness = shellOf(homeWith(context, S2), { found: ollamaLostItsModel });

    await listModels(harness.shell, { json: false });

    expect(harness.detections).toEqual([]);
    expect(harness.out()).not.toContain('not listed by the server');
  });
});
