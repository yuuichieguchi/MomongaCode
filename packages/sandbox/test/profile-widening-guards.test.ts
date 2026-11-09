import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { SandboxPolicyError, buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy, SeatbeltProfile } from '@momonga/sandbox';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const created: string[] = [];
const locked: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o700);
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Area = {
  root: string;
  home: string;
  tmp: string;
  wide: string;
  owned: string;
  literal: string;
  userAnchor: string;
};

const area = (): Area => {
  const base = fs.realpathSync(makeTempDir());
  created.push(base);
  const wide = path.join(base, 'outside', 'wide');
  const fx = {
    root: path.join(base, 'work'),
    home: path.join(base, 'home'),
    tmp: path.join(base, 'sessions', 's1'),
    wide,
    owned: path.join(wide, 'a', 'owned'),
    literal: path.join(wide, 'b', 'bin', 'momonga'),
    userAnchor: path.join(wide, 'c', 'secret'),
  };
  for (const dir of [fx.root, fx.home, fx.tmp, fx.owned, path.dirname(fx.literal), fx.userAnchor]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fx;
};

const policyOf = (fx: Area): SandboxPolicy =>
  ({
    writableRoots: [fx.root],
    writeDenied: [fx.owned],
    protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [fx.literal],
    readDenied: [path.dirname(fx.tmp)],
    readAllowed: [fx.tmp],
    network: 'deny',
    fileRules: fileRulesOf(
      [
        fileSpec(`/${fx.wide}/**`, { roots: [fx.root], home: fx.home, tool: 'Edit', effect: 'allow', layer: 'user' }),
        fileSpec(`/${fx.userAnchor}/**`, { roots: [fx.root], home: fx.home, ruleIndex: 1 }),
      ],
      [fx.root],
    ),
  }) as SandboxPolicy;

const profileOf = (fx: Area): SeatbeltProfile => buildSeatbeltProfile(policyOf(fx), { tmpDir: fx.tmp });

const guardedOf = (profile: SeatbeltProfile, prefix: string): string[] =>
  Object.entries(profile.params)
    .filter(([name]) => name.startsWith(`${prefix}_`))
    .map(([, value]) => value);

const valuesOf = (profile: SeatbeltProfile, prefix: string, within: string): string[] =>
  Object.entries(profile.params)
    .filter(([name, value]) => name.startsWith(`${prefix}_`) && (value === within || value.startsWith(`${within}/`)))
    .map(([, value]) => value)
    .sort();

describe('guarded ancestors inside a widening allow area (no OS tool)', () => {
  it('the profile widens the area for writes', () => {
    const fx = area();
    expect(profileOf(fx).profile).toMatch(/\(allow file-write\* \(subpath \(param "FILE_ALLOW_WRITE_0"\)\)\)/);
  });

  it('guards every ancestor of the owned path, the launcher literal and the user deny anchor that lies inside the area', () => {
    const fx = area();
    const expected = [fx.wide, path.join(fx.wide, 'a'), path.join(fx.wide, 'b'), path.join(fx.wide, 'b', 'bin'), path.join(fx.wide, 'c')].sort();
    expect(valuesOf(profileOf(fx), 'GUARDED_ANCESTOR', fx.wide)).toEqual(expected);
  });

  it('adds a symlink guard for every ancestor of the launcher literal and the user deny anchor inside the area', () => {
    const fx = area();
    const expected = [fx.wide, path.join(fx.wide, 'b'), path.join(fx.wide, 'b', 'bin'), path.join(fx.wide, 'c')].sort();
    expect(valuesOf(profileOf(fx), 'SYMLINK_GUARD', fx.wide)).toEqual(expected);
  });
});

const withoutAreaGuards = (profile: SeatbeltProfile, within: string): SeatbeltProfile => {
  const dropped = new Set(
    Object.entries(profile.params)
      .filter(([name, value]) => /^(GUARDED_ANCESTOR|SYMLINK_GUARD)_/.test(name) && (value === within || value.startsWith(`${within}/`)))
      .map(([name]) => name),
  );
  const lines = profile.profile.split('\n').filter((line) => ![...line.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].some((match) => dropped.has(match[1] as string)));
  return { ...profile, profile: lines.join('\n'), params: Object.fromEntries(Object.entries(profile.params).filter(([name]) => !dropped.has(name))) };
};

const sandboxExec = (profile: SeatbeltProfile, script: string, cwd: string): number => {
  const params = Object.entries(profile.params).flatMap(([name, value]) => ['-D', `${name}=${value}`]);
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile.profile, ...params, '--', '/bin/sh', '-c', script], { cwd, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  return result.status ?? -1;
};

describe.runIf(process.platform === 'darwin')('guarded ancestors inside a widening allow area under real Seatbelt', () => {
  it('refuses a sandboxed mv of an ancestor of the launcher literal, which succeeds without the area guards', () => {
    const guarded = area();
    const bin = path.dirname(guarded.literal);
    expect(sandboxExec(profileOf(guarded), `mv '${bin}' '${bin}.moved'`, guarded.root)).not.toBe(0);
    expect(fs.statSync(bin).isDirectory()).toBe(true);

    const control = area();
    const controlBin = path.dirname(control.literal);
    expect(sandboxExec(withoutAreaGuards(profileOf(control), control.wide), `mv '${controlBin}' '${controlBin}.moved'`, control.root)).toBe(0);
    expect(fs.existsSync(`${controlBin}.moved`)).toBe(true);
  });

  it('refuses removing an ancestor of the launcher literal, which succeeds without the area guards', () => {
    const guarded = area();
    const bin = path.dirname(guarded.literal);
    expect(sandboxExec(profileOf(guarded), `rmdir '${bin}'`, guarded.root)).not.toBe(0);
    expect(fs.statSync(bin).isDirectory()).toBe(true);

    const control = area();
    const controlBin = path.dirname(control.literal);
    expect(sandboxExec(withoutAreaGuards(profileOf(control), control.wide), `rmdir '${controlBin}'`, control.root)).toBe(0);
    expect(fs.existsSync(controlBin)).toBe(false);
  });

  it('refuses a symlink in place of a missing ancestor of the launcher literal, which succeeds without the area guards', () => {
    const guarded = area();
    const bin = path.dirname(guarded.literal);
    const profile = profileOf(guarded);
    fs.rmdirSync(bin);
    expect(sandboxExec(profile, `ln -s '${guarded.root}' '${bin}'`, guarded.root)).not.toBe(0);
    expect(fs.existsSync(bin)).toBe(false);

    const control = area();
    const controlBin = path.dirname(control.literal);
    const controlProfile = withoutAreaGuards(profileOf(control), control.wide);
    fs.rmdirSync(controlBin);
    expect(sandboxExec(controlProfile, `ln -s '${control.root}' '${controlBin}'`, control.root)).toBe(0);
    expect(fs.lstatSync(controlBin).isSymbolicLink()).toBe(true);
  });

  it('refuses a sandboxed mv of the parent of the user deny anchor and of the owned path', () => {
    const fx = area();
    const userParent = path.dirname(fx.userAnchor);
    const ownedParent = path.dirname(fx.owned);
    expect(sandboxExec(profileOf(fx), `mv '${userParent}' '${userParent}.moved'`, fx.root)).not.toBe(0);
    expect(sandboxExec(profileOf(fx), `mv '${ownedParent}' '${ownedParent}.moved'`, fx.root)).not.toBe(0);
    expect(fs.statSync(userParent).isDirectory()).toBe(true);
    expect(fs.statSync(ownedParent).isDirectory()).toBe(true);
  });
});

describe('guarded ancestors whose containment cannot be decided', () => {
  it('emits GUARDED_ANCESTOR and SYMLINK_GUARD lines for the ancestors of a launcher literal below a directory that cannot be searched (fail-closed)', () => {
    const fx = area();
    const lockedDir = path.join(fx.root, 'locked');
    const bin = path.join(lockedDir, 'inner', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(lockedDir, 0o000);
    locked.push(lockedDir);
    const profile = buildSeatbeltProfile({ ...policyOf(fx), writeDeniedLiterals: [path.join(bin, 'momonga')] }, { tmpDir: fx.tmp });
    const ancestors = [bin, path.dirname(bin), lockedDir];
    expect(guardedOf(profile, 'GUARDED_ANCESTOR')).toEqual(expect.arrayContaining(ancestors));
    expect(guardedOf(profile, 'SYMLINK_GUARD')).toEqual(expect.arrayContaining(ancestors));
  });
});

describe('guarded ancestors named with a leading ..', () => {
  it('guards <root>/..cfg, an ancestor inside the root of a user deny anchor below it', () => {
    const fx = area();
    const dotted = path.join(fx.root, '..cfg');
    const anchor = path.join(dotted, 'secret');
    fs.mkdirSync(anchor, { recursive: true });
    const policy = { ...policyOf(fx), fileRules: fileRulesOf([fileSpec(`/${anchor}/**`, { roots: [fx.root], home: fx.home })], [fx.root]) };
    const profile = buildSeatbeltProfile(policy, { tmpDir: fx.tmp });
    expect(guardedOf(profile, 'GUARDED_ANCESTOR')).toEqual(expect.arrayContaining([dotted, fx.root]));
    expect(guardedOf(profile, 'SYMLINK_GUARD')).toEqual(expect.arrayContaining([dotted, fx.root]));
  });
});

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('a guard candidate whose containment cannot be resolved', () => {
  it('fails the profile build with guard_path_unresolvable for an ELOOP in the ancestor chain of a launcher literal', () => {
    const fx = area();
    const loop = path.join(fx.root, 'loop');
    fs.symlinkSync(loop, loop);
    const literal = path.join(loop, 'bin', 'momonga');
    const error = thrownBy(() => buildSeatbeltProfile({ ...policyOf(fx), writeDeniedLiterals: [literal] }, { tmpDir: fx.tmp }));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    const typed = error as SandboxPolicyError & { reason?: unknown; cause?: unknown };
    expect(typed.code).toBe('guard_path_unresolvable');
    expect(typed.path).toBe(path.dirname(literal));
    expect(typed.reason).toEqual({ kind: 'errno', code: 'ELOOP' });
    expect((typed.cause as NodeJS.ErrnoException | undefined)?.code).toBe('ELOOP');
  });
});
