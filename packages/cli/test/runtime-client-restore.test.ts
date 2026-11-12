import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import type { TuiBackend } from '../src/tui/backend.ts';
import { SESSION } from './fake-backend.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

const serving = async (context: TestContext, socketPath: string, seen: string[]): Promise<void> => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session: SESSION }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
};

const clientWith = (context: TestContext, socketPath: string, restore: () => Promise<void>) => {
  const client = createRuntimeClient({
    personCapability: async () => FAKE_PERSON_CAPABILITY,
    resolveSocket: async () => socketPath,
    clock: { now: () => Date.now(), sleep: async () => undefined },
    restoreConnection: restore,
  });
  registerCleanup(context, () => client.close());
  return client;
};

describe('a call that finds no daemon restores it once and is sent again (cli-tui-C37)', () => {
  it('restores the daemon once and the call, a change of the session, succeeds', async (context) => {
    const socketPath = path.join(withTempDir(context), 'runtime.sock');
    const seen: string[] = [];
    let restores = 0;
    const client = clientWith(context, socketPath, async () => {
      restores += 1;
      await serving(context, socketPath, seen);
    });
    expect((await client.setPermissionMode(SESSION.id, 'manual')).id).toBe(SESSION.id);
    expect(restores).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('fails with the connection error when the restored daemon does not answer either, after one restore', async (context) => {
    const socketPath = path.join(withTempDir(context), 'runtime.sock');
    let restores = 0;
    const client = clientWith(context, socketPath, async () => {
      restores += 1;
    });
    await expect(client.setPermissionMode(SESSION.id, 'manual')).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/) });
    expect(restores).toBe(1);
  });

  it('startRun has no fresh history path', () => {
    expectTypeOf<Parameters<TuiBackend['startRun']>>().toEqualTypeOf<[text: string, options?: Parameters<TuiBackend['startRun']>[1]]>();
    expectTypeOf<Parameters<TuiBackend['startRun']>[1]>().not.toEqualTypeOf<'inherit' | 'fresh'>();
  });
});
