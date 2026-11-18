import { spawn } from '@momonga/testkit/child-process';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, findHolders, generationLayout, generationMarkerDirectories, inspectProcessLock } from '@momonga/foundation';
import type { GenerationLayout, MomongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { LOCK_HOLDER_MAIN, firstGeneration, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { prepareGenerationForTest } from '@momonga/testkit/first-generation';
import type { ChildRole } from '@momonga/supervisor';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { readLog, recordNamed, supervisorLog, untilRecord } from './support/log-reader.ts';
import type { LogRecord } from './support/log-reader.ts';
import { expectEndedAtTerminal, processRunning, untilProcessesEnded } from './support/process.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { LAUNCHER_PATH, productSandbox } from './support/sandbox.ts';
import { baseSettings, spawnSupervisor, startStack, upstreamModelRef, withUpstreamEntry, writeSettingsFile } from './support/stack.ts';
import type { SpawnedSupervisor, SupervisorExit } from './support/stack.ts';
import { childOf, createSupervisorClient, pidOf } from './support/supervisor-client.ts';
import type { E2eDeps } from './support/supervisor-main.ts';
import type { SupervisorClient } from './support/supervisor-client.ts';
import {
  E2E_HELD_RETRY_MS,
  E2E_KILLED_GONE_BOUND_MS,
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
const KILLED_STACK_BOUND_MS = E2E_READY_DEADLINE_MS + E2E_MARGIN_MS;
const S1_TIMEOUT_MS = e2eTestTimeoutMs(
  E2E_READY_DEADLINE_MS,
  E2E_MARGIN_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  2 * E2E_ORPHAN_CLOSE_BOUND_MS,
  e2eStartBoundMs({}),
  E2E_READY_DEADLINE_MS,
);
const S1B_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({}), E2E_MARGIN_MS, E2E_REAP_TO_RUNNING_BOUND_MS);
const S1C_PHASE1_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({}), E2E_MARGIN_MS, E2E_REAP_CLOSE_BOUND_MS);
const S1C_PHASE2_TIMEOUT_MS = e2eTestTimeoutMs(KILLED_STACK_BOUND_MS, e2eStartBoundMs({}), E2E_PHASE2_REACHED_BOUND_MS, E2E_REAP_CLOSE_BOUND_MS);
const S5_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_SETTINGS_RESTART_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const S5B_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_HELD_RETRY_MS + E2E_RESTART_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const S7_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS, E2E_MARGIN_MS, E2E_LOCK_FREE_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
const HANDS_LOCK_TO_CHILD = testKernelLock().claimInheritable !== undefined;
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
  const changed = withUpstreamEntry(settings, (entry) => ({ ...entry, id: CHANGED_MODEL }));
  return { ...changed, models: { ...(changed['models'] as Settings), start: upstreamModelRef(CHANGED_MODEL) } };
};

const appliedModelOf = (home: E2eHome): unknown => {
  const file = firstGeneration(home.paths).settingsApplied;
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { settings?: { models?: { connections?: { models?: { id?: unknown }[] }[] } } };
  return record.settings?.models?.connections?.[0]?.models?.[0]?.id;
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
    if (processRunning(pid)) process.kill(pid, 'SIGKILL');
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
    if (processRunning(pid)) process.kill(pid, 'SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => reject(new Error('lock holder fixture exited before holding the lock')));
    child.stdout?.once('data', () => resolve());
  });
  return pid;
};

const writeStaleLock = async (lockPath: string, pid: number): Promise<void> => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const outcome = await testKernelLock().claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error(`the lock ${lockPath} of a fresh home was held`);
  try {
    outcome.lock.writeHolder(String(pid));
  } finally {
    outcome.lock.release();
  }
};

const openClient = (home: E2eHome, generation: number = FIRST_GENERATION): SupervisorClient => {
  const client = createSupervisorClient(home, generation);
  registerE2eCleanup(() => client.close());
  return client;
};

const openRuntimeClient = (home: E2eHome): RuntimeClient => {
  const client = createRuntimeClient(home);
  registerE2eCleanup(() => client.close());
  return client;
};

const spawnNextSupervisor = async (home: E2eHome, deps: E2eDeps, stackNumber: number, generation?: number, version?: string): Promise<SpawnedSupervisor> => {
  const supervisor = spawnSupervisor({ home, entry: { kind: 'test', deps, ...(generation === undefined ? {} : { generation }), ...(version === undefined ? {} : { version }) }, stackNumber });
  await home.ledger.add(supervisor.pid, 'supervisor');
  registerE2eCleanup(() => {
    if (processRunning(supervisor.pid)) process.kill(supervisor.pid, 'SIGKILL');
  });
  return supervisor;
};

const daemonMarkersOf = (paths: MomongaPaths, generation: number): string => generationMarkerDirectories(paths, generation).daemons;

const markerEntries = (paths: MomongaPaths, generation: number = FIRST_GENERATION): string[] => fs.readdirSync(daemonMarkersOf(paths, generation)).sort();

const generationOf = (home: E2eHome, generation: number): GenerationLayout => generationLayout(path.dirname(home.paths.root), generation);

const bothReady = (health: SupervisorHealth): boolean =>
  health.phase === 'running' && childOf(health, 'runtime').state === 'ready' && childOf(health, 'gateway').state === 'ready';

const stopRuntimeAndKillSupervisor = async (home: E2eHome): Promise<{ orphanPid: number; gatewayPid: number; firstPid: number }> => {
  const stack = await startStack({ home });
  const before = await stack.client.health();
  const orphanPid = pidOf(before, 'runtime');
  const gatewayPid = pidOf(before, 'gateway');
  process.kill(orphanPid, 'SIGSTOP');
  registerE2eCleanup(() => {
    if (processRunning(orphanPid)) process.kill(orphanPid, 'SIGKILL');
  });
  const firstExit = trackExit(stack.supervisor);
  process.kill(stack.supervisor.pid, 'SIGKILL');
  await until(() => firstExit(), { deadlineMs: E2E_KILLED_GONE_BOUND_MS, description: 'first supervisor gone after SIGKILL' });
  expect(processRunning(orphanPid)).toBe(true);
  return { orphanPid, gatewayPid, firstPid: stack.ready.pid };
};

const resumeWedgedOrphan = async (orphanPid: number): Promise<void> => {
  process.kill(orphanPid, 'SIGCONT');
  await untilProcessesEnded([orphanPid], { deadlineMs: E2E_ORPHAN_CLOSE_BOUND_MS, description: 'the resumed orphan closed itself after the lifeline EOF' });
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
    const exit = await until(() => firstExit(), { deadlineMs: E2E_KILLED_GONE_BOUND_MS, description: 'supervisor gone after SIGKILL' });
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });

    await untilProcessesEnded([runtimePid, gatewayPid], { deadlineMs: E2E_ORPHAN_CLOSE_BOUND_MS, description: 'both daemons closed after the lifeline EOF' });
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.gateway, { mechanism: testKernelLock() })).toEqual({ state: 'free' });

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

    const second = await spawnNextSupervisor(home, { restart: E2E_RESTART_POLICY }, 2);
    const secondReady = await second.ready();
    expect(secondReady.pid).toBe(second.pid);
    const client = openClient(home, 2);
    const after = await until(async () => {
      const health = await client.health();
      return bothReady(health) && health.role === 'serving' ? health : undefined;
    }, { deadlineMs: E2E_READY_DEADLINE_MS, description: 'follow-up supervisor serving as generation 2 with both children ready' });
    expect(after.pid).toBe(second.pid);
    expect(after.generation).toBe(2);
    for (const role of ['runtime', 'gateway'] as const) {
      expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
      expect(childOf(after, role).lastExit).toBeUndefined();
    }
    expect(pidOf(after, 'runtime')).not.toBe(runtimePid);
    expect(pidOf(after, 'gateway')).not.toBe(gatewayPid);
    await until(() => !fs.existsSync(generationOf(home, 1).dir) && !fs.existsSync(daemonMarkersOf(home.paths, 1)), {
      deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS,
      description: 'the directory and the markers of the dead generation 1 removed by the reaper of generation 2',
    });
    const followUp = await untilRecord(home.paths, second.pid, [recordNamed('generation.promoted'), recordNamed('child.spawn', { child: 'runtime' }), recordNamed('child.spawn', { child: 'gateway' })], {
      deadlineMs: E2E_READY_DEADLINE_MS,
      description: 'the promotion and both spawns of generation 2',
    });
    expect(named(followUp, 'generation.promoted')).toEqual([expect.objectContaining({ generation: 2 })]);
    const followUpMarkers = markerEntries(home.paths, 2);
    expect(followUpMarkers.filter((entry) => entry.startsWith('runtime-'))).toHaveLength(1);
    expect(followUpMarkers.filter((entry) => entry.startsWith('gateway-'))).toHaveLength(1);
    expect(followUpMarkers).toHaveLength(2);
    expect(ofChild(followUp, 'child.spawn', 'runtime')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0, childPid: pidOf(after, 'runtime') })]);
    expect(ofChild(followUp, 'child.spawn', 'gateway')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0, childPid: pidOf(after, 'gateway') })]);
  });

  it(titleOf('s1b'), { timeout: S1B_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);

    const second = await spawnNextSupervisor(home, { reaper: { orphanGraceMs: E2E_ORPHAN_GRACE_MS } }, 2);
    const secondReady = await second.ready();
    expect(secondReady).toMatchObject({ service: 'supervisor', pid: second.pid });
    const client = openClient(home, 2);

    const after = await until(async () => {
      const health = await client.health();
      expect(health.pid).toBe(second.pid);
      expect(health.phase).not.toBe('reaping-orphans');
      return bothReady(health) ? health : undefined;
    }, { deadlineMs: E2E_READY_DEADLINE_MS, description: 'second supervisor running without waiting for the orphan of generation 1' });
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
    expect(pidOf(after, 'runtime')).not.toBe(orphanPid);

    const waiting = named(
      await untilRecord(home.paths, second.pid, recordNamed('orphans.waiting'), { deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS, description: 'orphans.waiting of the reaper of the second supervisor' }),
      'orphans.waiting',
    )[0];
    if (waiting === undefined) throw new Error('untilRecord returned without orphans.waiting');
    expect(waiting.holders).toBeGreaterThanOrEqual(1);
    await untilProcessesEnded([orphanPid], { deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS, description: 'the wedged orphan of generation 1 reaped' });
    await until(() => !fs.existsSync(generationOf(home, 1).dir) && !fs.existsSync(daemonMarkersOf(home.paths, 1)), {
      deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS,
      description: 'the directory and the markers of the dead generation 1 removed by the reaper of generation 2',
    });

    const records = await untilRecord(home.paths, second.pid, [recordNamed('orphans.reaped'), recordNamed('child.spawn', { child: 'runtime' })], {
      deadlineMs: E2E_REAP_TO_RUNNING_BOUND_MS,
      description: 'orphans.reaped and the runtime spawn',
    });
    expect(named(records, 'orphans.reaping')).toEqual([expect.objectContaining({ holders: waiting.holders })]);
    expect(named(records, 'orphans.reaped')).toEqual([expect.objectContaining({ reaped: 0, kept: 0 })]);
    expect(ofChild(records, 'child.exit', 'runtime')).toEqual([]);
    expect(ofChild(records, 'child.spawn', 'runtime')).toEqual([expect.objectContaining({ reason: 'initial', restarts: 0 })]);
    expect(markerEntries(home.paths, 2).filter((entry) => entry.startsWith('runtime-'))).toHaveLength(1);
    expect((await client.health()).pid).toBe(second.pid);
  });

  it(titleOf('s1c-phase1'), { timeout: S1C_PHASE1_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);
    const orphanMarkers = markerEntries(home.paths, 1);

    const second = await spawnNextSupervisor(home, { reaper: { orphanGraceMs: S1C_PHASE1_ORPHAN_GRACE_MS } }, 2);
    await second.ready();
    const secondExit = trackExit(second);
    const client = openClient(home, 2);
    await untilRecord(home.paths, second.pid, recordNamed('orphans.waiting'), { deadlineMs: E2E_READY_DEADLINE_MS, description: 'orphans.waiting of the reaper of the second supervisor' });

    const shutdown = await client.shutdown();
    expect(shutdown).toEqual({ status: 202, body: { phase: 'draining' } });
    const exit = await until(() => secondExit(), { deadlineMs: E2E_REAP_CLOSE_BOUND_MS, description: 'supervisor exit after a shutdown while its reaper waits for the orphan' });
    expect(exit).toEqual({ code: 0, signal: null });

    const records = supervisorLog(home.paths, second.pid);
    expect(named(records, 'orphans.reaping')).toEqual([]);
    const last = records.at(-1);
    expect(last).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', trigger: 'request', clean: true });
    expect(named(records, 'entry.exit')).toHaveLength(1);

    expect(processRunning(orphanPid)).toBe(true);
    expect(await inspectProcessLock(generationOf(home, 1).locks.runtime, { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: orphanPid });
    const entries = markerEntries(home.paths, 1);
    expect(entries).toEqual(orphanMarkers);
    const runtimeMarkers = entries.filter((entry) => entry.startsWith('runtime-'));
    expect(runtimeMarkers).toHaveLength(1);
    expect(await findHolders(path.join(daemonMarkersOf(home.paths, 1), runtimeMarkers[0] ?? ''), { inspector: testProcessInspector(), signal: new AbortController().signal })).toContain(orphanPid);
    expect(fs.existsSync(generationOf(home, 2).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(generationOf(home, 2).locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'free' });

    await resumeWedgedOrphan(orphanPid);
  });

  it(titleOf('s1c-phase2'), { timeout: S1C_PHASE2_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const { orphanPid } = await stopRuntimeAndKillSupervisor(home);

    const second = await spawnNextSupervisor(home, { reaper: { orphanGraceMs: E2E_ORPHAN_GRACE_MS } }, 2);
    await second.ready();
    const secondExit = trackExit(second);
    const client = openClient(home, 2);
    await untilRecord(home.paths, second.pid, recordNamed('orphans.reaping'), { deadlineMs: E2E_PHASE2_REACHED_BOUND_MS, description: 'orphans.reaping of the reaper of the second supervisor' });
    expect(processRunning(orphanPid)).toBe(true);

    const shutdown = await client.shutdown();
    expect(shutdown).toEqual({ status: 202, body: { phase: 'draining' } });
    const exit = await until(() => secondExit(), { deadlineMs: E2E_REAP_CLOSE_BOUND_MS, description: 'supervisor exit after a shutdown during phase 2 of the reap' });
    expect(exit).toEqual({ code: 0, signal: null });

    expect(processRunning(orphanPid)).toBe(true);
    const runtimeMarkers = markerEntries(home.paths, 1).filter((entry) => entry.startsWith('runtime-'));
    expect(runtimeMarkers).toHaveLength(1);
    expect(await findHolders(path.join(daemonMarkersOf(home.paths, 1), runtimeMarkers[0] ?? ''), { inspector: testProcessInspector(), signal: new AbortController().signal })).toContain(orphanPid);
    const records = supervisorLog(home.paths, second.pid);
    expect(named(records, 'orphans.reaped')).toEqual([expect.objectContaining({ reaped: 0, kept: 0 })]);
    expect(fs.existsSync(generationOf(home, 1).dir)).toBe(true);
    expect(records.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', trigger: 'request', clean: true });
    expect(await inspectProcessLock(generationOf(home, 2).locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'free' });

    await resumeWedgedOrphan(orphanPid);
  });

  it.skipIf(skipCase('s2'))(titleOf('s2'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, needsBash: true, sandbox: productSandbox() });
    const runtime = openRuntimeClient(home);
    expect((await runtime.health()).sandbox).toBe(productSandbox());
    const before = await stack.client.health();
    const runtimePid = pidOf(before, 'runtime');
    const gatewayPid = pidOf(before, 'gateway');

    editSettings(home, (settings) => ({ ...settings, sandbox: 'none' }));
    await until(async () => {
      await runtime.createSession({ permissionMode: 'bypassPermissions' });
      return (await runtime.health()).sandbox === 'none' ? true : undefined;
    }, {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the runtime to take sandbox none in place for the next operation',
    });
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('settings.changed'), { deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS, description: 'the sandbox change' });
    expect(named(records, 'settings.changed')).toHaveLength(1);

    const after = await stack.client.health();
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0 });
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

    editSettings(home, withChangedModel);
    await until(() => (appliedModelOf(home) === CHANGED_MODEL ? true : undefined), {
      deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS,
      description: 'the supervisor to record the models change as applied',
    });
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('settings.changed'), { deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS, description: 'the models change' });
    expect(named(records, 'settings.changed')).toHaveLength(1);
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

    editSettings(home, (settings) => ({ ...settings, permissions: { allow: ['Read'] } }));
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('settings.changed'), { deadlineMs: E2E_SETTINGS_SEEN_BOUND_MS, description: 'settings.changed after a permissions edit' });
    const changed = named(records, 'settings.changed');
    expect(changed).toHaveLength(1);
    expect(changed.at(-1)).toMatchObject({ level: 'info', service: 'supervisor' });
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
      deps: { runtime: { sandboxExecPath: '/nonexistent' } },
      readiness: { phase: 'running', children: { runtime: 'held-config', gateway: 'ready' } },
    });
    const held = await stack.client.untilChild('runtime', (child) => child.state === 'held-config', E2E_RESTART_BOUND_MS);
    expect(held.pid).toBeUndefined();
    expect(held.restarts).toBe(0);
    expect(held.lastExit).toMatchObject({ code: 78, signal: null, reason: 'config' });
    expect(typeof held.heldReason).toBe('string');
    expect(held.heldReason).not.toBe('');
    const gatewayPid = pidOf(await stack.client.health(), 'gateway');

    const heldRecords = await untilRecord(home.paths, stack.ready.pid, [recordNamed('child.exit', { child: 'runtime' }), recordNamed('child.held', { child: 'runtime' })], {
      deadlineMs: E2E_RESTART_BOUND_MS,
      description: 'the exit and the hold of the runtime',
    });
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
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('child.spawn', { child: 'runtime', reason: 'settings-change' }), {
      deadlineMs: E2E_SETTINGS_RESTART_BOUND_MS,
      description: 'the runtime spawn after the settings change',
    });
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
      deps: { heldRetryMs: E2E_HELD_RETRY_MS, runtime: { sandboxExecPath } },
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
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('child.spawn', { child: 'runtime', reason: 'held-retry' }), {
      deadlineMs: E2E_HELD_RETRY_MS + E2E_RESTART_BOUND_MS,
      description: 'the runtime spawn of the held retry',
    });
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
    const heldRecords = await untilRecord(home.paths, stack.ready.pid, [recordNamed('child.held', { child: 'runtime' }), recordNamed('child.held', { child: 'gateway' })], {
      deadlineMs: E2E_RESTART_BOUND_MS,
      description: 'the hold of both children',
    });
    expect(named(heldRecords, 'child.spawn')).toEqual([]);
    for (const role of ['runtime', 'gateway'] as const) expect(ofChild(heldRecords, 'child.held', role)).toEqual([expect.objectContaining({ source: 'settings' })]);

    writeSettingsFile(home, baseSettings(home, stack.sandbox));
    const after = await until(async () => {
      const current = await stack.client.health();
      return bothReady(current) ? current : undefined;
    }, { deadlineMs: E2E_SETTINGS_RESTART_BOUND_MS, description: 'both children ready after the settings fix' });
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ restarts: 0, consecutiveFailures: 0 });
    const records = await untilRecord(home.paths, stack.ready.pid, [recordNamed('child.spawn', { child: 'runtime' }), recordNamed('child.spawn', { child: 'gateway' })], {
      deadlineMs: E2E_SETTINGS_RESTART_BOUND_MS,
      description: 'both spawns after the settings fix',
    });
    for (const role of ['runtime', 'gateway'] as const) {
      expect(ofChild(records, 'child.spawn', role)).toEqual([expect.objectContaining({ reason: 'settings-change', restarts: 0, childPid: pidOf(after, role) })]);
    }
  });

  it(titleOf('s7'), { timeout: S7_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    prepareGenerationForTest(home.home, FIRST_GENERATION, cliPackage.version);
    const holderPid = await startLockHolderFixture(home, firstGeneration(home.paths).locks.runtime);
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime, { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: holderPid });

    const stack = await startStack({ home, readiness: false, preparedGeneration: FIRST_GENERATION });
    const external = await stack.client.untilChild('runtime', (child) => child.state === 'external', E2E_RESTART_BOUND_MS);
    expect(external.restarts).toBe(0);
    expect(external.pid).toBeUndefined();
    const externalRecords = await untilRecord(
      home.paths,
      stack.ready.pid,
      [recordNamed('child.external', { child: 'runtime' }), ...(HANDS_LOCK_TO_CHILD ? [] : [recordNamed('child.exit', { child: 'runtime' })])],
      { deadlineMs: E2E_RESTART_BOUND_MS, description: 'the runtime held by another process' },
    );
    expect(ofChild(externalRecords, 'child.external', 'runtime')).toEqual([expect.objectContaining({ holderPid })]);
    expect(ofChild(externalRecords, 'child.backoff', 'runtime')).toEqual([]);
    if (HANDS_LOCK_TO_CHILD) {
      expect(external.lastExit).toBeUndefined();
      expect(ofChild(externalRecords, 'child.spawn', 'runtime')).toEqual([]);
      expect(ofChild(externalRecords, 'child.exit', 'runtime')).toEqual([]);
    } else {
      expect(external.lastExit).toMatchObject({ code: 77, reason: 'lock-held' });
      expect(ofChild(externalRecords, 'child.spawn', 'runtime')).toHaveLength(1);
      expect(ofChild(externalRecords, 'child.exit', 'runtime')).toEqual([expect.objectContaining({ code: 77, reason: 'lock-held' })]);
    }
    expect(processRunning(holderPid)).toBe(true);

    process.kill(holderPid, 'SIGKILL');
    await untilProcessesEnded([holderPid], { deadlineMs: E2E_KILLED_GONE_BOUND_MS, description: 'lock holder fixture gone' });
    const ready = await stack.client.untilChild('runtime', (child) => child.state === 'ready', E2E_LOCK_FREE_BOUND_MS);
    const records = await untilRecord(home.paths, stack.ready.pid, recordNamed('child.spawn', { child: 'runtime', reason: 'lock-free' }), { deadlineMs: E2E_LOCK_FREE_BOUND_MS, description: 'the runtime spawn once the lock is free' });
    if (HANDS_LOCK_TO_CHILD) {
      expect(ready.restarts).toBe(0);
      expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['lock-free']);
      expect(ofChild(records, 'child.exit', 'runtime')).toEqual([]);
    } else {
      expect(ready.restarts).toBe(1);
      expect(ofChild(records, 'child.spawn', 'runtime').map((record) => record.reason)).toEqual(['initial', 'lock-free']);
      expect(ofChild(records, 'child.exit', 'runtime')).toHaveLength(1);
    }
    expect(await inspectProcessLock(firstGeneration(home.paths).locks.runtime, { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: ready.pid });
  });

  it(titleOf('s8'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const runtimeGhost = await startSleepFixture(home);
    const gatewayGhost = await startSleepFixture(home);
    prepareGenerationForTest(home.home, FIRST_GENERATION, cliPackage.version);
    await writeStaleLock(firstGeneration(home.paths).locks.runtime, runtimeGhost);
    await writeStaleLock(firstGeneration(home.paths).locks.gateway, gatewayGhost);

    const stack = await startStack({ home, preparedGeneration: FIRST_GENERATION });
    const health = await stack.client.health();
    const records = await untilRecord(home.paths, stack.ready.pid, [recordNamed('child.spawn', { child: 'runtime' }), recordNamed('child.spawn', { child: 'gateway' })], {
      deadlineMs: E2E_READY_DEADLINE_MS,
      description: 'both spawns',
    });
    for (const role of ['runtime', 'gateway'] as const) {
      const child = childOf(health, role);
      expect(child).toMatchObject({ state: 'ready', restarts: 0, consecutiveFailures: 0 });
      expect(child.lastExit).toBeUndefined();
      expect(await inspectProcessLock(firstGeneration(home.paths).locks[role], { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: pidOf(health, role) });
      expect((await testKernelLock().readHolder(firstGeneration(home.paths).locks[role]))?.trim()).toBe(String(pidOf(health, role)));
      expect(ofChild(records, 'child.spawn', role)).toHaveLength(1);
      expect(ofChild(records, 'child.exit', role)).toEqual([]);
      expect(ofChild(records, 'child.external', role)).toEqual([]);
    }
    expect(processRunning(runtimeGhost)).toBe(true);
    expect(processRunning(gatewayGhost)).toBe(true);
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
    for (const lock of [firstGeneration(home.paths).locks.supervisor, firstGeneration(home.paths).locks.runtime, firstGeneration(home.paths).locks.gateway]) expect(await inspectProcessLock(lock, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
    await expectEndedAtTerminal('shutdown.end', { processes: [runtimePid, gatewayPid] });
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

    const second = await spawnNextSupervisor(home, {}, 2, FIRST_GENERATION, cliPackage.version);
    expect(second.depsFile).not.toBe(stack.supervisor.depsFile);
    const readyFailure = second.ready().then(
      () => undefined,
      (error: unknown) => error,
    );
    const secondExit = trackExit(second);
    const exit = await until(() => secondExit(), { deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS, description: 'second supervisor exit' });
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await readyFailure).toBeInstanceOf(Error);
    expect(second.stdoutLines()).toEqual([]);

    const secondRecords = supervisorLog(home.paths, second.pid);
    expect(named(secondRecords, 'child.spawn')).toEqual([]);
    expect(secondRecords.filter((record) => record.msg.startsWith('orphans.'))).toEqual([]);
    expect(named(secondRecords, 'start.abandoned')).toEqual([expect.objectContaining({ generation: FIRST_GENERATION, reason: 'lock-held' })]);
    expect(secondRecords.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0 });

    expect(await inspectProcessLock(firstGeneration(home.paths).locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'held', pid: stack.supervisor.pid });
    expect(processRunning(stack.supervisor.pid)).toBe(true);
    const after = await stack.client.health();
    expect(after.pid).toBe(stack.supervisor.pid);
    expect(after.phase).toBe('running');
    expect(pidOf(after, 'runtime')).toBe(runtimePid);
    expect(pidOf(after, 'gateway')).toBe(gatewayPid);
    for (const role of ['runtime', 'gateway'] as const) expect(childOf(after, role)).toMatchObject({ state: 'ready', restarts: 0 });
    const ledgerPgids = home.ledger.entries().map((entry) => entry.pgid);
    expect(ledgerPgids).toEqual(expect.arrayContaining([stack.supervisor.pid, runtimePid, gatewayPid]));
    expect(home.ledger.entries().filter((entry) => entry.pgid === second.pid && entry.source === 'health')).toEqual([]);
    const firstRecords = await untilRecord(home.paths, stack.ready.pid, [recordNamed('child.spawn', { child: 'runtime' }), recordNamed('child.spawn', { child: 'gateway' })], {
      deadlineMs: E2E_READY_DEADLINE_MS,
      description: 'both spawns of the first supervisor',
    });
    expect(named(firstRecords, 'child.exit')).toEqual([]);
    expect(named(firstRecords, 'shutdown.begin')).toEqual([]);
  });
});
