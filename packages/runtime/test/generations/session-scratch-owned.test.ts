import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimPathOf, ensureSessionTmpDir, hostKernelLock, releaseSessionScratch } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import { createFakeClock, createFakeKernelLock } from '@momonga/testkit';
import { START_MS, makeLogger, makeTempHome } from '../process/helpers.ts';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourceFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));

describe('the claim of a session scratch directory (17.6, 20.41)', () => {
  it('is owned by the process that claimed it first and shared for a process that finds the claim held, which still gets the directory', async () => {
    const temp = await makeTempHome();
    const lock = createFakeKernelLock({ inheritable: false });
    const directory = path.join(temp.paths.tmp.sessions, 'session-held');
    lock.holdExternally(claimPathOf(lock, directory, 'sidecar'), 4242);

    const shared = await ensureSessionTmpDir(temp.paths, 'session-held', { lock });
    const owned = await ensureSessionTmpDir(temp.paths, 'session-own', { lock });

    expect(shared).toEqual({ dir: directory, claim: 'shared' });
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    expect(owned).toEqual({ dir: path.join(temp.paths.tmp.sessions, 'session-own'), claim: 'owned' });
    releaseSessionScratch(owned.dir);
  });

  it('is released at eviction, so the next sweep may take the directory', async () => {
    const temp = await makeTempHome();
    const lock = hostKernelLock();
    const { dir } = await ensureSessionTmpDir(temp.paths, 'session-1', { lock });
    const claimPath = claimPathOf(lock, dir, 'sidecar');
    const clock = createFakeClock(START_MS);
    const states = runtime.createSessionStates({
      clock,
      store: { sessionActivity: () => ({ lastActivityAt: START_MS, hasActiveRun: true }) },
      logger: makeLogger(),
      releaseScratch: (sessionId) => releaseSessionScratch(path.join(temp.paths.tmp.sessions, sessionId)),
    });
    states.get({ id: 'session-1', cwd: temp.project });
    expect(await lock.isHeld(claimPath)).toBe(true);

    expect(states.evictAll()).toEqual(['session-1']);

    expect(await lock.isHeld(claimPath)).toBe(false);
    expect(states.size()).toBe(0);
  });

  it('no source of the runtime decides retention by in-memory state any more', () => {
    const naming = sourceFiles(SOURCE_ROOT).filter((file) => fs.readFileSync(file, 'utf8').includes('hasInMemoryState'));
    expect(naming).toEqual([]);
  });
});
