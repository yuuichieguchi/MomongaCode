import fs from 'node:fs';
import path from 'node:path';
import { STARTUP_TIMEOUT_MS, acquireProcessLock, momongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { registerCleanup, withTempDir, firstGeneration, testKernelLock } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { STOP_WAIT_WHEN_UNKNOWN_MS, ensureDaemon, stopDaemon, stopWaitBoundMs } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import { PollTimeout } from '../src/poll.ts';
import type { CliClock, SelfExecutable } from '../src/ports.ts';
import { recordingSpawn, startFakeSupervisor } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const oversleepingClock = (after: Promise<unknown> = Promise.resolve()): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async () => {
      await after;
      now = Number.MAX_SAFE_INTEGER;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
};

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  const { ensureMomongaDirs } = await import('@momonga/foundation');
  await ensureMomongaDirs(paths);
  const writeUserSettings = (value: unknown): void => {
    const file = path.join(home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths'>, holdsLock = true) => {
    const supervisor = await startFakeSupervisor({ paths, holdsKernelLock: false, ...options });
    registerCleanup(context, () => supervisor.stop());
    if (holdsLock) {
      const lock = await acquireProcessLock(firstGeneration(paths).locks.supervisor, undefined, { mechanism: testKernelLock() });
      registerCleanup(context, () => lock.release());
    }
    return supervisor;
  };
  const ports: DaemonPorts = { version: VERSION, env: { PATH: '/usr/bin' }, home, clock: oversleepingClock(), self: SELF, spawnDetached: recordingSpawn(() => undefined).spawn };
  return { paths, ports, start, writeUserSettings };
};

const timeoutOf = async (pending: Promise<unknown>): Promise<PollTimeout> => {
  const error = await pending.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof PollTimeout)) throw new Error(`expected a PollTimeout, got ${String(error)}`);
  return error;
};

describe('daemon stop carries the values it read', () => {
  it('posts the values read when the command runs and waits the daemon stop bound of those values, unchanged by a later edit', async (context) => {
    const { paths, ports, start, writeUserSettings } = await setup(context);
    writeUserSettings({ gateway: { closeGraceMs: 2000, managedServerStopGraceMs: 500 }, runtime: { drainTimeoutMs: 7000 }, mcp: { closeGraceMs: 40 } });
    const supervisor = await start({ version: VERSION, keepsLock: true });
    const edited = (async () => {
      while (supervisor.shutdownBodies.length === 0) await new Promise((resolve) => setImmediate(resolve));
      writeUserSettings({ gateway: { closeGraceMs: 0, managedServerStopGraceMs: 0 }, runtime: { drainTimeoutMs: 0 }, mcp: { closeGraceMs: 0 } });
    })();
    const stopping = stopDaemon({ ...ports, clock: oversleepingClock(edited) }, paths);
    const timeout = await timeoutOf(stopping);
    await edited;
    expect(supervisor.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 2000, managedServerStopGraceMs: 500, drainTimeoutMs: 7000, mcpCloseGraceMs: 40 }]);
    expect(timeout.boundMs).toBe(7000 + 2000 + 7 * 500 + 6 * 40 + 79_275);
  });

  it('posts the defaults when the user settings set nothing', async (context) => {
    const { paths, ports, start } = await setup(context);
    const supervisor = await start({ version: VERSION, keepsLock: true });
    const timeout = await timeoutOf(stopDaemon(ports, paths));
    expect(supervisor.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 30_000, mcpCloseGraceMs: 1000 }]);
    expect(timeout.boundMs).toBe(146_275);
  });

  it('waits on a stop it did not begin for the bound the draining supervisor reports', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining', stopBoundMs: 123_456 });
    const timeout = await timeoutOf(stopDaemon(ports, paths));
    expect(timeout.boundMs).toBe(123_456);
  });

  it('ensureDaemon never waits the stop bound of a draining daemon: its only wait is the ready bound of the start (15.4, 20.16)', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining', stopBoundMs: 98_765 });
    const timeout = await timeoutOf(ensureDaemon(ports, paths));
    expect(timeout.boundMs).toBe(STARTUP_TIMEOUT_MS);
    expect(timeout.description).toBe('the daemon to become ready');
  });

  it('waits the bound at the allowed maxima when the draining supervisor reports none', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining' });
    const timeout = await timeoutOf(stopDaemon(ports, paths));
    expect(STOP_WAIT_WHEN_UNKNOWN_MS).toBe(1_279_275);
    expect(timeout.boundMs).toBe(1_279_275);
  });
});

const healthReporting = (stopBoundMs: number | undefined): SupervisorHealth => ({
  status: 'ok',
  version: VERSION,
  apiVersion: 1,
  pid: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  phase: 'draining',
  env: 'frozen at supervisor start',
  children: [],
  logs: { droppedLines: 0 },
  ...(stopBoundMs === undefined ? {} : { stopBoundMs }),
});

describe('the wait over several generations', () => {
  it('is the largest bound the generations report', () => {
    expect(stopWaitBoundMs([healthReporting(90_000), healthReporting(200_000), healthReporting(81_000)])).toBe(200_000);
  });

  it('counts a generation that reports no bound at the allowed maxima', () => {
    expect(stopWaitBoundMs([healthReporting(90_000), healthReporting(undefined)])).toBe(1_279_275);
  });
});
