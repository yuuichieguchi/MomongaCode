import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { testKernelLock } from '@momonga/testkit';
import { makeCache, makeRuntimeFixture, writeProjectSettings, writeUserSettings } from './helpers.ts';

const compositionOf = async (user: unknown, project: unknown): Promise<{ composition: runtime.SettingsComposition; cwd: string }> => {
  const f = await makeRuntimeFixture();
  writeUserSettings(f.temp.home, user);
  writeProjectSettings(f.temp.project, project);
  await f.store.trust.setAsked(f.temp.project, 'trusted', new AbortController().signal);
  const composition = runtime.createSettingsComposition({ lock: testKernelLock(), home: f.temp.home, platform: process.platform, cache: makeCache(f.temp.home), store: f.store });
  return { composition, cwd: f.temp.project };
};

describe('the env setting reaches the environment of the session (config-C14)', () => {
  it('puts each key of the user env setting into the tool environment, over the environment the session was made with', async () => {
    const { composition, cwd } = await compositionOf({ env: { FOO: '1', PATH_HINT: 'settings' } }, {});
    const env = await composition.envFor({ cwd, env: { PATH: '/usr/bin', PATH_HINT: 'session' } }, new AbortController().signal);
    expect(env).toMatchObject({ PATH: '/usr/bin', FOO: '1', PATH_HINT: 'settings' });
  });

  it('applies a project env key only from the allowlist', async () => {
    const { composition, cwd } = await compositionOf({}, { env: { NODE_ENV: 'test', SNEAKY: 'x' } });
    const env = await composition.envFor({ cwd, env: { PATH: '/usr/bin' } }, new AbortController().signal);
    expect(env['NODE_ENV']).toBe('test');
    expect(env['SNEAKY']).toBeUndefined();
  });

  it('strips a credential the env setting names', async () => {
    const { composition, cwd } = await compositionOf({ env: { OPENAI_API_KEY: 'not-a-real-key' } }, {});
    const env = await composition.envFor({ cwd, env: {} }, new AbortController().signal);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });
});

describe('the environment the references of the person own MCP servers read (config-C35)', () => {
  it('holds the session environment and the env setting, a credential included, while the tool environment strips the credential', async () => {
    const { composition, cwd } = await compositionOf({ env: { MCP_PORT: '9000' } }, {});
    const session = { cwd, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'fake-token-for-tests' } };
    const referenceEnv = await composition.referenceEnvFor(session, await composition.userSnapshot(new AbortController().signal), new AbortController().signal);
    expect(referenceEnv).toMatchObject({ PATH: '/usr/bin', MCP_PORT: '9000', GITHUB_TOKEN: 'fake-token-for-tests' });
    expect((await composition.envFor(session, new AbortController().signal))['GITHUB_TOKEN']).toBeUndefined();
  });
});
