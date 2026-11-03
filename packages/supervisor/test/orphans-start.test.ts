import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProbeFailedError, createUninspectableRegistry, probeFailed, runtimeMaxCloseMs, supervisorMaxCloseMs } from '@momonga/foundation';
import type { ReapMarkerDirectoryOptions } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, createFakeClock, createFakeTimers, fakeReapTiming, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { ORPHAN_REAP_GRACE_MS, SHUTDOWN_RELEASE_BOUND_MS } from '../src/constants.ts';
import { reapOrphans } from '../src/orphans.ts';
import type { MarkerPorts, OrphanReapOptions, OrphanReapResult } from '../src/orphans.ts';
import { captureLog, createRealWorkScope, httpOver, pumpUntil, settledFlag, startHarness, writeMarker } from './fixtures/p3-harness.ts';

const HOLDER_PID = 999_999;

const liveHolder = (): { findHolders: NonNullable<MarkerPorts['findHolders']>; exit(): void } => {
  let alive = true;
  return {
    findHolders: async () => (alive ? [HOLDER_PID] : []),
    exit: () => {
      alive = false;
    },
  };
};

const markersDir = (context: CleanupContext): string => {
  const dir = path.join(withTempDir(context), 'daemons');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const reapSetup = (dir: string, overrides: Partial<OrphanReapOptions> = {}) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = captureLog(clock);
  const controller = new AbortController();
  const realWork = createRealWorkScope();
  const options: OrphanReapOptions = {
    markersDir: dir,
    orphanGraceMs: 10_000,
    orphanReapGraceMs: 200,
    orphanPollMs: 250,
    timers,
    signal: controller.signal,
    logger: log.logger,
    reapTiming: fakeReapTiming(clock, timers),
    ...overrides,
  };
  const reap = (): ReturnType<typeof settledFlag<OrphanReapResult>> => settledFlag(realWork.run(() => reapOrphans(options)));
  const until = (done: () => boolean, maxMs: number): Promise<void> => pumpUntil(timers, done, { realWork, maxMs, description: 'orphan reap' });
  return { clock, timers, log, controller, options, reap, until };
};

const recorded = (overrides: MarkerPorts = {}) => {
  const calls = { findHolders: 0, reap: [] as Array<{ options: ReapMarkerDirectoryOptions; abortedAtCall: boolean }> };
  const ports: MarkerPorts = {
    findHolders: async (marker) => {
      calls.findHolders += 1;
      return overrides.findHolders === undefined ? [] : overrides.findHolders(marker);
    },
    reapMarkerDirectory: async (options) => {
      calls.reap.push({ options, abortedAtCall: options.signal?.aborted ?? false });
      return overrides.reapMarkerDirectory === undefined ? { reaped: 0, kept: 0 } : overrides.reapMarkerDirectory(options);
    },
  };
  return { calls, ports };
};

describe('reapOrphans', () => {
  it('returns at once when there are no markers', async (context) => {
    const dir = markersDir(context);
    const { calls, ports } = recorded();
    const { options, log } = reapSetup(dir, { markerPorts: ports });
    await expect(reapOrphans(options)).resolves.toEqual({ reaped: 0, kept: 0, aborted: false });
    expect(calls.findHolders).toBe(0);
    expect(log.withMsg('orphans.waiting')).toEqual([expect.objectContaining({ markers: 0, holders: 0 })]);
  });

  it('markers without holders go straight to the reap', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-01'), '', { mode: 0o600 });
    const { calls, ports } = recorded({ reapMarkerDirectory: async () => ({ reaped: 1, kept: 0 }) });
    const { options, log } = reapSetup(dir, { markerPorts: ports });
    await expect(reapOrphans(options)).resolves.toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(calls.findHolders).toBe(1);
    expect(calls.reap).toHaveLength(1);
    expect(log.withMsg('orphans.waiting')).toEqual([expect.objectContaining({ markers: 1, holders: 0 })]);
  });

  it('names a process that cannot be inspected as a warning, once for each marker it may hold', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-03'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'runtime-04'), '', { mode: 0o600 });
    const ports: MarkerPorts = {
      findHolders: async (_marker, _inspector, onUninspectable) => {
        onUninspectable?.({ pid: 31_339, command: 'ssh-agent', startTicks: '616161' });
        return [];
      },
      reapMarkerDirectory: async () => ({ reaped: 2, kept: 0 }),
    };
    const { options, log } = reapSetup(dir, { markerPorts: ports, uninspectable: createUninspectableRegistry({ isAlive: () => true }) });
    await reapOrphans(options);
    expect(log.withMsg('orphans.warning')).toEqual([
      expect.objectContaining({ detail: `marker ${path.join(dir, 'runtime-03')}: process 31339 (ssh-agent) could not be inspected, so it was left alone` }),
      expect.objectContaining({ detail: `marker ${path.join(dir, 'runtime-04')}: process 31339 (ssh-agent) could not be inspected, so it was left alone` }),
    ]);
  });

  it('phase 1 waits for a holder that exits on its own and then reaps without a signal request', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-02'), '', { mode: 0o600 });
    const holder = liveHolder();
    const { calls, ports } = recorded({ findHolders: holder.findHolders, reapMarkerDirectory: async () => ({ reaped: 1, kept: 0 }) });
    const { options, clock, reap, until } = reapSetup(dir, { markerPorts: ports });
    const result = reap();
    await until(() => clock.now() >= 3000, 3000);
    expect(result.settled()).toBe(false);
    expect(calls.reap).toEqual([]);
    holder.exit();
    await until(() => result.settled(), options.orphanGraceMs);
    expect(clock.now()).toBeLessThan(options.orphanGraceMs);
    expect(calls.reap).toHaveLength(1);
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
  });

  it('orphanGraceMs shortens phase 1 and the reap starts at its end', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-03'), '', { mode: 0o600 });
    const holder = liveHolder();
    let reapAt: number | undefined;
    let setup: ReturnType<typeof reapSetup> | undefined;
    const { ports } = recorded({
      findHolders: holder.findHolders,
      reapMarkerDirectory: async () => {
        reapAt = setup?.clock.now();
        return { reaped: 1, kept: 0 };
      },
    });
    setup = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 1000 });
    const { log, reap, until } = setup;
    const result = reap();
    await until(() => result.settled(), 5000);
    expect(reapAt ?? 0).toBeGreaterThanOrEqual(1000);
    expect(reapAt ?? 0).toBeLessThan(1000 + 250 + 100);
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(log.withMsg('orphans.waiting')).toEqual([expect.objectContaining({ markers: 1, holders: 1 })]);
    expect(log.withMsg('orphans.reaping')).toEqual([expect.objectContaining({ holders: 1 })]);
  });

  it('phase 1 is bounded by runtimeMaxCloseMs + 2000 even with a larger orphanGraceMs', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-04'), '');
    const { calls, ports } = recorded({ findHolders: async () => [999_999] });
    const bound = runtimeMaxCloseMs(30_000) + 2000;
    const { clock, reap, until } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 10 * bound });
    const result = reap();
    await until(() => calls.reap.length > 0, 250000);
    expect(clock.now()).toBeGreaterThanOrEqual(bound);
    expect(clock.now()).toBeLessThanOrEqual(bound + 250);
    await waitFor(() => result.settled());
  });

  it('the reap receives the supervisor signal, timing and grace', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'gateway-05'), '');
    const { calls, ports } = recorded({ findHolders: async () => [999_999] });
    const { options, reap, until, controller, log } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 500 });
    const result = reap();
    await until(() => result.settled(), 100000);
    expect(calls.reap).toHaveLength(1);
    const call = calls.reap[0];
    expect(call?.abortedAtCall).toBe(false);
    expect(call?.options.signal).toBe(controller.signal);
    expect(call?.options.timing).toBe(options.reapTiming);
    expect(call?.options.killGraceMs).toBe(200);
    expect(call?.options.dir).toBe(dir);
    expect(call?.options.label).toBe('daemon');
    expect(log.withMsg('orphans.reaping')).toEqual([expect.objectContaining({ holders: 1 })]);
  });

  it('an abort in phase 1 signals nothing, removes nothing and skips phase 2', async (context) => {
    const dir = markersDir(context);
    const marker = path.join(dir, 'runtime-06');
    fs.writeFileSync(marker, '');
    const { calls, ports } = recorded({ findHolders: async () => [999_999] });
    const { reap, until, controller } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 10_000 });
    const result = reap();
    await until(() => calls.findHolders >= 3, 100000);
    controller.abort();
    const before = calls.findHolders;
    await until(() => result.settled(), 1000);
    expect(result.value()).toMatchObject({ aborted: true });
    expect(calls.findHolders).toBeLessThanOrEqual(before + 1);
    expect(calls.reap).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('an abort during the last findHolders of phase 1 does not call the reap', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-07'), '');
    let controller: AbortController | undefined;
    const { calls, ports } = recorded({
      findHolders: async () => {
        if (calls.findHolders >= 2) controller?.abort();
        return [999_999];
      },
    });
    const setup = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 500 });
    controller = setup.controller;
    const result = setup.reap();
    await setup.until(() => result.settled(), 5000);
    expect(result.value()).toMatchObject({ aborted: true });
    expect(calls.reap).toEqual([]);
  });

  const transientFailure = (): ProbeFailedError => new ProbeFailedError('listing marker holders', probeFailed({ kind: 'errno', code: 'EMFILE', detail: 'too many open files' }));

  it('a deterministic findHolders failure in phase 1 is not read as no holders: it rejects and phase 2 never runs', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-08'), '');
    const failure = new ProbeFailedError('listing marker holders', probeFailed({ kind: 'exit', exitCode: 2, detail: 'lsof exited with 2' }));
    const { calls, ports } = recorded({ findHolders: () => Promise.reject(failure) });
    const { reap, until } = reapSetup(dir, { markerPorts: ports });
    const result = reap();
    await until(() => result.settled(), 2500);
    await expect(result.promise).rejects.toBe(failure);
    expect(calls.reap).toEqual([]);
  });

  it('a transient findHolders failure in phase 1 is retried on the poll until it clears, then phase 2 decides', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-08'), '');
    let attempts = 0;
    const { calls, ports } = recorded({
      findHolders: async () => {
        attempts += 1;
        if (attempts <= 2) throw transientFailure();
        return [];
      },
      reapMarkerDirectory: async () => ({ reaped: 1, kept: 0 }),
    });
    const { reap, until, log } = reapSetup(dir, { markerPorts: ports });
    const result = reap();
    await until(() => result.settled(), 5000);
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(attempts).toBe(3);
    expect(calls.reap).toHaveLength(1);
    expect(log.withMsg('orphans.warning')).toHaveLength(2);
    expect(log.withMsg('orphans.reaping')).toEqual([expect.objectContaining({ holders: 0 })]);
  });

  it('a transient findHolders failure that outlasts the grace rejects', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-08'), '');
    const { calls, ports } = recorded({ findHolders: () => Promise.reject(transientFailure()) });
    const { reap, until } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 1000 });
    const result = reap();
    await until(() => result.settled(), 10_000);
    await expect(result.promise).rejects.toBeInstanceOf(ProbeFailedError);
    expect(calls.reap).toEqual([]);
  });

  it('orphans.reaping is logged right before the phase-2 reap', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-10'), '');
    const reapingAtCall: unknown[][] = [];
    let log: ReturnType<typeof reapSetup>['log'] | undefined;
    const { ports } = recorded({
      reapMarkerDirectory: async () => {
        reapingAtCall.push(log?.withMsg('orphans.reaping').map((line) => line['holders']) ?? []);
        return { reaped: 1, kept: 0 };
      },
    });
    const setup = reapSetup(dir, { markerPorts: ports });
    log = setup.log;
    const result = setup.reap();
    await setup.until(() => result.settled(), 2500);
    expect(reapingAtCall).toEqual([[0]]);
    const messages = setup.log.messages();
    expect(messages.lastIndexOf('orphans.reaping')).toBe(messages.length - 1);
  });

  it('a readdir failure in phase 1 rejects instead of reaping nothing', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-09'), '');
    fs.chmodSync(dir, 0o000);
    const { calls, ports } = recorded();
    const { reap, until } = reapSetup(dir, { markerPorts: ports });
    const result = reap();
    await until(() => result.settled(), 2500);
    fs.chmodSync(dir, 0o700);
    await expect(result.promise).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls.findHolders).toBe(0);
    expect(calls.reap).toEqual([]);
  });

  it('an abort during phase 2 still reports what the reap did', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-10'), '');
    let controller: AbortController | undefined;
    const { calls, ports } = recorded({
      findHolders: async () => [999_999],
      reapMarkerDirectory: async (reapOptions) => {
        controller?.abort();
        expect(reapOptions.signal?.aborted).toBe(true);
        return { reaped: 1, kept: 0 };
      },
    });
    const setup = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 250 });
    controller = setup.controller;
    const result = setup.reap();
    await setup.until(() => result.settled(), 5000);
    expect(calls.reap).toHaveLength(1);
    expect(result.value()).toEqual<OrphanReapResult>({ reaped: 1, kept: 0, aborted: true });
  });
});

describe('orphan reap at supervisor start', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('reap shutdown bound relation', () => {
    expect(ORPHAN_REAP_GRACE_MS + SHUTDOWN_RELEASE_BOUND_MS).toBeLessThan(supervisorMaxCloseMs(0));
    expect(ORPHAN_REAP_GRACE_MS).toBe(17_000);
  });

  it('start reaps daemon markers before the first spawn', async (context) => {
    const holder = liveHolder();
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-0190a0a0-0000-7000-8000-000000000001'),
      markerPorts: {
        findHolders: holder.findHolders,
        reapMarkerDirectory: async () => {
          holder.exit();
          return { reaped: 1, kept: 0 };
        },
      },
      overrides: { orphanGraceMs: 500, orphanReapGraceMs: 200 },
    });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 100_000, description: 'both children spawned after the reap' });
    expect(h.markers.calls.reapMarkerDirectory).toEqual([expect.objectContaining({ dir: h.paths.markers.daemons, killGraceMs: 200 })]);
    const messages = h.log.messages();
    expect(messages.indexOf('orphans.reaped')).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf('orphans.reaped')).toBeLessThan(messages.indexOf('child.spawn'));
  });

  it('the control server listens and ready is announced before the first findHolders', async (context) => {
    let socketPath = '';
    let lockPath = '';
    const seenAtFirstCall: Array<{ lock: boolean; socket: boolean }> = [];
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        socketPath = paths.sockets.supervisor;
        lockPath = paths.locks.supervisor;
        writeMarker(paths, 'runtime-old');
      },
      markerPorts: {
        findHolders: async () => {
          seenAtFirstCall.push({ lock: fs.existsSync(lockPath), socket: fs.existsSync(socketPath) });
          return [999_999];
        },
      },
    });
    await waitFor(() => h.markers.calls.findHolders.length > 0);
    expect(h.order.indexOf('ready')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('ready')).toBeLessThan(h.order.indexOf('findHolders'));
    expect(seenAtFirstCall[0]).toEqual({ lock: true, socket: true });
    const response = await httpOver(context, socketPath, 'GET', '/v1/health');
    expect(JSON.parse(response.text)).toMatchObject({ phase: 'reaping-orphans' });
  });

  it('phase turns running when the reap ends', async (context) => {
    let holding = true;
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => (holding ? [999_999] : []) },
      overrides: { orphanGraceMs: 60_000 },
    });
    await pumpUntil(h.timers, () => h.markers.calls.findHolders.length >= 3, { realWork: h.realWork, maxMs: 5000 });
    expect(h.health().phase).toBe('reaping-orphans');
    expect(h.fake.spawnCount()).toBe(0);
    holding = false;
    let observedTogether = false;
    await pumpUntil(
      h.timers,
      () => {
        const health = h.health();
        if (health.phase === 'running') {
          observedTogether = health.children.every((child) => child.state !== 'pending');
          return true;
        }
        expect(health.children.map((child) => child.state)).toEqual(['pending', 'pending']);
        return false;
      },
      { realWork: h.realWork, maxMs: 5000 },
    );
    expect(observedTogether).toBe(true);
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 5000 });
    const messages = h.log.messages();
    const reapedAt = messages.indexOf('orphans.reaped');
    expect(reapedAt).toBeGreaterThanOrEqual(0);
    messages.forEach((message, index) => {
      if (message === 'child.spawn') expect(index).toBeGreaterThan(reapedAt);
    });
  });

  it('a kept marker does not block the start', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    let holderPid = 0;
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        writeMarker(paths, 'runtime-old');
        const holder = spawnTracked(context, 'sleep', ['30']);
        holderPid = holder.pid;
        lock.holdExternally(paths.locks.runtime, holder.pid);
      },
      markerPorts: { findHolders: async () => [999_999], reapMarkerDirectory: async () => ({ reaped: 0, kept: 1 }) },
      overrides: { orphanGraceMs: 250, lockMechanism: lock, lockWaitMs: 3_600_000 },
    });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 5000 });
    expect(h.log.withMsg('orphans.reaped')).toEqual([expect.objectContaining({ reaped: 0, kept: 1, level: 'warn' })]);
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock', 5000);
    expect(holderPid).toBeGreaterThan(0);
  });

  it('the default orphanReapGraceMs reaches the reap as killGraceMs 17000', async (context) => {
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999] },
      overrides: { orphanGraceMs: 250 },
    });
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 5000 });
    expect(h.markers.calls.reapMarkerDirectory[0]?.killGraceMs).toBe(ORPHAN_REAP_GRACE_MS);
    expect(h.markers.calls.reapMarkerDirectory[0]?.dir).toBe(h.paths.markers.daemons);
  });

  it('orphanGraceMs defaults to runtimeMaxCloseMs(drainTimeoutMs) + 2000', async (context) => {
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999] },
      overrides: { runtime: { drainTimeoutMs: 1000 } },
    });
    const bound = runtimeMaxCloseMs(1000) + 2000;
    await pumpUntil(h.timers, () => h.clock.now() - Date.parse('2026-01-01T00:00:00.000Z') >= bound - 300, { realWork: h.realWork, maxMs: bound });
    expect(h.markers.calls.reapMarkerDirectory).toEqual([]);
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 1000 });
  });
});
