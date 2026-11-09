import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernelLockMechanism, lockFormOf, sweepLeftovers } from '@momonga/foundation';
import type { LeftoverFiles, LockForm } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { exitOf, startHolder } from './support/lock-processes.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

const ENTRY_NAME = 'entry.json.tmp';

const PRIMITIVES: ReadonlyArray<{ test: string; platform: NodeJS.Platform; form: LockForm }> = [
  { test: 'T1, entry form (darwin, O_EXLOCK on the entry)', platform: 'darwin', form: 'entry' },
  { test: 'T2, sidecar form (linux and win32, SQLite BEGIN EXCLUSIVE on <entry>.sqlite)', platform: 'linux', form: 'sidecar' },
];

const nodeLeftoverFiles: LeftoverFiles = {
  readdir: (directory) => fs.promises.readdir(directory),
  rm: (file) => fs.promises.rm(file, { force: true }),
};

describe('the kernel lock is released when its holder is killed with SIGKILL', () => {
  for (const { test, platform, form } of PRIMITIVES) {
    it(
      `${test}: a second process is refused while the holder lives and claims after the kill`,
      async (context) => {
        const mechanism = createKernelLockMechanism(platform);
        expect(lockFormOf(mechanism)).toBe(form);
        const entry = path.join(makeTemporaryDirectory(), ENTRY_NAME);
        const holder = await startHolder(context, entry, platform);
        expect((await mechanism.claim(entry)).kind).toBe('held');
        holder.kill('SIGKILL');
        expect(await exitOf(holder)).toEqual({ code: null, signal: 'SIGKILL' });
        const after = await mechanism.claim(entry);
        expect(after.kind).toBe('claimed');
        if (after.kind === 'claimed') after.lock.release();
      },
      REAL_PROCESS_TEST_TIMEOUT_MS,
    );
  }
});

describe('R1 on real kernel locks: the sweep keeps an entry whose holder lives and removes it once the holder is killed', () => {
  for (const { test, platform } of PRIMITIVES) {
    it(
      `${test}: kept while held, removed with its sidecar after SIGKILL`,
      async (context) => {
        const mechanism = createKernelLockMechanism(platform);
        const directory = makeTemporaryDirectory();
        const entry = path.join(directory, ENTRY_NAME);
        const holder = await startHolder(context, entry, platform);
        const before = fs.readdirSync(directory).sort();
        const registered = [{ directory, isLeftover: (name: string) => name.endsWith('.tmp') }];
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(directory).sort()).toEqual(before);
        holder.kill('SIGKILL');
        await exitOf(holder);
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(directory)).toEqual([]);
      },
      REAL_PROCESS_TEST_TIMEOUT_MS,
    );
  }
});
