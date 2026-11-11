import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { readPlanRelay } from '../src/eval/context-host.ts';

describe('every read of the plan relay takes the signal of its operation (gateway-accounts C38, P-111)', () => {
  it('the signal is a required AbortSignal', () => {
    expectTypeOf(readPlanRelay).parameter(1).toEqualTypeOf<AbortSignal>();
  });

  it('a read whose signal is aborted rejects with the reason of the signal', async (context) => {
    const socketPath = path.join(withTempDir(context), 'g.sock');
    const server = http.createServer((request) => {
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    registerCleanup(context, async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const stop = new AbortController();
    const reason = new Error('the operation ended');
    const read = readPlanRelay(socketPath, stop.signal);
    stop.abort(reason);
    await expect(read).rejects.toBe(reason);
  });
});
