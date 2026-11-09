import type fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaimOutcome, KernelLockMechanism } from '@momonga/foundation';
import { sweepSessionTmp, sweepSpawnTmp } from '../src/process/tmp-sweep.ts';
import type { RuntimeFiles } from '../src/process/runtime-files.ts';

const DIR = path.join(path.sep, 'cache', 'momonga', 'tmp', 'spawn');
const NOW = 1_800_000_000_000;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const CLAIM_FAILS = 'claim-fails';
const REMOVE_REFUSED = 'remove-refused';
const NOT_EMPTY = 'not-empty';
const REMOVABLE = 'removable';
const NAMES = [CLAIM_FAILS, REMOVE_REFUSED, NOT_EMPTY, REMOVABLE];

const entryLock = (claims: string[]): KernelLockMechanism => {
  const claimSync = (lockPath: string): ClaimOutcome => {
    claims.push(lockPath);
    if (path.basename(lockPath) === CLAIM_FAILS) throw errno('EIO');
    return { kind: 'claimed', lock: { descriptor: undefined, writeHolder: () => undefined, release: () => undefined, dispose: () => undefined } };
  };
  return {
    name: 'file-lock',
    claim: async (lockPath) => claimSync(lockPath),
    claimSync,
    isHeld: async () => false,
    readHolder: async () => undefined,
    readHolderSync: () => undefined,
    claimInheritable: undefined,
    adoptInherited: undefined,
  };
};

const failingFiles = (directory: string, present: Set<string>): RuntimeFiles => {
  const fail = (entry: string): void => {
    const name = path.basename(entry);
    if (name === REMOVE_REFUSED) throw errno('EACCES');
    if (name === NOT_EMPTY) throw errno('ENOTEMPTY');
    present.delete(name);
  };
  const stat = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as unknown as fs.Stats;
  return {
    readdir: async (dir: string) => (dir === directory ? [...present] : []),
    rm: async (entry: string) => fail(entry),
    lstat: async () => stat,
    unlink: async (entry: string) => fail(entry),
    lstatSync: () => stat,
    unlinkSync: (entry: string) => fail(entry),
    renameSync: () => undefined,
  } as RuntimeFiles;
};

const expectedWarnings = (directory: string): string[] => [
  `leftover cleanup kept ${path.join(directory, CLAIM_FAILS)}: EIO`,
  `leftover cleanup kept ${path.join(directory, REMOVE_REFUSED)}: EACCES`,
  `leftover cleanup kept ${path.join(directory, NOT_EMPTY)}: ENOTEMPTY`,
];

describe('S7: an error on one entry keeps that entry, warns once, and the sweep goes on and resolves', () => {
  it('sweepSpawnTmp, the runtime start step: a claim error, an EACCES and an ENOTEMPTY are each kept and reported, and the next entry is removed', async () => {
    const present = new Set(NAMES);
    const warnings: string[] = [];
    const claims: string[] = [];
    await expect(sweepSpawnTmp({ dir: DIR, onWarning: (message) => void warnings.push(message), files: failingFiles(DIR, present), lock: entryLock(claims) })).resolves.toBeUndefined();
    expect(warnings).toEqual(expectedWarnings(DIR));
    expect([...present].sort()).toEqual([CLAIM_FAILS, NOT_EMPTY, REMOVE_REFUSED].sort());
    expect(claims.map((claimed) => path.basename(claimed))).toEqual(NAMES);
  });

  it('sweepSessionTmp, the runtime start step: the same three errors are kept and reported once each, and the sweep resolves', async () => {
    const root = path.join(path.sep, 'cache', 'momonga', 'tmp', 'sessions');
    const present = new Set(NAMES);
    const warnings: string[] = [];
    const store = { sessionActivity: () => undefined };
    const result = await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: (message) => void warnings.push(message), files: failingFiles(root, present), lock: entryLock([]) });
    expect(warnings).toEqual(expectedWarnings(root));
    expect(result).toEqual({ removed: 1, kept: 3 });
    expect(present.has(REMOVABLE)).toBe(false);
  });
});
