import fs from 'node:fs';
import { EMPTY_FILE_RULES } from '@momonga/foundation';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = fs.realpathSync(makeTempDir());
  created.push(dir);
  return dir;
};

const policyFor = (root: string, overrides: Partial<SandboxPolicy>): SandboxPolicy => ({
  writableRoots: [root],
  writeDenied: [], writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
  readDenied: [],
  network: 'deny',
  ...overrides,
});

type Rule = { index: number; action: string; operation: string; filter: string; value: string };

const rulesOf = (profile: string, params: Record<string, string>): Rule[] =>
  profile.split('\n').flatMap((line, index) => {
    const match = /^\((allow|deny) (\S+) \((subpath|literal) \(param "([^"]+)"\)\)\)$/.exec(line);
    if (match === null) return [];
    const [, action = '', operation = '', filter = '', name = ''] = match;
    return [{ index, action, operation, filter, value: params[name] ?? '' }];
  });

describe('buildSeatbeltProfile readAllowed', () => {
  it('re-allows each readAllowed subpath after every read deny', () => {
    const root = tempDir();
    const denied = path.join(root, 'sessions');
    const allowed = path.join(denied, 's1');
    fs.mkdirSync(allowed, { recursive: true });
    const { profile, params } = buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [allowed] }));
    const rules = rulesOf(profile, params);
    const denies = rules.filter((rule) => rule.action === 'deny' && rule.operation === 'file-read*');
    const allows = rules.filter((rule) => rule.action === 'allow' && rule.operation === 'file-read*');
    expect(denies.map((rule) => [rule.filter, rule.value])).toEqual([['subpath', denied]]);
    expect(allows.map((rule) => [rule.filter, rule.value])).toEqual([['subpath', allowed]]);
    for (const allow of allows) for (const deny of denies) expect(allow.index).toBeGreaterThan(deny.index);
  });

  it('allows metadata reads on each ancestor from the deny root down to the allowed entry parent', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const allowed = path.join(denied, 'a', 'b', 'c');
    fs.mkdirSync(allowed, { recursive: true });
    const { profile, params } = buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [allowed] }));
    const rules = rulesOf(profile, params);
    const metadata = rules.filter((rule) => rule.action === 'allow' && rule.operation === 'file-read-metadata');
    expect(metadata.every((rule) => rule.filter === 'literal')).toBe(true);
    expect(metadata.map((rule) => rule.value).sort()).toEqual([denied, path.join(denied, 'a'), path.join(denied, 'a', 'b')].sort());
    const lastDeny = Math.max(...rules.filter((rule) => rule.action === 'deny' && rule.operation === 'file-read*').map((rule) => rule.index));
    for (const rule of metadata) expect(rule.index).toBeGreaterThan(lastDeny);
  });

  it('emits no read allows when readAllowed is absent', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    fs.mkdirSync(denied);
    const { profile } = buildSeatbeltProfile(policyFor(root, { readDenied: [denied] }));
    expect(profile).not.toMatch(/\(allow file-read\* \(subpath/);
    expect(profile).not.toContain('file-read-metadata');
  });

  it('canonicalizes readAllowed entries given through a symlink', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const allowed = path.join(denied, 'ok');
    fs.mkdirSync(allowed, { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(denied, link);
    const { profile, params } = buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [path.join(link, 'ok')] }));
    const allows = rulesOf(profile, params).filter((rule) => rule.action === 'allow' && rule.operation === 'file-read*');
    expect(allows.map((rule) => rule.value)).toEqual([allowed]);
  });

  it('keeps every write deny after every writable-root allow', () => {
    const root = tempDir();
    const { profile, params } = buildSeatbeltProfile(
      policyFor(root, { writableRoots: [root, '/'], writeDenied: [path.join(root, '.momonga'), path.join(root, 'Library', 'Keychains')] }),
    );
    const rules = rulesOf(profile, params);
    const allows = rules.filter((rule) => rule.action === 'allow' && rule.operation === 'file-write*');
    const denies = rules.filter((rule) => rule.action === 'deny' && rule.operation === 'file-write*');
    expect(denies.map((rule) => rule.value)).toEqual([path.join(root, '.momonga'), path.join(root, 'Library', 'Keychains')]);
    for (const deny of denies) for (const allow of allows) expect(deny.index).toBeGreaterThan(allow.index);
  });
});

describe('buildSeatbeltProfile readAllowed validation', () => {
  it('throws for an entry outside every readDenied entry', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(denied);
    fs.mkdirSync(elsewhere);
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [elsewhere] }))).toThrow();
  });

  it('throws when readDenied is empty', () => {
    const root = tempDir();
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [], readAllowed: [path.join(root, 'x')] }))).toThrow();
  });

  it('throws for an entry equal to a readDenied entry', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    fs.mkdirSync(denied);
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [denied] }))).toThrow();
  });

  it('throws for an entry that is an ancestor of another readDenied entry', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const inner = path.join(denied, 'x', 'y');
    fs.mkdirSync(inner, { recursive: true });
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [denied, inner], readAllowed: [path.join(denied, 'x')] }))).toThrow();
  });

  it('throws for an entry that equals a readDenied entry only after canonicalization', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    fs.mkdirSync(denied);
    const link = path.join(root, 'alias');
    fs.symlinkSync(denied, link);
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [link] }))).toThrow();
  });

  it('accepts an entry strictly inside a readDenied entry', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const allowed = path.join(denied, 'ok');
    fs.mkdirSync(allowed, { recursive: true });
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [denied], readAllowed: [allowed] }))).not.toThrow();
  });
});

const caseInsensitiveVolume = process.platform === 'darwin' || process.platform === 'win32';

describe.runIf(caseInsensitiveVolume)('buildSeatbeltProfile readAllowed validation on a case-insensitive volume', () => {
  it('throws for an entry that equals a readDenied entry in another case', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    fs.mkdirSync(denied);
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [root, denied], readAllowed: [path.join(root, 'VAULT')] }))).toThrow();
  });

  it('throws for an entry that is an ancestor of a readDenied entry in another case', () => {
    const root = tempDir();
    const denied = path.join(root, 'vault');
    const inner = path.join(denied, 'x', 'y');
    fs.mkdirSync(inner, { recursive: true });
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: [root, inner], readAllowed: [path.join(root, 'VAULT', 'X')] }))).toThrow();
  });
});

describe('buildSeatbeltProfile session tmpDir validation', () => {
  const sessionFixture = () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const momonga = path.join(home, '.momonga');
    const sessions = path.join(root, 'cache', 'tmp', 'sessions');
    const mine = path.join(sessions, 'session-1');
    const other = path.join(sessions, 'session-2');
    const work = path.join(root, 'work');
    for (const dir of [momonga, mine, other, work]) fs.mkdirSync(dir, { recursive: true });
    const policy = policyFor(work, { writeDenied: [momonga, sessions], readDenied: [momonga, sessions], readAllowed: [mine] });
    return { root, home, sessions, mine, other, policy };
  };

  it('accepts a tmpDir that is a readAllowed entry and re-allows writes to it after the denies', () => {
    const fx = sessionFixture();
    const { profile, params } = buildSeatbeltProfile(fx.policy, { tmpDir: fx.mine });
    const rules = rulesOf(profile, params);
    const reAllow = rules.find((rule) => rule.action === 'allow' && rule.operation === 'file-write*' && rule.value === fx.mine);
    expect(reAllow).toBeDefined();
    const lastWriteDeny = Math.max(...rules.filter((rule) => rule.action === 'deny' && rule.operation === 'file-write*').map((rule) => rule.index));
    expect(reAllow?.index).toBeGreaterThan(lastWriteDeny);
  });

  it('throws for a tmpDir equal to home', () => {
    const fx = sessionFixture();
    expect(() => buildSeatbeltProfile(fx.policy, { tmpDir: fx.home })).toThrow();
  });

  it('throws for a tmpDir equal to the sessions root', () => {
    const fx = sessionFixture();
    expect(() => buildSeatbeltProfile(fx.policy, { tmpDir: fx.sessions })).toThrow();
  });

  it('throws for a tmpDir of /', () => {
    const fx = sessionFixture();
    expect(() => buildSeatbeltProfile(fx.policy, { tmpDir: '/' })).toThrow();
  });

  it('throws for a tmpDir that is not a readAllowed entry', () => {
    const fx = sessionFixture();
    expect(() => buildSeatbeltProfile(fx.policy, { tmpDir: fx.other })).toThrow();
  });

  it('throws for a tmpDir that is readAllowed but is an ancestor of a writeDenied entry', () => {
    const fx = sessionFixture();
    const inner = path.join(fx.mine, 'locked');
    fs.mkdirSync(inner);
    const policy = { ...fx.policy, writeDenied: [...fx.policy.writeDenied, inner] };
    expect(() => buildSeatbeltProfile(policy, { tmpDir: fx.mine })).toThrow();
  });
});
