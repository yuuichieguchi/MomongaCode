import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isUnixSocketLive } from '@momonga/foundation';

type LiveCheck = (socketPath: string, signal: AbortSignal) => Promise<boolean>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listening = async (): Promise<string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-uds-'));
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
});
