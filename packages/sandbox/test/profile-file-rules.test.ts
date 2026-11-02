import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy, SeatbeltProfile } from '@momonga/sandbox';
import { escapeKernel, fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Layout = { root: string; home: string; outside: string; sessions: string; tmp: string };

const layout = (): Layout => {
  const base = fs.realpathSync(makeTempDir());
  created.push(base);
  const dirs = {
    root: path.join(base, 'work'),
    home: path.join(base, 'home'),
    outside: path.join(base, 'outside'),
    sessions: path.join(base, 'sessions'),
    tmp: path.join(base, 'sessions', 's1'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dirs;
};

const policyOf = (dirs: Layout, fileRules: FileRuleSet): SandboxPolicy =>
  ({
    writableRoots: [dirs.root],
    writeDenied: [dirs.sessions],
    protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [],
    readDenied: [dirs.sessions],
    readAllowed: [dirs.tmp],
    network: 'deny',
    fileRules,
  }) as SandboxPolicy;

const build = (dirs: Layout, fileRules: FileRuleSet): SeatbeltProfile => buildSeatbeltProfile(policyOf(dirs, fileRules), { tmpDir: dirs.tmp });

const linesOf = (profile: SeatbeltProfile): string[] => profile.profile.split('\n');

const paramIn = (line: string): string[] => [...line.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((match) => match[1] as string);

const findLine = (lines: readonly string[], pattern: RegExp): { index: number; line: string } => {
  const index = lines.findIndex((line) => pattern.test(line));
  expect(index, `no line matches ${pattern}`).toBeGreaterThanOrEqual(0);
  return { index, line: lines[index] as string };
};

const lastIndex = (lines: readonly string[], pattern: RegExp): number => lines.findLastIndex((line) => pattern.test(line));

const DEV_NULL_LINE = '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))';

describe('buildSeatbeltProfile with file rules (no OS tool)', () => {
  it('adds no line for an empty set', () => {
    const dirs = layout();
    const withEmpty = build(dirs, EMPTY_FILE_RULES);
    expect(withEmpty).toEqual(buildSeatbeltProfile(policyOf(dirs, EMPTY_FILE_RULES), { tmpDir: dirs.tmp }));
    expect(withEmpty.profile).not.toMatch(/FILE_/);
  });

  it('emits a read deny on a subtree as one subpath rule that also denies unlink', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${dirs.home}/.ssh/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    const { line } = findLine(linesOf(profile), /FILE_DENY_READ_/);
    expect(line).toBe('(deny file-read* file-write-unlink (subpath (param "FILE_DENY_READ_0")))');
    expect(profile.params['FILE_DENY_READ_0']).toBe(path.join(dirs.home, '.ssh'));
  });

  it('emits a write deny on the closure regex and a symlink guard on the same closure', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec('*.pem', { roots: [dirs.root], home: dirs.home, tool: 'Edit' })], [dirs.root]));
    const lines = linesOf(profile);
    const closure = `^${escapeKernel(dirs.root)}/(.*/)?[^/]*\\.pem(/.*)?$`;
    const { line } = findLine(lines, /FILE_DENY_WRITE_/);
    expect(line).toBe('(deny file-write* (regex (param "FILE_DENY_WRITE_0")))');
    expect(profile.params['FILE_DENY_WRITE_0']).toBe(closure);
    const guard = findLine(lines, /^\(deny file-read-metadata \(require-all /);
    expect(guard.line).toMatch(/^\(deny file-read-metadata \(require-all \(regex \(param "[A-Z0-9_]+"\)\) \(vnode-type SYMLINK\)\)\)$/);
    expect(profile.params[paramIn(guard.line)[0] as string]).toBe(closure);
  });

  it('emits the two-rule form with require-not and subset exceptions for an entry with exceptions', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec('*.env', { roots: [dirs.root], home: dirs.home, exceptions: ['sample.env'] })], [dirs.root]));
    const lines = linesOf(profile);
    const root = escapeKernel(dirs.root);
    const own = findLine(lines, /^\(deny file-read\* file-write-unlink \(require-all \(regex \(param "FILE_DENY_READ_\d+"\)\) \(require-not \(regex \(param "FILE_EXCEPTION_\d+"\)\)\)\)\)$/);
    const [ownParam, exceptionParam] = paramIn(own.line) as [string, string];
    expect(profile.params[ownParam]).toBe(`^${root}/(.*/)?[^/]*\\.env$`);
    expect(profile.params[exceptionParam]).toBe(`^${root}/(.*/)?sample\\.env$`);
    const below = findLine(lines, /^\(deny file-read\* file-write-unlink \(regex \(param "FILE_DENY_READ_\d+"\)\)\)$/);
    expect(profile.params[paramIn(below.line)[0] as string]).toBe(`^${root}/(.*/)?[^/]*\\.env/.+$`);
  });

  it('places a widening user allow right after the writable roots and before every deny', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${dirs.outside}/**`, { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'allow' })], [dirs.root]));
    const lines = linesOf(profile);
    const allow = findLine(lines, /FILE_ALLOW_WRITE_/);
    expect(allow.line).toBe('(allow file-write* (subpath (param "FILE_ALLOW_WRITE_0")))');
    expect(profile.params['FILE_ALLOW_WRITE_0']).toBe(dirs.outside);
    expect(allow.index).toBeGreaterThan(lastIndex(lines, /WRITABLE_ROOT_/));
    expect(allow.index).toBeLessThan(findLine(lines, /WRITE_DENIED_0/).index);
  });

  it.each([
    ['a project-layer anchored allow', (dirs: Layout) => fileSpec(`/${dirs.outside}/**`, { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'allow', layer: 'project' })],
    ['a local-layer anchored allow', (dirs: Layout) => fileSpec(`/${dirs.outside}/**`, { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'allow', layer: 'local' })],
    ['a relative user allow anchored at a root', (dirs: Layout) => fileSpec('*.ts', { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'allow' })],
    ['a Read allow', (dirs: Layout) => fileSpec(`/${dirs.outside}/**`, { roots: [dirs.root], home: dirs.home, effect: 'allow' })],
    ['an ask entry', (dirs: Layout) => fileSpec('*.pem', { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'ask' })],
    ['a Grep deny', (dirs: Layout) => fileSpec('*.pem', { roots: [dirs.root], home: dirs.home, tool: 'Grep' })],
    ['a Glob deny', (dirs: Layout) => fileSpec('*.pem', { roots: [dirs.root], home: dirs.home, tool: 'Glob' })],
  ])('emits no line for %s', (_label, make) => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([make(dirs)], [dirs.root]));
    expect(profile.profile).not.toMatch(/FILE_/);
    expect(Object.keys(profile.params).filter((name) => name.startsWith('FILE_'))).toEqual([]);
  });

  it('emits a widening allow for a cli-layer anchored Edit allow', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${dirs.outside}/**`, { roots: [dirs.root], home: dirs.home, tool: 'Edit', effect: 'allow', layer: 'cli' })], [dirs.root]));
    expect(profile.params['FILE_ALLOW_WRITE_0']).toBe(dirs.outside);
  });

  it('orders user denies after owned allows, then symlink guards, then owned allows and device nodes again, then network', () => {
    const dirs = layout();
    const profile = build(
      dirs,
      fileRulesOf([fileSpec('**', { roots: [dirs.root], home: dirs.home }), fileSpec('**', { roots: [dirs.root], home: dirs.home, tool: 'Edit' })], [dirs.root]),
    );
    const lines = linesOf(profile);
    const firstUserDeny = findLine(lines, /FILE_DENY_/).index;
    const lastUserDeny = lastIndex(lines, /FILE_DENY_(READ|WRITE)_\d+"\)\)\)$/);
    const guard = findLine(lines, /^\(deny file-read-metadata \(require-all /).index;
    expect(firstUserDeny).toBeGreaterThan(findLine(lines, /READ_ALLOWED_0/).index);
    expect(guard).toBeGreaterThan(lastUserDeny);
    expect(lastIndex(lines, /SESSION_TMP_0/)).toBeGreaterThan(guard);
    expect(lastIndex(lines, /READ_ALLOWED_0/)).toBeGreaterThan(guard);
    expect(lines.filter((line) => line === DEV_NULL_LINE)).toHaveLength(2);
    expect(lines.lastIndexOf(DEV_NULL_LINE)).toBeGreaterThan(guard);
  });

  it('puts the ancestors of an anchored entry into the guarded ancestor pipeline', () => {
    const dirs = layout();
    const anchored = path.join(dirs.root, 'a', 'b', 'secrets');
    const profile = build(dirs, fileRulesOf([fileSpec(`/${anchored}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    const guarded = Object.entries(profile.params)
      .filter(([name]) => name.startsWith('GUARDED_ANCESTOR_'))
      .map(([, value]) => value);
    expect(guarded).toEqual(expect.arrayContaining([path.join(dirs.root, 'a', 'b'), path.join(dirs.root, 'a')]));
  });

  it('carries no pattern text and no raw control character in the profile', () => {
    const dirs = layout();
    const profile = build(
      dirs,
      fileRulesOf(
        [
          fileSpec('*.pem', { roots: [dirs.root], home: dirs.home, tool: 'Edit' }),
          fileSpec('secrets/**', { roots: [dirs.root], home: dirs.home }),
          fileSpec('a?b', { roots: [dirs.root], home: dirs.home }),
          fileSpec('*.env', { roots: [dirs.root], home: dirs.home, exceptions: ['sample.env'] }),
        ],
        [dirs.root],
      ),
    );
    expect(Object.keys(profile.params).some((name) => name.startsWith('FILE_DENY_'))).toBe(true);
    for (const text of ['pem', 'secrets', 'sample', '.env', 'a?b']) expect(profile.profile).not.toContain(text);
    expect(profile.profile).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });
});

const paramValues = (profile: SeatbeltProfile, prefix: string): string[] =>
  Object.entries(profile.params)
    .filter(([name]) => name.startsWith(`${prefix}_`))
    .map(([, value]) => value)
    .sort();

const namesWithValue = (profile: SeatbeltProfile, prefix: string, value: string): string[] =>
  Object.entries(profile.params)
    .filter(([name, candidate]) => name.startsWith(`${prefix}_`) && candidate === value)
    .map(([name]) => name);

const symlinkGuardLine = (name: string): string => `(deny file-write-create (require-all (literal (param "${name}")) (vnode-type SYMLINK)))`;

const DEVICE_NODE_LINES = [
  '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
  '(allow file-write-data file-ioctl (literal "/dev/tty"))',
  '(allow file-write-data file-ioctl (regex #"^/dev/fd/[0-9]+$"))',
];

describe('user deny ancestors in the move and re-point guards (pins)', () => {
  it('guards exactly the ancestors within the root of an anchored subtree entry, starting at its parent', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${path.join(dirs.root, 'a', 'b', 'secrets')}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    const expected = [dirs.root, path.join(dirs.root, 'a'), path.join(dirs.root, 'a', 'b')].sort();
    expect(paramValues(profile, 'GUARDED_ANCESTOR')).toEqual(expected);
    expect(paramValues(profile, 'SYMLINK_GUARD')).toEqual(expected);
    const lines = linesOf(profile);
    for (const value of expected) {
      const [name] = namesWithValue(profile, 'SYMLINK_GUARD', value);
      expect(lines).toContain(symlinkGuardLine(name as string));
    }
  });

  it('guards the directory itself for an anchored non-tree entry', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${path.join(dirs.root, 'a', 'b')}/*.pem`, { roots: [dirs.root], home: dirs.home, tool: 'Edit' })], [dirs.root]));
    const expected = [dirs.root, path.join(dirs.root, 'a'), path.join(dirs.root, 'a', 'b')].sort();
    expect(paramValues(profile, 'GUARDED_ANCESTOR')).toEqual(expected);
    expect(paramValues(profile, 'SYMLINK_GUARD')).toEqual(expected);
  });

  it('guards only the root for an unanchored entry', () => {
    const dirs = layout();
    const profile = build(dirs, fileRulesOf([fileSpec('.env', { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    expect(paramValues(profile, 'GUARDED_ANCESTOR')).toEqual([dirs.root]);
    expect(paramValues(profile, 'SYMLINK_GUARD')).toEqual([dirs.root]);
  });
});

describe('an entry whose lexical form differs from its canonical form', () => {
  const symlinked = () => {
    const dirs = layout();
    fs.mkdirSync(path.join(dirs.root, 'real'));
    fs.symlinkSync(path.join(dirs.root, 'real'), path.join(dirs.root, 'sym'));
    return dirs;
  };

  it('emits the read deny for both forms and guards the ancestors of both', () => {
    const dirs = symlinked();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${path.join(dirs.root, 'sym', 'secrets')}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    expect(paramValues(profile, 'FILE_DENY_READ')).toEqual([path.join(dirs.root, 'real', 'secrets'), path.join(dirs.root, 'sym', 'secrets')].sort());
    const lines = linesOf(profile);
    for (const name of ['FILE_DENY_READ_0', 'FILE_DENY_READ_1']) expect(lines).toContain(`(deny file-read* file-write-unlink (subpath (param "${name}")))`);
    const ancestors = [dirs.root, path.join(dirs.root, 'real'), path.join(dirs.root, 'sym')].sort();
    expect(paramValues(profile, 'GUARDED_ANCESTOR')).toEqual(ancestors);
    expect(paramValues(profile, 'SYMLINK_GUARD')).toEqual(ancestors);
    for (const value of ancestors) {
      const [name] = namesWithValue(profile, 'SYMLINK_GUARD', value);
      expect(lines).toContain(symlinkGuardLine(name as string));
    }
  });

  it('emits the write deny and its symlink metadata guard for both forms', () => {
    const dirs = symlinked();
    const profile = build(dirs, fileRulesOf([fileSpec(`/${path.join(dirs.root, 'sym')}/k.pem`, { roots: [dirs.root], home: dirs.home, tool: 'Edit' })], [dirs.root]));
    expect(paramValues(profile, 'FILE_DENY_WRITE')).toEqual(
      [path.join(dirs.root, 'real', 'k.pem'), path.join(dirs.root, 'sym', 'k.pem')].sort(),
    );
    const lines = linesOf(profile);
    for (const name of ['FILE_DENY_WRITE_0', 'FILE_DENY_WRITE_1']) {
      expect(lines).toContain(`(deny file-write* (subpath (param "${name}")))`);
      expect(lines).toContain(`(deny file-read-metadata (require-all (subpath (param "${name}")) (vnode-type SYMLINK)))`);
    }
  });

  it('emits the read deny for a rule spelled through a symlinked directory at both spellings', () => {
    const dirs = layout();
    const alias = path.join(path.dirname(dirs.root), 'alias');
    fs.symlinkSync(dirs.root, alias);
    const lexical = path.join(alias, 'secret');
    const profile = build(dirs, fileRulesOf([fileSpec(`/${lexical}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]));
    expect(paramValues(profile, 'FILE_DENY_READ')).toEqual([path.join(dirs.root, 'secret'), lexical].sort());
  });
});

describe('owned scratch space stays reachable under a user Read deny that covers it (pins)', () => {
  it('allows metadata on the ancestors of the session tmp dir within the user deny, before and after the user denies', () => {
    const dirs = layout();
    const base = path.dirname(dirs.root);
    const profile = build(dirs, fileRulesOf([fileSpec(`/${base}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root], dirs.tmp));
    expect(paramValues(profile, 'READ_METADATA')).toEqual([base, dirs.sessions].sort());
    const lines = linesOf(profile);
    const firstUserDeny = findLine(lines, /FILE_DENY_READ_0/).index;
    for (const name of Object.keys(profile.params).filter((key) => key.startsWith('READ_METADATA_'))) {
      const line = `(allow file-read-metadata (literal (param "${name}")))`;
      expect(lines.indexOf(line)).toBeLessThan(firstUserDeny);
      expect(lines.lastIndexOf(line)).toBeGreaterThan(firstUserDeny);
    }
  });

  it('allows metadata on the ancestors of the private scratch dir and of readAllowed within the user deny', () => {
    const dirs = layout();
    const base = path.dirname(dirs.root);
    const scratchRoot = path.join(base, 'spawn-tmp');
    const scratchDir = path.join(scratchRoot, 'sandbox-x');
    fs.mkdirSync(scratchDir, { recursive: true });
    const fileRules = fileRulesOf([fileSpec(`/${base}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]);
    const policy = { ...policyOf(dirs, fileRules), writableRoots: [dirs.root, scratchDir] } as SandboxPolicy;
    const profile = buildSeatbeltProfile(policy, { scratchDir });
    expect(paramValues(profile, 'READ_METADATA')).toEqual([base, dirs.sessions, scratchRoot].sort());
  });
});

describe('device node lines (pin)', () => {
  it('ends the file-rule section with exactly the three device node lines of BASE_RULES', () => {
    const dirs = layout();
    const lines = linesOf(build(dirs, fileRulesOf([fileSpec('**', { roots: [dirs.root], home: dirs.home })], [dirs.root])));
    expect(lines.slice(-4)).toEqual([...DEVICE_NODE_LINES, '']);
    for (const line of DEVICE_NODE_LINES) expect(lines.filter((candidate) => candidate === line)).toHaveLength(2);
    expect(lines.indexOf(DEVICE_NODE_LINES[0] as string)).toBe(7);
  });
});

describe('only owned scratch space is re-allowed after the user denies', () => {
  it('re-emits no READ_ALLOWED line other than the session tmp dir after the user deny lines', () => {
    const dirs = layout();
    const shared = path.join(dirs.outside, 'shared');
    fs.mkdirSync(shared);
    const fileRules = fileRulesOf([fileSpec(`/${shared}/**`, { roots: [dirs.root], home: dirs.home })], [dirs.root]);
    const policy = { ...policyOf(dirs, fileRules), readDenied: [dirs.sessions, dirs.outside], readAllowed: [dirs.tmp, shared] } as SandboxPolicy;
    const profile = buildSeatbeltProfile(policy, { tmpDir: dirs.tmp });
    const lines = linesOf(profile);
    const firstUserDeny = findLine(lines, /FILE_DENY_READ_0/).index;
    const reallowed = lines
      .slice(firstUserDeny)
      .filter((line) => line.startsWith('(allow file-read* ') && line.includes('READ_ALLOWED_'))
      .flatMap(paramIn)
      .map((name) => profile.params[name]);
    expect(reallowed).toEqual([dirs.tmp]);
    const sharedName = namesWithValue(profile, 'READ_ALLOWED', shared)[0] as string;
    expect(lines.indexOf(`(allow file-read* (subpath (param "${sharedName}")))`)).toBeLessThan(firstUserDeny);
  });
});
