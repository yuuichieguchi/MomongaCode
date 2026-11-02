import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, LOCK_FD_ENV, LOCK_NONCE_ENV, runDaemonEntry } from '@momonga/foundation';
import type { DaemonDefinition, DaemonHandle } from '@momonga/foundation';
import { createFakeEntryIo, createFakeKernelLock, withTempDir } from '@momonga/testkit';

describe('lock adoption in the daemon entry', () => {
  it('adopts a handed-off lock through the injected lock mechanism rather than touching descriptors itself', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const lockPath = path.join(home, '.momonga', 'run', 'runtime.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const kernel = createFakeKernelLock({ inheritable: true });
    const claim = kernel.claimInheritable?.(lockPath);
    if (claim?.kind !== 'claimed') throw new Error('the fake lock was not free');
    claim.lock.writeHolder('handoff:abc');
    claim.lock.release();
    const io = createFakeEntryIo({
      argv: [`--home=${home}`, '--log-target=file'],
      home,
      env: { [LOCK_FD_ENV]: '5', [LOCK_NONCE_ENV]: 'abc' },
      lockMechanism: kernel,
    });
    const handle: DaemonHandle = { close: async () => ({ clean: true }), abort: async () => ({ clean: true }), fatal: new Promise<Error>(() => undefined) };
    const definition: DaemonDefinition<typeof COMMON_ENTRY_FLAGS> = {
      service: 'runtime',
      version: '1.0.0',
      flags: COMMON_ENTRY_FLAGS,
      maxCloseMs: () => 1000,
      ownLockPath: () => lockPath,
      logPath: (directory) => path.join(directory, '.momonga', 'logs', 'runtime.log'),
      isConfigError: () => false,
      start: async ({ acquireLock }) => {
        await acquireLock(lockPath);
        io.signal('SIGTERM');
        return handle;
      },
    };

    await runDaemonEntry(io, definition);

    expect(kernel.adoptionsMade()).toEqual([{ lockPath, descriptor: 5 }]);
    expect(kernel.claimsMade()).toEqual([lockPath]);
  });
});
