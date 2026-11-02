import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listenUnix } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { shutdownIfIdle } from '../src/idle-shutdown.ts';

const startRuntime = async (context: CleanupContext, handler: http.RequestListener): Promise<string> => {
  const directory = path.join(withTempDir(context), 'run');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'runtime.sock');
  const server = http.createServer(handler);
  await listenUnix(server, socketPath);
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socketPath;
};

describe('shutdownIfIdle', () => {
  it('accepts when the runtime answers 202 to the drain request', async (context) => {
    const runtimeSocketPath = await startRuntime(context, (_request, response) => {
      response.writeHead(202).end('{"state":"draining"}');
    });
    await expect(shutdownIfIdle({ runtime: { state: 'ready' }, runtimeSocketPath })).resolves.toEqual({ kind: 'accepted' });
  });

  it('reports busy with the runtime reason when the runtime answers 409', async (context) => {
    const runtimeSocketPath = await startRuntime(context, (_request, response) => {
      response.writeHead(409).end('a run is active');
    });
    await expect(shutdownIfIdle({ runtime: { state: 'ready' }, runtimeSocketPath })).resolves.toEqual({
      kind: 'busy',
      reason: 'the runtime has an active run: a run is active',
    });
  });

  it('fails with a headers timeout when the runtime never answers the drain request', async (context) => {
    const runtimeSocketPath = await startRuntime(context, () => undefined);
    await expect(shutdownIfIdle({ runtime: { state: 'ready' }, runtimeSocketPath, requestTimeoutMs: 50 })).rejects.toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
  });
});
