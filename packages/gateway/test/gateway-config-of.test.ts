import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { gatewayConfigOf } from '@momonga/gateway';
import { modelSettings } from '@momonga/testkit';
import type { ModelSettingsSpec } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';

const configFor = async (spec: ModelSettingsSpec) => {
  const home = makeDir();
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify(modelSettings(spec)), { mode: 0o600 });
  const { settings } = await loadUserSettings({ home });
  return gatewayConfigOf(settings.models).models;
};

const fieldOf = <Field extends 'billing' | 'provider'>(targets: Awaited<ReturnType<typeof configFor>>['targets'], field: Field) =>
  Object.fromEntries(Object.entries(targets).map(([canon, target]) => [canon, target[field]]));

const ON_DEVICE = { provider: 'apple', adapter: 'managed', server: 'fm', id: 'system' };

describe('gatewayConfigOf billing', () => {
  it('declares an fm model local, a remote model metered unless the user declares it local', async () => {
    const { targets } = await configFor({
      models: [
        ON_DEVICE,
        { provider: 'acme', adapter: 'chat-completions', id: 'm', baseUrl: 'https://api.example.com/v1' },
        { provider: 'vllm', adapter: 'chat-completions', id: 'm', baseUrl: 'http://127.0.0.1:8000/v1', billing: 'local' },
      ],
    });
    expect(fieldOf(targets, 'billing')).toEqual({ 'apple/system': 'local', 'acme/m': 'metered', 'vllm/m': 'local' });
  });
});

describe('gatewayConfigOf server names', () => {
  it('keys every model by its full reference and names its server', async () => {
    const { targets } = await configFor({
      models: [
        ON_DEVICE,
        { provider: 'acme', adapter: 'chat-completions', id: 'm', baseUrl: 'https://api.example.com/v1' },
        { provider: 'anthropic', adapter: 'anthropic', id: 'claude-x', baseUrl: 'https://api.example.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
        { provider: 'ollama', adapter: 'ollama', id: 'devstral-small-2', baseUrl: 'http://127.0.0.1:11434' },
      ],
    });
    expect(fieldOf(targets, 'provider')).toEqual({ 'apple/system': 'apple', 'acme/m': 'acme', 'anthropic/claude-x': 'anthropic', 'ollama/devstral-small-2:latest': 'ollama' });
    expect(targets['ollama/devstral-small-2:latest']).toMatchObject({ kind: 'ollama', model: 'devstral-small-2:latest', defaultTag: 'latest' });
    expect(targets['acme/m']).not.toHaveProperty('defaultTag');
  });

  it('hands over the chain of every model, the start model and the roles the loader resolved', async () => {
    const models = await configFor({
      models: [
        { provider: 'acme', adapter: 'chat-completions', id: 'm', baseUrl: 'https://api.example.com/v1' },
        { provider: 'vllm', adapter: 'chat-completions', id: 'm', baseUrl: 'http://127.0.0.1:8000/v1' },
      ],
      start: 'vllm/m',
      fallback: ['acme/m'],
      roles: { compaction: 'acme/m' },
    });
    expect(models.chains).toEqual({ 'acme/m': ['acme/m'], 'vllm/m': ['vllm/m', 'acme/m'] });
    expect(models.start).toBe('vllm/m');
    expect(models.roles).toEqual({ compaction: 'acme/m' });
  });

  it('creates no implicit model', async () => {
    const models = await configFor({ models: [] });
    expect(models.targets).toEqual({});
    expect(models.chains).toEqual({});
    expect(models).not.toHaveProperty('start');
  });
});
