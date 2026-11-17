import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './model-fixtures.ts';
import { loadModelsSection } from './load-models.ts';

const UNMEASURED_FIELDS = ['structuredOutput', 'streaming', 'stopSequences', 'tokenCounting', 'usageReported'] as const;

const remoteModels = (capabilities: Record<string, unknown> | undefined) =>
  loadModelsSection({
    connections: [
      {
        adapter: 'chat-completions',
        provider: 'remote',
        baseUrl: 'https://llm.example.com',
        apiKeyEnv: 'REMOTE_KEY',
        models: [{ id: 'm1', capabilities: { ...CAPABILITIES, ...capabilities } }],
      },
    ],
  });

const resolvedOf = async (capabilities?: Record<string, unknown>) => {
  const { models } = await remoteModels(capabilities);
  const model = models.models.get('remote/m1');
  if (model === undefined) throw new Error('the remote model is not resolved');
  return model as unknown as { capabilities: Record<string, unknown>; writtenCapabilities: Record<string, unknown> };
};

describe('an unmeasured remote capability is a default, never a value the person declared', () => {
  it('writes no value for a capability the person did not declare', async () => {
    const model = await resolvedOf(undefined);
    for (const field of UNMEASURED_FIELDS) expect(model.writtenCapabilities).not.toHaveProperty(field);
  });

  it('keeps the unmeasured default in the resolved capabilities, the floor under every measured value', async () => {
    const model = await resolvedOf(undefined);
    expect(model.capabilities).toMatchObject({ structuredOutput: 'none', streaming: true, stopSequences: true, tokenCounting: 'estimated', usageReported: true });
  });

  it('writes exactly the value the person declared, and only that one', async () => {
    const model = await resolvedOf({ streaming: false });
    expect(model.writtenCapabilities).toMatchObject({ streaming: false });
    expect(model.writtenCapabilities).not.toHaveProperty('usageReported');
    expect(model.capabilities).toMatchObject({ streaming: false, usageReported: true });
  });
});
