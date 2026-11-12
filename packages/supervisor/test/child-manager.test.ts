import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, EXIT_RETIRED, MAXIMUM_STOP_VALUES, gatewayAbortBudgetMs, gatewayStopBudgetMs, runtimeAbortStopBudgetMs, runtimeStopBudgetMs } from '@momonga/foundation';
import { afterMicrotasks, createFakeKernelLock, waitFor, firstGeneration } from '@momonga/testkit';
import { DEFAULT_INTERVALS, HELD_RETRY_MS, KILL_CONFIRM_MS, STABLE_AFTER_MS, STARTUP_KILL_GRACE_MS, STARTUP_TIMEOUT_MS, STDIO_FLUSH_MS } from '../src/constants.ts';
import { errnoError } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness, T0 } from './support/p2-manager-harness.ts';
import type { ManagerHarness } from './support/p2-manager-harness.ts';

const RUNTIME_SHUTDOWN_BUDGET_MS = runtimeStopBudgetMs(DEFAULT_STOP_VALUES);
const RUNTIME_ABORT_BUDGET_MS = runtimeAbortStopBudgetMs(DEFAULT_STOP_VALUES);

const stopLineWritten = afterMicrotasks;

const exitAndWait = async (harness: ManagerHarness, state: string, code: number | null, signal: NodeJS.Signals | null = null): Promise<void> => {
  harness.port.last().exit(code, signal);
  await waitFor(() => harness.manager.state() === state, { description: `state ${state}` });
};

const spawnReasons = (harness: ManagerHarness): unknown[] => harness.events('child.spawn').map((line) => line['reason']);

describe('ready parsing', () => {
  it('ready line makes the child ready', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    expect(harness.manager.state()).toBe('starting');
    harness.clock.advance(1500);
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
    const health = harness.manager.health();
    expect(health).toMatchObject({ role: 'runtime', state: 'ready', pid: 41_000, restarts: 0, consecutiveFailures: 0 });
    expect(health.readyAt).toBe(new Date(T0 + 1500).toISOString());
    expect(harness.events('child.ready')).toEqual([expect.objectContaining({ child: 'runtime', childPid: 41_000, version: '1.2.3', socketPath: '/fake/run/runtime.sock' })]);
  });

  it('ready line with another pid kills the child and backs off', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().ready({ pid: 999_999 });
    await waitFor(() => harness.manager.state() === 'stopping');
    await stopLineWritten();
    expect(harness.events('child.ready.mismatch')).toEqual([expect.objectContaining({ level: 'error', child: 'runtime', childPid: 41_000 })]);
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    expect(harness.events('child.ready')).toEqual([]);
    await exitAndWait(harness, 'backoff', 0);
    const health = harness.manager.health();
    expect(health.lastExit?.reason).toBe('protocol-violation');
    expect(health.consecutiveFailures).toBe(1);
    harness.timers.advance(249);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    harness.timers.advance(1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
  });

  it('through a keeper, the ready line is checked against the pid of the command, which the keeper reports after the start, and every report names it', async (context) => {
    const harness = createManagerHarness(context, { keptCommandPidOffset: 1000 });
    await harness.spawnInitial();
    const child = harness.port.last();
    expect(child.pid).toBe(41_000);
    child.started();
    child.ready({ pid: 42_000 });
    await waitFor(() => harness.manager.state() === 'ready');
    expect(harness.manager.health()).toMatchObject({ state: 'ready', pid: 42_000 });
    expect(harness.events('child.ready')).toEqual([expect.objectContaining({ childPid: 42_000 })]);
  });

  it('through a keeper, a ready line that names the keeper instead of the command is a mismatch', async (context) => {
    const harness = createManagerHarness(context, { keptCommandPidOffset: 1000 });
    await harness.spawnInitial();
    const child = harness.port.last();
    child.started();
    child.ready({ pid: 41_000 });
    await waitFor(() => harness.manager.state() === 'stopping');
    expect(harness.events('child.ready.mismatch')).toEqual([expect.objectContaining({ childPid: 42_000, readyPid: 41_000 })]);
  });

  it('ready line of another version is not ready, is reported to the supervisor, and the child is stopped and held for its version (20.12)', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.ready({ version: '9.9.9' });
    await waitFor(() => harness.versionMismatches.length === 1);
    expect(harness.versionMismatches).toEqual([{ role: 'runtime', childVersion: '9.9.9' }]);
    expect(harness.manager.state()).toBe('stopping');
    expect(harness.manager.health().readyAt).toBeUndefined();
    expect(harness.events('child.ready')).toEqual([]);
    expect(harness.events('child.version.mismatch')).toEqual([
      expect.objectContaining({ level: 'error', child: 'runtime', childPid: 41_000, childVersion: '9.9.9', supervisorVersion: '1.2.3' }),
    ]);
    expect(harness.events('child.stop')).toEqual([expect.objectContaining({ stop: 'ready-mismatch', mode: 'term' })]);
    child.exit(0);
    await waitFor(() => harness.manager.state() === 'held-version');
    expect(harness.manager.health().lastExit).toMatchObject({ reason: 'version-mismatch' });
    expect(harness.manager.hasEnded()).toBe(true);
    harness.timers.advance(HELD_RETRY_MS + STARTUP_TIMEOUT_MS);
    harness.manager.spawnFresh('backoff');
    harness.manager.retryHeld();
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
  });

  it('a child that exits with the retire code is final: it tells the supervisor and is never restarted (20.1)', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.ready();
    await waitFor(() => harness.manager.state() === 'ready');
    child.exit(EXIT_RETIRED);
    await waitFor(() => harness.manager.state() === 'stopped');
    expect(harness.retiredExits).toBe(1);
    expect(harness.manager.health().lastExit).toMatchObject({ code: EXIT_RETIRED, reason: 'retired' });
    expect(harness.events('child.backoff')).toEqual([]);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
  });

  it('a child of a retiring generation that exits for any other reason is not restarted (U-I3-11)', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.ready();
    await waitFor(() => harness.manager.state() === 'ready');
    harness.retiring.value = true;
    harness.manager.enterRetiring();
    expect(harness.manager.state()).toBe('ready');
    child.exit(1);
    await waitFor(() => harness.manager.state() === 'stopped');
    expect(harness.manager.health().lastExit).toMatchObject({ code: 1, reason: 'failure' });
    harness.timers.advance(HELD_RETRY_MS);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    expect(harness.manager.hasEnded()).toBe(true);
  });

  it('ready line of another service is a mismatch', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().ready({ service: 'gateway' });
    await waitFor(() => harness.manager.state() === 'stopping');
    expect(harness.events('child.ready.mismatch')).toHaveLength(1);
  });

  it('ready line during stopping is ignored', async (context) => {
    const stops: ((harness: ManagerHarness) => void)[] = [
      (harness) => void harness.manager.stop('shutdown', 'term'),
      (harness) => harness.timers.advance(STARTUP_TIMEOUT_MS),
    ];
    for (const stop of stops) {
      const harness = createManagerHarness(context);
      await harness.spawnInitial();
      stop(harness);
      expect(harness.manager.state()).toBe('stopping');
      harness.port.last().ready();
      await waitFor(() => harness.events('child.ready.ignored').length === 1);
      expect(harness.manager.state()).toBe('stopping');
      expect(harness.events('child.ready')).toEqual([]);
    }
  });

  it('non-ready stdout is ignored', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.stdoutLine('before ready');
    child.ready();
    await waitFor(() => harness.manager.state() === 'ready');
    child.stdoutLine('after ready');
    child.ready();
    await waitFor(() => harness.events('child.stdout').length === 3);
    expect(harness.manager.state()).toBe('ready');
    const records = harness.events('child.stdout');
    expect(records.map((line) => line['raw'])).toEqual(['before ready', 'after ready', expect.stringContaining('"event":"ready"')]);
    for (const record of records) expect(record).toMatchObject({ level: 'info', child: 'runtime', childPid: 41_000 });
    expect(harness.events('child.ready')).toHaveLength(1);
    expect(fs.existsSync(harness.paths.logFiles.runtime)).toBe(false);
  });

  it('stderr is captured as child.stderr', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().stderrLine('{"level":"error","msg":"looks like a log"}');
    harness.port.last().stderrLine('TypeError: boom');
    await waitFor(() => harness.events('child.stderr').length === 2);
    expect(harness.events('child.stderr')).toEqual([
      expect.objectContaining({ level: 'warn', child: 'runtime', childPid: 41_000, raw: '{"level":"error","msg":"looks like a log"}' }),
      expect.objectContaining({ level: 'warn', child: 'runtime', childPid: 41_000, raw: 'TypeError: boom' }),
    ]);
  });
});

describe('startup timeout', () => {
  it('startup timeout ends in backoff, not stopped', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.timers.advance(STARTUP_TIMEOUT_MS - 1);
    expect(harness.port.last().signals).toEqual([]);
    harness.timers.advance(1);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    expect(harness.manager.state()).toBe('stopping');
    await exitAndWait(harness, 'backoff', 0);
    expect(harness.manager.health().lastExit?.reason).toBe('startup-timeout');
    harness.timers.advance(250);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    expect(harness.manager.state()).toBe('starting');

    const stubborn = createManagerHarness(context);
    await stubborn.spawnInitial();
    stubborn.timers.advance(STARTUP_TIMEOUT_MS);
    await stopLineWritten();
    stubborn.timers.advance(STARTUP_KILL_GRACE_MS - 1);
    expect(stubborn.port.last().groupKills).toBe(0);
    stubborn.timers.advance(1);
    expect(stubborn.port.last().groupKills).toBe(1);
    expect(stubborn.port.last().signals).toEqual(['SIGTERM']);
    await exitAndWait(stubborn, 'backoff', null, 'SIGKILL');
    expect(stubborn.manager.health().lastExit?.reason).toBe('startup-timeout');
  });
});

describe('start-up stall limit', () => {
  const progressLine = (pid: number, step: string): string => JSON.stringify({ event: 'progress', service: 'runtime', pid, step });
  const PROGRESS_EVERY_MS = 50_000;
  const TOTAL_MS = 180_000;

  it('a child that reports progress every 50 s for three minutes is not stopped', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += PROGRESS_EVERY_MS) {
      await harness.timers.advanceAsync(PROGRESS_EVERY_MS);
      harness.port.last().stdoutLine(progressLine(41_000, `step-${elapsed}`));
      await afterMicrotasks();
    }
    expect(harness.port.last().signals).toEqual([]);
    expect(harness.manager.state()).toBe('starting');
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
  });

  it('a child silent for the stall limit after its last progress is stopped with startup-timeout', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await harness.timers.advanceAsync(PROGRESS_EVERY_MS);
    harness.port.last().stdoutLine(progressLine(41_000, 'store'));
    await afterMicrotasks();
    await harness.timers.advanceAsync(STARTUP_TIMEOUT_MS - 1);
    expect(harness.port.last().signals).toEqual([]);
    await harness.timers.advanceAsync(1);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    await exitAndWait(harness, 'backoff', 0);
    expect(harness.manager.health().lastExit?.reason).toBe('startup-timeout');
  });

  it('progress of another process does not re-arm the limit', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await harness.timers.advanceAsync(PROGRESS_EVERY_MS);
    harness.port.last().stdoutLine(progressLine(999_999, 'store'));
    await afterMicrotasks();
    await harness.timers.advanceAsync(STARTUP_TIMEOUT_MS - PROGRESS_EVERY_MS);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
  });
});

describe('exit classification in the manager', () => {
  it('exit 1 restarts after backoff', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', 1);
    expect(harness.manager.health()).toMatchObject({ consecutiveFailures: 1, lastExit: { code: 1, signal: null, reason: 'failure', at: new Date(T0).toISOString() } });
    harness.timers.advance(249);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    harness.timers.advance(1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    expect(harness.manager.health().restarts).toBe(1);
    expect(spawnReasons(harness)).toEqual(['initial', 'backoff']);
  });

  it('shutdown stop that exits 1 ends stopped', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const stopped = harness.manager.stop('shutdown', 'term');
    await exitAndWait(harness, 'stopped', 1);
    await expect(stopped).resolves.toEqual({ killed: false, leaked: false });
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.manager.health().lastExit?.reason).toBe('requested');
  });

  it.for(['superseded', 'unpromoted'] as const)('the stop of a %s start gives the child the startup kill grace, and its exit is a requested one', async (reason, context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
    void harness.manager.stop(reason, 'term', MAXIMUM_STOP_VALUES);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    harness.timers.advance(STARTUP_KILL_GRACE_MS - 1);
    expect(harness.port.last().groupKills).toBe(0);
    harness.timers.advance(1);
    expect(harness.port.last().groupKills).toBe(1);
    await exitAndWait(harness, 'stopped', null, 'SIGKILL');
    expect(harness.manager.health().lastExit?.reason).toBe('requested');
  });

  it('shutdown supersedes startup-timeout', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.timers.advance(STARTUP_TIMEOUT_MS);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    void harness.manager.stop('shutdown', 'term');
    expect(harness.port.last().signals).toEqual(['SIGTERM']);
    expect(harness.events('child.stop').some((line) => line['superseded'] === 'startup-timeout' && line['stop'] === 'shutdown')).toBe(true);
    await exitAndWait(harness, 'stopped', 0);
    expect(harness.manager.health().lastExit?.reason).toBe('requested');
    expect(harness.manager.health().consecutiveFailures).toBe(0);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('exit 77 does not respawn on a timer', async (context) => {
    const harness = createManagerHarness(context);
    harness.lock.holdExternally(firstGeneration(harness.paths).locks.runtime, process.pid);
    await harness.spawnInitial();
    await exitAndWait(harness, 'waiting-lock', 77);
    for (let step = 0; step < 120; step += 1) {
      harness.timers.advance(5000);
      await afterMicrotasks();
    }
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    expect(harness.manager.state()).toBe('waiting-lock');
    expect(harness.manager.health().consecutiveFailures).toBe(0);
    harness.lock.releaseExternally(firstGeneration(harness.paths).locks.runtime);
    await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === DEFAULT_INTERVALS.lockWatchIntervalMs), { description: 'the next lock poll is armed' });
    harness.timers.advance(DEFAULT_INTERVALS.lockWatchIntervalMs);
    await waitFor(() => harness.spawnCount() === 2, { description: 'spawn after the lock is released' });
    expect(spawnReasons(harness)).toEqual(['initial', 'lock-free']);
    expect(harness.manager.state()).toBe('starting');
  });

  it('with descriptor hand-off the claim is taken before the spawn and given to the child', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    const harness = createManagerHarness(context, { overrides: { lockMechanism: lock } });
    await harness.spawnInitial();
    const { options } = harness.port.last();
    expect(lock.claimsMade()).toEqual([firstGeneration(harness.paths).locks.runtime]);
    expect(options.stdio).toHaveLength(6);
    expect(options.stdio[5]).toBeGreaterThanOrEqual(900);
    expect(options.env['MOMONGA_LOCK_FD']).toBe('5');
    expect(options.env['MOMONGA_LOCK_NONCE']).toMatch(/^[0-9a-f]{32}$/);
    expect(lock.isHeldBy(firstGeneration(harness.paths).locks.runtime)).toBeUndefined();
  });

  it('with descriptor hand-off a held lock spawns no child and waits', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    const harness = createManagerHarness(context, { overrides: { lockMechanism: lock } });
    lock.holdExternally(firstGeneration(harness.paths).locks.runtime, process.pid);
    await harness.spawnInitial();
    expect(harness.manager.state()).toBe('waiting-lock');
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(0);
    lock.releaseExternally(firstGeneration(harness.paths).locks.runtime);
    await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === DEFAULT_INTERVALS.lockWatchIntervalMs), { description: 'the lock poll is armed' });
    harness.timers.advance(DEFAULT_INTERVALS.lockWatchIntervalMs);
    await waitFor(() => harness.spawnCount() === 1, { description: 'spawn after the lock is released' });
    expect(spawnReasons(harness)).toEqual(['lock-free']);
  });

  it('with descriptor hand-off a failed spawn gives the claim back', async (context) => {
    const lock = createFakeKernelLock({ inheritable: true });
    const harness = createManagerHarness(context, { overrides: { lockMechanism: lock } });
    harness.port.nextFailure = { kind: 'throw', error: new Error('spawn boom') };
    await harness.spawnInitial();
    expect(harness.manager.state()).toBe('backoff');
    expect(lock.isHeldBy(firstGeneration(harness.paths).locks.runtime)).toBeUndefined();
  });

  it('escalating a stop to SIGINT never moves the kill deadline later', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const first = harness.port.last();
    void harness.manager.stop('shutdown', 'term');
    await stopLineWritten();
    harness.timers.advance(40_000);
    void harness.manager.stop('shutdown', 'int');
    expect(first.signals).toEqual(['SIGTERM', 'SIGINT']);
    harness.timers.advance(RUNTIME_SHUTDOWN_BUDGET_MS - 40_000);
    expect(first.groupKills).toBe(1);
  });

  it('exit 78 holds until a trigger', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'held-config', 78);
    expect(harness.manager.health().heldReason).toBe('child exited 78 (see runtime.log)');
    expect(harness.events('child.held')).toEqual([expect.objectContaining({ source: 'child-exit', heldReason: 'child exited 78 (see runtime.log)' })]);
    harness.timers.advance(HELD_RETRY_MS - 1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    harness.manager.retryHeld();
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    expect(spawnReasons(harness)).toEqual(['initial', 'settings-change']);
    harness.port.last().stderrLine('{"msg":"entry.usage_error","detail":"unknown flag --x"}');
    await waitFor(() => harness.events('child.stderr').length === 1);
    await exitAndWait(harness, 'held-config', 78);
    expect(harness.manager.health().heldReason).toBe('child exited 78: {"msg":"entry.usage_error","detail":"unknown flag --x"}');
    expect(harness.manager.health().consecutiveFailures).toBe(0);
  });

  it('heldReason keeps at most 200 characters of the stderr line', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().stderrLine('e'.repeat(500));
    await waitFor(() => harness.events('child.stderr').length === 1);
    await exitAndWait(harness, 'held-config', 78);
    expect(harness.manager.health().heldReason).toBe(`child exited 78: ${'e'.repeat(200)}`);
  });

  it('held-config retries on the slow timer', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'held-config', 78);
    for (let retry = 1; retry <= 12; retry += 1) {
      harness.timers.advance(HELD_RETRY_MS - 1);
      await afterMicrotasks();
      expect(harness.spawnCount()).toBe(retry);
      harness.timers.advance(1);
      await afterMicrotasks();
      expect(harness.spawnCount()).toBe(retry + 1);
      await exitAndWait(harness, 'held-config', 78);
    }
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(13);
    expect(harness.events('child.held')).toHaveLength(1);
    expect(spawnReasons(harness).slice(1)).toEqual(Array.from({ length: 12 }, () => 'held-retry'));
    expect(harness.manager.health().consecutiveFailures).toBe(0);
  });

  it('held-config retry that succeeds recovers', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'held-config', 78);
    harness.timers.advance(HELD_RETRY_MS);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
    expect(harness.manager.health().consecutiveFailures).toBe(0);
    expect(harness.manager.health().heldReason).toBeUndefined();
    expect(harness.timers.pending().some((timer) => timer.delayMs === HELD_RETRY_MS)).toBe(false);
    harness.timers.advance(HELD_RETRY_MS * 2);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
  });

  it('a settings change re-arms the held timer', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'held-config', 78);
    harness.timers.advance(HELD_RETRY_MS / 2);
    harness.manager.retryHeld();
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    await exitAndWait(harness, 'held-config', 78);
    harness.timers.advance(HELD_RETRY_MS - 1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    harness.timers.advance(1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(3);
  });

  it('stable period resets the counter', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', 1);
    harness.timers.advance(250);
    await waitFor(() => harness.spawnCount() === 2, { description: 'the second spawn' });
    await exitAndWait(harness, 'backoff', 1);
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    harness.timers.advance(499);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    harness.timers.advance(1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(3);
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
    harness.timers.advance(STABLE_AFTER_MS - 1);
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    harness.timers.advance(1);
    expect(harness.manager.health().consecutiveFailures).toBe(0);
    await exitAndWait(harness, 'backoff', 1);
    harness.timers.advance(249);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(3);
    harness.timers.advance(1);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(4);
  });

  it('signal death restarts', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', null, 'SIGKILL');
    expect(harness.manager.health().lastExit).toMatchObject({ code: null, signal: 'SIGKILL', reason: 'signal' });
    harness.timers.advance(250);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
  });

  it('unexpected 0 restarts with backoff', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', 0);
    expect(harness.manager.health()).toMatchObject({ consecutiveFailures: 1, lastExit: { reason: 'unexpected-clean' } });
    harness.timers.advance(250);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
  });

  it('shutdown stop does not respawn', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    harness.port.last().ready();
    await waitFor(() => harness.manager.state() === 'ready');
    void harness.manager.stop('shutdown', 'term');
    await exitAndWait(harness, 'stopped', 0);
    expect(harness.timers.pending()).toEqual([]);
    harness.timers.advance(HELD_RETRY_MS);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
  });

  it('a child without a process stops at once on shutdown', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', 1);
    await expect(harness.manager.stop('shutdown', 'term')).resolves.toEqual({ killed: false, leaked: false });
    expect(harness.manager.state()).toBe('stopped');
    expect(harness.timers.pending()).toEqual([]);
    harness.timers.advance(HELD_RETRY_MS);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
  });

});

describe('spawn failures', () => {
  it('spawn error as a synchronous throw', async (context) => {
    const harness = createManagerHarness(context);
    const markerFds: number[] = [];
    harness.port.hook = (_command, _args, options) => {
      markerFds.push(options.stdio[4]);
    };
    harness.port.nextFailure = { kind: 'throw', error: errnoError('ENOENT', 'spawn ENOENT') };
    await harness.spawnInitial();
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(harness.manager.health().lastExit).toMatchObject({ code: null, signal: null, reason: 'spawn-failed' });
    expect(harness.manager.health().consecutiveFailures).toBe(1);
    expect(harness.timers.pending().some((timer) => timer.delayMs === STARTUP_TIMEOUT_MS)).toBe(false);
    expect(harness.markers()).toEqual([]);
    expect(markerFds).toHaveLength(1);
    expect(() => fs.fstatSync(markerFds[0] as number)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    harness.timers.advance(250);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
  });

  it('spawn error as an asynchronous error event without exit', async (context) => {
    const harness = createManagerHarness(context);
    const markerFds: number[] = [];
    harness.port.hook = (_command, _args, options) => {
      markerFds.push(options.stdio[4]);
    };
    harness.port.nextFailure = { kind: 'spawn-error', error: errnoError('ENOENT', 'spawn ENOENT') };
    await harness.spawnInitial();
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(harness.clock.now()).toBe(T0);
    expect(harness.manager.health().lastExit).toMatchObject({ code: null, signal: null, reason: 'spawn-failed' });
    expect(harness.timers.pending().some((timer) => timer.delayMs === STARTUP_TIMEOUT_MS)).toBe(false);
    expect(harness.markers()).toEqual([]);
    expect(() => fs.fstatSync(markerFds[0] as number)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('launcher throw, marker creation failure and spawn throw take the spawn-failure path', async (context) => {
    const launcherThrows = createManagerHarness(context, {
      launcher: () => {
        throw new TypeError('launcher exploded');
      },
    });
    await launcherThrows.spawnInitial();
    await waitFor(() => launcherThrows.manager.state() === 'backoff');
    await afterMicrotasks();
    expect(launcherThrows.spawnCount()).toBe(0);
    expect(launcherThrows.manager.health().lastExit?.reason).toBe('spawn-failed');
    expect(launcherThrows.markers()).toEqual([]);

    const markerFails = createManagerHarness(context);
    fs.chmodSync(markerFails.paths.markers.daemons, 0o500);
    await markerFails.spawnInitial();
    await waitFor(() => markerFails.manager.state() === 'backoff');
    await afterMicrotasks();
    expect(markerFails.spawnCount()).toBe(0);
    expect(markerFails.manager.health().lastExit?.reason).toBe('spawn-failed');
    fs.chmodSync(markerFails.paths.markers.daemons, 0o700);
    expect(markerFails.markers()).toEqual([]);

    const spawnThrows = createManagerHarness(context);
    spawnThrows.port.nextFailure = { kind: 'throw', error: new TypeError('The argument stdio is invalid') };
    await spawnThrows.spawnInitial();
    await waitFor(() => spawnThrows.manager.state() === 'backoff');
    await afterMicrotasks();
    expect(spawnThrows.spawnCount()).toBe(1);
    expect(spawnThrows.markers()).toEqual([]);
    for (const harness of [launcherThrows, markerFails, spawnThrows]) expect(harness.backgroundErrors).toEqual([]);
  });
});

describe('stop', () => {
  it('stop is idempotent', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const first = harness.manager.stop('shutdown', 'term');
    const second = harness.manager.stop('shutdown', 'term');
    expect(second).toBe(first);
    await stopLineWritten();
    expect(harness.port.last().signals).toEqual(['SIGTERM']);

    const upgraded = createManagerHarness(context);
    await upgraded.spawnInitial();
    upgraded.timers.advance(STARTUP_TIMEOUT_MS);
    await stopLineWritten();
    expect(upgraded.port.last().signals).toEqual(['SIGTERM']);
    void upgraded.manager.stop('shutdown', 'term');
    expect(upgraded.port.last().signals).toEqual(['SIGTERM']);
    expect(upgraded.events('child.stop').at(-1)).toMatchObject({ stop: 'shutdown', mode: 'term', superseded: 'startup-timeout' });
    await exitAndWait(upgraded, 'stopped', 0);
    expect(upgraded.manager.health().lastExit?.reason).toBe('requested');
    expect(upgraded.timers.pending()).toEqual([]);
  });

  it('a lower-ranked stop does not replace the recorded reason', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term');
    void harness.manager.stop('startup-timeout', 'term');
    await exitAndWait(harness, 'stopped', 0);
    expect(harness.manager.health().lastExit?.reason).toBe('requested');
  });

  it('stop escalation sends SIGINT once', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term');
    await stopLineWritten();
    void harness.manager.stop('shutdown', 'int');
    void harness.manager.stop('shutdown', 'int');
    expect(harness.port.last().signals).toEqual(['SIGTERM', 'SIGINT']);
    harness.timers.advance(RUNTIME_ABORT_BUDGET_MS - 1);
    expect(harness.port.last().groupKills).toBe(0);
    harness.timers.advance(1);
    expect(harness.port.last().groupKills).toBe(1);
  });

  it('the shutdown budget of the runtime ends in SIGKILL of the group', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term');
    harness.timers.advance(RUNTIME_SHUTDOWN_BUDGET_MS - 1);
    expect(harness.port.last().groupKills).toBe(0);
    harness.timers.advance(1);
    expect(harness.port.last().groupKills).toBe(1);
  });

  it('the gateway budgets are the stop and abort budgets of the stop values, counted from the stop begin, with the signal sent once the stop line is written', async (context) => {
    const harness = createManagerHarness(context, { role: 'gateway' });
    await harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term', DEFAULT_STOP_VALUES);
    harness.timers.advance(gatewayStopBudgetMs(DEFAULT_STOP_VALUES) - 1);
    expect(harness.port.last().groupKills).toBe(0);
    harness.timers.advance(1);
    expect(harness.port.last().groupKills).toBe(1);
    const aborted = createManagerHarness(context, { role: 'gateway' });
    await aborted.spawnInitial();
    void aborted.manager.stop('shutdown', 'int', DEFAULT_STOP_VALUES);
    expect(aborted.port.last().signals).toEqual([]);
    await stopLineWritten();
    expect(aborted.port.last().signals).toEqual(['SIGINT']);
    aborted.timers.advance(gatewayAbortBudgetMs(DEFAULT_STOP_VALUES) - 1);
    expect(aborted.port.last().groupKills).toBe(0);
    aborted.timers.advance(1);
    expect(aborted.port.last().groupKills).toBe(1);
  });

  it('SIGKILL that never exits is bounded', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const stopped = harness.manager.stop('shutdown', 'term');
    harness.timers.advance(RUNTIME_SHUTDOWN_BUDGET_MS);
    expect(harness.port.last().groupKills).toBe(1);
    harness.timers.advance(KILL_CONFIRM_MS - 1);
    expect(harness.manager.state()).toBe('stopping');
    harness.timers.advance(1);
    await expect(stopped).resolves.toEqual({ killed: true, leaked: true });
    expect(harness.manager.state()).toBe('stopped');
    expect(harness.events('child.unkillable')).toEqual([expect.objectContaining({ level: 'error', child: 'runtime', childPid: 41_000 })]);
    harness.port.last().exit(null, 'SIGKILL');
    await afterMicrotasks();
    expect(harness.manager.state()).toBe('stopped');
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
  });

  it('stop signals the pid and kills the group', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const stopped = harness.manager.stop('shutdown', 'term');
    await stopLineWritten();
    void harness.manager.stop('shutdown', 'int');
    harness.timers.advance(RUNTIME_ABORT_BUDGET_MS);
    const child = harness.port.last();
    expect(child.signals).toEqual(['SIGTERM', 'SIGINT']);
    expect(child.signals).not.toContain('SIGKILL');
    expect(child.groupKills).toBe(1);
    child.exit(null, 'SIGKILL');
    await expect(stopped).resolves.toEqual({ killed: true, leaked: false });
  });
});

describe('exit handling mechanics', () => {
  it('an exit while draining does not reap in line', async (context) => {
    const draining = createManagerHarness(context);
    await draining.spawnInitial();
    const marker = draining.markers()[0];
    draining.draining.value = true;
    draining.manager.enterDraining();
    await exitAndWait(draining, 'stopped', 1);
    await afterMicrotasks();
    expect(draining.reapCalls).toEqual([]);
    expect(draining.manager.unreapedMarkers()).toEqual([`${draining.paths.markers.daemons}/${marker}`]);
    expect(draining.timers.pending()).toEqual([]);

    const running = createManagerHarness(context);
    await running.spawnInitial();
    const runningMarker = running.markers()[0];
    await exitAndWait(running, 'backoff', 1);
    expect(running.reapCalls).toEqual([{ marker: `${running.paths.markers.daemons}/${runningMarker}`, killGraceMs: 2000, label: 'daemon' }]);
    expect(running.manager.unreapedMarkers()).toEqual([]);
  });

  it('lifeline socket is destroyed after the exit', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    expect(child.lifeline.destroyed).toBe(false);
    await exitAndWait(harness, 'backoff', 1);
    expect(child.lifeline.destroyed).toBe(true);
  });

  it('stdio flush bound', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.exit(1, null, { endPipes: false });
    await afterMicrotasks();
    harness.timers.advance(STDIO_FLUSH_MS - 1);
    await afterMicrotasks();
    expect(harness.manager.state()).toBe('starting');
    harness.timers.advance(1);
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it('partial last stderr line is flushed before the exit is recorded', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const child = harness.port.last();
    child.stderr.write('no trailing newline');
    await exitAndWait(harness, 'backoff', 1);
    const lines = harness.logLines();
    const stderrIndex = lines.findIndex((line) => line['msg'] === 'child.stderr' && line['raw'] === 'no trailing newline');
    const exitIndex = lines.findIndex((line) => line['msg'] === 'child.exit');
    expect(stderrIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(stderrIndex);
    expect(lines[exitIndex]).toMatchObject({ child: 'runtime', code: 1, reason: 'failure', restarts: 0 });
  });
});

describe('draining is enforced by the manager', () => {
  const beginDraining = {
    'the draining flag and enterDraining': (harness: ManagerHarness): void => {
      harness.draining.value = true;
      harness.manager.enterDraining();
    },
    'the draining flag alone': (harness: ManagerHarness): void => {
      harness.draining.value = true;
    },
  };

  describe.each(Object.entries(beginDraining))('after %s', (_name, drain) => {
    it('a direct spawnWith spawns nothing', async (context) => {
      const harness = createManagerHarness(context);
      drain(harness);
      await harness.manager.spawnWith(harness.settings.snapshot(), 'initial');
      harness.timers.advance(HELD_RETRY_MS);
      await afterMicrotasks();
      expect(harness.spawnCount()).toBe(0);
      expect(harness.events('child.spawn')).toEqual([]);
      expect(harness.markers()).toEqual([]);
      expect(harness.manager.state()).not.toBe('starting');
    });

    it('a direct spawnFresh spawns nothing', async (context) => {
      const harness = createManagerHarness(context);
      drain(harness);
      harness.manager.spawnFresh('backoff');
      harness.timers.advance(HELD_RETRY_MS);
      await afterMicrotasks();
      expect(harness.spawnCount()).toBe(0);
      expect(harness.events('child.spawn')).toEqual([]);
      expect(harness.markers()).toEqual([]);
    });

    it('retryHeld of a held child spawns nothing', async (context) => {
      const harness = createManagerHarness(context);
      await harness.spawnInitial();
      await exitAndWait(harness, 'held-config', 78);
      drain(harness);
      harness.manager.retryHeld();
      harness.timers.advance(HELD_RETRY_MS);
      await afterMicrotasks();
      expect(harness.spawnCount()).toBe(1);
      expect(spawnReasons(harness)).toEqual(['initial']);
      expect(harness.manager.state()).not.toBe('starting');
    });
  });
});

const settledWithin = async <T>(promise: Promise<T>): Promise<{ settled: true; value: T } | { settled: false }> => {
  let outcome: { settled: true; value: T } | { settled: false } = { settled: false };
  void promise.then((value) => {
    outcome = { settled: true, value };
  });
  await afterMicrotasks();
  return outcome;
};

const neverSettles = (): Promise<{ removed: boolean }> => new Promise(() => undefined);

describe('a life without a process', () => {
  it('a stop issued before the spawn error sends no signal and settles once the error arrives', async (context) => {
    const harness = createManagerHarness(context);
    harness.port.nextFailure = { kind: 'spawn-error', error: errnoError('ENOENT', 'spawn ENOENT') };
    harness.port.onSignal = (child, signal) => {
      if (signal === 'group' && child.pid === undefined) throw errnoError('ESRCH', 'kill ESRCH');
    };
    await harness.spawnInitial();
    const stopping = harness.manager.stop('shutdown', 'term');
    expect(harness.port.last().signals).toEqual([]);
    const outcome = await settledWithin(stopping);
    expect(outcome).toEqual({ settled: true, value: { killed: false, leaked: false } });
    expect(harness.manager.state()).toBe('stopped');
    expect(harness.port.last().signals).toEqual([]);
    expect(harness.port.last().groupKills).toBe(0);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.manager.health().lastExit?.reason).toBe('spawn-failed');
    harness.timers.advance(STARTUP_TIMEOUT_MS * 2);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(1);
    expect(harness.backgroundErrors).toEqual([]);
  });

  it('a startup timeout before the spawn error sends no signal, backs off and respawns', async (context) => {
    const harness = createManagerHarness(context);
    harness.port.nextFailure = { kind: 'spawn-error', error: errnoError('ENOENT', 'spawn ENOENT') };
    await harness.spawnInitial();
    harness.timers.advance(STARTUP_TIMEOUT_MS);
    await afterMicrotasks();
    expect(harness.port.last().signals).toEqual([]);
    expect(harness.manager.state()).toBe('backoff');
    expect(harness.events('child.backoff')).toHaveLength(1);
    const backoffDelay = harness.events('child.backoff')[0]?.['delayMs'];
    expect(typeof backoffDelay).toBe('number');
    harness.timers.advance(backoffDelay as number);
    await afterMicrotasks();
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    expect(spawnReasons(harness)).toEqual(['initial', 'backoff']);
    expect(harness.backgroundErrors).toEqual([]);
  });

  it('settings-read failure while draining goes to stopped and arms nothing', async (context) => {
    const harness = createManagerHarness(context);
    harness.draining.value = true;
    harness.manager.failWithoutProcess('settings-read-failed');
    expect(harness.manager.state()).toBe('stopped');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.events('child.backoff')).toEqual([]);
  });

  it('a spawn error that arrives while draining goes to stopped and arms nothing', async (context) => {
    const harness = createManagerHarness(context);
    harness.port.nextFailure = { kind: 'spawn-error', error: errnoError('ENOENT', 'spawn ENOENT') };
    await harness.spawnInitial();
    harness.draining.value = true;
    await afterMicrotasks();
    expect(harness.manager.state()).toBe('stopped');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.events('child.backoff')).toEqual([]);
  });
});

describe('stops of a life whose exit is still being handled', () => {
  it('a stop of an exited life settles even when a newer life started before its handler finished', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const first = harness.port.last();
    first.exit(1, null, { endPipes: false });
    await afterMicrotasks();
    const stopping = harness.manager.stop('shutdown', 'term');
    await harness.manager.spawnWith(harness.settings.snapshot(), 'initial');
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(2);
    harness.timers.advance(STDIO_FLUSH_MS);
    const outcome = await settledWithin(stopping);
    expect(outcome).toEqual({ settled: true, value: { killed: false, leaked: false } });
    expect(harness.manager.health().pid).toBe(harness.port.last().pid);
  });

  it('a stop of an exited life whose reap never settles returns at once', async (context) => {
    const harness = createManagerHarness(context);
    harness.reapResult = neverSettles;
    await harness.spawnInitial();
    harness.port.last().exit(1);
    await waitFor(() => harness.reapCalls.length === 1, { description: 'exit-handler reap started' });
    const outcome = await settledWithin(harness.manager.stop('shutdown', 'term'));
    expect(outcome).toEqual({ settled: true, value: { killed: false, leaked: false } });
  });

  it('the marker of an in-flight exit-handler reap is visible as unreaped while the reap runs', async (context) => {
    const harness = createManagerHarness(context);
    harness.reapResult = neverSettles;
    await harness.spawnInitial();
    harness.port.last().exit(1);
    await waitFor(() => harness.reapCalls.length === 1, { description: 'exit-handler reap started' });
    expect(harness.manager.unreapedMarkers()).toEqual([harness.reapCalls[0]?.marker]);
  });

  it('a removed in-flight reap clears the marker from unreaped', async (context) => {
    const harness = createManagerHarness(context);
    let finishReap: (value: { removed: boolean }) => void = () => undefined;
    harness.reapResult = () =>
      new Promise((resolve) => {
        finishReap = resolve;
      });
    await harness.spawnInitial();
    harness.port.last().exit(1);
    await waitFor(() => harness.reapCalls.length === 1, { description: 'exit-handler reap started' });
    expect(harness.manager.unreapedMarkers()).toEqual([harness.reapCalls[0]?.marker]);
    finishReap({ removed: true });
    await waitFor(() => harness.manager.state() === 'backoff', { description: 'exit handled' });
    expect(harness.manager.unreapedMarkers()).toEqual([]);
  });
});

describe('consecutiveFailures across held-config retries', () => {
  it('a settings-change retry resets the counter and a timer retry leaves it unchanged', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    await exitAndWait(harness, 'backoff', 1);
    harness.timers.advance(STABLE_AFTER_MS);
    await waitFor(() => harness.spawnCount() === 2, { description: 'second spawn' });
    await exitAndWait(harness, 'backoff', 1);
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    harness.timers.advance(STABLE_AFTER_MS);
    await waitFor(() => harness.spawnCount() === 3, { description: 'third spawn' });
    await exitAndWait(harness, 'held-config', 78);
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    harness.timers.advance(HELD_RETRY_MS);
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(4);
    expect(spawnReasons(harness).at(-1)).toBe('held-retry');
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    await exitAndWait(harness, 'held-config', 78);
    expect(harness.manager.health().consecutiveFailures).toBe(2);
    harness.manager.retryHeld();
    await afterMicrotasks();
    expect(harness.spawnCount()).toBe(5);
    expect(spawnReasons(harness).at(-1)).toBe('settings-change');
    expect(harness.manager.health().consecutiveFailures).toBe(0);
  });
});

const HOOK_TIMEOUT_MS = 12_345;

const hookTimers = (harness: ManagerHarness): number => harness.timers.pending().filter((timer) => timer.delayMs === HOOK_TIMEOUT_MS).length;

describe('awaitLeave', () => {
  it('resolves with ready on a ready line', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const leaving = harness.manager.awaitLeave('starting', { timeoutMs: HOOK_TIMEOUT_MS, signal: new AbortController().signal });
    expect(hookTimers(harness)).toBe(1);
    harness.port.last().ready();
    await expect(leaving).resolves.toBe('ready');
    expect(hookTimers(harness)).toBe(0);
  });

  it('resolves with the resulting state on an exit', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const leaving = harness.manager.awaitLeave('starting', { timeoutMs: HOOK_TIMEOUT_MS, signal: new AbortController().signal });
    harness.port.last().exit(1);
    await expect(leaving).resolves.toBe('backoff');
    expect(hookTimers(harness)).toBe(0);
  });

  it('resolves with backoff on the no-process failure path', async (context) => {
    const harness = createManagerHarness(context);
    harness.port.nextFailure = { kind: 'spawn-error', error: errnoError('ENOENT', 'spawn ENOENT') };
    await harness.spawnInitial();
    const leaving = harness.manager.awaitLeave('starting', { timeoutMs: HOOK_TIMEOUT_MS, signal: new AbortController().signal });
    await expect(leaving).resolves.toBe('backoff');
    expect(hookTimers(harness)).toBe(0);
  });

  it('resolves with stopped on unkillable', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    void harness.manager.stop('shutdown', 'term');
    const leaving = harness.manager.awaitLeave('stopping', { timeoutMs: HOOK_TIMEOUT_MS * 10, signal: new AbortController().signal });
    await harness.timers.advanceAsync(RUNTIME_SHUTDOWN_BUDGET_MS + KILL_CONFIRM_MS);
    await expect(leaving).resolves.toBe('stopped');
    expect(harness.events('child.unkillable')).toHaveLength(1);
    expect(harness.timers.pending().filter((timer) => timer.delayMs === HOOK_TIMEOUT_MS * 10)).toEqual([]);
  });

  it('resolves with starting at timeoutMs', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const leaving = harness.manager.awaitLeave('starting', { timeoutMs: HOOK_TIMEOUT_MS, signal: new AbortController().signal });
    harness.timers.advance(HOOK_TIMEOUT_MS - 1);
    expect((await settledWithin(leaving)).settled).toBe(false);
    harness.timers.advance(1);
    await expect(leaving).resolves.toBe('starting');
    expect(hookTimers(harness)).toBe(0);
  });

  it('resolves with starting when the signal aborts', async (context) => {
    const harness = createManagerHarness(context);
    await harness.spawnInitial();
    const controller = new AbortController();
    const leaving = harness.manager.awaitLeave('starting', { timeoutMs: HOOK_TIMEOUT_MS, signal: controller.signal });
    controller.abort();
    await expect(leaving).resolves.toBe('starting');
    expect(hookTimers(harness)).toBe(0);
  });
});
