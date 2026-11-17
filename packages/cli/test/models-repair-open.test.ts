import { describe, expect, it } from 'vitest';
import { runModelsForm } from '../src/commands/models.ts';
import { OLLAMA_ADDRESS, documentOf, homeWith, shellOf } from './models-shell-harness.ts';

const UNLOADABLE = {
  models: {
    connections: [{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS, models: [{ id: 'devstral-small-2:latest', capabilities: { contextWindow: 'large' } }] }],
  },
};

describe('a settings file that does not load', () => {
  it('opens the models forms: the reason is shown, and a write that would leave the file unloadable is refused by the writer', async (context) => {
    const given = homeWith(context, UNLOADABLE);
    const harness = shellOf(given);

    const code = await runModelsForm(harness.shell, 'timeouts', { args: [], options: { headers: '10', yes: true } });

    expect(harness.err()).toContain('invalid settings at /models/connections/0/models/0/capabilities');
    expect(harness.out()).toBe('');
    expect(code).toBe(1);
    expect(documentOf(given.settingsFile)).toEqual(UNLOADABLE);
  });
});
