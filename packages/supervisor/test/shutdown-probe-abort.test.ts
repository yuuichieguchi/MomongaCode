import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, POLL_INTERVAL_MS, SHUTDOWN_DRAIN_BOUND_MS } from '@momonga/foundation';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, waitFor, sleepDrivenTiming } from '@momonga/testkit';
import type { ChildManager } from '../src/child-manager.ts';
import { SHUTDOWN_REAP_BOUND_MS } from '../src/constants.ts';
import type { ChildRole } from '../src/launcher.ts';
import { reapOrphans } from '../src/orphans.ts';
import type { MarkerPorts } from '../src/orphans.ts';
import { createShutdownController } from '../src/shutdown.ts';
import type { SupervisorCloseResult } from '../src/start-supervisor.ts';
import { createLogBuffer } from './support/p2-log-buffer.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markersWithOne = (): { dir: string; marker: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-probe-abort-'));
  created.push(dir);
  const marker = path.join(dir, 'runtime-old');
  fs.writeFileSync(marker, '');
  return { dir, marker };
};

const unexpected = (name: string) => (): never => {
  throw new Error(`the shutdown controller must not call ${name}`);
};

const fakeManager = (role: ChildRole, unreaped: readonly string[]): ChildManager => ({
  role,
  state: () => 'stopped',
  health: () => ({ role, state: 'stopped', restarts: 0, consecutiveFailures: 0 }),
  spawnWith: unexpected('spawnWith'),
  spawnFresh: unexpected('spawnFresh'),
  failWithoutProcess: unexpected('failWithoutProcess'),
  retryHeld: unexpected('retryHeld'),
  holdsCapability: () => false,
  stop: async () => ({ killed: false, leaked: false }),
  enterDraining: () => undefined,
  enterRetiring: () => undefined,
  hasEnded: () => true,
  unreapedMarkers: () => unreaped,
  inFlightReaps: () => new Map(),
  awaitLeave: unexpected('awaitLeave'),
});

const signalOf = (options: unknown): AbortSignal | undefined => (options as { signal?: AbortSignal } | undefined)?.signal;

const probeAnsweringOnlyItsSignal = (seen: Array<AbortSignal | undefined>) => (_marker: string, options?: unknown): Promise<number[]> =>
  new Promise<number[]>((_resolve, reject) => {
    const signal = signalOf(options);
    seen.push(signal);
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const world = () => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = createLogBuffer(clock);
  const reapTiming = sleepDrivenTiming({ now: () => clock.now(), sleep: (ms: number) => new Promise<void>((resolve) => void timers.setTimeout(resolve, ms)) });
  return { clock, timers, log, reapTiming };
};

const settled = <T>(promise: Promise<T>) => {
  let state: { kind: 'pending' } | { kind: 'resolved'; value: T } | { kind: 'rejected'; reason: unknown } = { kind: 'pending' };
  promise.then(
    (value) => void (state = { kind: 'resolved', value }),
    (reason: unknown) => void (state = { kind: 'rejected', reason }),
  );
  return () => state;
};

describe('T6 shutdown aborts the probes it waits for', () => {
  it('step 1: beginDraining aborts the start-up probe at once, so step 1 ends within one poll interval and not at the drain bound; markers stay', async () => {
    const { clock, timers, log, reapTiming } = world();
    const { dir, marker } = markersWithOne();
    const launchController = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const markerPorts: MarkerPorts = { findHolders: probeAnsweringOnlyItsSignal(seen) as never };
    const background = reapOrphans({ markersDir: dir, orphanGraceMs: 60_000, orphanReapGraceMs: 1000, orphanPollMs: 250, timers, signal: launchController.signal, logger: log.logger, reapTiming, markerPorts });
    await waitFor(() => seen.length > 0, { description: 'the start-up probe started' });
    const controller = createShutdownController({
      runtime: fakeManager('runtime', []),
      gateway: fakeManager('gateway', []),
      recordStop: async () => undefined,
      timers,
      logger: log.logger,
      beginDraining: () => launchController.abort(),
      awaitBackground: async () => void (await background.catch(() => undefined)),
      closeControl: async () => undefined,
      releaseLock: () => undefined,
      onFatal: () => undefined,
    });
    const closing = settled<SupervisorCloseResult>(controller.close(DEFAULT_STOP_VALUES));
    timers.advance(POLL_INTERVAL_MS);
    await waitFor(() => log.events('shutdown.step').some((line) => line['shutdownStep'] === 2), { description: 'step 2 begins within one poll interval of the drain', maxTurns: 20_000 });
    expect(clock.now()).toBeLessThanOrEqual(POLL_INTERVAL_MS);
    expect(clock.now()).toBeLessThan(SHUTDOWN_DRAIN_BOUND_MS);
    expect(log.events('shutdown.step.bound').filter((line) => line['detail'] === 'step 1 bound reached')).toEqual([]);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    void closing;
  });

  it('step 4: the reap of a marker gets a signal that is aborted when the step 4 bound fires; the bound is logged and the marker stays', async () => {
    const { timers, log } = world();
    const signals: Array<AbortSignal | undefined> = [];
    const controller = createShutdownController({
      runtime: fakeManager('runtime', ['/markers/runtime-a']),
      gateway: fakeManager('gateway', []),
      recordStop: async () => undefined,
      timers,
      logger: log.logger,
      markerPorts: {
        reapMarkedProcesses: (options: ReapMarkedProcessesOptions) =>
          new Promise<{ removed: boolean }>(() => {
            signals.push(options.signal);
          }),
      },
      beginDraining: () => undefined,
      awaitBackground: async () => undefined,
      closeControl: async () => undefined,
      releaseLock: () => undefined,
      onFatal: () => undefined,
    });
    const closing = settled<SupervisorCloseResult>(controller.close(DEFAULT_STOP_VALUES));
    await waitFor(() => signals.length > 0, { description: 'step 4 started its reap' });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    timers.advance(SHUTDOWN_REAP_BOUND_MS);
    await waitFor(() => closing().kind !== 'pending', { description: 'close settles after the step 4 bound' });
    expect(signals[0]?.aborted).toBe(true);
    expect(log.events('orphans.warning').filter((line) => line['detail'] === 'step 4 bound reached').map((line) => line['marker'])).toEqual(['/markers/runtime-a']);
  });
});

describe('T4 (d) start-up recovery with a probe that never answers', () => {
  it('fails with an explicit error at the orphan phase deadline and does not hang', async () => {
    const { timers, log, reapTiming } = world();
    const { dir, marker } = markersWithOne();
    const seen: Array<AbortSignal | undefined> = [];
    const recovery = settled(
      reapOrphans({ markersDir: dir, orphanGraceMs: 1000, orphanReapGraceMs: 1000, orphanPollMs: 250, timers, signal: new AbortController().signal, logger: log.logger, reapTiming, markerPorts: { findHolders: probeAnsweringOnlyItsSignal(seen) as never } }),
    );
    await waitFor(() => seen.length > 0, { description: 'the start-up probe started' });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    timers.advance(999);
    await waitFor(() => true);
    expect(recovery().kind).toBe('pending');
    timers.advance(1);
    await waitFor(() => recovery().kind !== 'pending', { description: 'recovery ends at the phase deadline' });
    expect(recovery()).toMatchObject({ kind: 'rejected', reason: expect.any(Error) });
    expect(fs.existsSync(marker)).toBe(true);
  });
});
