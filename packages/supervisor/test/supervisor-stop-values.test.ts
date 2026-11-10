import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatStopMessage } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, waitFor, withTempDir } from '@momonga/testkit';
import { startControlServer } from '../src/control-server.ts';
import { writeSettings } from './support/p2-manager-harness.ts';
import { startSupervisorHarness } from './support/p2-supervisor-harness.ts';
import type { SupervisorHarness } from './support/p2-supervisor-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIRST: StopValues = { closeGraceMs: 1000, managedServerStopGraceMs: 200 };
const FIRST_DAEMON_STOP_BOUND_MS = 30_000 + 1000 + 10 * 200 + 4 * 25 + 48_000 + 3000;
const LATER: StopValues = { closeGraceMs: 250_000, managedServerStopGraceMs: 50_000 };
const POSTED: StopValues = { closeGraceMs: 0, managedServerStopGraceMs: 10 };
const POSTED_DAEMON_STOP_BOUND_MS = 30_000 + 0 + 10 * 10 + 4 * 25 + 48_000 + 3000;

const gatewayLifeline = (harness: SupervisorHarness): { lines: string[]; boundsAtSignal: unknown[] } => {
  const child = harness.port.children.find((candidate) => candidate.args.some((arg) => arg.includes('gateway')));
  if (child === undefined) throw new Error('no gateway child was spawned');
  const lines: string[] = [];
  const boundsAtSignal: unknown[] = [];
  harness.port.onSignal = (signalled, signal) => {
    if (signal === 'SIGTERM' && signalled === child) {
      lines.push('SIGTERM');
      boundsAtSignal.push(harness.supervisor.health().stopBoundMs);
    }
    queueMicrotask(() => signalled.exit(null, signal === 'group' ? 'SIGKILL' : signal));
  };
  child.lifeline.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  return { lines, boundsAtSignal };
};

const spawnedBoth = (harness: SupervisorHarness) => waitFor(() => harness.port.children.length >= 2, { description: 'both children to spawn' });

describe('the supervisor reads the stop values once, when its stop begins', () => {
  it('a close it begins itself sends the values read at its begin to the gateway, and reports their bound in its health', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: { gateway: FIRST } });
    await spawnedBoth(harness);
    const { lines, boundsAtSignal } = gatewayLifeline(harness);
    void harness.supervisor.close();
    writeSettings(harness.home, { gateway: LATER });
    await waitFor(() => lines.includes('SIGTERM'), { description: 'the gateway to be signalled' });
    expect(lines).toEqual([formatStopMessage(FIRST), 'SIGTERM']);
    expect(boundsAtSignal).toEqual([FIRST_DAEMON_STOP_BOUND_MS]);
  });

  it('a close requested with values uses them, not the file', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: { gateway: FIRST } });
    await spawnedBoth(harness);
    const { lines, boundsAtSignal } = gatewayLifeline(harness);
    void harness.supervisor.close(POSTED);
    await waitFor(() => lines.includes('SIGTERM'), { description: 'the gateway to be signalled' });
    expect(lines).toEqual([formatStopMessage(POSTED), 'SIGTERM']);
    expect(boundsAtSignal).toEqual([POSTED_DAEMON_STOP_BOUND_MS]);
  });

});

describe('POST /v1/shutdown carries the requester values', () => {
  it('hands the posted values to the shutdown callback', async (context) => {
    const dir = withTempDir(context);
    const socketPath = path.join(dir, 's.sock');
    const requested: unknown[] = [];
    const server = await startControlServer({
      socketPath,
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      health: () => {
        throw new Error('health is not read here');
      },
      credential: () => ({ kind: 'refused' }),
      onShutdownRequested: (values?: StopValues) => requested.push(values),
      onError: () => undefined,
    });
    context.onTestFinished(() => server.close());
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ socketPath, method: 'POST', path: '/v1/shutdown', headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end(JSON.stringify(POSTED));
    });
    expect(status).toBe(202);
    expect(requested).toEqual([POSTED]);
  });
});
