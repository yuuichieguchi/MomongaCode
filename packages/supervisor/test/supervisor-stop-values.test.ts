import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, formatStopMessage, generationLayout, readStopRecord } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, waitFor, withTempDir, testKernelLock } from '@momonga/testkit';
import { startControlServer } from '../src/control-server.ts';
import { writeSettings } from './support/p2-manager-harness.ts';
import { startSupervisorHarness } from './support/p2-supervisor-harness.ts';
import type { SupervisorHarness } from './support/p2-supervisor-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIRST: StopValues = { closeGraceMs: 1000, managedServerStopGraceMs: 200, drainTimeoutMs: 7000, mcpCloseGraceMs: 40 };
const FIRST_DAEMON_STOP_BOUND_MS = 7000 + 1000 + 7 * 200 + 6 * 40 + 79_275;
const LATER: StopValues = { closeGraceMs: 250_000, managedServerStopGraceMs: 50_000, drainTimeoutMs: 250_000, mcpCloseGraceMs: 25_000 };
const POSTED: StopValues = { closeGraceMs: 0, managedServerStopGraceMs: 10, drainTimeoutMs: 20, mcpCloseGraceMs: 30 };
const POSTED_DAEMON_STOP_BOUND_MS = 20 + 0 + 7 * 10 + 6 * 30 + 79_275;

const settingsOf = (values: StopValues): Record<string, unknown> => ({
  gateway: { closeGraceMs: values.closeGraceMs, managedServerStopGraceMs: values.managedServerStopGraceMs },
  runtime: { drainTimeoutMs: values.drainTimeoutMs },
  mcp: { closeGraceMs: values.mcpCloseGraceMs },
});

type RecordedStop = { generation: number; values: StopValues };
type Observed = { lines: string[]; boundsAtSignal: unknown[]; recordAtFirstLine: Array<RecordedStop | undefined> };

const observeChildren = (harness: SupervisorHarness): Record<'gateway' | 'runtime', Observed> => {
  const recordPath = generationLayout(harness.home, FIRST_GENERATION).stopRecord;
  const observe = (role: 'gateway' | 'runtime'): Observed => {
    const child = harness.port.children.find((candidate) => candidate.args.some((arg) => arg.includes(role)));
    if (child === undefined) throw new Error(`no ${role} child was spawned`);
    const observed: Observed = { lines: [], boundsAtSignal: [], recordAtFirstLine: [] };
    child.lifeline.on('data', (chunk: Buffer) => {
      if (observed.lines.length === 0) observed.recordAtFirstLine.push(fs.existsSync(recordPath) ? (JSON.parse(fs.readFileSync(recordPath, 'utf8')) as RecordedStop) : undefined);
      observed.lines.push(chunk.toString('utf8'));
    });
    return observed;
  };
  const gateway = observe('gateway');
  const runtime = observe('runtime');
  harness.port.onSignal = (signalled, signal) => {
    for (const [role, observed] of [['gateway', gateway], ['runtime', runtime]] as const) {
      const child = harness.port.children.find((candidate) => candidate.args.some((arg) => arg.includes(role)));
      if (signal === 'SIGTERM' && signalled === child) {
        observed.lines.push('SIGTERM');
        observed.boundsAtSignal.push(harness.supervisor.health().stopBoundMs);
      }
    }
    queueMicrotask(() => signalled.exit(null, signal === 'group' ? 'SIGKILL' : signal));
  };
  return { gateway, runtime };
};

const spawnedBoth = (harness: SupervisorHarness) => waitFor(() => harness.port.children.length >= 2, { description: 'both children to spawn' });

describe('the supervisor reads the four stop values once, when its stop begins', () => {
  it('a close it begins itself sends the values read at its begin to the gateway and to the runtime, and reports their bound in its health', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: settingsOf(FIRST) });
    await spawnedBoth(harness);
    const observed = observeChildren(harness);
    void harness.supervisor.close();
    writeSettings(harness.home, settingsOf(LATER));
    await waitFor(() => observed.gateway.lines.includes('SIGTERM') && observed.runtime.lines.includes('SIGTERM'), { description: 'both children to be signalled' });
    expect(observed.gateway.lines).toEqual([formatStopMessage(FIRST), 'SIGTERM']);
    expect(observed.runtime.lines).toEqual([formatStopMessage(FIRST), 'SIGTERM']);
    expect([...observed.gateway.boundsAtSignal, ...observed.runtime.boundsAtSignal]).toEqual([FIRST_DAEMON_STOP_BOUND_MS, FIRST_DAEMON_STOP_BOUND_MS]);
  });

  it('a close requested with values uses them, not the file, for both children', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: { gateway: { closeGraceMs: FIRST.closeGraceMs, managedServerStopGraceMs: FIRST.managedServerStopGraceMs } } });
    await spawnedBoth(harness);
    const observed = observeChildren(harness);
    void harness.supervisor.close(POSTED);
    await waitFor(() => observed.gateway.lines.includes('SIGTERM') && observed.runtime.lines.includes('SIGTERM'), { description: 'both children to be signalled' });
    expect(observed.gateway.lines).toEqual([formatStopMessage(POSTED), 'SIGTERM']);
    expect(observed.runtime.lines).toEqual([formatStopMessage(POSTED), 'SIGTERM']);
    expect(observed.gateway.boundsAtSignal).toEqual([POSTED_DAEMON_STOP_BOUND_MS]);
  });

  it('writes the values of its stop to the stop record in run/g<N>/ before the first stop line to any child', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: { gateway: { closeGraceMs: FIRST.closeGraceMs, managedServerStopGraceMs: FIRST.managedServerStopGraceMs } } });
    await spawnedBoth(harness);
    const observed = observeChildren(harness);
    void harness.supervisor.close(POSTED);
    await waitFor(() => observed.gateway.lines.includes('SIGTERM') && observed.runtime.lines.includes('SIGTERM'), { description: 'both children to be signalled' });
    expect(observed.gateway.recordAtFirstLine).toEqual([{ generation: FIRST_GENERATION, values: POSTED }]);
    expect(observed.runtime.recordAtFirstLine).toEqual([{ generation: FIRST_GENERATION, values: POSTED }]);
    expect(await readStopRecord(generationLayout(harness.home, FIRST_GENERATION).stopRecord)).toEqual(POSTED);
  });
});

describe('POST /v1/shutdown carries the four requester values', () => {
  it('hands the posted values to the shutdown callback', async (context) => {
    const dir = withTempDir(context);
    const socketPath = path.join(dir, 's.sock');
    const requested: unknown[] = [];
    const server = await startControlServer({
      mechanism: testKernelLock(),
      socketPath,
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      health: () => {
        throw new Error('health is not read here');
      },
      credential: async () => ({ kind: 'refused' }),
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
