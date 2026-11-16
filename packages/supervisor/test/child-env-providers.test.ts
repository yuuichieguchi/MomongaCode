import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { secretStoreEnvFor } from '@momonga/foundation';
import { createTempDir, modelSettings } from '@momonga/testkit';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gatewayEnv, runtimeEnv } from '../src/child-env.ts';

const HOST = { platform: process.platform, uid: process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) };

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };
const ANTHROPIC_VALUE = 'anthropic-env-value-0001';
const OPEN_RESPONSES_VALUE = 'open-responses-env-value-0002';
const STORED_SECRET_NAME = 'stored-main';

const settingsWithProviders = async () => {
  const home = createTempDir();
  try {
    mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(home, '.momonga', 'settings.json'),
      JSON.stringify(
        modelSettings({
          models: [
            { adapter: 'anthropic', provider: 'claude', id: 'm', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'PROVIDER_ENV_ANTHROPIC', capabilities: CAPABILITIES },
            { adapter: 'open-responses', provider: 'router', id: 'm', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'PROVIDER_ENV_ROUTER', capabilities: CAPABILITIES },
            { adapter: 'anthropic', provider: 'stored', id: 'm', baseUrl: 'https://api.anthropic.com', apiKeySecret: STORED_SECRET_NAME, capabilities: CAPABILITIES },
          ],
        }),
      ),
    );
    return (await loadUserSettings({ env: process.env, home, signal: new AbortController().signal })).settings;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const SOURCE = {
  PATH: '/usr/bin',
  HOME: '/Users/u',
  PROVIDER_ENV_ANTHROPIC: ANTHROPIC_VALUE,
  PROVIDER_ENV_ROUTER: OPEN_RESPONSES_VALUE,
  UNRELATED: 'kept-for-runtime',
};

describe('credential environment separation for the provider adapters', () => {
  it('hands the declared apiKeyEnv of anthropic and open-responses targets to the gateway only', async () => {
    const settings = await settingsWithProviders();
    const gateway = gatewayEnv(SOURCE, settings, '/canonical/home', secretStoreEnvFor(SOURCE, HOST));
    expect(gateway).toMatchObject({ PROVIDER_ENV_ANTHROPIC: ANTHROPIC_VALUE, PROVIDER_ENV_ROUTER: OPEN_RESPONSES_VALUE });
    expect(gateway).not.toHaveProperty('UNRELATED');

    const runtime = runtimeEnv(SOURCE, settings, secretStoreEnvFor(SOURCE, HOST));
    expect(runtime.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/u', UNRELATED: 'kept-for-runtime', ...secretStoreEnvFor(SOURCE, HOST) });
    expect(runtime.removed).toEqual(['PROVIDER_ENV_ANTHROPIC', 'PROVIDER_ENV_ROUTER']);
  });

  it('puts no variable in the gateway environment for a target that references a stored secret', async () => {
    const settings = await settingsWithProviders();
    const gateway = gatewayEnv({ ...SOURCE, [STORED_SECRET_NAME]: 'must-not-be-read' }, settings, '/canonical/home', secretStoreEnvFor({ ...SOURCE, [STORED_SECRET_NAME]: 'must-not-be-read' }, HOST));
    expect(Object.keys(gateway)).not.toContain(STORED_SECRET_NAME);
    expect(Object.values(gateway)).not.toContain('must-not-be-read');
  });
});
