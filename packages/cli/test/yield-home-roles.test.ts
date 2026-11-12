import { describe, expect, it } from 'vitest';
import { liveSettingsFor } from '../src/eval/context-host.ts';
import { homeWith, threeModels } from './models-shell-harness.ts';
import { userModelsAt } from './user-models.ts';

describe('the settings of a case home', () => {
  it('hold the model roles of the user settings, with the servers their models need', (context) => {
    const user = userModelsAt(homeWith(context, threeModels({ roles: { reflection: 'lmstudio/gemma-3-4b' } })).home);

    const live = liveSettingsFor(user, ['ollama/qwen3.8:27b']);

    expect(live.models['roles']).toEqual({ reflection: 'lmstudio/gemma-3-4b' });
    expect(live.models['connections']).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'lmstudio', models: [expect.objectContaining({ id: 'gemma-3-4b' })] })]));
  });
});
