import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InspectProcessLockOptions, ProcessLockInspection } from '@momonga/foundation';
import { ProbeFailedError, createKernelLockMechanism, probeFailed } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeKernelLock, createFakeTimers, registerCleanup, startLockHolder, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { PROBE_HEADERS_TIMEOUT_MS, createExternalHealthProbe, holderPidOf, labelHealthResponse, probeExternalHealth, watchLock } from '../src/lock-watch.ts';
import type { ExternalProbe, LockWatchOptions, ProbeOutcome } from '../src/lock-watch.ts';
import type { ChildRole } from '../src/launcher.ts';
import { createRealWorkScope, pump, pumpUntil, quiesce, startHarness } from './fixtures/p3-harness.ts';

describe('labelHealthResponse', () => {
  it('external probe labels', () => {
    expect(labelHealthResponse('runtime', { status: 200, body: JSON.stringify({ status: 'ok', state: 'running' }) })).toBe('healthy');
    expect(labelHealthResponse('gateway', { status: 200, body: JSON.stringify({ ok: false, state: 'running' }) })).toBe('healthy');
    expect(labelHealthResponse('gateway', { status: 200, body: JSON.stringify({ ok: true, state: 'running' }) })).toBe('healthy');
    expect(labelHealthResponse('runtime', { status: 200, body: JSON.stringify({ status: 'ok', state: 'draining' }) })).toBe('unhealthy');
    expect(labelHealthResponse('gateway', { status: 200, body: JSON.stringify({ ok: true, state: 'draining' }) })).toBe('unhealthy');
    expect(labelHealthResponse('runtime', { status: 200, body: JSON.stringify({ status: 'degraded', state: 'running' }) })).toBe('unhealthy');
    expect(labelHealthResponse('runtime', { status: 500, body: JSON.stringify({ status: 'ok', state: 'running' }) })).toBe('unhealthy');
    expect(labelHealthResponse('gateway', { status: 200, body: 'not json' })).toBe('unhealthy');
    expect(labelHealthResponse('runtime', { status: 200, body: JSON.stringify({ state: 'running' }) })).toBe('unhealthy');
  });
});

describe('holderPidOf', () => {
  it('names the pid only for a held lock', () => {
    expect(holderPidOf({ state: 'held', pid: 4321 })).toBe(4321);
    expect(holderPidOf({ state: 'free' })).toBeUndefined();
    expect(holderPidOf({ state: 'unreadable' })).toBeUndefined();
  });
});

const serveOn = async (context: CleanupContext, socketPath: string, handler: http.RequestListener): Promise<string[]> => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return seen;
};

const json = (status: number, body: unknown): http.RequestListener => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

describe('probeExternalHealth', () => {
  it('runtime: GET /v1/health on the runtime socket', async (context) => {
    const dir = withTempDir(context);
    const socket = path.join(dir, 'runtime.sock');
    const seen = await serveOn(context, socket, json(200, { status: 'ok', state: 'running' }));
    await expect(probeExternalHealth('runtime', socket)).resolves.toBe('healthy');
    expect(seen).toEqual(['GET /v1/health']);
  });

  it('gateway: GET /v1/momonga/health, ok does not matter', async (context) => {
    const dir = withTempDir(context);
    const socket = path.join(dir, 'gateway.sock');
    const seen = await serveOn(context, socket, json(200, { ok: false, state: 'running' }));
    await expect(probeExternalHealth('gateway', socket)).resolves.toBe('healthy');
    expect(seen).toEqual(['GET /v1/momonga/health']);
  });

  it('draining and 500 are unhealthy', async (context) => {
    const dir = withTempDir(context);
    const draining = path.join(dir, 'd.sock');
    const failing = path.join(dir, 'f.sock');
    await serveOn(context, draining, json(200, { status: 'ok', state: 'draining' }));
    await serveOn(context, failing, json(500, { error: 'x' }));
    await expect(probeExternalHealth('runtime', draining)).resolves.toBe('unhealthy');
    await expect(probeExternalHealth('runtime', failing)).resolves.toBe('unhealthy');
  });

  it('closed socket is unreachable', async (context) => {
    const dir = withTempDir(context);
    await expect(probeExternalHealth('runtime', path.join(dir, 'nobody.sock'))).resolves.toBe('unreachable');
  });

  it('a holder that never answers is unreachable after the injected timeout', async (context) => {
    const dir = withTempDir(context);
    const socket = path.join(dir, 'silent.sock');
    await serveOn(context, socket, () => undefined);
    await expect(createExternalHealthProbe(20)('gateway', socket)).resolves.toBe('unreachable');
  });

  it('the production probe timeout stays within 2000 ms', () => {
    expect(PROBE_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});

type Scripted = {
  inspections: Array<InspectProcessLockOptions | undefined>;
  next: ProcessLockInspection | (() => Promise<ProcessLockInspection>);
};

const watchHarness = (overrides: Partial<LockWatchOptions> = {}) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const realWork = createRealWorkScope();
  const scripted: Scripted = { inspections: [], next: { state: 'held', pid: 4321 } };
  const events: string[] = [];
  const probes: number[] = [];
  const backgroundErrors: Array<{ error: unknown; source: string }> = [];
  const transients: Array<{ error: unknown; source: string }> = [];
  let probeResult: ProbeOutcome = 'unreachable';
  const options: LockWatchOptions = {
    role: 'runtime',
    lockPath: '/fake/run/runtime.lock',
    socketPath: '/fake/run/runtime.sock',
    lockWaitMs: 10_000,
    lockWatchIntervalMs: 500,
    externalPollMs: 5000,
    timers,
    inspect: async (_lockPath, inspectOptions) => {
      scripted.inspections.push(inspectOptions);
      const next = scripted.next;
      return typeof next === 'function' ? next() : next;
    },
    probe: async () => {
      probes.push(clock.now());
      return probeResult;
    },
    onFree: () => void events.push(`free@${clock.now()}`),
    onExternal: (holderPid) => void events.push(`external:${holderPid}@${clock.now()}`),
    onProbe: (probe: ExternalProbe) => void events.push(`probe:${probe}`),
    onTransient: (error, source) => void transients.push({ error, source }),
    onBackgroundError: (error, source) => void backgroundErrors.push({ error, source }),
    ...overrides,
  };
  const watch = realWork.run(() => watchLock(options));
  return {
    clock,
    timers,
    realWork,
    scripted,
    events,
    probes,
    backgroundErrors,
    transients,
    watch,
    setProbe: (next: ProbeOutcome) => {
      probeResult = next;
    },
  };
};

describe('watchLock', () => {
  it('exit 75 waits on the lock and fires onFree when it frees', async () => {
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    await pump(h.timers, h.realWork, 5 * 60_000);
    expect(h.events.filter((event) => event.startsWith('free'))).toEqual([]);
    expect(h.scripted.inspections.length).toBeGreaterThanOrEqual(599);
    expect(h.scripted.inspections.length).toBeLessThanOrEqual(601);
    const freedAt = h.clock.now();
    h.scripted.next = { state: 'free' };
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('free')), { realWork: h.realWork, maxMs: 1000 });
    expect(h.clock.now() - freedAt).toBeLessThanOrEqual(500);
    const callsAtFree = h.scripted.inspections.length;
    await pump(h.timers, h.realWork, 5000);
    expect(h.scripted.inspections.length).toBe(callsAtFree);
    expect(h.timers.pending()).toEqual([]);
  });

  it('lockWaitMs expiry gives external with the holder pid', async () => {
    const h = watchHarness({ lockWaitMs: 2000 });
    await pump(h.timers, h.realWork, 1950);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([]);
    await pump(h.timers, h.realWork, 600);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([expect.stringMatching(/^external:4321@/)]);
    h.watch.stop();
  });

  it('the first probe starts on entering external, then every EXTERNAL_POLL_MS', async () => {
    const h = watchHarness({ lockWaitMs: 1000 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, maxMs: 5000 });
    const enteredAt = h.clock.now();
    await quiesce(h.realWork);
    expect(h.probes).toEqual([enteredAt]);
    expect(h.events).toContain('probe:unreachable');
    await pumpUntil(h.timers, () => h.clock.now() >= enteredAt + 60_000, { realWork: h.realWork });
    expect(h.probes).toHaveLength(13);
    expect(h.probes.map((at) => at - enteredAt)).toEqual(Array.from({ length: 13 }, (_unused, index) => index * 5000));
    h.watch.stop();
  });

  it('probe results are reported as they change', async () => {
    const h = watchHarness({ lockWaitMs: 500 });
    h.setProbe('healthy');
    await pumpUntil(h.timers, () => h.events.includes('probe:healthy'), { realWork: h.realWork, maxMs: 5000 });
    h.setProbe('unhealthy');
    await pumpUntil(h.timers, () => h.events.includes('probe:unhealthy'), { realWork: h.realWork, maxMs: 10_000 });
    h.watch.stop();
  });

  it('external polls the lock at LOCK_WATCH_INTERVAL_MS', async () => {
    const h = watchHarness({ lockWaitMs: 1000 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, 1200);
    const freedAt = h.clock.now();
    h.scripted.next = { state: 'free' };
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('free')), { realWork: h.realWork, maxMs: 5000 });
    expect(h.clock.now() - freedAt).toBeLessThanOrEqual(500);
    expect(h.timers.pending()).toEqual([]);
  });

  it('unreadable lock counts as held', async () => {
    const h = watchHarness({ lockWaitMs: 2000 });
    h.scripted.next = { state: 'unreadable' };
    await pump(h.timers, h.realWork, 3000);
    expect(h.events.filter((event) => event.startsWith('free'))).toEqual([]);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([expect.stringMatching(/^external:undefined@/)]);
    h.watch.stop();
  });

  it('forwards the lock mechanism to every inspection', async () => {
    const mechanism = createKernelLockMechanism(process.platform);
    const h = watchHarness({ lockWaitMs: 3_600_000, mechanism });
    await pump(h.timers, h.realWork, 10_000);
    expect(h.scripted.inspections.length).toBeGreaterThanOrEqual(19);
    for (const inspection of h.scripted.inspections) expect(inspection?.mechanism).toBe(mechanism);
    h.watch.stop();
  });

  it('a lock poll in flight when the watch stops does not fire onFree', async () => {
    let release: (value: ProcessLockInspection) => void = () => undefined;
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    h.scripted.next = () =>
      new Promise<ProcessLockInspection>((resolve) => {
        release = resolve;
      });
    await pumpUntil(h.timers, () => h.scripted.inspections.length > 0, { realWork: h.realWork, maxMs: 2000 });
    h.watch.stop();
    release({ state: 'free' });
    await quiesce(h.realWork);
    expect(h.events).toEqual([]);
    expect(h.timers.pending()).toEqual([]);
  });

  it('a deterministic inspection failure is a background error, not an unhandled rejection', async () => {
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    const failure = Object.assign(new Error('lock read EACCES'), { code: 'EACCES' });
    h.scripted.next = () => Promise.reject(failure);
    await pump(h.timers, h.realWork, 1500);
    expect(h.backgroundErrors.length).toBeGreaterThanOrEqual(1);
    expect(h.backgroundErrors[0]?.error).toBe(failure);
    expect(h.backgroundErrors[0]?.source).toBe('lock-poll');
    expect(h.transients).toEqual([]);
    h.watch.stop();
  });

  it('a transient inspection failure is reported as transient, keeps polling and still sees the lock free', async () => {
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    const failure = Object.assign(new Error('lock read EMFILE'), { code: 'EMFILE' });
    h.scripted.next = () => Promise.reject(failure);
    await pump(h.timers, h.realWork, 1500);
    expect(h.transients.length).toBeGreaterThanOrEqual(2);
    expect(h.transients[0]).toEqual({ error: failure, source: 'lock-poll' });
    expect(h.backgroundErrors).toEqual([]);
    h.scripted.next = { state: 'free' };
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('free')), { realWork: h.realWork, maxMs: 1000 });
    expect(h.backgroundErrors).toEqual([]);
  });

  it('a transient probe failure is not an unreachable holder and the next probe still runs', async () => {
    const results: Array<ProbeOutcome | Error> = [new ProbeFailedError('probing', probeFailed({ kind: 'timeout', detail: 'slow' })), 'healthy'];
    const h = watchHarness({
      lockWaitMs: 500,
      probe: async () => {
        const next = results.shift() ?? 'healthy';
        if (next instanceof Error) throw next;
        return next;
      },
    });
    await pumpUntil(h.timers, () => h.events.includes('probe:healthy'), { realWork: h.realWork, maxMs: 20_000 });
    expect(h.events).not.toContain('probe:unreachable');
    expect(h.transients).toHaveLength(1);
    expect(h.backgroundErrors).toEqual([]);
    h.watch.stop();
  });

  it('a deterministic probe failure is a background error', async () => {
    const failure = new Error('boom');
    const h = watchHarness({ lockWaitMs: 500, probe: async () => Promise.reject(failure) });
    await pumpUntil(h.timers, () => h.backgroundErrors.length > 0, { realWork: h.realWork, maxMs: 20_000 });
    expect(h.backgroundErrors[0]).toEqual({ error: failure, source: 'external-probe' });
    h.watch.stop();
  });

  it('never has two probes in flight: the next is armed only after the current one settled', async () => {
    const releases: Array<(outcome: ProbeOutcome) => void> = [];
    const h = watchHarness({
      lockWaitMs: 500,
      probe: () => new Promise<ProbeOutcome>((resolve) => void releases.push(resolve)),
    });
    await pumpUntil(h.timers, () => releases.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, 60_000);
    expect(releases).toHaveLength(1);
    releases[0]?.('healthy');
    await pumpUntil(h.timers, () => releases.length === 2, { realWork: h.realWork, maxMs: 10_000 });
    h.watch.stop();
  });

  it('a slow inspection does not delay external past lockWaitMs', async () => {
    const releases: ((value: ProcessLockInspection) => void)[] = [];
    const h = watchHarness({ lockWaitMs: 300, lockWatchIntervalMs: 100 });
    h.scripted.next = () =>
      new Promise<ProcessLockInspection>((resolve) => {
        releases.push(resolve);
      });
    h.timers.advance(100);
    await quiesce(h.realWork);
    expect(releases).toHaveLength(1);
    h.timers.advance(300);
    await quiesce(h.realWork);
    expect(h.events).toEqual([]);
    releases[0]?.({ state: 'held', pid: 4321 });
    await quiesce(h.realWork);
    expect(h.events).toEqual(['external:4321@400', 'probe:unreachable']);
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
  });

  it('the lockWaitMs deadline timer is armed at construction and cleared by stop', () => {
    const h = watchHarness({ lockWaitMs: 7777, lockWatchIntervalMs: 100 });
    expect(h.timers.pending().map((timer) => timer.delayMs).sort((a, b) => a - b)).toEqual([100, 7777]);
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
  });

  it('stop clears every timer', async () => {
    const h = watchHarness({ lockWaitMs: 500 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, maxMs: 5000 });
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
    const probes = h.probes.length;
    await pump(h.timers, h.realWork, 20_000);
    expect(h.probes).toHaveLength(probes);
  });
});

const realWatch = (lockPath: string) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const events: string[] = [];
  const watch = watchLock({
    role: 'runtime' as ChildRole,
    lockPath,
    socketPath: path.join(path.dirname(lockPath), 'runtime.sock'),
    lockWaitMs: 3_600_000,
    lockWatchIntervalMs: 500,
    externalPollMs: 5000,
    timers,
    onFree: () => void events.push('free'),
    onExternal: () => void events.push('external'),
    onProbe: () => undefined,
    onTransient: (error) => void events.push(`transient:${String(error)}`),
    onBackgroundError: (error) => void events.push(`error:${String(error)}`),
  });
  return { clock, timers, events, watch };
};

describe('watchLock with the real kernel lock', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('stays waiting while a real process holds the lock and sees it free the moment that process is SIGKILLed', async (context) => {
    const lockPath = path.join(withTempDir(context), 'runtime.lock');
    const holder = await startLockHolder(context, lockPath);
    const h = realWatch(lockPath);
    context.onTestFinished(() => h.watch.stop());
    for (let tick = 0; tick < 20; tick += 1) {
      h.timers.advance(500);
      await waitFor(() => h.timers.pending().some((timer) => timer.delayMs === 500), { description: `tick ${tick}` });
    }
    expect(h.events).toEqual([]);
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await exited;
    h.timers.advance(500);
    await waitFor(() => h.events.includes('free'), { description: 'free after the holder died' });
    expect(h.events).toEqual(['free']);
  });
});

describe('a held lock through the supervisor', () => {
  const EXTERNAL_PID = 4242;

  it('on a platform without descriptor hand-off, exit 75 waits on the lock, is not a failure, and spawns when it frees', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const h = await startHarness(context, { overrides: { lockMechanism: lock, lockWaitMs: 3_600_000 } });
    await h.waitForState('runtime', 'ready');
    lock.holdExternally(h.paths.locks.runtime, EXTERNAL_PID);
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock');
    await pump(h.timers, h.realWork, 5 * 60_000);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.child('runtime')).toMatchObject({ state: 'waiting-lock', consecutiveFailures: 0 });
    expect(h.child('runtime').lastExit).toMatchObject({ code: 75, reason: 'lock-held' });
    lock.releaseExternally(h.paths.locks.runtime);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 10_000, description: 'respawn after the lock frees' });
    expect(h.log.withMsg('child.spawn').at(-1)).toMatchObject({ child: 'runtime', reason: 'lock-free' });
    expect(h.child('runtime').consecutiveFailures).toBe(0);
  });

  it('with descriptor hand-off, a lock held at start spawns nothing, and the child is spawned holding the claim once it frees', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    let lockPath = '';
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        lockPath = paths.locks.runtime;
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        lock.holdExternally(lockPath, EXTERNAL_PID);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 3_600_000 },
    });
    await h.waitForState('runtime', 'waiting-lock');
    await h.waitForState('gateway', 'ready');
    expect(h.fake.spawnCount('runtime')).toBe(0);
    lock.releaseExternally(lockPath);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 1, { realWork: h.realWork, maxMs: 10_000, description: 'spawn after the lock frees' });
    const spawned = h.fake.latest('runtime');
    expect(spawned.options.stdio).toHaveLength(6);
    expect(spawned.options.stdio[5]).toBeGreaterThanOrEqual(900);
    expect(spawned.options.env['MOMONGA_LOCK_FD']).toBe('5');
    expect(spawned.options.env['MOMONGA_LOCK_NONCE']).toMatch(/^[0-9a-f]{32}$/);
    expect(lock.isHeldBy(lockPath)).toBeUndefined();
    expect(h.log.withMsg('child.spawn').filter((entry) => entry['child'] === 'runtime')).toEqual([expect.objectContaining({ reason: 'lock-free' })]);
  });

  it('lockWaitMs expiry gives external and the holder is not signalled', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        fs.mkdirSync(path.dirname(paths.locks.runtime), { recursive: true, mode: 0o700 });
        lock.holdExternally(paths.locks.runtime, EXTERNAL_PID);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 2000 },
    });
    await h.waitForState('runtime', 'external', 10_000);
    expect(h.child('runtime').external?.pid).toBe(EXTERNAL_PID);
    await pumpUntil(h.timers, () => h.child('runtime').external?.probe === 'unreachable', { realWork: h.realWork, maxMs: 10_000 });
    expect(h.fake.spawnCount('runtime')).toBe(0);
    expect(h.log.withMsg('child.external')).toEqual([expect.objectContaining({ child: 'runtime', holderPid: EXTERNAL_PID })]);
  });

  it('keeps the healthy sibling running when one lock poll fails transiently', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    let failing = true;
    const flaky = {
      ...lock,
      isHeld: async (lockPath: string): Promise<boolean> => {
        if (failing && lockPath.endsWith('runtime.lock')) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
        return lock.isHeld(lockPath);
      },
    };
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        fs.mkdirSync(path.dirname(paths.locks.runtime), { recursive: true, mode: 0o700 });
        lock.holdExternally(paths.locks.runtime, EXTERNAL_PID);
      },
      overrides: { lockMechanism: flaky, lockWaitMs: 3_600_000 },
    });
    await h.waitForState('runtime', 'waiting-lock');
    await pump(h.timers, h.realWork, 3000);
    expect(h.child('gateway').state).toBe('ready');
    expect(h.log.withMsg('supervisor.background_failed')).toEqual([]);
    expect(h.log.withMsg('supervisor.background_transient')).toHaveLength(1);
    failing = false;
    lock.releaseExternally(h.paths.locks.runtime);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 1, { realWork: h.realWork, maxMs: 10_000, description: 'spawn after the poll recovers' });
  });
});
