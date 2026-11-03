import { describe, expect, it } from 'vitest';
import { inheritedEnvOf } from '@momonga/mcp';
import { rawConfig, startRaw } from './raw-transport.ts';

const PLATFORM_INJECTED_ENV_KEYS = new Set(['__CF_USER_TEXT_ENCODING']);
const FAKE_SECRET = 'not-a-real-key';

describe('inheritedEnvOf', () => {
  it('inheritedEnvOf keeps only DEFAULT_INHERITED_ENV_VARS and drops function-valued entries', () => {
    const baseEnv = {
      HOME: '/home/fixture-user',
      LOGNAME: 'fixture-user',
      PATH: '/usr/bin:/bin',
      SHELL: '() { :; }; /bin/zsh',
      TERM: 'xterm-fixture',
      OPENAI_API_KEY: FAKE_SECRET,
      MOMONGA_UNRELATED: 'leak',
      LANG: 'C',
    };

    expect(inheritedEnvOf(baseEnv)).toEqual({
      HOME: '/home/fixture-user',
      LOGNAME: 'fixture-user',
      PATH: '/usr/bin:/bin',
      TERM: 'xterm-fixture',
    });
  });

  it('returns an empty object when no inherited key is present', () => {
    expect(inheritedEnvOf({ LANG: 'C', OPENAI_API_KEY: FAKE_SECRET })).toEqual({});
  });

  it('the server env equals inheritedEnvOf(baseEnv) overlaid with config.env', async () => {
    const baseEnv = { HOME: '/home/fixture-user', PATH: '/usr/bin:/bin', USER: 'fixture-user', TERM: '() { evil; }', OPENAI_API_KEY: FAKE_SECRET };
    const overlay = { FIXTURE_FLAG: 'on', HOME: '/override-home', TERM: 'xterm-from-config' };
    const { request } = await startRaw({ config: rawConfig([], { env: overlay }), baseEnv });

    const { env } = (await request('env')) as { env: Record<string, string> };
    const seen = Object.fromEntries(Object.entries(env).filter(([key]) => !PLATFORM_INJECTED_ENV_KEYS.has(key)));

    expect(seen).toEqual({ ...inheritedEnvOf(baseEnv), ...overlay });
    expect(seen).toEqual({ HOME: '/override-home', PATH: '/usr/bin:/bin', USER: 'fixture-user', TERM: 'xterm-from-config', FIXTURE_FLAG: 'on' });
  });
});
