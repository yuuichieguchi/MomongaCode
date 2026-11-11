import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '@momonga/runtime';
import { chatTargetSettings, createSession, makeRuntimeFixture, signalNever, writeUserSettings } from './helpers.ts';

const FORGE_VARIABLE = 'FORGE_ACCESS_FOR_TEST';

const forgeSettings = (name: string): Record<string, unknown> => ({
  ...chatTargetSettings('MODEL_VARIABLE_FOR_TEST'),
  forges: [{ id: 'gh', descriptor: 'github', hosts: ['github.com'], apiBaseUrl: 'https://api.github.com', credential: { env: name } }],
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the forge credential in the runtime', () => {
  it('is read from the environment of the runtime process', async () => {
    vi.stubEnv(FORGE_VARIABLE, 'forge-value');
    const read = runtime.forgeCredentialReader(() => {
      throw new Error('no secret is named');
    });

    expect(await read({ env: FORGE_VARIABLE }, signalNever())).toBe('forge-value');
  });

  it('is not in the environment of a sandboxed command, even under a name that looks like no credential', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, forgeSettings(FORGE_VARIABLE));
    const session = createSession(f.store, f.temp.project, { env: { [FORGE_VARIABLE]: 'forge-value', PLAIN: '1' } });

    expect(await f.toolRuntime.port.envFor(session, signalNever())).toEqual({ PLAIN: '1' });
  });
});
