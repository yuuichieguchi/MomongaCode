import { describe, expect, it } from 'vitest';
import { runModelsHub } from '../../src/tui/models/hub.ts';
import { flowOf } from '../tui-models-harness.ts';
import type { Step } from '../tui-models-harness.ts';
import { S1, threeModels } from '../models-shell-harness.ts';

const cases: readonly { action: string; settings: unknown; steps: readonly Step[]; refreshes: readonly number[] }[] = [
  {
    action: 'changing the model for new sessions',
    settings: threeModels(),
    steps: [{ pick: 'Model for new sessions' }, { pick: 'Use the first model in my settings' }, { pick: 'Yes' }],
    refreshes: [0, 1],
  },
  {
    action: 'changing a role model',
    settings: threeModels(),
    steps: [{ pick: 'Models for other roles' }, { pick: /^Analysis/ }, { pick: 'ollama/qwen3.8:27b' }, { pick: 'Yes' }, { leave: true }],
    refreshes: [0, 1],
  },
  {
    action: 'removing the last model',
    settings: S1,
    steps: [{ pick: /^ollama\/devstral-small-2/ }, { pick: 'Remove' }, { pick: 'Yes' }],
    refreshes: [0, 1],
  },
  {
    action: 'declining to remove the last model',
    settings: S1,
    steps: [{ pick: /^ollama\/devstral-small-2/ }, { pick: 'Remove' }, { pick: 'No' }],
    refreshes: [0],
  },
];

describe('refreshing the model connection while the Models panel stays open', () => {
  it.for(cases)('refreshes on entry and after each saved change when $action', async ({ settings, steps, refreshes }, context) => {
    const harness = flowOf(context, settings, steps);
    const summariesAtRefresh: number[] = [];

    await runModelsHub({
      ...harness.context,
      refreshConnection: async () => {
        summariesAtRefresh.push(harness.infos.length);
      },
    });

    expect(harness.unused()).toEqual([]);
    expect(summariesAtRefresh).toEqual(refreshes);
    expect(harness.picks().at(-1)?.title).toBe('Models');
  });
});
