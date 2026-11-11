import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUdsClient, listenUnix, fixedSocket } from '@momonga/foundation';
import { waitFor, realProcessTestSignal, testKernelLock } from '@momonga/testkit';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const socketPathInTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-'));
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 's.sock');
};

type Hanging = { socketPath: string; requestsSeen: () => number; closedConnections: () => number };

const startHangingServer = async (mode: 'no-headers' | 'partial-body'): Promise<Hanging> => {
  const socketPath = socketPathInTempDir();
  let requests = 0;
  let closed = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.socket.once('close', () => {
      closed += 1;
    });
    if (mode === 'partial-body') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first');
    }
  });
  await listenUnix(server, socketPath, { mechanism: testKernelLock() }, realProcessTestSignal());
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { socketPath, requestsSeen: () => requests, closedConnections: () => closed };
};

describe('UdsClient.destroy', () => {
  it('rejects a request still waiting for response headers and closes its connection', async () => {
    const server = await startHangingServer('no-headers');
    const client = createUdsClient(fixedSocket(server.socketPath), { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
    cleanups.push(() => client.destroy());
    const pending = client.request({ method: 'GET', path: '/hang' });
    const outcome = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await waitFor(() => server.requestsSeen() === 1, { description: 'the request to arrive' });

    await client.destroy();

    expect(await outcome).toBe('rejected');
    await waitFor(() => server.closedConnections() === 1, { description: 'the connection to close' });
    expect(server.closedConnections()).toBe(1);
  });

  it('rejects reading a body that is still streaming', async () => {
    const server = await startHangingServer('partial-body');
    const client = createUdsClient(fixedSocket(server.socketPath), { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
    cleanups.push(() => client.destroy());
    const response = await client.request({ method: 'GET', path: '/stream' });
    expect(response.status).toBe(200);
    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(Buffer.from(first.value ?? new Uint8Array()).toString('utf8')).toBe('first');
    const rest = iterator.next().then(
      () => 'resolved',
      () => 'rejected',
    );

    await client.destroy();

    expect(await rest).toBe('rejected');
  });

  it('rejects requests made after destroy without connecting', async () => {
    const server = await startHangingServer('no-headers');
    const client = createUdsClient(fixedSocket(server.socketPath), { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
    await client.destroy();

    await expect(client.request({ method: 'GET', path: '/late' })).rejects.toThrow();
    expect(server.requestsSeen()).toBe(0);
  });

  it('is idempotent and safe after close', async () => {
    const server = await startHangingServer('no-headers');
    const client = createUdsClient(fixedSocket(server.socketPath));
    await client.close();
    await expect(client.destroy()).resolves.toBeUndefined();
    await expect(client.destroy()).resolves.toBeUndefined();
  });
});
