import { describe, expect, it } from 'vitest';
import { liveSettingsFor, needsPlanRelay } from '../src/eval/context-host.ts';
import { PLAN_TARGET, PRODUCT_WRITTEN_PLAN_CONNECTION } from './fake-models-listing.ts';
import { homeWith, threeModels } from './models-shell-harness.ts';
import { userModelsAt } from './user-models.ts';

describe('the settings of a case home', () => {
  it('hold the model roles of the user settings, with the servers their models need', (context) => {
    const user = userModelsAt(homeWith(context, threeModels({ roles: { reflection: 'lmstudio/gemma-3-4b' } })).home);

    const live = liveSettingsFor(user, ['ollama/qwen3.8:27b']);

    expect(live.models['roles']).toEqual({ reflection: 'lmstudio/gemma-3-4b' });
    expect(live.models['connections']).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'lmstudio', models: [expect.objectContaining({ id: 'gemma-3-4b' })] })]));
  });

  it('need the relay of the gateway when a role names a model on a plan sign-in, though the pinned model is local', (context) => {
    const settings = threeModels({ roles: { compaction: PLAN_TARGET } });
    const user = userModelsAt(homeWith(context, { models: { ...settings.models, connections: [...settings.models.connections, PRODUCT_WRITTEN_PLAN_CONNECTION] } }).home);

    expect(needsPlanRelay(user, ['ollama/qwen3.8:27b'])).toBe(true);
    expect(() => liveSettingsFor(user, ['ollama/qwen3.8:27b'])).toThrow('no relay');
  });
});
