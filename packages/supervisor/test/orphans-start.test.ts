import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findHolders, reapMarkerDirectory, runtimeMaxCloseMs, supervisorMaxCloseMs } from '@momonga/foundation';
import type { ReapMarkerDirectoryOptions } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, fakeReapTiming, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeTimers, TrackedChild } from '@momonga/testkit';
import { ORPHAN_REAP_GRACE_MS, SHUTDOWN_RELEASE_BOUND_MS } from '../src/constants.ts';
import { reapOrphans } from '../src/orphans.ts';
import type { MarkerPorts, OrphanReapOptions, OrphanReapResult } from '../src/orphans.ts';
import { writeLockFile, captureLog, httpOver, pumpUntil, settledFlag, startHarness, writeMarker } from './fixtures/p3-harness.ts';

const HOLDER_FIXTURE = fileURLToPath(new URL('./fixtures/p3-marker-holder.ts', import.meta.url));

type Holder = { child: TrackedChild; stdout(): string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

const startHolder = async (context: CleanupContext, marker: string, options: { trapTerm?: boolean; onLine?: (line: string) => void } = {}): Promise<Holder> => {
  const fd = fs.openSync(marker, 'r');
  let child: TrackedChild;
  try {
    child = spawnTracked(context, process.execPath, [HOLDER_FIXTURE], {
      stdio: ['pipe', 'pipe', 'ignore', fd],
      env: { ...process.env, P3_TRAP_TERM: options.trapTerm === true ? '1' : '0' },
    });
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    text += chunk;
    for (const line of chunk.split('\n')) if (line !== '') options.onLine?.(line);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await waitFor(() => text.includes('ready'), { description: 'holder ready' });
  return { child, stdout: () => text, exited };
};

const markersDir = (context: CleanupContext): string => {
  const dir = path.join(withTempDir(context), 'daemons');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const drive = async (timers: FakeTimers, done: () => boolean, stepMs: number, maxSteps = 400): Promise<void> => {
  for (let step = 0; step < maxSteps && !done(); step += 1) {
    await waitFor(() => done() || timers.pending().length > 0, { description: 'next reap tick' });
    if (done()) return;
    timers.advance(stepMs);
  }
  if (!done()) throw new Error('drive: reap did not finish');
};

const reapSetup = (dir: string, overrides: Partial<OrphanReapOptions> = {}) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = captureLog(clock);
  const controller = new AbortController();
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
  return { clock, timers, log, controller, options };
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

  it('marker without holders is just removed', async (context) => {
    const dir = markersDir(context);
    const marker = path.join(dir, 'runtime-01');
    fs.writeFileSync(marker, '', { mode: 0o600 });
    const { options, log } = reapSetup(dir);
    await expect(reapOrphans(options)).resolves.toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(fs.existsSync(marker)).toBe(false);
    expect(log.withMsg('orphans.waiting')).toEqual([expect.objectContaining({ markers: 1, holders: 0 })]);
  });

  it('phase 1 does not signal a holder that exits on its own', async (context) => {
    const dir = markersDir(context);
    const marker = path.join(dir, 'runtime-02');
    fs.writeFileSync(marker, '', { mode: 0o600 });
    const holder = await startHolder(context, marker);
    const { options, timers, clock } = reapSetup(dir);
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => clock.now() >= 3000, 250);
    expect(result.settled()).toBe(false);
    holder.child.stdin?.end();
    await expect(holder.exited).resolves.toEqual({ code: 0, signal: null });
    await drive(timers, () => result.settled(), 250);
    expect(holder.stdout()).not.toContain('TERM');
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('an orphan that ignores SIGTERM is SIGKILLed after phase 2 grace, and orphanGraceMs shortens phase 1', async (context) => {
    const dir = markersDir(context);
    const marker = path.join(dir, 'runtime-03');
    fs.writeFileSync(marker, '', { mode: 0o600 });
    const { options, timers, clock, log } = reapSetup(dir, { orphanGraceMs: 1000 });
    let termAt: number | undefined;
    const holder = await startHolder(context, marker, {
      trapTerm: true,
      onLine: (line) => {
        if (line === 'TERM') termAt ??= clock.now();
      },
    });
    let killAt: number | undefined;
    void holder.exited.then(() => {
      killAt = clock.now();
    });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => result.settled(), 250);
    await holder.exited;
    await expect(holder.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(termAt).toBeDefined();
    expect(termAt ?? 0).toBeGreaterThanOrEqual(1000);
    expect(termAt ?? 0).toBeLessThan(1000 + 250 + 100);
    expect((killAt ?? 0) - (termAt ?? 0)).toBeGreaterThanOrEqual(150);
    expect((killAt ?? 0) - (termAt ?? 0)).toBeLessThanOrEqual(450);
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(fs.existsSync(marker)).toBe(false);
    expect(log.withMsg('orphans.waiting')).toEqual([expect.objectContaining({ markers: 1, holders: 1 })]);
    expect(log.withMsg('orphans.reaping')).toEqual([expect.objectContaining({ holders: 1 })]);
  });

  it('phase 1 is bounded by runtimeMaxCloseMs + 2000 even with a larger orphanGraceMs', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-04'), '');
    const { calls, ports } = recorded({ findHolders: async () => [999_999] });
    const bound = runtimeMaxCloseMs(30_000) + 2000;
    const { options, timers, clock } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 10 * bound });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => calls.reap.length > 0, 250, 1000);
    expect(clock.now()).toBeGreaterThanOrEqual(bound);
    expect(clock.now()).toBeLessThanOrEqual(bound + 250);
    await waitFor(() => result.settled());
  });

  it('the reap receives the supervisor signal, timing and grace', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'gateway-05'), '');
    const { calls, ports } = recorded({ findHolders: async () => [999_999] });
    const { options, timers, controller, log } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 500 });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => result.settled(), 250);
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
    const { options, timers, controller } = reapSetup(dir, { markerPorts: ports, orphanGraceMs: 10_000 });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => calls.findHolders >= 3, 250);
    controller.abort();
    const before = calls.findHolders;
    await drive(timers, () => result.settled(), 250, 4);
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
    const result = settledFlag(reapOrphans(setup.options));
    await drive(setup.timers, () => result.settled(), 250, 20);
    expect(result.value()).toMatchObject({ aborted: true });
    expect(calls.reap).toEqual([]);
  });

  it('a findHolders failure in phase 1 is a warning and phase 2 decides', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-08'), '');
    const { calls, ports } = recorded({
      findHolders: () => Promise.reject(new Error('lsof: not found')),
      reapMarkerDirectory: async () => ({ reaped: 1, kept: 0 }),
    });
    const { options, timers, log } = reapSetup(dir, { markerPorts: ports });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => result.settled(), 250, 10);
    expect(result.value()).toEqual({ reaped: 1, kept: 0, aborted: false });
    expect(calls.reap).toHaveLength(1);
    expect(log.withMsg('orphans.warning').length).toBeGreaterThanOrEqual(1);
    expect(log.withMsg('orphans.warning')[0]?.level).toBe('warn');
  });

  it.for(['no holders', 'a findHolders failure', 'a readdir failure'] as const)('orphans.reaping is logged right before the phase-2 reap after %s', async (variant, context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-10'), '');
    const reapingAtCall: unknown[][] = [];
    let log: ReturnType<typeof reapSetup>['log'] | undefined;
    const { ports } = recorded({
      ...(variant === 'a findHolders failure' ? { findHolders: () => Promise.reject(new Error('lsof: not found')) } : {}),
      reapMarkerDirectory: async () => {
        reapingAtCall.push(log?.withMsg('orphans.reaping').map((line) => line['holders']) ?? []);
        return { reaped: 1, kept: 0 };
      },
    });
    if (variant === 'a readdir failure') fs.chmodSync(dir, 0o000);
    const setup = reapSetup(dir, { markerPorts: ports });
    log = setup.log;
    const result = settledFlag(reapOrphans(setup.options));
    await drive(setup.timers, () => result.settled(), 250, 10);
    fs.chmodSync(dir, 0o700);
    expect(reapingAtCall).toEqual([[0]]);
    const messages = setup.log.messages();
    expect(messages.lastIndexOf('orphans.reaping')).toBe(messages.length - 1);
  });

  it('a readdir failure in phase 1 is a warning', async (context) => {
    const dir = markersDir(context);
    fs.writeFileSync(path.join(dir, 'runtime-09'), '');
    fs.chmodSync(dir, 0o000);
    const { calls, ports } = recorded();
    const { options, timers, log } = reapSetup(dir, { markerPorts: ports });
    const result = settledFlag(reapOrphans(options));
    await drive(timers, () => result.settled(), 250, 10);
    fs.chmodSync(dir, 0o700);
    expect(result.value()).toMatchObject({ aborted: false });
    expect(calls.findHolders).toBe(0);
    expect(calls.reap).toHaveLength(1);
    expect(log.withMsg('orphans.warning').length).toBeGreaterThanOrEqual(1);
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
    const result = settledFlag(reapOrphans(setup.options));
    await drive(setup.timers, () => result.settled(), 250, 20);
    expect(calls.reap).toHaveLength(1);
    expect(result.value()).toEqual<OrphanReapResult>({ reaped: 1, kept: 0, aborted: true });
  });
});

describe('orphan reap at supervisor start', () => {
  it('reap shutdown bound relation', () => {
    expect(ORPHAN_REAP_GRACE_MS + SHUTDOWN_RELEASE_BOUND_MS).toBeLessThan(supervisorMaxCloseMs(0));
    expect(ORPHAN_REAP_GRACE_MS).toBe(17_000);
  });

  it('start reaps daemon markers before the first spawn', async (context) => {
    let marker = '';
    const holderReady: Array<Promise<Holder>> = [];
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        marker = writeMarker(paths, 'runtime-0190a0a0-0000-7000-8000-000000000001');
        holderReady.push(startHolder(context, marker));
      },
      markerPorts: { findHolders, reapMarkerDirectory },
      overrides: { orphanGraceMs: 500, orphanReapGraceMs: 200 },
    });
    const holder = await holderReady[0];
    await drive(h.timers, () => h.fake.spawnCount() === 2, 250);
    expect(holder?.stdout()).toContain('TERM');
    await expect(holder?.exited).resolves.toEqual({ code: 143, signal: null });
    expect(fs.existsSync(marker)).toBe(false);
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
    await pumpUntil(h.timers, () => h.markers.calls.findHolders.length >= 3, { realWork: h.realWork, stepMs: 250, maxMs: 5000 });
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
      { realWork: h.realWork, stepMs: 250, maxMs: 5000 },
    );
    expect(observedTogether).toBe(true);
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    const messages = h.log.messages();
    const reapedAt = messages.indexOf('orphans.reaped');
    expect(reapedAt).toBeGreaterThanOrEqual(0);
    messages.forEach((message, index) => {
      if (message === 'child.spawn') expect(index).toBeGreaterThan(reapedAt);
    });
  });

  it('a kept marker does not block the start', async (context) => {
    let holderPid = 0;
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        writeMarker(paths, 'runtime-old');
        const holder = spawnTracked(context, 'sleep', ['30']);
        holderPid = holder.pid;
        writeLockFile(paths.locks.runtime, holder.pid);
      },
      markerPorts: { findHolders: async () => [999_999], reapMarkerDirectory: async () => ({ reaped: 0, kept: 1 }) },
      overrides: { orphanGraceMs: 250, startTimeOf: async () => 0, lockWaitMs: 3_600_000 },
    });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, stepMs: 250, maxMs: 5000 });
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
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, stepMs: 250, maxMs: 5000 });
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
    await pumpUntil(h.timers, () => h.clock.now() - Date.parse('2026-01-01T00:00:00.000Z') >= bound - 300, { realWork: h.realWork, stepMs: 250, maxMs: bound });
    expect(h.markers.calls.reapMarkerDirectory).toEqual([]);
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, stepMs: 250, maxMs: 1000 });
  });
});
