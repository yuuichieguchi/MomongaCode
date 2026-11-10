import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHolders, hostKernelLock, inspectProcessLock } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { ORPHAN_REAP_GRACE_MS } from '@momonga/supervisor';
import { LOCK_HOLDER_MAIN, firstGeneration } from '@momonga/testkit';
import type { ChildRole } from '@momonga/supervisor';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { readLog, supervisorLog } from './support/log-reader.ts';
import type { LogRecord } from './support/log-reader.ts';
import { isAlive } from './support/process.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { LAUNCHER_PATH, productSandbox } from './support/sandbox.ts';
import { DEFAULT_E2E_DEPS, baseSettings, spawnSupervisor, startStack, writeSettingsFile } from './support/stack.ts';
import type { SpawnedSupervisor, SupervisorExit } from './support/stack.ts';
import { childOf, createSupervisorClient, pidOf } from './support/supervisor-client.ts';
import type { E2eDeps } from './support/supervisor-main.ts';
import type { SupervisorClient } from './support/supervisor-client.ts';
import {
  E2E_HELD_RETRY_MS,
  E2E_LOCK_FREE_BOUND_MS,
  E2E_MARGIN_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  E2E_ORPHAN_GRACE_MS,
  E2E_PHASE2_REACHED_BOUND_MS,
  E2E_READY_DEADLINE_MS,
  E2E_REAP_CLOSE_BOUND_MS,
  E2E_REAP_TO_RUNNING_BOUND_MS,
  E2E_RESTART_BOUND_MS,
  E2E_RESTART_POLICY,
  E2E_SETTINGS_RESTART_BOUND_MS,
  E2E_SETTINGS_SEEN_BOUND_MS,
  E2E_SUPERVISOR_CLOSE_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  until,
  e2eStartBoundMs,
  e2eTestTimeoutMs,
} from './support/wait.ts';

const S1C_PHASE1_ORPHAN_GRACE_MS = 30_000;
const S7_LOCK_WAIT_MS = 1500;
const KILLED_STACK_BOUND_MS = E2E_READY_DEADLINE_MS + E2E_MARGIN_MS;
const S1_TIMEOUT_MS = e2eTestTimeoutMs(
  E2E_READY_DEADLINE_MS,
  E2E_MARGIN_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  2 * E2E_ORPHAN_CLOSE_BOUND_MS,
  e2eStartBoundMs(DEFAULT_E2E_DEPS),
  E2E_READY_DEADLINE_MS,
);
const S1B_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({ ...DEFAULT_E2E_DEPS, orphanGraceMs: E2E_ORPHAN_GRACE_MS }), E2E_MARGIN_MS, E2E_REAP_TO_RUNNING_BOUND_MS);
const S1C_PHASE1_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({ ...DEFAULT_E2E_DEPS, orphanGraceMs: S1C_PHASE1_ORPHAN_GRACE_MS }), E2E_MARGIN_MS, E2E_REAP_CLOSE_BOUND_MS);
const S1C_PHASE2_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({ ...DEFAULT_E2E_DEPS, orphanGraceMs: E2E_ORPHAN_GRACE_MS }), E2E_PHASE2_REACHED_BOUND_MS, E2E_REAP_CLOSE_BOUND_MS);
const S5_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_SETTINGS_RESTART_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const S5B_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_HELD_RETRY_MS + E2E_RESTART_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const S7_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_MARGIN_MS, E2E_LOCK_FREE_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const HANDS_LOCK_TO_CHILD = hostKernelLock().claimInheritable !== undefined;
const FIXTURE_SLEEP_SECONDS = '300';
const CHANGED_MODEL = 'system-changed';

type Settings = Record<string, unknown>;

const named = (records: readonly LogRecord[], msg: string): LogRecord[] => records.filter((record) => record.msg === msg);

const ofChild = (records: readonly LogRecord[], msg: string, role: ChildRole): LogRecord[] => named(records, msg).filter((record) => record.child === role);

const indexOf = (records: readonly LogRecord[], predicate: (record: LogRecord) => boolean): number => {
  const index = records.findIndex(predicate);
  if (index < 0) throw new Error('expected record not found');
  return index;
};

const roleRecordsOf = (paths: MomongaPaths, role: ChildRole, pid: number): LogRecord[] => readLog(paths.logFiles[role]).filter((record) => record.pid === pid);

const readSettings = (home: E2eHome): Settings => JSON.parse(fs.readFileSync(home.paths.settingsFile, 'utf8')) as Settings;

const editSettings = (home: E2eHome, edit: (settings: Settings) => Settings): void => {
  writeSettingsFile(home, edit(readSettings(home)));
};

const withChangedModel = (settings: Settings): Settings => {
  const models = settings.models as { targets: Record<string, Record<string, unknown>> } & Settings;
  const primary = models.targets['primary'];
  if (primary === undefined) throw new Error('settings have no primary target');
  return { ...settings, models: { ...models, targets: { ...models.targets, primary: { ...primary, model: CHANGED_MODEL } } } };
};

const appliedModelOf = (home: E2eHome): unknown => {
  const file = firstGeneration(home.paths).settingsApplied;
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { settings?: { models?: { targets?: Record<string, { model?: unknown }> } } };
  return record.settings?.models?.targets?.['primary']?.model;
};

const trackExit = (supervisor: SpawnedSupervisor): (() => SupervisorExit | undefined) => {
  let settled: SupervisorExit | undefined;
  void supervisor.exited.then((exit) => {
    settled = exit;
  });
  return () => settled;
};

const startSleepFixture = async (home: E2eHome): Promise<number> => {
  const child = spawn('/bin/sleep', [FIXTURE_SLEEP_SECONDS], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleep fixture did not start');
  await home.ledger.add(pid, 'fixture');
  registerE2eCleanup(() => {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  });
  return pid;
};

const startLockHolderFixture = async (home: E2eHome, lockPath: string): Promise<number> => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [LOCK_HOLDER_MAIN, lockPath], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('lock holder fixture did not start');
  await home.ledger.add(pid, 'fixture');
  registerE2eCleanup(() => {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => reject(new Error('lock holder fixture exited before holding the lock')));
    child.stdout?.once('data', () => resolve());
  });
  return pid;
};

const writeStaleLock = (lockPath: string, pid: number): void => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, String(pid), { mode: 0o600 });
};

const openClient = (home: E2eHome): SupervisorClient => {
  const client = createSupervisorClient(home);
  registerE2eCleanup(() => client.close());
  return client;
};

const openRuntimeClient = (home: E2eHome): RuntimeClient => {
  const client = createRuntimeClient(home);
  registerE2eCleanup(() => client.close());
  return client;
};

const spawnNextSupervisor = async (home: E2eHome, deps: E2eDeps, stackNumber: number): Promise<SpawnedSupervisor> => {
  const supervisor = spawnSupervisor({ home, deps, stackNumber });
  await home.ledger.add(supervisor.pid, 'supervisor');
  registerE2eCleanup(() => {
    if (isAlive(supervisor.pid)) process.kill(supervisor.pid, 'SIGKILL');
  });
  return supervisor;
};

const markerEntries = (paths: MomongaPaths): string[] => fs.readdirSync(paths.markers.daemons).sort();

const bothReady = (health: SupervisorHealth): boolean =>
  health.phase === 'running' && childOf(health, 'runtime').state === 'ready' && childOf(health, 'gateway').state === 'ready';

const stopRuntimeAndKillSupervisor = async (home: E2eHome): Promise<{ orphanPid: number; gatewayPid: number; firstPid: number }> => {
  const stack = await startStack({ home });
  const before = await stack.client.health();
  const orphanPid = pidOf(before, 'runtime');
  const gatewayPid = pidOf(before, 'gateway');
  process.kill(orphanPid, 'SIGSTOP');
  registerE2eCleanup(() => {
    if (isAlive(orphanPid)) process.kill(orphanPid, 'SIGKILL');
  });
  const firstExit = trackExit(stack.supervisor);
  process.kill(stack.supervisor.pid, 'SIGKILL');
  await until(() => firstExit(), { deadlineMs: E2E_MARGIN_MS, description: 'first supervisor gone after SIGKILL' });
  expect(isAlive(orphanPid)).toBe(true);
  return { orphanPid, gatewayPid, firstPid: stack.ready.pid };
};

describe('supervisor cases', () => {
  it(titleOf('s1'), { timeout: S1_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');
    expect(home.ledger.entries().map((entry) => entry.pgid)).toEqual(expect.arrayContaining([runtimePid, gatewayPid, stack.supervisor.pid]));

    const firstExit = trackExit(stack.supervisor);
    process.kill(stack.supervisor.pid, 'SIGKILL');
    const exit = await until(() => firstExit(), { deadlineMs: E2E_MARGIN_MS, description: 'supervisor gone after SIGKILL' });
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });

    await until(() => !isAlive(runtimePid) && !isAlive(gatewayPid), { deadlineMs: E2E_ORPHAN_CLOSE_BOUND_MS, description: 'both daemons closed after the lifeline EOF' });
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime)).toEqual({ state: 'free' });
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.gateway)).toEqual({ state: 'free' });

    for (const [role, pid] of [['runtime', runtimePid], ['gateway', gatewayPid]] as const) {
      const exitLine = await until(() => named(roleRecordsOf(home.paths, role, pid), 'entry.exit')[0], {
        deadlineMs: E2E_ORPHAN_CLOSE_BOUND_MS,
        description: `${role}.log entry.exit of pid ${pid}`,
      });
      expect(exitLine).toMatchObject({ service: role, path: 'close', trigger: 'lifeline', clean: true, code: 0, suppressedUncaught: 0 });
      expect(named(roleRecordsOf(home.paths, role, pid), 'entry.exit')).toHaveLength(1);
      expect(named(roleRecordsOf(home.paths, role, pid), 'entry.uncaught')).toEqual([]);
    }

    const killed = supervisorLog(home.paths, stack.ready.pid);
    expect(ofChild(killed, 'child.spawn', 'runtime')).toHaveLength(1);
    expect(ofChild(killed, 'child.spawn', 'gateway')).toHaveLength(1);
    expect(named(killed, 'shutdown.begin')).toEqual([]);
    expect(named(killed, 'entry.exit')).toEqual([]);
    expect(named(killed, 'child.exit')).toEqual([]);

    const second = await spawnNextSupervisor(home, { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY }, 2);
    const secondReady = await second.ready();
    expect(secondReady.pid).toBe(second.pid);
    const client = openClient(home);
    const after = await until(async () => {
      const health = await client.health();
      return bothReady(health) ? health : undefined;
    }, { deadlineMs: E2E_READY_DEADLINE_MS, description: 'follow-up supervisor running with both children ready' });
    expect(after.pid).toBe(second.pid);
    for (const role of ['runtime', 'gateway'] as const) {
      expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
      expect(childOf(after, role).lastExit).toBeUndefined();
    }
    expect(pidOf(after, 'runtime')).not.toBe(runtimePid);
    expect(pidOf(after, 'gateway')).not.toBe(gatewayPid);
    const followUp = supervisorLog(home.paths, second.pid);
    expect(named(followUp, 'orphans.reaped')).toEqual([expect.objectContaining({ kept: 0 })]);
    const followUpMarkers = markerEntries(home.paths);
    expect(followUpMarkers.filter((entry) => entry.startsWith('runtime-'))).toHaveLength(1);
    expect(followUpMarkers.filter((entry) => entry.startsWith('gateway-'))).toHaveLength(1);
    expect(followUpMarkers).toHaveLength(2);
    expect(ofChild(followUp, 'child.spawn', 'runtime')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0, childPid: pidOf(after, 'runtime') })]);
    expect(ofChild(followUp, 'child.spawn', 'gateway')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0, childPid: pidOf(after, 'gateway') })]);
  });

  it(titleOf('s1b'), { timeout: S1B_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);

    const second = await spawnNextSupervisor(home, { ...DEFAULT_E2E_DEPS, orphanGraceMs: E2E_ORPHAN_GRACE_MS }, 2);
    const secondReady = await second.ready();
    expect(secondReady).toMatchObject({ service: 'supervisor', pid: second.pid });
    const client = openClient(home);

    for (let reading = 0; reading < 3; reading += 1) {
      const health = await client.health();
      expect(health.pid).toBe(second.pid);
      expect(health.phase).toBe('reaping-orphans');
      for (const role of ['runtime', 'gateway'] as const) {
        const child = childOf(health, role);
        expect(child.state).toBe('pending');
        expect(child.pid).toBeUndefined();
        expect(child.restarts).toBe(0);
      }
      expect(named(supervisorLog(home.paths, second.pid), 'child.spawn')).toEqual([]);
      expect(isAlive(orphanPid)).toBe(true);
    }
    const waiting = await until(() => named(supervisorLog(home.paths, second.pid), 'orphans.waiting')[0], {
      deadlineMs: E2E_MARGIN_MS,
      description: 'orphans.waiting of the second supervisor',
    });
    expect(waiting.holders).toBeGreaterThanOrEqual(1);

    const after = await until(async () => {
      const health = await client.health();
      return bothReady(health) ? health : undefined;
    }, { deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS, description: 'second supervisor running after the reap' });
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
    expect(pidOf(after, 'runtime')).not.toBe(orphanPid);
    expect(isAlive(orphanPid)).toBe(false);

    const records = supervisorLog(home.paths, second.pid);
    const reaped = named(records, 'orphans.reaped');
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.kept).toBe(0);
    expect(reaped[0]?.reaped).toBeGreaterThanOrEqual(1);
    expect(indexOf(records, (record) => record.msg === 'orphans.reaping')).toBeLessThan(indexOf(records, (record) => record.msg === 'orphans.reaped'));
    expect(indexOf(records, (record) => record.msg === 'orphans.reaped')).toBeLessThan(indexOf(records, (record) => record.msg === 'child.spawn'));
    expect(ofChild(records, 'child.exit', 'runtime').filter((record) => record.code === 75)).toEqual([]);
    expect(ofChild(records, 'child.spawn', 'runtime')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0 })]);
    expect(markerEntries(home.paths).filter((entry) => entry.startsWith('runtime-'))).toHaveLength(1);
  });

  it(titleOf('s1c-phase1'), { timeout: S1C_PHASE1_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);
    const orphanMarkers = markerEntries(home.paths);

    const second = await spawnNextSupervisor(home, { ...DEFAULT_E2E_DEPS, orphanGraceMs: S1C_PHASE1_ORPHAN_GRACE_MS }, 2);
    await second.ready();
    const secondExit = trackExit(second);
    const client = openClient(home);
    await client.untilPhase('reaping-orphans', E2E_MARGIN_MS);

    const postedAt = Date.now();
    const shutdown = await client.shutdown();
    expect(shutdown).toEqual({ status: 202, body: { phase: 'draining' } });
    const exit = await until(() => secondExit(), { deadlineMs: E2E_REAP_CLOSE_BOUND_MS, description: 'supervisor exit after a shutdown during phase 1' });
    expect(Date.now() - postedAt).toBeLessThan(E2E_REAP_CLOSE_BOUND_MS);
    expect(exit).toEqual({ code: 0, signal: null });

    const records = supervisorLog(home.paths, second.pid);
    expect(named(records, 'child.spawn')).toEqual([]);
    expect(named(records, 'orphans.reaping')).toEqual([]);
    const last = records.at(-1);
    expect(last).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', trigger: 'request', clean: true });
    expect(records.at(-2)?.msg).toBe('shutdown.end');
    expect(named(records, 'entry.exit')).toHaveLength(1);

    expect(isAlive(orphanPid)).toBe(true);
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime)).toEqual({ state: 'held', pid: orphanPid });
    const entries = markerEntries(home.paths);
    expect(entries).toEqual(orphanMarkers);
    const runtimeMarkers = entries.filter((entry) => entry.startsWith('runtime-'));
    expect(runtimeMarkers).toHaveLength(1);
    expect(entries.filter((entry) => entry.startsWith('gateway-'))).toHaveLength(1);
    expect(entries).toHaveLength(2);
    expect(await findHolders(path.join(home.paths.markers.daemons, runtimeMarkers[0] ?? ''), { signal: new AbortController().signal })).toContain(orphanPid);
    expect(fs.existsSync(firstGeneration(home.paths).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.supervisor)).toEqual({ state: 'free' });
  });

  it(titleOf('s1c-phase2'), { timeout: S1C_PHASE2_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);

    const second = await spawnNextSupervisor(home, { ...DEFAULT_E2E_DEPS, orphanGraceMs: E2E_ORPHAN_GRACE_MS }, 2);
    await second.ready();
    const secondExit = trackExit(second);
    const client = openClient(home);
    await until(() => named(supervisorLog(home.paths, second.pid), 'orphans.reaping')[0], {
      deadlineMs: E2E_PHASE2_REACHED_BOUND_MS,
      description: 'orphans.reaping of the second supervisor',
    });
    expect((await client.health()).phase).toBe('reaping-orphans');
    expect(isAlive(orphanPid)).toBe(true);

    const postedAt = Date.now();
    const shutdown = await client.shutdown();
    expect(shutdown).toEqual({ status: 202, body: { phase: 'draining' } });
    const exit = await until(() => secondExit(), { deadlineMs: E2E_REAP_CLOSE_BOUND_MS, description: 'supervisor exit after a shutdown during phase 2' });
    expect(Date.now() - postedAt).toBeLessThan(ORPHAN_REAP_GRACE_MS);
    expect(exit).toEqual({ code: 0, signal: null });

    expect(isAlive(orphanPid)).toBe(true);
    const runtimeMarkers = markerEntries(home.paths).filter((entry) => entry.startsWith('runtime-'));
    expect(runtimeMarkers).toHaveLength(1);
    expect(await findHolders(path.join(home.paths.markers.daemons, runtimeMarkers[0] ?? ''), { signal: new AbortController().signal })).toContain(orphanPid);
    const records = supervisorLog(home.paths, second.pid);
    const reaped = named(records, 'orphans.reaped');
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.kept).toBeGreaterThanOrEqual(1);
    expect(named(records, 'child.spawn')).toEqual([]);
    expect(records.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', trigger: 'request', clean: true });
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.supervisor)).toEqual({ state: 'free' });
  });

  it.skipIf(skipCase('s2'))(titleOf('s2'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, needsBash: true, sandbox: productSandbox() });
    const runtime = openRuntimeClient(home);
    expect((await runtime.health()).sandbox).toBe(productSandbox());
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');
    const changedBefore = named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length;

    editSettings(home, (settings) => ({ ...settings, sandbox: 'none' }));
    await until(async () => {
      await runtime.createSession();
      return (await runtime.health()).sandbox === 'none' ? true : undefined;
    }, {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the runtime to take sandbox none in place for the next operation',
    });
    await until(() => (named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length === changedBefore + 1 ? true : undefined), {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the supervisor to log the sandbox change',
    });

    const after = await stack.client.health();
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0 });
    const records = supervisorLog(home.paths, stack.ready.pid);
    expect(named(records, 'child.stop')).toEqual([]);
    expect(named(records, 'child.exit')).toEqual([]);
    for (const role of ['runtime', 'gateway'] as const) expect(ofChild(records, 'child.spawn', role).map((record) => record.reason)).toEqual(['initial']);
  });

  it(titleOf('s3'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');
    const changedBefore = named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length;

    editSettings(home, withChangedModel);
    await until(() => (appliedModelOf(home) === CHANGED_MODEL ? true : undefined), {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the supervisor to record the models change as applied',
    });
    await until(() => (named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length === changedBefore + 1 ? true : undefined), {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the supervisor to log the models change',
    });

    const records = supervisorLog(home.paths, stack.ready.pid);
    expect(named(records, 'child.stop')).toEqual([]);
    expect(named(records, 'child.exit')).toEqual([]);
    for (const role of ['runtime', 'gateway'] as const) expect(ofChild(records, 'child.spawn', role).map((record) => record.reason)).toEqual(['initial']);
    const after = await stack.client.health();
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
  });

  it(titleOf('s4'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');
    const changedBefore = named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed').length;

    editSettings(home, (settings) => ({ ...settings, permissions: { allow: ['Read'] } }));
    const changed = await until(() => {
      const records = named(supervisorLog(home.paths, stack.ready.pid), 'settings.changed');
      return records.length === changedBefore + 1 ? records : undefined;
    }, { deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS, description: 'one more settings.changed after a permissions edit' });

    expect(changed.at(-1)).toMatchObject({ level: 'info', service: 'supervisor' });
    const records = supervisorLog(home.paths, stack.ready.pid);
    expect(named(records, 'child.stop')).toEqual([]);
    expect(named(records, 'child.exit')).toEqual([]);
    expect(named(records, 'child.spawn')).toHaveLength(2);
    const after = await stack.client.health();
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0 });
  });

  it(titleOf('s5'), { timeout: S5_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      sandbox: 'seatbelt',
      deps: { ...DEFAULT_E2E_DEPS, runtime: { ...DEFAULT_E2E_DEPS.runtime, sandboxExecPath: '/nonexistent' } },
      readiness: { phase: 'running', children: { runtime: 'held-config', gateway: 'ready' } },
    });
    const held = await stack.client.untilChild('runtime', (child) => child.state === 'held-config', E2E_RESTART_BOUND_MS);
    expect(held.pid).toBeUndefined();
    expect(held.restarts).toBe(0);
    expect(held.lastExit).toMatchObject({ code: 78, signal: null, reason: 'config' });
    expect(typeof held.heldReason).toBe('string');
    expect(held.heldReason).not.toBe('');
    const gatewayPid = pidOf(await stack.client.health(), 'gateway');

    const heldRecords = supervisorLog(home.paths, stack.ready.pid);
    expect(ofChild(heldRecords, 'child.spawn', 'runtime')).toHaveLength(1);
    expect(ofChild(heldRecords, 'child.exit', 'runtime')).toEqual([expect.objectContaining({ code: 78, reason: 'config' })]);
    expect(ofChild(heldRecords, 'child.held', 'runtime')).toEqual([expect.objectContaining({ source: 'child-exit' })]);
    expect(ofChild(heldRecords, 'child.backoff', 'runtime')).toEqual([]);

    editSettings(home, (settings) => ({ ...settings, sandbox: 'none' }));
    const ready = await stack.client.untilChild('runtime', (child) => child.state === 'ready', E2E_SETTINGS_RESTART_BOUND_MS);
    expect(ready).toMatchObject({ restarts: 1, consecutiveFailures: 0 });
    const after = await stack.client.health();
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    expect(childOf(after, 'gateway').restarts).toBe(0);
    const records = supervisorLog(home.paths, stack.ready.pid);
    expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['initial', 'settings-change']);
    expect(ofChild(records, 'child.held', 'runtime')).toHaveLength(1);
  });

  it.skipIf(skipCase('s5b'))(titleOf('s5b'), { timeout: S5B_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const sandboxExecPath = path.join(home.root, 'sbx');
    const stack = await startStack({
      home,
      needsBash: true,
      sandbox: productSandbox(),
      deps: { ...DEFAULT_E2E_DEPS, heldRetryMs: E2E_HELD_RETRY_MS, runtime: { ...DEFAULT_E2E_DEPS.runtime, sandboxExecPath } },
      readiness: { phase: 'running', children: { runtime: 'held-config', gateway: 'ready' } },
    });
    const held = await stack.client.untilChild('runtime', (child) => child.state === 'held-config', E2E_RESTART_BOUND_MS);
    expect(held.lastExit).toMatchObject({ code: 78, reason: 'config' });
    const gatewayPid = pidOf(await stack.client.health(), 'gateway');
    const settingsBefore = fs.readFileSync(home.paths.settingsFile, 'utf8');

    fs.symlinkSync(LAUNCHER_PATH[productSandbox()], sandboxExecPath);
    const ready = await stack.client.untilChild('runtime', (child) => child.state === 'ready', E2E_HELD_RETRY_MS + E2E_RESTART_BOUND_MS);
    expect(ready).toMatchObject({ restarts: 1, consecutiveFailures: 0 });
    expect(fs.readFileSync(home.paths.settingsFile, 'utf8')).toBe(settingsBefore);
    const runtime = openRuntimeClient(home);
    expect((await runtime.health()).sandbox).toBe(productSandbox());

    const after = await stack.client.health();
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    expect(childOf(after, 'gateway').restarts).toBe(0);
    const records = supervisorLog(home.paths, stack.ready.pid);
    const heldLines = ofChild(records, 'child.held', 'runtime');
    expect(heldLines).toEqual([expect.objectContaining({ source: 'child-exit' })]);
    expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['initial', 'held-retry']);
    expect(indexOf(records, (record) => record.msg === 'child.held' && record.child === 'runtime')).toBeLessThan(
      indexOf(records, (record) => record.msg === 'child.spawn' && record.child === 'runtime' && record.reason === 'held-retry'),
    );
    expect(named(records, 'settings.evaluated')).toEqual([]);
  });

  it(titleOf('s6'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      settingsText: '{ "models": ',
      readiness: { phase: 'running', children: { runtime: 'held-config', gateway: 'held-config' } },
    });
    const health = await stack.client.health();
    for (const role of ['runtime', 'gateway'] as const) {
      const child = childOf(health, role);
      expect(child.state).toBe('held-config');
      expect(child.pid).toBeUndefined();
      expect(child.restarts).toBe(0);
      expect(child.lastExit).toBeUndefined();
      expect(child.heldReason).not.toBe('');
    }
    const heldRecords = supervisorLog(home.paths, stack.ready.pid);
    expect(named(heldRecords, 'child.spawn')).toEqual([]);
    for (const role of ['runtime', 'gateway'] as const) expect(ofChild(heldRecords, 'child.held', role)).toEqual([expect.objectContaining({ source: 'settings' })]);

    writeSettingsFile(home, baseSettings(home, stack.sandbox));
    const after = await until(async () => {
      const current = await stack.client.health();
      return bothReady(current) ? current : undefined;
    }, { deadlineMs: E2E_SETTINGS_RESTART_BOUND_MS, description: 'both children ready after the settings fix' });
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ restarts: 0, consecutiveFailures: 0 });
    const records = supervisorLog(home.paths, stack.ready.pid);
    for (const role of ['runtime', 'gateway'] as const) {
      expect(ofChild(records, 'child.spawn', role)).toEqual([expect.objectContaining({ reason: 'settings-change', restarts: 0, childPid: pidOf(after, role) })]);
    }
  });

  it(titleOf('s7'), { timeout: S7_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const holderPid = await startLockHolderFixture(home, firstGeneration(home.paths).locks.runtime);
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime)).toEqual({ state: 'held', pid: holderPid });

    const stack = await startStack({ home, deps: { ...DEFAULT_E2E_DEPS, lockWaitMs: S7_LOCK_WAIT_MS }, readiness: false });
    const external = await stack.client.untilChild('runtime', (child) => child.state === 'external', E2E_RESTART_BOUND_MS);
    expect(external.restarts).toBe(0);
    expect(external.pid).toBeUndefined();
    const externalRecords = supervisorLog(home.paths, stack.ready.pid);
    expect(ofChild(externalRecords, 'child.external', 'runtime')).toEqual([expect.objectContaining({ holderPid })]);
    expect(ofChild(externalRecords, 'child.backoff', 'runtime')).toEqual([]);
    if (HANDS_LOCK_TO_CHILD) {
      expect(external.lastExit).toBeUndefined();
      expect(ofChild(externalRecords, 'child.spawn', 'runtime')).toEqual([]);
      expect(ofChild(externalRecords, 'child.exit', 'runtime')).toEqual([]);
    } else {
      expect(external.lastExit).toMatchObject({ code: 75, reason: 'lock-held' });
      expect(ofChild(externalRecords, 'child.spawn', 'runtime')).toHaveLength(1);
      expect(ofChild(externalRecords, 'child.exit', 'runtime')).toEqual([expect.objectContaining({ code: 75, reason: 'lock-held' })]);
    }
    expect(isAlive(holderPid)).toBe(true);

    process.kill(holderPid, 'SIGKILL');
    await until(() => !isAlive(holderPid), { deadlineMs: E2E_MARGIN_MS, description: 'lock holder fixture gone' });
    const ready = await stack.client.untilChild('runtime', (child) => child.state === 'ready', E2E_LOCK_FREE_BOUND_MS);
    const records = supervisorLog(home.paths, stack.ready.pid);
    if (HANDS_LOCK_TO_CHILD) {
      expect(ready.restarts).toBe(0);
      expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['lock-free']);
      expect(ofChild(records, 'child.exit', 'runtime')).toEqual([]);
    } else {
      expect(ready.restarts).toBe(1);
      expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['initial', 'lock-free']);
      expect(ofChild(records, 'child.exit', 'runtime')).toHaveLength(1);
    }
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime)).toEqual({ state: 'held', pid: ready.pid });
  });

  it(titleOf('s8'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const runtimeGhost = await startSleepFixture(home);
    const gatewayGhost = await startSleepFixture(home);
    writeStaleLock(firstGeneration(home.paths).locks.runtime, runtimeGhost);
    writeStaleLock(firstGeneration(home.paths).locks.gateway, gatewayGhost);

    const stack = await startStack({ home });
    const health = await stack.client.health();
    const records = supervisorLog(home.paths, stack.ready.pid);
    for (const role of ['runtime', 'gateway'] as const) {
      const child = childOf(health, role);
      expect(child).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
      expect(child.lastExit).toBeUndefined();
      expect(await inspectProcessLock(firstGeneration(home.paths).locks[role])).toEqual({ state: 'held', pid: pidOf(health, role) });
      expect(fs.readFileSync(firstGeneration(home.paths).locks[role], 'utf8').trim()).toBe(String(pidOf(health, role)));
      expect(ofChild(records, 'child.spawn', role)).toHaveLength(1);
      expect(ofChild(records, 'child.exit', role)).toEqual([]);
      expect(ofChild(records, 'child.external', role)).toEqual([]);
    }
    expect(isAlive(runtimeGhost)).toBe(true);
    expect(isAlive(gatewayGhost)).toBe(true);
  });

  it(titleOf('s9'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');
    const exited = trackExit(stack.supervisor);

    const shutdown = await stack.client.shutdown();
    expect(shutdown).toEqual({ status: 202, body: { phase: 'draining' } });
    const exit = await until(() => exited(), { deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS, description: 'supervisor exit after POST /v1/shutdown' });
    expect(exit).toEqual({ code: 0, signal: null });

    const records = supervisorLog(home.paths, stack.ready.pid);
    const runtimeExit = indexOf(records, (record) => record.msg === 'child.exit' && record.child === 'runtime');
    const gatewayExit = indexOf(records, (record) => record.msg === 'child.exit' && record.child === 'gateway');
    expect(runtimeExit).toBeLessThan(gatewayExit);
    expect(ofChild(records, 'child.exit', 'runtime')).toEqual([expect.objectContaining({ childPid: runtimePid, code: 0, reason: 'requested' })]);
    expect(ofChild(records, 'child.exit', 'gateway')).toEqual([expect.objectContaining({ childPid: gatewayPid, code: 0, reason: 'requested' })]);
    expect(named(records, 'shutdown.begin')).toEqual([expect.objectContaining({ mode: 'close' })]);
    expect(named(records, 'shutdown.end')).toEqual([expect.objectContaining({ clean: true, killed: '', leaked: '' })]);
    expect(indexOf(records, (record) => record.msg === 'shutdown.begin')).toBeLessThan(runtimeExit);
    expect(records.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, trigger: 'request', path: 'close', clean: true });
    expect(records.at(-2)?.msg).toBe('shutdown.end');

    for (const socket of [firstGeneration(home.paths).sockets.supervisor, firstGeneration(home.paths).sockets.runtime, firstGeneration(home.paths).sockets.gateway]) expect(fs.existsSync(socket)).toBe(false);
    for (const lock of [firstGeneration(home.paths).locks.supervisor, firstGeneration(home.paths).locks.runtime, firstGeneration(home.paths).locks.gateway]) expect(await inspectProcessLock(lock)).toEqual({ state: 'free' });
    expect(isAlive(runtimePid)).toBe(false);
    expect(isAlive(gatewayPid)).toBe(false);
    for (const [role, pid] of [['runtime', runtimePid], ['gateway', gatewayPid]] as const) {
      const own = roleRecordsOf(home.paths, role, pid);
      expect(own.at(-1)).toMatchObject({ msg: 'entry.exit', service: role, code: 0, trigger: 'sigterm', path: 'close', clean: true, suppressedUncaught: 0 });
      expect(named(own, 'entry.uncaught')).toEqual([]);
    }
  });

  it(titleOf('s10'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');

    const second = await spawnNextSupervisor(home, DEFAULT_E2E_DEPS, 2);
    expect(second.depsFile).not.toBe(stack.supervisor.depsFile);
    const readyRejects = expect(second.ready()).rejects.toThrow();
    const secondExit = trackExit(second);
    const exit = await until(() => secondExit(), { deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS, description: 'second supervisor exit' });
    expect(exit).toEqual({ code: 75, signal: null });
    await readyRejects;
    expect(second.stdoutLines()).toEqual([]);

    const secondRecords = supervisorLog(home.paths, second.pid);
    expect(named(secondRecords, 'child.spawn')).toEqual([]);
    expect(secondRecords.filter((record) => record.msg.startsWith('orphans.'))).toEqual([]);
    expect(secondRecords.at(-1)).toMatchObject({ msg: 'entry.exit', code: 75, path: 'start-failed', clean: false });
    expect(named(secondRecords, 'entry.start_failed')).toHaveLength(1);

    expect(await inspectProcessLock(firstGeneration(home.paths).locks.supervisor)).toEqual({ state: 'held', pid: stack.supervisor.pid });
    expect(isAlive(stack.supervisor.pid)).toBe(true);
    const after = await stack.client.health();
    expect(after.pid).toBe(stack.supervisor.pid);
    expect(after.phase).toBe('running');
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0 });
    const ledgerPgids = home.ledger.entries().map((entry) => entry.pgid);
    expect(ledgerPgids).toEqual(expect.arrayContaining([stack.supervisor.pid, runtimePid, gatewayPid]));
    expect(home.ledger.entries().filter((entry) => entry.pgid === second.pid && entry.source === 'health')).toEqual([]);
    const firstRecords = supervisorLog(home.paths, stack.ready.pid);
    expect(named(firstRecords, 'child.exit')).toEqual([]);
    expect(named(firstRecords, 'shutdown.begin')).toEqual([]);
  });
});
