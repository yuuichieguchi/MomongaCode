import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUnixSocketLive, listenUnix } from '@momonga/foundation';
import { createTempDir, testKernelLock } from '@momonga/testkit';
import type { KernelLockMechanism } from '@momonga/foundation';

type LiveCheck = (socketPath: string, signal: AbortSignal) => Promise<boolean>;

type Listen = (server: net.Server, socketPath: string, lockOptions?: { mechanism: KernelLockMechanism }, signal?: AbortSignal) => Promise<void>;

const listenAt = listenUnix as unknown as Listen;

const privateDir = (): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const closeServer = (server: net.Server): Promise<void> => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));

const occupiedByUnlockedServer = async (dir: string): Promise<{ socketPath: string; owner: net.Server }> => {
  const socketPath = path.join(dir, 'held.sock');
  const owner = net.createServer((socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => owner.listen(socketPath, () => resolve()));
  cleanups.unshift(() => closeServer(owner));
  return { socketPath, owner };
};

const deadSocket = (dir: string): string => {
  const socketPath = path.join(dir, 'dead.sock');
  const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`;
  spawnSync(process.execPath, ['-e', script]);
  return socketPath;
};


const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listening = async (): Promise<string> => {
  const dir = createTempDir();
  const socketPath = path.join(dir, 'live.sock');
  const server = net.createServer((socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
};

describe.skipIf(process.platform === 'win32')('the socket liveness check takes the asking operation signal (design-managed-servers V7, section 8.2)', () => {
  it('rejects with the signal reason when the asking operation has already ended, instead of answering', async () => {
    const socketPath = await listening();
    const ended = new AbortController();
    const reason = new Error('the start that asked has ended');
    ended.abort(reason);
    await expect((isUnixSocketLive as unknown as LiveCheck)(socketPath, ended.signal)).rejects.toBe(reason);
  });

  it('ends listenUnix when the start deadline signal aborts during the liveness check, with that reason, and releases the lock so a later start can claim the path (design-managed-servers section 18, item 7)', async () => {
    const dir = privateDir();
    const { socketPath, owner } = await occupiedByUnlockedServer(dir);
    const deadline = new AbortController();
    const reason = new Error('the start deadline passed');
    deadline.abort(reason);
    const claimant = net.createServer();
    await expect(listenAt(claimant, socketPath, { mechanism: testKernelLock() }, deadline.signal)).rejects.toBe(reason);
    await closeServer(owner);
    const later = net.createServer();
    cleanups.unshift(() => closeServer(later));
    await listenAt(later, socketPath, { mechanism: testKernelLock() }, new AbortController().signal);
    expect(later.listening).toBe(true);
  });

  it('allows no liveness check without the asking operation signal: a listenUnix call with no signal is refused before it binds (section 18, item 7: a signal that never aborts is not allowed)', async () => {
    const dir = privateDir();
    const socketPath = deadSocket(dir);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    const claimant = net.createServer();
    cleanups.unshift(() => closeServer(claimant));
    await expect(listenAt(claimant, socketPath)).rejects.toBeInstanceOf(Error);
    expect(claimant.listening).toBe(false);
  });

  it('answers not live when the connect is reset: a listener that is ending accepts nothing (design-managed-servers section 8)', async () => {
    const socketPath = await listening();
    const reset = Object.assign(new Error(`connect ECONNRESET ${socketPath}`), { code: 'ECONNRESET', syscall: 'connect' });
    const probe = Object.assign(new EventEmitter(), { destroy: () => undefined });
    const connect = vi.spyOn(net, 'connect').mockImplementation((() => {
      setImmediate(() => probe.emit('error', reset));
      return probe;
    }) as unknown as typeof net.connect);
    try {
      await expect((isUnixSocketLive as unknown as LiveCheck)(socketPath, new AbortController().signal)).resolves.toBe(false);
    } finally {
      connect.mockRestore();
    }
  });
});
