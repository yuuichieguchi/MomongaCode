import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InspectProcessLockOptions, ProcessLockInspection } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, registerCleanup, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { PROBE_HEADERS_TIMEOUT_MS, holderPidOf, labelHealthResponse, probeExternalHealth, watchLock } from '../src/lock-watch.ts';
import type { ExternalProbe, LockWatchOptions, ProbeOutcome } from '../src/lock-watch.ts';
import type { ChildRole } from '../src/launcher.ts';
import { createRealWorkScope, drive, pump, pumpUntil, startHarness, turns } from './fixtures/p3-harness.ts';

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

  it('a holder that never answers is unreachable after the headers timeout', async (context) => {
    expect(PROBE_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    const dir = withTempDir(context);
    const socket = path.join(dir, 'silent.sock');
    await serveOn(context, socket, () => undefined);
    await expect(probeExternalHealth('gateway', socket)).resolves.toBe('unreachable');
  }, 4500);
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
  let probeResult: ProbeOutcome = 'unreachable';
  const options: LockWatchOptions = {
    role: 'runtime',
    lockPath: '/fake/run/runtime.lock',
    socketPath: '/fake/run/runtime.sock',
    lockWaitMs: 10_000,
    lockPollMs: 500,
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
    watch,
    setProbe: (next: ProbeOutcome) => {
      probeResult = next;
    },
  };
};

describe('watchLock', () => {
  it('exit 75 waits on the lock and fires onFree when it frees', async () => {
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    await pump(h.timers, h.realWork, 5 * 60_000, 500);
    expect(h.events.filter((event) => event.startsWith('free'))).toEqual([]);
    expect(h.scripted.inspections.length).toBeGreaterThanOrEqual(599);
    expect(h.scripted.inspections.length).toBeLessThanOrEqual(601);
    const freedAt = h.clock.now();
    h.scripted.next = { state: 'free' };
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('free')), { realWork: h.realWork, stepMs: 50, maxMs: 1000 });
    expect(h.clock.now() - freedAt).toBeLessThanOrEqual(500);
    const callsAtFree = h.scripted.inspections.length;
    await pump(h.timers, h.realWork, 5000, 500);
    expect(h.scripted.inspections.length).toBe(callsAtFree);
    expect(h.timers.pending()).toEqual([]);
  });

  it('lockWaitMs expiry gives external with the holder pid', async () => {
    const h = watchHarness({ lockWaitMs: 2000 });
    await pump(h.timers, h.realWork, 1950, 50);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([]);
    await pump(h.timers, h.realWork, 600, 50);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([expect.stringMatching(/^external:4321@/)]);
    h.watch.stop();
  });

  it('the first probe starts on entering external, then every EXTERNAL_POLL_MS', async () => {
    const h = watchHarness({ lockWaitMs: 1000 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    const enteredAt = h.clock.now();
    await turns();
    expect(h.probes).toEqual([enteredAt]);
    expect(h.events).toContain('probe:unreachable');
    await pumpUntil(h.timers, () => h.clock.now() >= enteredAt + 60_000, { realWork: h.realWork, stepMs: 50 });
    expect(h.probes).toHaveLength(13);
    expect(h.probes.map((at) => at - enteredAt)).toEqual(Array.from({ length: 13 }, (_unused, index) => index * 5000));
    h.watch.stop();
  });

  it('probe results are reported as they change', async () => {
    const h = watchHarness({ lockWaitMs: 500 });
    h.setProbe('healthy');
    await pumpUntil(h.timers, () => h.events.includes('probe:healthy'), { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    h.setProbe('unhealthy');
    await pumpUntil(h.timers, () => h.events.includes('probe:unhealthy'), { realWork: h.realWork, stepMs: 50, maxMs: 10_000 });
    h.watch.stop();
  });

  it('external polls the lock at LOCK_POLL_MS', async () => {
    const h = watchHarness({ lockWaitMs: 1000 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    await pump(h.timers, h.realWork, 1200, 50);
    const freedAt = h.clock.now();
    h.scripted.next = { state: 'free' };
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('free')), { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    expect(h.clock.now() - freedAt).toBeLessThanOrEqual(500);
    expect(h.timers.pending()).toEqual([]);
  });

  it('unreadable lock counts as held', async () => {
    const h = watchHarness({ lockWaitMs: 2000 });
    h.scripted.next = { state: 'unreadable' };
    await pump(h.timers, h.realWork, 3000, 50);
    expect(h.events.filter((event) => event.startsWith('free'))).toEqual([]);
    expect(h.events.filter((event) => event.startsWith('external'))).toEqual([expect.stringMatching(/^external:undefined@/)]);
    h.watch.stop();
  });

  it('the waiting loop passes one memo per watch and forwards startTimeOf', async () => {
    const startTimeOf = async (): Promise<number | undefined> => 0;
    const h = watchHarness({ lockWaitMs: 3_600_000, startTimeOf });
    await pump(h.timers, h.realWork, 10_000, 500);
    expect(h.scripted.inspections.length).toBeGreaterThanOrEqual(19);
    const first = h.scripted.inspections[0];
    expect(first?.memo).toBeDefined();
    expect(first?.startTimeOf).toBe(startTimeOf);
    for (const inspection of h.scripted.inspections) expect(inspection?.memo).toBe(first?.memo);
    const other = watchHarness({ role: 'gateway', lockWaitMs: 3_600_000 });
    await pump(other.timers, other.realWork, 1000, 500);
    expect(other.scripted.inspections[0]?.memo).toBeDefined();
    expect(other.scripted.inspections[0]?.memo).not.toBe(first?.memo);
    h.watch.stop();
    other.watch.stop();
  });

  it('a lock poll in flight when the watch stops does not fire onFree', async () => {
    let release: (value: ProcessLockInspection) => void = () => undefined;
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    h.scripted.next = () =>
      new Promise<ProcessLockInspection>((resolve) => {
        release = resolve;
      });
    await pumpUntil(h.timers, () => h.scripted.inspections.length > 0, { realWork: h.realWork, stepMs: 50, maxMs: 2000 });
    h.watch.stop();
    release({ state: 'free' });
    await turns();
    expect(h.events).toEqual([]);
    expect(h.timers.pending()).toEqual([]);
  });

  it('a rejected inspection is a background error, not an unhandled rejection', async () => {
    const h = watchHarness({ lockWaitMs: 3_600_000 });
    const failure = Object.assign(new Error('lock read EIO'), { code: 'EIO' });
    h.scripted.next = () => Promise.reject(failure);
    await pump(h.timers, h.realWork, 1500, 50);
    expect(h.backgroundErrors.length).toBeGreaterThanOrEqual(1);
    expect(h.backgroundErrors[0]?.error).toBe(failure);
    expect(typeof h.backgroundErrors[0]?.source).toBe('string');
    h.watch.stop();
  });

  it('a slow inspection does not delay external past lockWaitMs', async () => {
    const releases: ((value: ProcessLockInspection) => void)[] = [];
    const h = watchHarness({ lockWaitMs: 300, lockPollMs: 100 });
    h.scripted.next = () =>
      new Promise<ProcessLockInspection>((resolve) => {
        releases.push(resolve);
      });
    h.timers.advance(100);
    await turns();
    expect(releases).toHaveLength(1);
    h.timers.advance(300);
    await turns();
    expect(h.events).toEqual([]);
    releases[0]?.({ state: 'held', pid: 4321 });
    await turns();
    expect(h.events).toEqual(['external:4321@400', 'probe:unreachable']);
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
  });

  it('the lockWaitMs deadline timer is armed at construction and cleared by stop', () => {
    const h = watchHarness({ lockWaitMs: 7777, lockPollMs: 100 });
    expect(h.timers.pending().map((timer) => timer.delayMs).sort((a, b) => a - b)).toEqual([100, 7777]);
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
  });

  it('stop clears every timer', async () => {
    const h = watchHarness({ lockWaitMs: 500 });
    await pumpUntil(h.timers, () => h.events.some((event) => event.startsWith('external')), { realWork: h.realWork, stepMs: 50, maxMs: 5000 });
    h.watch.stop();
    expect(h.timers.pending()).toEqual([]);
    const probes = h.probes.length;
    await pump(h.timers, h.realWork, 20_000, 500);
    expect(h.probes).toHaveLength(probes);
  });
});

const writeLock = (lockPath: string, pid: number, mtimeMs: number): void => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, String(pid), { mode: 0o600 });
  fs.utimesSync(lockPath, mtimeMs / 1000, mtimeMs / 1000);
};

const realWatch = (lockPath: string, startTimeOf: (pid: number) => Promise<number | undefined>) => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const events: string[] = [];
  const watch = watchLock({
    role: 'runtime' as ChildRole,
    lockPath,
    socketPath: path.join(path.dirname(lockPath), 'runtime.sock'),
    lockWaitMs: 3_600_000,
    lockPollMs: 500,
    externalPollMs: 5000,
    timers,
    startTimeOf,
    onFree: () => void events.push('free'),
    onExternal: () => void events.push('external'),
    onProbe: () => undefined,
    onBackgroundError: (error) => void events.push(`error:${String(error)}`),
  });
  return { clock, timers, events, watch };
};

describe('watchLock with the real inspection', () => {
  it('the waiting loop passes one memo per role', async (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    const holder = spawnTracked(context, 'sleep', ['30']);
    writeLock(lockPath, holder.pid, Date.now());
    let probes = 0;
    const h = realWatch(lockPath, async () => {
      probes += 1;
      return 0;
    });
    context.onTestFinished(() => h.watch.stop());
    for (let tick = 0; tick < 20; tick += 1) {
      h.timers.advance(500);
      await waitFor(() => h.timers.pending().some((timer) => timer.delayMs === 500), { description: `tick ${tick}` });
    }
    expect(probes).toBe(1);
    expect(h.events).toEqual([]);
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await exited;
    h.timers.advance(500);
    await waitFor(() => h.events.includes('free'), { description: 'free after the holder died' });
    expect(probes).toBe(1);
  });

  it('a ghost lock is free for the waiting loop', async (context) => {
    const dir = withTempDir(context);
    const lockPath = path.join(dir, 'runtime.lock');
    const holder = spawnTracked(context, 'sleep', ['30']);
    writeLock(lockPath, holder.pid, Date.now() - 3_600_000);
    const h = realWatch(lockPath, async () => Date.now());
    context.onTestFinished(() => h.watch.stop());
    h.timers.advance(500);
    await waitFor(() => h.events.length > 0, { description: 'first verdict' });
    expect(h.events).toEqual(['free']);
  });
});

describe('exit 75 through the supervisor', () => {
  const liveHolder = (context: CleanupContext, lockPath: string) => {
    const holder = spawnTracked(context, 'sleep', ['30']);
    writeLock(lockPath, holder.pid, Date.now());
    return holder;
  };

  it('exit 75 waits on the lock, is not a failure, and spawns when it frees', async (context) => {
    let holderPid = 0;
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        holderPid = liveHolder(context, paths.locks.runtime).pid;
      },
      overrides: { startTimeOf: async () => 0, lockWaitMs: 3_600_000 },
    });
    await h.waitForState('runtime', 'ready');
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock');
    await pump(h.timers, h.realWork, 5 * 60_000, 500);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.child('runtime')).toMatchObject({ state: 'waiting-lock', consecutiveFailures: 0 });
    expect(h.child('runtime').lastExit).toMatchObject({ code: 75, reason: 'lock-held' });
    process.kill(holderPid, 'SIGKILL');
    await waitFor(() => {
      try {
        process.kill(holderPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await drive(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, stepMs: 50, maxSteps: 200, description: 'respawn after the lock frees' });
    expect(h.log.withMsg('child.spawn').at(-1)).toMatchObject({ child: 'runtime', reason: 'lock-free' });
    expect(h.child('runtime').consecutiveFailures).toBe(0);
  });

  it('lockWaitMs expiry gives external and the holder is not signalled', async (context) => {
    let holderPid = 0;
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        holderPid = liveHolder(context, paths.locks.runtime).pid;
      },
      overrides: { startTimeOf: async () => 0, lockWaitMs: 2000 },
    });
    await h.waitForState('runtime', 'ready');
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'external', 10_000);
    const external = h.child('runtime').external;
    expect(external?.pid).toBe(holderPid);
    expect(['pending', 'unreachable']).toContain(external?.probe);
    await pumpUntil(h.timers, () => h.child('runtime').external?.probe === 'unreachable', { realWork: h.realWork, stepMs: 50, maxMs: 10_000 });
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(() => process.kill(holderPid, 0)).not.toThrow();
    expect(h.log.withMsg('child.external')).toEqual([expect.objectContaining({ child: 'runtime', holderPid })]);
  });
});
