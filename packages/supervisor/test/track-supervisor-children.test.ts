import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { registerCleanup, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { trackSupervisorChildren } from './support/track-supervisor-children.ts';

const healthNaming = (pid: number): SupervisorHealth => ({
  status: 'ok',
  version: '9.9.9-test',
  apiVersion: 1,
  pid: process.pid,
  startedAt: '2026-01-01T00:00:00.000Z',
  phase: 'running',
  env: 'frozen at supervisor start',
  children: [
    { role: 'gateway', state: 'ready', pid, restarts: 0, consecutiveFailures: 0 },
    { role: 'runtime', state: 'backoff', restarts: 1, consecutiveFailures: 1 },
  ],
  logs: { droppedLines: 0 },
});

const serveSupervisorSocket = async (context: CleanupContext, handler: http.RequestListener): Promise<string> => {
  const socketPath = path.join(withTempDir(context), 'supervisor.sock');
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socketPath;
};

const capturedCleanups = (): { context: CleanupContext; run(): Promise<void> } => {
  const cleanups: (() => unknown)[] = [];
  const context = { onTestFinished: (cleanup: () => unknown) => void cleanups.push(cleanup) } as unknown as CleanupContext;
  return {
    context,
    run: async () => {
      for (const cleanup of cleanups) await cleanup();
    },
  };
};

describe('trackSupervisorChildren', () => {
  it('kills the recorded pids even when the health fetch fails, then rethrows', async (context) => {
    const socketPath = await serveSupervisorSocket(context, (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const recorded = spawnTracked(context, '/bin/sleep', ['30'], { stdio: 'ignore' });
    const tracking = capturedCleanups();
    const tracker = trackSupervisorChildren(tracking.context, socketPath);
    tracker.record(healthNaming(recorded.pid));
    await expect(tracking.run()).rejects.toThrow('500');
    expect(isProcessAlive(recorded.pid)).toBe(false);
  });

  it('a supervisor socket that never answers fails the cleanup within a few seconds and still kills the recorded pids', { timeout: 15_000 }, async (context) => {
    const socketPath = await serveSupervisorSocket(context, () => undefined);
    const recorded = spawnTracked(context, '/bin/sleep', ['30'], { stdio: 'ignore' });
    const tracking = capturedCleanups();
    const tracker = trackSupervisorChildren(tracking.context, socketPath);
    tracker.record(healthNaming(recorded.pid));
    const startedAt = Date.now();
    await expect(tracking.run()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(isProcessAlive(recorded.pid)).toBe(false);
  });

  it('kills the union of the recorded and fetched pids', async (context) => {
    const recorded = spawnTracked(context, '/bin/sleep', ['30'], { stdio: 'ignore' });
    const fetched = spawnTracked(context, '/bin/sleep', ['30'], { stdio: 'ignore' });
    const socketPath = await serveSupervisorSocket(context, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(healthNaming(fetched.pid)));
    });
    const tracking = capturedCleanups();
    const tracker = trackSupervisorChildren(tracking.context, socketPath);
    tracker.record(healthNaming(recorded.pid));
    await tracking.run();
    expect(isProcessAlive(recorded.pid)).toBe(false);
    expect(isProcessAlive(fetched.pid)).toBe(false);
  });
});
