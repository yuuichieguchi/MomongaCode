import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABSTRACT_SOCKET_PREFIX, PIPE_LOCK_PREFIX, claimNetAddress, netLockAddress, probeNetAddress } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';

describe('network-namespace lock addresses (Linux abstract socket, Windows named pipe)', () => {
  it('derives one address from the comparable form of the lock path', (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    expect(netLockAddress('linux', path.join(dir, '.', 'runtime.lock'), 'alice')).toBe(netLockAddress('linux', lockPath, 'alice'));
    expect(netLockAddress('linux', path.join(dir, 'sub', '..', 'runtime.lock'), 'alice')).toBe(netLockAddress('linux', lockPath, 'alice'));
  });

  it('separates users and lock files', (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    expect(netLockAddress('linux', lockPath, 'alice')).not.toBe(netLockAddress('linux', lockPath, 'bob'));
    expect(netLockAddress('linux', lockPath, 'alice')).not.toBe(netLockAddress('linux', path.join(dir, 'gateway.lock'), 'alice'));
  });

  it('puts the Linux address in the abstract namespace and the Windows address in the pipe namespace', (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    expect(netLockAddress('linux', lockPath, 'alice').startsWith(ABSTRACT_SOCKET_PREFIX)).toBe(true);
    expect(ABSTRACT_SOCKET_PREFIX.startsWith('\0')).toBe(true);
    expect(netLockAddress('win32', lockPath, 'alice').startsWith(PIPE_LOCK_PREFIX)).toBe(true);
    expect(PIPE_LOCK_PREFIX).toBe('\\\\.\\pipe\\momonga-lock-');
  });
});

describe('claiming and probing a listening address (run against a filesystem socket path, the only kind this host has)', () => {
  it('claims once, reports the second claim as held, and frees the address on release', async (context) => {
    const dir = withTempDir(context);
    const address = path.join(dir, 'l.sock');
    const holderFile = path.join(dir, 'l.lock');
    const first = await claimNetAddress(address, holderFile);
    if (first.kind !== 'claimed') throw new Error('the address was not free');
    expect(await probeNetAddress(address)).toBe(true);
    expect((await claimNetAddress(address, holderFile)).kind).toBe('held');
    first.lock.writeHolder('4242');
    expect(fs.readFileSync(holderFile, 'utf8')).toBe('4242');
    first.lock.release();
    first.lock.release();
    expect(await probeNetAddress(address)).toBe(false);
    const again = await claimNetAddress(address, holderFile);
    if (again.kind !== 'claimed') throw new Error('the address was not free after release');
    registerCleanup(context, () => again.lock.release());
  });

  it('does not map an address it cannot bind to held', async (context) => {
    const dir = withTempDir(context);
    await expect(claimNetAddress(path.join(dir, 'missing', 'l.sock'), path.join(dir, 'l.lock'))).rejects.toBeInstanceOf(Error);
  });

  it('does not map a probe failure to free', async (context) => {
    const dir = withTempDir(context);
    const notASocket = path.join(dir, 'file');
    fs.writeFileSync(notASocket, '');
    await expect(probeNetAddress(notASocket)).rejects.toMatchObject({ code: 'ENOTSOCK' });
  });
});
