import fs from 'node:fs';
import { secretStoreEnvFor } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { runtimeEnv } from '../src/child-env.ts';
import type { CredentialSettings } from '../src/child-env.ts';

const HOST = { platform: process.platform, uid: process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) };

const settingsNaming = (forgeName: string, modelName: string): CredentialSettings =>
  ({
    models: { connections: [{ adapter: 'chat-completions', provider: 't0', apiKeyEnv: modelName }] },
    forges: [{ id: 'gh', descriptor: 'github', hosts: ['github.com'], apiBaseUrl: 'https://api.github.com', credential: { env: forgeName } }],
  }) as unknown as CredentialSettings;

describe('the runtime environment and the forge credential', () => {
  it('passes the variable a forge names for its token, and keeps every other credential stripped', async () => {
    const { env, removed } = runtimeEnv({ PATH: '/usr/bin', GITHUB_TOKEN: 'forge-value', OTHER_TOKEN: 'other-value', MODEL_KEY: 'model-value' }, settingsNaming('GITHUB_TOKEN', 'MODEL_KEY'), await secretStoreEnvFor({ PATH: '/usr/bin', GITHUB_TOKEN: 'forge-value', OTHER_TOKEN: 'other-value', MODEL_KEY: 'model-value' }, HOST));

    expect(env['GITHUB_TOKEN']).toBe('forge-value');
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env).not.toHaveProperty('MODEL_KEY');
    expect(removed).toEqual(['MODEL_KEY', 'OTHER_TOKEN']);
  });

  it('passes the forge variable even when a stripped variable holds the same value', async () => {
    const { env } = runtimeEnv({ PATH: '/usr/bin', GITHUB_TOKEN: 'shared-value', COPY_TOKEN: 'shared-value' }, settingsNaming('GITHUB_TOKEN', 'MODEL_KEY'), await secretStoreEnvFor({ PATH: '/usr/bin', GITHUB_TOKEN: 'shared-value', COPY_TOKEN: 'shared-value' }, HOST));

    expect(env['GITHUB_TOKEN']).toBe('shared-value');
    expect(env).not.toHaveProperty('COPY_TOKEN');
  });
});
