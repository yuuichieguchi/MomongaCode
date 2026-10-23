import { describe, expect, it } from 'vitest';
import { isCredentialEnvName, stripCredentialEnv } from '@momonga/config';

const OPENAI_STYLE_TOKEN = 'sk-' + 'example-not-a-real-key';
const AWS_STYLE_KEY_ID = 'AKIA' + 'IOSFODNN7EXAMPLE';

type Row = { name: string; value: string; stripped: boolean; why: string };

const TABLE: Row[] = [
  { name: 'PGPASSWORD', value: 'x', stripped: true, why: 'PASSWORD' },
  { name: 'MYSQL_PWD', value: 'x', stripped: true, why: 'a _PWD suffix' },
  { name: 'DB_PASS', value: 'x', stripped: true, why: 'a PASS segment' },
  { name: 'STRIPE_SECRET_KEY', value: 'x', stripped: true, why: 'SECRET' },
  { name: 'AZURE_OPENAI_KEY', value: 'x', stripped: true, why: 'KEY' },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', value: '/home/u/sa.json', stripped: true, why: 'CREDENTIAL' },
  { name: 'X_PRIVATE_KEY', value: 'x', stripped: true, why: 'PRIVATE' },
  { name: 'GPG_PASSPHRASE', value: 'x', stripped: true, why: 'PASSPHRASE' },
  { name: 'AWS_SESSION_TOKEN', value: 'x', stripped: true, why: 'TOKEN' },
  { name: 'OPENAIKEY', value: 'x', stripped: true, why: 'KEY inside a word' },
  { name: 'DOCKER_CREDS', value: 'x', stripped: true, why: 'CREDS' },
  { name: 'MONKEY_COUNT', value: '3', stripped: true, why: 'the accepted false positive on KEY' },
  { name: 'DATABASE_URL', value: 'postgres://app:hunter2@db.local:5432/app', stripped: true, why: 'a URL with a password' },
  { name: 'SOME_HANDLE', value: OPENAI_STYLE_TOKEN, stripped: true, why: 'an sk- value' },
  { name: 'AWS_ID', value: AWS_STYLE_KEY_ID, stripped: true, why: 'an AKIA access key id value' },
  { name: 'PWD', value: '/work/a', stripped: false, why: 'keep-list' },
  { name: 'OLDPWD', value: '/work', stripped: false, why: 'keep-list' },
  { name: 'SSH_AUTH_SOCK', value: '/tmp/agent.sock', stripped: false, why: 'keep-list' },
  { name: 'TERM_SESSION_ID', value: 'w0t0p0', stripped: false, why: 'keep-list' },
  { name: 'SECURITYSESSIONID', value: '186a5', stripped: false, why: 'keep-list' },
  { name: 'GPG_TTY', value: '/dev/ttys001', stripped: false, why: 'keep-list' },
  { name: 'GIT_AUTHOR_NAME', value: 'A', stripped: false, why: 'keep-prefix GIT_AUTHOR_' },
  { name: 'GIT_COMMITTER_EMAIL', value: 'a@example.com', stripped: false, why: 'keep-prefix GIT_COMMITTER_' },
  { name: 'XDG_SESSION_TYPE', value: 'x11', stripped: false, why: 'keep-prefix XDG_SESSION_' },
  { name: 'PATH', value: '/usr/bin', stripped: false, why: 'ordinary' },
  { name: 'HOME', value: '/home/u', stripped: false, why: 'ordinary' },
  { name: 'LANG', value: 'C', stripped: false, why: 'ordinary' },
  { name: 'PASSAGE_DIR', value: '/x', stripped: false, why: 'PASS is not a whole segment' },
];

const VALUE_ONLY = new Set(['DATABASE_URL', 'SOME_HANDLE', 'AWS_ID']);

describe('isCredentialEnvName', () => {
  it.each(TABLE.filter((row) => !VALUE_ONLY.has(row.name)).map((row) => [row.name, row.stripped, row.why] as const))(
    '%s is a credential name: %s (%s)',
    (name, expected) => {
      expect(isCredentialEnvName(name)).toBe(expected);
    },
  );

  it.each(['SSH_AUTH_SOCK_X', 'MY_PWD_FILE', 'XPWD'])('%s is decided by the pattern, not the keep-list', (name) => {
    expect(isCredentialEnvName(name)).toBe(name === 'SSH_AUTH_SOCK_X');
  });

  it('classifies names case-insensitively for the pattern', () => {
    expect(isCredentialEnvName('github_token')).toBe(true);
  });
});

describe('stripCredentialEnv', () => {
  it('strips by name, by declared name and by value, and reports the sorted names', () => {
    const env = Object.fromEntries([...TABLE.map((row) => [row.name, row.value]), ['MY_MODEL_ENV', 'v'], ['DATABASE_URL_RO', 'postgres://db.local/app']]);

    const result = stripCredentialEnv(env, ['MY_MODEL_ENV']);

    const strippedNames = [...TABLE.filter((row) => row.stripped).map((row) => row.name), 'MY_MODEL_ENV'].sort();
    expect(result.removed).toEqual(strippedNames);
    expect(result.env).toEqual(
      Object.fromEntries([...TABLE.filter((row) => !row.stripped).map((row) => [row.name, row.value]), ['DATABASE_URL_RO', 'postgres://db.local/app']]),
    );
  });

  it.each(['ghp_', 'gho_', 'ghu_', 'ghs_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-', 'sk-'])(
    'strips a value starting with %s',
    (prefix) => {
      expect(stripCredentialEnv({ HARMLESS_NAME: prefix + 'example' }, [])).toEqual({ env: {}, removed: ['HARMLESS_NAME'] });
    },
  );

  it('keeps a URL without a password and an AKIA-like value of the wrong length', () => {
    const env = { DATABASE_URL: 'postgres://app@db.local/app', LABEL: 'AKIA' + 'SHORT' };
    expect(stripCredentialEnv(env, [])).toEqual({ env: { DATABASE_URL: 'postgres://app@db.local/app', LABEL: 'AKIA' + 'SHORT' }, removed: [] });
  });

  it('does not mutate its input', () => {
    const env = { PATH: '/usr/bin', GITHUB_TOKEN: 'x' };
    stripCredentialEnv(env, []);
    expect(env).toEqual({ PATH: '/usr/bin', GITHUB_TOKEN: 'x' });
  });
});
