import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileCredentialStore, createMemoryCredentialStore } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder, sleepDrivenTiming, createFakeRandom, testKernelLock } from '@momonga/testkit';
import { deferred, rejection, settlementOf } from './support/secret-store-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SIGNAL = new AbortController().signal;

describe.each([
  ['memory', () => createMemoryCredentialStore()],
  ['file', () => createFileCredentialStore(path.join(makeDir(), 'creds'), { lock: testKernelLock() })],
] as const)('%s credential store', (_name, make) => {
  it('returns undefined for a missing key, then what was written, then undefined after removal', async () => {
    const store = make();
    expect(await store.read('k', SIGNAL)).toBeUndefined();
    await store.write('k', 'one', SIGNAL);
    await store.write('k', 'two', SIGNAL);
    expect(await store.read('k', SIGNAL)).toBe('two');
    await store.remove('k', SIGNAL);
    expect(await store.read('k', SIGNAL)).toBeUndefined();
    await store.remove('k', SIGNAL);
  });
});

describe('file credential store', () => {
  it('leaves no temporary files and keeps one file per key', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory, { lock: testKernelLock() });
    await store.write('a', '1', SIGNAL);
    await store.write('a', '2', SIGNAL);
    await store.write('b', '3', SIGNAL);
    const names = fs.readdirSync(directory);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
  });

  it('refuses to read through a symlink', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory, { lock: testKernelLock() });
    await store.write('k', 'secret', SIGNAL);
    const file = path.join(directory, fs.readdirSync(directory)[0] as string);
    const elsewhere = path.join(makeDir(), 'copy.json');
    fs.copyFileSync(file, elsewhere);
    fs.chmodSync(elsewhere, 0o600);
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    await expect(store.read('k', SIGNAL)).rejects.toThrow();
  });
});

describe('file credential store updates', () => {
  const counterOf = async (store: ReturnType<typeof createFileCredentialStore>): Promise<number> => Number(await store.read('counter', SIGNAL));

  it('applies every concurrent read-modify-write from two stores on one directory', async () => {
    const directory = path.join(makeDir(), 'creds');
    const first = createFileCredentialStore(directory, { lock: testKernelLock() });
    const second = createFileCredentialStore(directory, { lock: testKernelLock() });
    await first.write('counter', '0', SIGNAL);
    const bump = (current: string | undefined): string => String(Number(current) + 1);
    await Promise.all(Array.from({ length: 10 }, (_unused, index) => (index % 2 === 0 ? first : second).update('counter', bump, SIGNAL)));
    expect(await counterOf(first)).toBe(10);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('starts from undefined when the key does not exist yet', async () => {
    const store = createFileCredentialStore(path.join(makeDir(), 'creds'), { lock: testKernelLock() });
    await store.update('fresh', (current) => (current === undefined ? 'created' : 'existed'), SIGNAL);
    expect(await store.read('fresh', SIGNAL)).toBe('created');
  });

  it('removes the temporary file when the write fails', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory, { lock: testKernelLock() });
    await store.write('k', 'one', SIGNAL);
    const [file] = fs.readdirSync(directory);
    fs.rmSync(path.join(directory, file as string));
    fs.mkdirSync(path.join(directory, file as string));
    await expect(store.write('k', 'two', SIGNAL)).rejects.toThrow();
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('file credential store while another process holds the key lock', () => {
  const steppedPorts = (): FileLockPorts => {
    let now = 1_000_000;
    return {
      timing: sleepDrivenTiming({
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
      random: { ...createFakeRandom(1), hex: () => 'cafe0001' },
    };
  };

  const heldStore = async (context: Parameters<typeof startLockHolder>[0]) => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory, { lock: testKernelLock(), ports: steppedPorts(), lockTimeoutMs: 100 });
    await store.write('k', 'tokens', SIGNAL);
    const lockPath = path.join(`${directory}.locks`, `${createHash('sha256').update('k').digest('hex')}.json.lock`);
    const holder = await startLockHolder(context, lockPath);
    return { store, holder };
  };

  it.for(['update', 'write', 'remove'] as const)('%s waits for the lock and gives up at the timeout, naming the holder', async (operation, context) => {
    const { store, holder } = await heldStore(context);
    const attempt =
      operation === 'update' ? store.update('k', () => 'changed', SIGNAL) : operation === 'write' ? store.write('k', 'changed', SIGNAL) : store.remove('k', SIGNAL);
    await expect(attempt).rejects.toThrow(`held by process ${holder.pid}`);
    expect(await store.read('k', SIGNAL)).toBe('tokens');
  });

  it('keeps serving other keys while one key is held', async (context) => {
    const { store } = await heldStore(context);
    await store.write('other', 'free', SIGNAL);
    expect(await store.read('other', SIGNAL)).toBe('free');
  });
});

describe.each([
  ['memory', () => createMemoryCredentialStore()],
  ['file', () => createFileCredentialStore(path.join(makeDir(), 'creds'), { lock: testKernelLock() })],
] as const)('%s credential store: a call queued behind another one on its key', (name, make) => {
  it(`a ${name} credential store call queued behind a hung one leaves at its signal`, async () => {
    const store = make();
    await store.write('k', 'kept', SIGNAL);
    const held = deferred<void>();
    const started = deferred<void>();
    const hung = store.withKey(
      'k',
      async () => {
        started.resolve();
        await held.promise;
      },
      SIGNAL,
    );
    await started.promise;
    const controller = new AbortController();
    const queued = store.write('k', 'replaced', controller.signal);
    const settlement = settlementOf(queued);
    expect(settlement.current()).toBe('pending');
    const reason = new Error('the requester left');
    controller.abort(reason);
    expect(await rejection(queued)).toBe(reason);
    held.resolve();
    await hung;
    expect(await store.read('k', SIGNAL)).toBe('kept');
  });
});
