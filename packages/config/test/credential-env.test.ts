import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCredentialEnvName as looksLikeCredentialName, stripCredentialEnv } from '@momonga/config';

type CredentialSettings = { env?: readonly string[]; keep?: readonly string[]; valuePatterns?: readonly string[] };

type Strip = (env: Readonly<Record<string, string>>, declaredNames: readonly string[], credentials?: CredentialSettings) => { env: Record<string, string>; removed: string[] };

const strip = stripCredentialEnv as unknown as Strip;

const GITHUB_STYLE_VALUE = 'ghp_' + 'example';
const OPENAI_STYLE_VALUE = 'sk-' + 'example-not-a-real-key';
const AWS_STYLE_KEY_ID = 'AKIA' + 'IOSFODNN7EXAMPLE';

type Row = { name: string; withheld: boolean; why: string };

const NAMES: Row[] = [
  { name: 'PGPASSWORD', withheld: true, why: 'strong PASSWORD as a substring' },
  { name: 'MYSQL_PWD', withheld: true, why: 'PWD as the last word of a longer name' },
  { name: 'DB_PASS', withheld: true, why: 'weak PASS as a whole word' },
  { name: 'STRIPE_SECRET_KEY', withheld: true, why: 'strong SECRET' },
  { name: 'AZURE_OPENAI_KEY', withheld: true, why: 'strong KEY' },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', withheld: true, why: 'strong CREDENTIAL as a substring' },
  { name: 'X_PRIVATE_KEY', withheld: true, why: 'strong KEY' },
  { name: 'GPG_PASSPHRASE', withheld: true, why: 'strong PASSPHRASE' },
  { name: 'AWS_SESSION_TOKEN', withheld: true, why: 'strong TOKEN' },
  { name: 'OPENAIKEY', withheld: true, why: 'strong KEY inside a word' },
  { name: 'DOCKER_CREDS', withheld: true, why: 'strong CREDS' },
  { name: 'MONKEY_COUNT', withheld: true, why: 'strong KEY inside a word, the accepted false positive' },
  { name: 'SSH_AUTH_SOCK', withheld: true, why: 'weak AUTH as a whole word' },
  { name: 'TERM_SESSION_ID', withheld: true, why: 'weak SESSION as a whole word' },
  { name: 'XDG_SESSION_TYPE', withheld: true, why: 'weak SESSION as a whole word' },
  { name: 'BROWSER_COOKIE', withheld: true, why: 'weak COOKIE as the last word' },
  { name: 'PRIVATE_DIR', withheld: true, why: 'weak PRIVATE as the first word' },
  { name: 'SSH_AUTH_SOCK_X', withheld: true, why: 'weak AUTH as a whole word inside a longer name' },
  { name: 'github_token', withheld: true, why: 'strong TOKEN in lower case' },
  { name: 'PWD', withheld: false, why: 'PWD alone is not the last word of a longer name' },
  { name: 'OLDPWD', withheld: false, why: 'PWD is not a delimited word of OLDPWD' },
  { name: 'XPWD', withheld: false, why: 'PWD is not a delimited word of XPWD' },
  { name: 'MY_PWD_FILE', withheld: false, why: 'PWD is not the last word' },
  { name: 'SECURITYSESSIONID', withheld: false, why: 'SESSION is not a delimited word' },
  { name: 'GPG_TTY', withheld: false, why: 'no word of the vocabulary' },
  { name: 'GIT_AUTHOR_NAME', withheld: false, why: 'AUTHOR is not the word AUTH' },
  { name: 'GIT_COMMITTER_EMAIL', withheld: false, why: 'no word of the vocabulary' },
  { name: 'PASSAGE_DIR', withheld: false, why: 'PASSAGE is not the word PASS' },
  { name: 'COOKIEJAR', withheld: false, why: 'COOKIE is not a delimited word' },
  { name: 'PATH', withheld: false, why: 'ordinary' },
  { name: 'HOME', withheld: false, why: 'ordinary' },
  { name: 'LANG', withheld: false, why: 'ordinary' },
];

describe('the security vocabulary has a strong and a weak class', () => {
  it.each(NAMES.map((row) => [row.name, row.withheld, row.why] as const))('%s looks like a credential: %s (%s)', (name, expected) => {
    expect(looksLikeCredentialName(name)).toBe(expected);
  });

  it.each(NAMES.map((row) => [row.name, row.withheld] as const))('strips %s by name alone with no settings: %s', (name, withheld) => {
    const result = strip({ [name]: '/some/ordinary/value' }, []);
    expect(result.removed).toEqual(withheld ? [name] : []);
  });
});

describe('values carry no vendor knowledge', () => {
  it.each([GITHUB_STYLE_VALUE, OPENAI_STYLE_VALUE, AWS_STYLE_KEY_ID, 'xoxb-' + 'example'])('retains a variable with an innocuous name whose value is %s', (value) => {
    expect(strip({ MY_SERVICE: value }, [])).toEqual({ env: { MY_SERVICE: value }, removed: [] });
  });

  it('withholds a value that matches a user-declared value pattern', () => {
    expect(strip({ MY_SERVICE: GITHUB_STYLE_VALUE, OTHER: 'plain' }, [], { valuePatterns: ['^ghp_'] })).toEqual({ env: { OTHER: 'plain' }, removed: ['MY_SERVICE'] });
  });

  it('withholds a URL carrying a password in its authority, and keeps one without', () => {
    const env = { DATABASE_URL: 'postgres://app:hunter2@db.local:5432/app', DATABASE_URL_RO: 'postgres://app@db.local/app' };
    expect(strip(env, [])).toEqual({ env: { DATABASE_URL_RO: 'postgres://app@db.local/app' }, removed: ['DATABASE_URL'] });
  });
});

describe('copies of withheld values', () => {
  it('withholds a variable whose value equals a declared credential', () => {
    const env = { MY_MODEL_ENV: 'value-of-the-declared-credential', MY_COPY: 'value-of-the-declared-credential', OTHER: 'unrelated' };
    expect(strip(env, ['MY_MODEL_ENV'])).toEqual({ env: { OTHER: 'unrelated' }, removed: ['MY_COPY', 'MY_MODEL_ENV'] });
  });

  it('withholds a copy of a variable withheld by the vocabulary', () => {
    const env = { OPENAI_API_KEY: 'value-under-a-vocabulary-name', HANDLE: 'value-under-a-vocabulary-name' };
    expect(strip(env, []).removed).toEqual(['HANDLE', 'OPENAI_API_KEY']);
  });

  it('withholds a copy of a URL with a password', () => {
    const url = 'https://user:pw@registry.local/path';
    expect(strip({ REGISTRY: url, MIRROR_URL_COPY: url }, []).removed).toEqual(['MIRROR_URL_COPY', 'REGISTRY']);
  });

  it('withholds a copy of a value matched by a user value pattern', () => {
    const env = { MY_SERVICE: GITHUB_STYLE_VALUE, ALSO_THERE: GITHUB_STYLE_VALUE };
    expect(strip(env, [], { valuePatterns: ['^ghp_'] }).removed).toEqual(['ALSO_THERE', 'MY_SERVICE']);
  });
});

describe('user declarations', () => {
  it('withholds names and globs declared in credentials.env', () => {
    const env = { MYCO_PRIMARY: 'a', MYCO_SECONDARY: 'b', SERVICE_ID: 'c', PATH: '/usr/bin' };
    expect(strip(env, [], { env: ['MYCO_*', 'SERVICE_ID'] })).toEqual({ env: { PATH: '/usr/bin' }, removed: ['MYCO_PRIMARY', 'MYCO_SECONDARY', 'SERVICE_ID'] });
  });

  it.each(['SSH_AUTH_SOCK', 'XDG_SESSION_ID', 'TERM_SESSION_ID'])('retains %s when the person lists it in credentials.keep', (name) => {
    expect(strip({ [name]: '/tmp/x' }, [])).toEqual({ env: {}, removed: [name] });
    expect(strip({ [name]: '/tmp/x' }, [], { keep: [name] })).toEqual({ env: { [name]: '/tmp/x' }, removed: [] });
  });

  it('retains a URL with a password when the person keeps its name', () => {
    expect(strip({ DATABASE_URL: 'postgres://app:hunter2@db.local/app' }, [], { keep: ['DATABASE_URL'] }).removed).toEqual([]);
  });

  it('withholds a declared name even when credentials.keep lists it', () => {
    expect(strip({ OPENAI_API_KEY: 'v' }, ['OPENAI_API_KEY'], { keep: ['OPENAI_API_KEY'] }).removed).toEqual(['OPENAI_API_KEY']);
    expect(strip({ SERVICE_ID: 'v' }, [], { env: ['SERVICE_ID'], keep: ['SERVICE_ID'] }).removed).toEqual(['SERVICE_ID']);
  });

  it('does not mutate its input', () => {
    const env = { PATH: '/usr/bin', GITHUB_TOKEN: 'x' };
    strip(env, [], { keep: ['PATH'] });
    expect(env).toEqual({ PATH: '/usr/bin', GITHUB_TOKEN: 'x' });
  });
});

const STRONG = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL', 'CREDS'];
const WEAK = ['AUTH', 'COOKIE', 'SESSION', 'PRIVATE', 'PASS'];

const referenceVocabulary = (name: string): boolean => {
  const upper = name.toUpperCase();
  const words = upper.split('_');
  return STRONG.some((word) => upper.includes(word)) || WEAK.some((word) => words.includes(word)) || (words.length > 1 && words.at(-1) === 'PWD');
};

const globMatches = (glob: string, name: string): boolean => new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);

const REFERENCE_URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*:[^/?#@\s]+@/i;

const referenceStrip = (env: Readonly<Record<string, string>>, declaredNames: readonly string[], credentials: CredentialSettings): string[] => {
  const declared = (name: string): boolean => declaredNames.includes(name) || (credentials.env ?? []).some((glob) => globMatches(glob, name));
  const patterns = (credentials.valuePatterns ?? []).map((pattern) => new RegExp(pattern));
  const kept = new Set(credentials.keep ?? []);
  const direct = (name: string, value: string): boolean =>
    declared(name) || (!kept.has(name) && (REFERENCE_URL_WITH_PASSWORD.test(value) || patterns.some((pattern) => pattern.test(value)) || referenceVocabulary(name)));
  const withheldValues = new Set(Object.entries(env).filter(([name, value]) => direct(name, value)).map(([, value]) => value));
  return Object.entries(env)
    .filter(([name, value]) => direct(name, value) || withheldValues.has(value))
    .map(([name]) => name)
    .sort();
};

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NAME_PARTS = ['DB', 'MY', 'SSH', 'AUTH', 'AUTHOR', 'SESSION', 'SESSIONID', 'KEY', 'MONKEY', 'TOKEN', 'PASS', 'PASSAGE', 'PWD', 'OLDPWD', 'COOKIE', 'PRIVATE', 'SECRET', 'CREDS', 'PATH', 'HOME', 'GIT', 'NAME', 'ID', 'TTY'];
const VALUES = ['/usr/bin', 'en_US.UTF-8', 'postgres://u:pw@h/db', 'postgres://u@h/db', GITHUB_STYLE_VALUE, 'alpha-1', 'beta-2', 'gamma-3', 'delta-4'];

const generatedCase = (random: () => number) => {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const env: Record<string, string> = {};
  const size = 1 + Math.floor(random() * 6);
  for (let index = 0; index < size; index += 1) {
    const words = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(NAME_PARTS));
    env[words.join('_')] = pick(VALUES);
  }
  const names = Object.keys(env);
  const credentials: CredentialSettings = {
    ...(random() < 0.3 ? { env: [`${pick(NAME_PARTS)}_*`] } : {}),
    ...(random() < 0.3 ? { keep: [pick(names)] } : {}),
    ...(random() < 0.3 ? { valuePatterns: ['^ghp_'] } : {}),
  };
  const declaredNames = random() < 0.3 ? [pick(names)] : [];
  return { env, declaredNames, credentials };
};

describe('the rule is the closed list of reasons (property, seeded)', () => {
  const cases = Array.from({ length: 400 }, (_unused, index) => generatedCase(seeded(index + 1)));

  it('withholds exactly what the reference rule withholds', () => {
    for (const { env, declaredNames, credentials } of cases) {
      expect(strip(env, declaredNames, credentials).removed, JSON.stringify({ env, declaredNames, credentials })).toEqual(referenceStrip(env, declaredNames, credentials));
    }
  });

  it('is idempotent', () => {
    for (const { env, declaredNames, credentials } of cases) {
      const once = strip(env, declaredNames, credentials).env;
      expect(strip(once, declaredNames, credentials).env).toEqual(once);
    }
  });

  it('never retains a withheld variable when a declared name is added', () => {
    for (const { env, declaredNames, credentials } of cases) {
      const before = strip(env, declaredNames, credentials).removed;
      const extra = Object.keys(env).at(-1) as string;
      const after = strip(env, [...declaredNames, extra], credentials).removed;
      expect(before.filter((name) => !after.includes(name))).toEqual([]);
      expect(after).toContain(extra);
    }
  });
});

describe('credential-env.ts carries no vendor or program knowledge', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'credential-env.ts'), 'utf8');
  const FORBIDDEN = ['sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-', 'AKIA', 'SSH_AUTH_SOCK', 'TERM_SESSION_ID', 'SECURITYSESSIONID', 'GPG_TTY', 'OLDPWD', 'XDG_SESSION_', 'GIT_AUTHOR_', 'GIT_COMMITTER_'];

  it.each(FORBIDDEN)('contains no literal %s', (token) => {
    expect(source.includes(token)).toBe(false);
  });

  it('has no shipped keep list', () => {
    expect(source).not.toMatch(/\bKEPT_[A-Z_]+\b/);
    expect(source).not.toMatch(/\bTOKEN_PREFIXES\b/);
  });
});
