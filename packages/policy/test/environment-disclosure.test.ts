import { describe, expect, it } from 'vitest';
import { stripCredentialEnv } from '@momonga/config';
import { commandRow, kindIn } from './decision-rows.ts';

describe('environment disclosure: the Bash environment is scrubbed before the shell starts', () => {
  const session = {
    PATH: '/usr/bin:/bin',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
    AWS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP',
    GITHUB_TOKEN: 'ghp_abcdefghijklmnop',
    DATABASE_URL: 'postgres://user:hunter2@db/app',
    OPENAI_API_KEY: 'sk-abc',
    HOME: '/Users/me',
  };

  it('removes credential names and credential-shaped values from the environment the Bash tool receives', () => {
    const { env } = stripCredentialEnv(session, []);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('therefore allows echo of a variable, which can print only what the scrubbed environment holds', () => {
    expect(kindIn(commandRow('echo $AWS_SECRET_ACCESS_KEY'), 'default')).toBe('allow');
    expect(kindIn(commandRow('which $X'), 'default')).toBe('allow');
  });

  it('still asks for ps with the environment option, which reads the unscrubbed environment of other processes', () => {
    expect(kindIn(commandRow('ps aux -e'), 'default')).toBe('ask');
    expect(kindIn(commandRow('ps -E'), 'default')).toBe('ask');
  });
});
