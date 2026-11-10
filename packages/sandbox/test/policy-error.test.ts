import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { SandboxPolicyError, buildSeatbeltProfile, createSeatbeltSandbox } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = (): { root: string; sessions: string; tmp: string; spawnTmp: string } => {
  const dir = fs.realpathSync(makeTempDir());
  created.push(dir);
  const dirs = { root: path.join(dir, 'work'), sessions: path.join(dir, 'sessions'), tmp: path.join(dir, 'sessions', 's1'), spawnTmp: path.join(dir, 'spawn-tmp') };
  for (const entry of Object.values(dirs)) fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
  return dirs;
};

const policyOf = (overrides: Partial<SandboxPolicy> & { writableRoots: readonly string[] }): SandboxPolicy =>
  ({ writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules: EMPTY_FILE_RULES, ...overrides }) as SandboxPolicy;

const codeOf = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    return (error as SandboxPolicyError).code;
  }
  throw new Error('expected a SandboxPolicyError');
};

describe('SandboxPolicyError codes from buildSeatbeltProfile', () => {
  it('read_allowed_not_inside_denied for an entry outside every readDenied entry', () => {
    const dirs = base();
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: [dirs.root], readDenied: [dirs.sessions], readAllowed: [dirs.root] })))).toBe(
      'read_allowed_not_inside_denied',
    );
  });

  it('read_allowed_not_inside_denied when readDenied is empty', () => {
    const dirs = base();
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: [dirs.root], readAllowed: [dirs.tmp] })))).toBe('read_allowed_not_inside_denied');
  });

  it('read_allowed_contains_denied for an entry that contains another readDenied entry', () => {
    const dirs = base();
    const inner = path.join(dirs.tmp, 'inner');
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: [dirs.root], readDenied: [dirs.sessions, inner], readAllowed: [dirs.tmp] })))).toBe(
      'read_allowed_contains_denied',
    );
  });

  it('session_tmp_not_read_allowed for a tmpDir that is not a readAllowed entry', () => {
    const dirs = base();
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: [dirs.root], readDenied: [dirs.sessions] }), { tmpDir: dirs.tmp }))).toBe(
      'session_tmp_not_read_allowed',
    );
  });

  it('session_tmp_write_denied for a tmpDir that contains a writeDenied entry', () => {
    const dirs = base();
    const policy = policyOf({ writableRoots: [dirs.root], readDenied: [dirs.sessions], readAllowed: [dirs.tmp], writeDenied: [path.join(dirs.tmp, 'hook')] });
    expect(codeOf(() => buildSeatbeltProfile(policy, { tmpDir: dirs.tmp }))).toBe('session_tmp_write_denied');
  });

  it.each(['readDenied', 'writeDenied'] as const)('entry_not_absolute for a relative %s entry', (field) => {
    const dirs = base();
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: [dirs.root], [field]: ['rel/entry'] })))).toBe('entry_not_absolute');
  });

  it('writable_root_not_absolute for a relative writable root', () => {
    expect(codeOf(() => buildSeatbeltProfile(policyOf({ writableRoots: ['rel/root-dir'] })))).toBe('writable_root_not_absolute');
  });
});

describe.runIf(process.platform === 'darwin')('SandboxPolicyError codes from the seatbelt spawn', () => {
  it('writable_root_missing for a writable root that does not exist', () => {
    const dirs = base();
    const sandbox = createSeatbeltSandbox({ tmpRoot: dirs.spawnTmp, killGraceMs: 300 });
    const missing = path.join(dirs.root, 'missing');
    expect(
      codeOf(() => sandbox.spawn({ argv: ['/usr/bin/true'], cwd: dirs.root, env: {} }, policyOf({ writableRoots: [missing] }), new AbortController().signal)),
    ).toBe('writable_root_missing');
  });

  it('writable_root_not_absolute for a relative writable root', () => {
    const dirs = base();
    const sandbox = createSeatbeltSandbox({ tmpRoot: dirs.spawnTmp, killGraceMs: 300 });
    expect(
      codeOf(() => sandbox.spawn({ argv: ['/usr/bin/true'], cwd: dirs.root, env: {} }, policyOf({ writableRoots: ['relative/root'] }), new AbortController().signal)),
    ).toBe('writable_root_not_absolute');
  });
});
