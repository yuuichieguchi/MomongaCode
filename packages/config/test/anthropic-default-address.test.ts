import { describe, expect, it } from 'vitest';
import { upstreamEndpointOf } from '@momonga/config';
import { DEFAULT_ANTHROPIC_BASE_URL } from '@momonga/protocol';
import { CAPABILITIES } from './model-fixtures.ts';
import { loadModelsSection } from './load-models.ts';

const anthropicConnection = (address: Record<string, string>) => ({
  adapter: 'anthropic',
  provider: 'claude-work',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  ...address,
  models: [{ id: 'claude-x', capabilities: CAPABILITIES }],
});

const resolvedOf = async (address: Record<string, string>) => {
  const { models } = await loadModelsSection({ connections: [anthropicConnection(address)] });
  const model = models.models.get('claude-work/claude-x');
  if (model === undefined || model['adapter'] !== 'anthropic') throw new Error('the anthropic model is not resolved');
  return model as unknown as Parameters<typeof upstreamEndpointOf>[0];
};

describe('an anthropic connection has a default address', () => {
  it('is the public Messages API base address', () => {
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('sends a connection that names no address to the default origin', async () => {
    expect(upstreamEndpointOf(await resolvedOf({}))).toEqual({ kind: 'tcp', baseUrl: DEFAULT_ANTHROPIC_BASE_URL });
  });

  it('uses an address the person sets as given', async () => {
    expect(upstreamEndpointOf(await resolvedOf({ baseUrl: 'https://claude.example.com' }))).toEqual({ kind: 'tcp', baseUrl: 'https://claude.example.com' });
  });
});
