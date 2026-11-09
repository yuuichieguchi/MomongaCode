import fs from 'node:fs';
import path from 'node:path';
import { acquireProcessLock, momongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { registerCleanup, withTempDir, firstGeneration } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { STOP_WAIT_WHEN_UNKNOWN_MS, ensureDaemon, restoreDaemon, stopDaemon, stopWaitBoundMs } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import { PollTimeout } from '../src/poll.ts';
import type { CliClock, SelfExecutable } from '../src/ports.ts';
import { recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  const { ensureMomongaDirs } = await import('@momonga/foundation');
  await ensureMomongaDirs(paths);
  const writeUserSettings = (value: unknown): void => {
    const file = path.join(home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths'>, holdsLock = true) => {
    const supervisor = await startFakeSupervisor({ paths, ...options });
    registerCleanup(context, () => supervisor.stop());
    if (holdsLock) {
      const lock = await acquireProcessLock(firstGeneration(paths).locks.supervisor);
      registerCleanup(context, () => lock.release());
    }
    return supervisor;
  };
  const ports: DaemonPorts = { version: VERSION, env: { PATH: '/usr/bin' }, home, clock: virtualClock(), self: SELF, spawnDetached: recordingSpawn(() => undefined).spawn };
  return { paths, ports, start, writeUserSettings };
};

const oversleepingClock = (): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async () => {
      now = Number.MAX_SAFE_INTEGER;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
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
    writeUserSettings({ gateway: { closeGraceMs: 2000, managedServerStopGraceMs: 500 } });
    const supervisor = await start({ version: VERSION, keepsLock: true });
    const stopping = stopDaemon(ports, paths);
    const edited = (async () => {
      while (supervisor.shutdownBodies.length === 0) await new Promise((resolve) => setImmediate(resolve));
      writeUserSettings({ gateway: { closeGraceMs: 0, managedServerStopGraceMs: 0 } });
    })();
    const timeout = await timeoutOf(stopping);
    await edited;
    expect(supervisor.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 2000, managedServerStopGraceMs: 500 }]);
    expect(timeout.boundMs).toBe(30_000 + 2000 + 10 * 500 + 4 * 25 + 48_000 + 3000);
  });

  it('posts the defaults when the user settings set nothing', async (context) => {
    const { paths, ports, start } = await setup(context);
    const supervisor = await start({ version: VERSION, keepsLock: true });
    const timeout = await timeoutOf(stopDaemon(ports, paths));
    expect(supervisor.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 10_000, managedServerStopGraceMs: 3000 }]);
    expect(timeout.boundMs).toBe(121_100);
  });

  it('waits on a stop it did not begin for the bound the draining supervisor reports', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining', stopBoundMs: 123_456 });
    const timeout = await timeoutOf(stopDaemon(ports, paths));
    expect(timeout.boundMs).toBe(123_456);
  });

  it('the draining branch of ensureDaemon waits the reported bound', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining', stopBoundMs: 98_765 });
    const timeout = await timeoutOf(ensureDaemon(ports, paths));
    expect(timeout.boundMs).toBe(98_765);
  });

  it('waits the bound at the allowed maxima when the draining supervisor reports none', async (context) => {
    const { paths, ports, start } = await setup(context);
    await start({ version: VERSION, phase: 'draining' });
    const timeout = await timeoutOf(stopDaemon({ ...ports, clock: oversleepingClock() }, paths));
    expect(STOP_WAIT_WHEN_UNKNOWN_MS).toBe(981_100);
    expect(timeout.boundMs).toBe(981_100);
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
    expect(stopWaitBoundMs([healthReporting(90_000), healthReporting(undefined)])).toBe(981_100);
  });
});

const writeInvalidUserSettings = (home: string): void => {
  const file = path.join(home, '.momonga', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "gateway": ');
};

const failureOf = async (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (failure: unknown) => failure,
  );

describe('a version-mismatch stop inside ensureDaemon with an invalid settings file (design 1.5)', () => {
  const BOUNDS = { readyMs: 500, stopMs: 500 };

  it('ensureDaemon stops the older daemon with the defaults and reports once through the caller channel, never throwing the notice', async (context) => {
    const { paths, ports, start } = await setup(context);
    writeInvalidUserSettings(ports.home);
    const older = await start({ version: '0.0.1' }, false);
    const notices: string[] = [];
    const failure = await failureOf(ensureDaemon(ports, paths, { bounds: BOUNDS, onNotice: (message) => notices.push(message) }));
    expect(older.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 10_000, managedServerStopGraceMs: 3000 }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('the default values were used');
    expect(failure instanceof PollTimeout ? failure.description : failure).toBe('the daemon to become ready');
  });

  it('restoreDaemon takes the caller channel and reports through it, never throwing the notice', async (context) => {
    const { paths, ports, start } = await setup(context);
    writeInvalidUserSettings(ports.home);
    const older = await start({ version: '0.0.1' }, false);
    const notices: string[] = [];
    const failure = await failureOf(restoreDaemon(ports, paths, (message: string) => notices.push(message))(undefined));
    expect(older.shutdownBodies.map((body) => JSON.parse(body) as unknown)).toEqual([{ closeGraceMs: 10_000, managedServerStopGraceMs: 3000 }]);
    expect(notices).toHaveLength(1);
    expect(String(failure)).not.toContain('the default values were used');
  });
});
