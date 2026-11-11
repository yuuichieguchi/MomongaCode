import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, protectedSetFor } from '@momonga/foundation';
import { createSeatbeltSandbox, planBubblewrap } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, killGroupsForCleanup, NEVER_CANCELLED, testPaths } from '@momonga/testkit';
import { buildSeatbeltProfile } from '../src/profile.ts';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let base: string;
let work: string;

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(work, 'vendor', 'lib', '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(work, 'vendor', 'lib', '.git', 'objects'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = async (): Promise<SandboxPolicy> => {
  const protectedSet = await protectedSetFor([work], fakePolicyFilesystem());
  return {
    writableRoots: [work],
    writeDenied: [...protectedSet.paths],
    writeDeniedLiterals: [],
    readDenied: [],
    network: 'deny',
    fileRules: EMPTY_FILE_RULES,
    protectedSet,
  };
};

const paramIn = (line: string): string[] => [...line.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((match) => match[1] as string);

describe('the .git name rule of the protected set reaches the sandbox', () => {
  it('denies in the Seatbelt profile the control entries of every .git below a root, existing or not', async () => {
    const profile = await buildSeatbeltProfile(await policy(), {}, testPaths());
    const regexes = profile.profile
      .split('\n')
      .filter((line) => /^\(deny file-write\* \(regex \(param "FILE_DENY_WRITE_\d+"\)\)\)$/.test(line))
      .map((line) => profile.params[paramIn(line)[0] as string] as string);
    const blocked = (target: string): boolean => regexes.some((source) => new RegExp(source).test(target));
    for (const entry of ['hooks/post-checkout', 'hooks', 'config', 'config.worktree', 'commondir']) {
      expect(blocked(path.join(work, 'vendor', 'lib', '.git', entry))).toBe(true);
      expect(blocked(path.join(work, 'not', 'yet', 'there', '.git', entry))).toBe(true);
    }
    expect(blocked(path.join(work, 'vendor', 'lib', '.git', 'objects', 'x'))).toBe(false);
    expect(blocked(path.join(work, 'vendor', 'lib', 'src', 'config'))).toBe(false);
  });

  it('mounts read-only in the bubblewrap plan the control entries of every existing nested .git', async () => {
    const { args } = await planBubblewrap(await policy(), { cwd: work }, NEVER_CANCELLED);
    const readOnly = args.flatMap((value, index) => (value === '--ro-bind' && args[index + 1] === args[index + 2] ? [args[index + 1]] : []));
    expect(readOnly).toContain(path.join(work, 'vendor', 'lib', '.git', 'hooks'));
    expect(readOnly).not.toContain(path.join(work, 'vendor', 'lib', '.git', 'objects'));
  });

  it.runIf(process.platform === 'darwin')('refuses a real sandboxed write to a nested .git hook and config, even in a .git that does not exist yet', async () => {
    const sandbox = createSeatbeltSandbox({ tmpRoot: base, killGraceMs: 300 });
    const sh = async (script: string) => {
      const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: { PATH: BASE_PATH, HOME: work } }, await policy(), new AbortController().signal);
      try {
        return await run(await proc);
      } finally {
        killGroupsForCleanup([(await proc).pgid]);
      }
    };
    expect((await sh('echo x > vendor/lib/.git/hooks/post-checkout')).code).not.toBe(0);
    expect((await sh('echo x > vendor/lib/.git/config')).code).not.toBe(0);
    expect((await sh('mkdir -p fresh/.git/hooks && echo x > fresh/.git/hooks/pre-commit')).code).not.toBe(0);
    expect((await sh('echo x > vendor/lib/.GIT/hooks/post-merge')).code).not.toBe(0);
    expect((await sh('echo x > vendor/lib/.git/objects/y')).code).toBe(0);
    expect(fs.existsSync(path.join(work, 'vendor', 'lib', '.git', 'hooks', 'post-checkout'))).toBe(false);
  });
});
