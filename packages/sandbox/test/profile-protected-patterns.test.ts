import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, protectedSetFor } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy, SeatbeltProfile } from '@momonga/sandbox';
import { fakePolicyFilesystem } from '@momonga/testkit';
import { makeTempDir } from './helpers.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const workspace = (): string => {
  const base = fs.realpathSync(makeTempDir());
  created.push(base);
  const root = path.join(base, 'work');
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  return root;
};

const policyOf = (root: string, protectedSet: ProtectedSet): SandboxPolicy => ({
  writableRoots: [root],
  writeDenied: [...protectedSet.paths],
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet,
});

const paramIn = (line: string): string[] => [...line.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((match) => match[1] as string);

const denyWriteRegexes = (profile: SeatbeltProfile): string[] =>
  profile.profile
    .split('\n')
    .filter((line) => /^\(deny file-write\* \(regex \(param "FILE_DENY_WRITE_\d+"\)\)\)$/.test(line))
    .map((line) => profile.params[paramIn(line)[0] as string] as string);

const blockedByProfile = (profile: SeatbeltProfile, target: string): boolean => denyWriteRegexes(profile).some((source) => new RegExp(source).test(target));

describe('buildSeatbeltProfile with protected-set patterns (no OS tool)', () => {
  it('emits the pattern entries as write denies', () => {
    const root = workspace();
    const set = protectedSetFor([root], fakePolicyFilesystem());
    const profile = buildSeatbeltProfile(policyOf(root, set));
    for (const target of ['modules/a/hooks', 'modules/a/hooks/pre-commit', 'modules/a/modules/b/hooks', 'modules/a/config', 'modules/a/config.worktree', 'worktrees/w/config.worktree']) {
      expect(blockedByProfile(profile, path.join(root, '.git', target))).toBe(true);
    }
    for (const target of ['modules/a/objects/x', 'worktrees/w/HEAD']) {
      expect(blockedByProfile(profile, path.join(root, '.git', target))).toBe(false);
    }
  });

  it('emits a symlink guard on the closure of each pattern entry', () => {
    const root = workspace();
    const profile = buildSeatbeltProfile(policyOf(root, protectedSetFor([root], fakePolicyFilesystem())));
    const guarded = profile.profile
      .split('\n')
      .filter((line) => /^\(deny file-read-metadata \(require-all \(regex \(param "[A-Z0-9_]+"\)\) \(vnode-type SYMLINK\)\)\)$/.test(line))
      .map((line) => profile.params[paramIn(line)[0] as string]);
    const regexes = denyWriteRegexes(profile);
    expect(regexes.length).toBeGreaterThan(0);
    for (const source of regexes) expect(guarded).toContain(source);
  });

  it('emits the literals of the set through the literal channel', () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, 'x'), 'file');
    const set: ProtectedSet = { ...EMPTY_PROTECTED_SET, roots: [root], literals: [path.join(root, 'x')] };
    const profile = buildSeatbeltProfile(policyOf(root, set));
    const literalLines = profile.profile.split('\n').filter((line) => /^\(deny file-write\* \(literal \(param "WRITE_DENIED_LITERAL_\d+"\)\)\)$/.test(line));
    expect(literalLines.map((line) => profile.params[paramIn(line)[0] as string])).toContain(path.join(root, 'x'));
  });

  it('rejects a relative literal of the set', () => {
    const root = workspace();
    const set: ProtectedSet = { ...EMPTY_PROTECTED_SET, roots: [root], literals: ['relative/x'] };
    expect(() => buildSeatbeltProfile(policyOf(root, set))).toThrow(/relative\/x/);
  });

  it('adds no line for the empty set', () => {
    const root = workspace();
    const withEmpty = buildSeatbeltProfile(policyOf(root, EMPTY_PROTECTED_SET));
    expect(withEmpty.profile).not.toMatch(/FILE_DENY_WRITE_|WRITE_DENIED_LITERAL_/);
  });
});
