import { describe, expect, it } from 'vitest';
import { S1 } from './model-fixtures.ts';
import { loadWithProject, refusalOf } from './load-models.ts';

const SCHEMA_REFUSAL = 'must NOT have additional properties';

const OLD_TARGET = { adapter: 'ollama', model: 'devstral-small-2', baseUrl: 'http://127.0.0.1:11434', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } };

const expectSentence = async (models: unknown, pointer: string, sentence: string): Promise<void> => {
  const { file, message } = await refusalOf({ models });
  expect(message).toBe(`${file}: invalid settings at ${pointer}: ${sentence}`);
  expect(message).not.toContain(SCHEMA_REFUSAL);
};

describe('a user settings file in the shape of an earlier build is refused with a sentence that says what replaces the key', () => {
  it('models.targets', async () => {
    await expectSentence({ targets: { local: OLD_TARGET } }, '/models/targets', 'is not a setting any more; declare each server under models.connections with its models (see README, Models).');
  });

  it('models.aliases', async () => {
    await expectSentence(
      { ...S1.models, aliases: { default: ['local'] } },
      '/models/aliases',
      'is not a setting any more; list the models to try after the model in models.fallback and choose the first with models.start (see README, Models).',
    );
  });

  it('models.billingChanges[i].alias', async () => {
    await expectSentence(
      { ...S1.models, billingChanges: [{ from: 'local', to: 'metered' }, { from: 'local', to: 'plan', alias: 'default' }] },
      '/models/billingChanges/1/alias',
      'is not a setting any more; write "model" with the model it applies to (see README, Models).',
    );
  });

  it('a project file with models.targets is discarded with the warning, never refused', async () => {
    const { models, warnings, projectFile } = await loadWithProject(S1, { models: { targets: { local: OLD_TARGET }, aliases: { default: ['local'] } } });
    expect([...models.models.keys()]).toEqual(['ollama/devstral-small-2:latest', 'ollama/qwen3.8:27b']);
    expect(warnings).toContain(`${projectFile}: models.targets is only honored in user settings; discarded`);
    expect(warnings).toContain(`${projectFile}: models.aliases is only honored in user settings; discarded`);
  });
});
