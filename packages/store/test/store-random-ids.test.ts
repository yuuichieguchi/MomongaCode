import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSY_WAIT_LIMIT_MS, nodeFileSystem, nodeFileSystemSync } from '@momonga/foundation';
import type { Random } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock, testKernelLock } from '@momonga/testkit';
import { LEASE_MS, START_MS, UNASKED_COMMANDS, makeStoreDir, registerCleanup } from './helpers.ts';

const fixedRandom = (): Random => ({
  float: () => 0.5,
  bytes: (length) => new Uint8Array(length).fill(9),
  hex: (byteLength) => '09'.repeat(byteLength),
  uuid: () => '00000000-0000-4000-8000-000000000009',
});

const openWith = (random: Random): RuntimeStore => {
  const dir = makeStoreDir();
  const store = openRuntimeStore({
    busyTimeoutMs: BUSY_WAIT_LIMIT_MS,
    lock: testKernelLock(),
    unaskedCommands: UNASKED_COMMANDS,
    path: path.join(dir, 'runtime.db'),
    home: dir,
    clock: createFakeClock(START_MS),
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    fileSystem: nodeFileSystem,
    fileSystemSync: nodeFileSystemSync,
    random,
  });
  registerCleanup(() => store.close());
  return store;
};

describe('store ids come from the store random port', () => {
  it('two stores with the same random port and the same clock start give the same session id', () => {
    const create = (store: RuntimeStore) => store.createSession({ cwd: '/work/a', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
    expect(create(openWith(fixedRandom())).id).toBe(create(openWith(fixedRandom())).id);
  });
});
