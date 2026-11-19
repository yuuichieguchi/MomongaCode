import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ABORT_SETTLE_LIMIT_MS, createUdsClient, fixedSocket, listenUnix } from '@momonga/foundation';
import { createTempDir, realProcessTestSignal, testKernelLock, waitFor } from '@momonga/testkit';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const endlessStreamServer = async (): Promise<{ socketPath: string; closedConnections: () => number }> => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 's.sock');
  let closed = 0;
  const server = http.createServer((request, response) => {
    request.socket.once('close', () => {
      closed += 1;
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('first');
  });
  await listenUnix(server, socketPath, { mechanism: testKernelLock() }, realProcessTestSignal());
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { socketPath, closedConnections: () => closed };
};

const manualTiming = () => {
  let now = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  return {
    setTimeout: (callback: () => void, ms: number): unknown => {
      next += 1;
      pending.set(next, { at: now + ms, callback });
      return next;
    },
    clearTimeout: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    scheduled: (): number[] => [...pending.values()].map((entry) => entry.at - now),
    advance: (ms: number): void => {
      now += ms;
      for (const [handle, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(handle);
        entry.callback();
      }
    },
  };
};

describe('UdsClient.close is bounded', () => {
  it('lets an open response run until the settle limit, then destroys it and completes', async () => {
    const server = await endlessStreamServer();
    const timing = manualTiming();
    const client = createUdsClient(fixedSocket(server.socketPath), { connectTimeoutMs: 0, timing });
    cleanups.push(() => client.destroy());
    const response = await client.request({ method: 'GET', path: '/events' });
    const iterator = response.body[Symbol.asyncIterator]();
    await iterator.next();
    const rest = iterator.next().then(
      () => 'resolved',
      () => 'rejected',
    );
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await waitFor(() => timing.scheduled().includes(ABORT_SETTLE_LIMIT_MS), { description: 'the close bound to be scheduled' });
    expect(closed).toBe(false);
    timing.advance(ABORT_SETTLE_LIMIT_MS - 1);
    expect(closed).toBe(false);
    timing.advance(1);
    await closing;
    expect(await rest).toBe('rejected');
    await waitFor(() => server.closedConnections() === 1, { description: 'the connection to close' });
  });
});
