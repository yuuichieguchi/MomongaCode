import { execFileSync, spawn } from '@momonga/testkit/child-process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeClock, createFakeTimers, createTempDir, HOLD_UNTIL_SIGNALLED, HOLD_UNTIL_SIGNALLED_ARGV, killGroupsForCleanup, killPidsForCleanup, LSOF_PATH, pacedReapTiming, REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, testLocks, testProcessInspector, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeTimers, PacedReapTiming, TrackedChild } from '@momonga/testkit';
import { KILL_CONFIRM_MS, createPosixGroupPort, createProcessInspector, hostInspectorPorts, reapMarkedProcesses, reapMarkedProcessesWithReport, reapMarkerDirectory, reconcileProcessGroup, sleep, POLL_INTERVAL_MS, systemWaitTiming, waitUntil as foundationWaitUntil } from '@momonga/foundation';
import type { CommandRunner, ProcessInspector } from '@momonga/foundation';

vi.setConfig({ testTimeout: 4 * REAL_PROCESS_TEST_TIMEOUT_MS });


const spawnedGroups: number[] = [];
const spawnedPids: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  realChildren.clear();
  try {
    await killGroupsForCleanup(spawnedGroups.splice(0));
  } finally {
    killPidsForCleanup(spawnedPids.splice(0));
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const holdersOf = (file: string): number[] => {
  try {
    return execFileSync(LSOF_PATH, ['-t', '--', file], { env: { LC_ALL: 'C' }, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  } catch {
    return [];
  }
};

const ownGroup = (): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());

const alive = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const CONDITION_BOUND_MS = 10_000;

const waitUntil = async (condition: () => boolean): Promise<boolean> =>
  (await foundationWaitUntil(systemWaitTiming, async () => (condition() ? true : undefined), { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + CONDITION_BOUND_MS })).kind === 'found';

const makeDir = (): string => {
  const dir = createTempDir();
  tempDirs.push(dir);
  return dir;
};

const makeMarker = (dir: string, name = 'marker', content = ''): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, content, { mode: 0o600 });
  return marker;
};

type ReapTime = { timers: FakeTimers; timing: PacedReapTiming; sleeps: number[]; now(): number };

const reapTime = (): ReapTime => {
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const timing = pacedReapTiming(clock, timers);
  return { timers, timing, sleeps: timing.sleeps, now: () => clock.now() };
};

const abortingAt = (time: ReapTime, controller: AbortController, at: number): ReapTime => {
  time.timers.setTimeout(() => controller.abort(), at);
  return time;
};

type RealChild = { exited: Promise<void>; diesOn: 'SIGTERM' | 'SIGKILL' };

const realChildren = new Map<number, RealChild>();

const diesOnOf = (script: string): RealChild['diesOn'] => (script.includes("trap '' TERM") ? 'SIGKILL' : 'SIGTERM');

const ownGroupLeader = (pid: number, child: RealChild): void => {
  realChildren.set(pid, child);
  realChildren.set(-pid, child);
};

const pairWithDeath = (time: ReapTime, target: number, signal: NodeJS.Signals): void => {
  const child = realChildren.get(target);
  if (child === undefined) return;
  if (signal === 'SIGKILL' || signal === child.diesOn) void time.timing.pairedWith(() => child.exited);
};

type Signalled = { pid: number; signal: NodeJS.Signals | 0; at: number };

const recordingKill = (time: ReapTime, intercept: (pid: number, signal: NodeJS.Signals | 0) => boolean = () => false) => {
  const signals: Signalled[] = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) signals.push({ pid, signal, at: time.now() });
    if (intercept(pid, signal)) return;
    process.kill(pid, signal);
    if (signal !== 0) pairWithDeath(time, pid, signal);
  };
  return { signals, kill };
};

const errnoError = (code: string, pid: number): Error => Object.assign(new Error(`kill ${code} ${pid}`), { code, errno: -1, syscall: 'kill' });

type Group = { pgid: number; leaderReaped: Promise<void> };

const startGroup = async (dir: string, script: string, options: { fd3?: string; readyFiles?: string[] } = {}): Promise<Group> => {
  const fd = options.fd3 === undefined ? undefined : fs.openSync(options.fd3, 'r');
  try {
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: fd === undefined ? 'ignore' : ['ignore', 'ignore', 'ignore', fd],
      env: { PATH: '/usr/bin:/bin', DIR: dir },
    });
    const leaderReaped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error('spawn failed');
    spawnedGroups.push(pid);
    ownGroupLeader(pid, { exited: leaderReaped, diesOn: diesOnOf(script) });
    const readyFiles = (options.readyFiles ?? ['ready']).map((name) => path.join(dir, name));
    if (!(await waitUntil(() => readyFiles.every((file) => fs.existsSync(file))))) throw new Error('process group did not become ready');
    return { pgid: pid, leaderReaped };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const startHolder = async (marker: string, options: { ignoreTerm?: boolean } = {}): Promise<number> => {
  const fd = fs.openSync(marker, 'r');
  try {
    const argv = options.ignoreTerm === true ? ['/bin/sh', '-c', `trap '' TERM; exec ${HOLD_UNTIL_SIGNALLED}`] : [...HOLD_UNTIL_SIGNALLED_ARGV];
    const child = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error('spawn failed');
    spawnedPids.push(pid);
    spawnedGroups.push(pid);
    ownGroupLeader(pid, { exited, diesOn: options.ignoreTerm === true ? 'SIGKILL' : 'SIGTERM' });
    if (!(await waitUntil(() => holdersOf(marker).includes(pid)))) throw new Error('holder did not open the marker');
    return pid;
  } finally {
    fs.closeSync(fd);
  }
};

const TERM_MARKER_SCRIPT = `trap 'echo term > "$DIR/term"; kill $! 2>/dev/null; exit 0' TERM; ${HOLD_UNTIL_SIGNALLED} & touch "$DIR/ready"; wait`;
const IGNORING_GROUP_SCRIPT = `trap '' TERM; touch "$DIR/ready"; while :; do sleep 1; done`;
const CLOSED_FD_SCRIPT = `exec 3<&-; trap 'exit 0' TERM; ${HOLD_UNTIL_SIGNALLED} & touch "$DIR/ready"; wait`;
const MEMBER_WITHOUT_FD_SCRIPT = `/bin/sh -c 'exec 3<&-; echo $$ > "$DIR/member.pid"; exec ${HOLD_UNTIL_SIGNALLED}' & trap 'exit 0' TERM; touch "$DIR/ready"; wait`;

const nonZero = (signals: readonly Signalled[]): Array<[number, NodeJS.Signals | 0]> => signals.map(({ pid, signal }) => [pid, signal]);

describe('reapMarkedProcesses', () => {
  it('reaps the recorded group and removes the marker', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    fs.writeFileSync(marker, `${group.pgid}\n`);
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 10_000, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(nonZero(signals)[0]).toEqual([-group.pgid, 'SIGTERM']);
    expect(fs.readFileSync(path.join(dir, 'term'), 'utf8')).toBe('term\n');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('prefers the pgid option over the marker content', async () => {
    const dir = makeDir();
    const decoyDir = makeDir();
    const marker = makeMarker(dir);
    const decoy = await startGroup(decoyDir, TERM_MARKER_SCRIPT);
    fs.writeFileSync(marker, `${decoy.pgid}\n`);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid: group.pgid, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(nonZero(signals)[0]).toEqual([-group.pgid, 'SIGTERM']);
    expect(signals.some(({ pid }) => Math.abs(pid) === decoy.pgid)).toBe(false);
    expect(alive(-decoy.pgid)).toBe(true);
    expect(fs.existsSync(path.join(decoyDir, 'term'))).toBe(false);
  });

  it('with an empty marker and no pgid signals only the holders', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, MEMBER_WITHOUT_FD_SCRIPT, { fd3: marker, readyFiles: ['ready', 'member.pid'] });
    const member = Number(fs.readFileSync(path.join(dir, 'member.pid'), 'utf8').trim());
    const holders = holdersOf(marker);
    expect(holders).toEqual([group.pgid]);
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(nonZero(signals)).toEqual([[group.pgid, 'SIGTERM']]);
    await group.leaderReaped;
    expect(alive(member)).toBe(true);
    expect(alive(-group.pgid)).toBe(true);
  });

  it.each([
    ['pgid 0', () => 0],
    ['pgid 1', () => 1],
    ['a negative pgid', () => -5],
    ['its own group', ownGroup],
  ])('never signals %s', async (_name, pgidOf) => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker);
    const pgid = pgidOf();
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(({ pid }) => pid === holder)).toBe(true);
  });

  it('never signals a recorded own group read from the marker content', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker);
    fs.writeFileSync(marker, `${ownGroup()}\n`);
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(({ pid }) => pid === holder)).toBe(true);
  });

  it('escalates a SIGTERM-ignoring holder to SIGKILL once the injected clock passes killGraceMs', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_GROUP_SCRIPT, { fd3: marker });
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid: group.pgid, killGraceMs: 600_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    const term = signals.find(({ signal }) => signal === 'SIGTERM');
    const killed = signals.find(({ signal }) => signal === 'SIGKILL');
    expect(term).toEqual({ pid: -group.pgid, signal: 'SIGTERM', at: 0 });
    expect(killed?.pid).toBe(-group.pgid);
    expect(killed?.at).toBeGreaterThanOrEqual(600_000);
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('escalates a SIGTERM-ignoring holder to SIGKILL on the holders-only path once the injected clock passes killGraceMs', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: true });
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 500, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals[0]).toEqual({ pid: holder, signal: 'SIGTERM', at: 0 });
    const killed = signals.find(({ signal }) => signal === 'SIGKILL');
    expect(killed?.pid).toBe(holder);
    expect(killed?.at).toBeGreaterThanOrEqual(500);
    expect(fake.sleeps.every((ms) => ms === 25)).toBe(true);
    expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('keeps the marker and warns with the label when a holder remains', async (context) => {
    const marker = markerFile(withTempDir(context));
    const other = 300;
    const world = processTable({ [SURVIVOR]: { pgid: SURVIVOR, holdsMarker: true, ignoresTerm: true, survivesKill: true }, [other]: { pgid: other, holdsMarker: true, ignoresTerm: false } }, {});
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
    expect(warnings).toEqual([`tool marker ${marker} kept: process ${SURVIVOR} still hold it after cleanup; the next start will retry`]);
    expect(world.signals).toContainEqual({ pid: other, signal: 'SIGTERM' });
    expect(world.alive(other)).toBe(false);
    expect(world.alive(SURVIVOR)).toBe(true);
  });

  describe('prefixes the leftAloneGroup, leftAlonePids and unsignalled warnings with the label', () => {
    it('leftAloneGroup', async () => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const group = await startGroup(dir, CLOSED_FD_SCRIPT, { fd3: marker });
      const fake = reapTime();
      const { signals, kill } = recordingKill(fake);
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid: group.pgid, killGraceMs: 200, label: 'mcp', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
      expect(result).toEqual({ removed: true });
      expect(warnings).toEqual([`mcp marker ${marker}: group ${group.pgid} is still alive but could not be verified as belonging to this call, so it was left alone`]);
      expect(signals).toEqual([]);
      expect(alive(-group.pgid)).toBe(true);
    });

    it('leftAlonePids', async (context) => {
      const marker = markerFile(withTempDir(context));
      const world = processTable({ 200: { pgid: 200, holdsMarker: true, ignoresTerm: false, startUnreadable: true } }, {});
      const warnings: string[] = [];
      await reapMarkedProcesses({ marker, pgid: 100, killGraceMs: 1000, label: 'mcp', onWarning: (m) => warnings.push(m), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
      expect(warnings).toContain(`mcp marker ${marker}: process 200 is still alive but could not be verified as belonging to this call, so it was left alone`);
    });

    it('unsignalled', async (context) => {
      const marker = markerFile(withTempDir(context));
      const blocked = 300;
      const world = processTable({ [blocked]: { pgid: blocked, holdsMarker: true, ignoresTerm: false, signalError: 'EPERM' } }, {});
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, killGraceMs: 200, label: 'mcp', onWarning: (m) => warnings.push(m), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
      expect(result).toEqual({ removed: false });
      expect(warnings).toContain(`mcp marker ${marker}: could not signal process ${blocked}`);
      expect(warnings).toContain(`mcp marker ${marker} kept: process ${blocked} still hold it after cleanup; the next start will retry`);
      expect(world.alive(blocked)).toBe(true);
    });
  });

  describe('one signalling rule for both reap paths', () => {
    const paths = [
      ['the holders-only path', false],
      ['the recorded-group path', true],
    ] as const;

    const refusedBy = (context: CleanupContext, code: string, recordGroup: boolean) => {
      const marker = markerFile(withTempDir(context));
      const world = processTable({ [REFUSING]: { pgid: REFUSING, holdsMarker: true, ignoresTerm: false, signalError: code } }, {});
      const warnings: string[] = [];
      const reap = reapMarkedProcesses({ marker, ...(recordGroup ? { pgid: REFUSING } : {}), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
      return { marker, warnings, reap };
    };

    it.for(paths)('collects EPERM on %s and warns could not signal', async ([, recordGroup], context) => {
      const { marker, warnings, reap } = refusedBy(context, 'EPERM', recordGroup);
      await reap;
      expect(warnings.filter((m) => m.startsWith(`tool marker ${marker}: could not signal process `))).toHaveLength(1);
      expect(warnings.find((m) => m.includes('could not signal'))).toContain(String(REFUSING));
    });

    it.for(paths)('ignores ESRCH on %s', async ([, recordGroup], context) => {
      const { marker, warnings, reap } = refusedBy(context, 'ESRCH', recordGroup);
      expect(await reap).toEqual({ removed: false });
      expect(warnings.some((m) => m.includes('could not signal'))).toBe(false);
      expect(warnings).toContain(`tool marker ${marker} kept: process ${REFUSING} still hold it after cleanup; the next start will retry`);
    });

    it.for(paths)('throws any other signalling error on %s', async ([, recordGroup], context) => {
      const { reap } = refusedBy(context, 'EINVAL', recordGroup);
      await expect(reap).rejects.toThrow(`kill EINVAL`);
    });
  });

  it('unlinks a symlink marker without following it', async () => {
    const dir = makeDir();
    const target = makeMarker(dir, 'target', 'keep me');
    const marker = path.join(dir, 'marker');
    fs.symlinkSync(target, marker);
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(() => fs.lstatSync(marker)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(marker);
    expect(signals).toEqual([]);
  });

  it('reports a missing marker as removed', async () => {
    const dir = makeDir();
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker: path.join(dir, 'gone'), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals).toEqual([]);
  });

  it('reports that nothing was stopped for a missing marker', async () => {
    const dir = makeDir();
    const fake = reapTime();
    const { kill } = recordingKill(fake);
    const result = await reapMarkedProcessesWithReport({ inspector: testProcessInspector(), marker: path.join(dir, 'gone'), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true, stopped: false, uninspectable: [] });
  });

  it('reports that a recorded group was stopped', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    fs.writeFileSync(marker, `${group.pgid}\n`);
    const fake = reapTime();
    const { kill } = recordingKill(fake);
    const result = await reapMarkedProcessesWithReport({ inspector: testProcessInspector(), marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true, stopped: true, uninspectable: [] });
    await group.leaderReaped;
  });

  it('reports that a holder without a recorded group was stopped', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: false });
    const result = await reapMarkedProcessesWithReport({ inspector: testProcessInspector(), marker, killGraceMs: 300, label: 'tool', onWarning: () => {} });
    expect(result).toEqual({ removed: true, stopped: true, uninspectable: [] });
    expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('waits only through timing.sleep', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_GROUP_SCRIPT, { fd3: marker });
    const fake = reapTime();
    const { signals, kill } = recordingKill(fake);
    const hour = 3_600_000;
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid: group.pgid, killGraceMs: hour, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(fake.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(hour);
    expect(signals.find(({ signal }) => signal === 'SIGKILL')?.at).toBeGreaterThanOrEqual(hour);
  });

  it('smoke (real time)', async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: true });
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 300, label: 'tool', onWarning: (m) => warnings.push(m) });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(await waitUntil(() => !alive(holder))).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('reapMarkerDirectory', () => {
  it('reapMarkerDirectory reaps markers concurrently', async () => {
    const dir = makeDir();
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    const groups: Group[] = [];
    for (const name of ['a', 'b', 'c']) {
      const groupDir = path.join(dir, `g-${name}`);
      fs.mkdirSync(groupDir);
      const marker = makeMarker(markerDir, name);
      const group = await startGroup(groupDir, IGNORING_GROUP_SCRIPT, { fd3: marker });
      fs.writeFileSync(marker, `${group.pgid}\n`);
      groups.push(group);
    }
    const time = reapTime();
    let everyMarkerSleptAtOnce = false;
    void time.timing.pairedWith(async () => {
      await waitFor(() => time.sleeps.length >= groups.length, { description: 'every marker in its first sleep at the same time' });
      everyMarkerSleptAtOnce = true;
    });
    const sent: Array<{ pid: number; signal: NodeJS.Signals; sleepsBefore: number }> = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) sent.push({ pid, signal, sleepsBefore: time.sleeps.length });
      process.kill(pid, signal);
      if (signal !== 0) pairWithDeath(time, pid, signal);
    };
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ inspector: testProcessInspector(), signal: new AbortController().signal, dir: markerDir, killGraceMs: 1000, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: time.timing });
    expect(everyMarkerSleptAtOnce).toBe(true);
    expect(result).toEqual({ reaped: 3, kept: 0, unreaped: [] });
    const firstKill = sent.findIndex(({ signal }) => signal === 'SIGKILL');
    expect(sent[firstKill]?.sleepsBefore).toBeGreaterThanOrEqual(groups.length);
    for (const group of groups) {
      const term = sent.findIndex(({ pid, signal }) => pid === -group.pgid && signal === 'SIGTERM');
      expect(term).toBeGreaterThanOrEqual(0);
      expect(term).toBeLessThan(firstKill);
    }
    expect(fs.readdirSync(markerDir)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reapMarkerDirectory on a missing directory reaps nothing', async () => {
    const dir = makeDir();
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ inspector: testProcessInspector(), signal: new AbortController().signal, dir: path.join(dir, 'missing'), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), timing: reapTime().timing });
    expect(result).toEqual({ reaped: 0, kept: 0, unreaped: [] });
    expect(warnings).toEqual([]);
  });

  it('counts a marker whose holder remains as kept', async (context) => {
    const markerDir = withTempDir(context);
    const kept = markerFile(markerDir, 'kept');
    markerFile(markerDir, 'reaped');
    const other = 300;
    const world = processTable(
      {
        [SURVIVOR]: { pgid: SURVIVOR, holdsMarker: true, marker: 'kept', ignoresTerm: true, survivesKill: true },
        [other]: { pgid: other, holdsMarker: true, marker: 'reaped', ignoresTerm: false },
      },
      {},
    );
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ signal: new AbortController().signal, dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(result).toEqual({ reaped: 1, kept: 1, unreaped: [] });
    expect(fs.readdirSync(markerDir)).toEqual(['kept']);
    expect(warnings).toEqual([`tool marker ${kept} kept: process ${SURVIVOR} still hold it after cleanup; the next start will retry`]);
    expect(world.alive(other)).toBe(false);
  });

  it('reaps the other markers when one target fails, and reports the failure with its marker and code in the result', async () => {
    const dir = makeDir();
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    const failing = makeMarker(markerDir, 'failing');
    const first = makeMarker(markerDir, 'first');
    const second = makeMarker(markerDir, 'second');
    const broken = await startHolder(failing);
    const holders = [await startHolder(first), await startHolder(second)];
    const fake = reapTime();
    const { kill } = recordingKill(fake, (pid, signal) => {
      if (pid === broken && signal !== 0) throw errnoError('EINVAL', pid);
      return false;
    });
    const result = await reapMarkerDirectory({ inspector: testProcessInspector(), signal: new AbortController().signal, dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: () => undefined, kill, timing: fake.timing });
    expect(result).toMatchObject({ reaped: 2, kept: 0, unreaped: [{ marker: failing, code: 'EINVAL' }] });
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(failing)).toBe(true);
    for (const holder of holders) expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('reaps three readable markers and reports the one that fails with EACCES, with its file and code', async (context) => {
    const markerDir = withTempDir(context);
    const readable = ['a', 'b', 'c'].map((name) => markerFile(markerDir, name));
    const denied = markerFile(markerDir, 'denied');
    fs.chmodSync(denied, 0o000);
    context.onTestFinished(() => fs.chmodSync(denied, 0o600));
    const world = processTable({}, {});
    const result = await reapMarkerDirectory({ signal: new AbortController().signal, dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: () => undefined, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector, occasion: 'startup' });
    expect(result).toMatchObject({ reaped: 3, kept: 0, unreaped: [{ marker: denied, code: 'EACCES' }] });
    for (const marker of readable) expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(denied)).toBe(true);
  });

  it('propagates a readdir error other than ENOENT', async () => {
    const dir = makeDir();
    const notADirectory = makeMarker(dir, 'file');
    await expect(reapMarkerDirectory({ inspector: testProcessInspector(), signal: new AbortController().signal, dir: notADirectory, killGraceMs: 200, label: 'tool', onWarning: () => undefined, timing: reapTime().timing })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

const SLICE_MS = 25;
const REMOVED_PS_PROBE_TIMEOUT_MS = 2000;
const SLOW_LISTING_MS = 5 * REMOVED_PS_PROBE_TIMEOUT_MS;

type Held = { child: TrackedChild; exited: Promise<void> };

const exitOf = (child: TrackedChild): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

const spawnOnMarker = async (context: CleanupContext, dir: string, marker: string, script: string): Promise<Held> => {
  const ready = path.join(dir, `ready-${path.basename(marker)}-${fs.readdirSync(dir).length}`);
  const fd = fs.openSync(marker, 'r');
  try {
    const child = spawnTracked(context, '/bin/sh', ['-c', script], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      env: { PATH: '/usr/bin:/bin', READY: ready },
    });
    await waitFor(() => fs.existsSync(ready), { description: `holder ready file ${ready}` });
    const exited = exitOf(child);
    ownGroupLeader(child.pid, { exited, diesOn: diesOnOf(script) });
    return { child, exited };
  } finally {
    fs.closeSync(fd);
  }
};

const TERM_IGNORING_HOLDER = `trap '' TERM; touch "$READY"; exec ${HOLD_UNTIL_SIGNALLED}`;
const TERM_IGNORING_GROUP = `trap '' TERM; touch "$READY"; while :; do /bin/sleep 1; done`;
const TERM_EXITING_GROUP = `trap 'exit 0' TERM; ${HOLD_UNTIL_SIGNALLED} & touch "$READY"; wait`;

const markerFile = (dir: string, name = 'marker'): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

type SignalRecord = { pid: number; signal: NodeJS.Signals; at: number };

const signalRecorder = (time: ReapTime, intercept: (pid: number, signal: NodeJS.Signals) => boolean = () => false) => {
  const signals: SignalRecord[] = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) {
      signals.push({ pid, signal, at: time.now() });
      if (intercept(pid, signal)) return;
    }
    process.kill(pid, signal);
    if (signal !== 0) pairWithDeath(time, pid, signal);
  };
  return { signals, kill };
};

const firstAt = (signals: readonly SignalRecord[], signal: NodeJS.Signals): number | undefined => signals.find((entry) => entry.signal === signal)?.at;

const hungListing = (seen: AbortSignal[]): ProcessInspector =>
  ({
    startTimeOf: async () => ({ kind: 'gone' }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    markerState: (_marker: string, options: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        seen.push(options.signal);
        options.signal.addEventListener('abort', () => resolve('unknown'), { once: true });
      }),
    holdersOf: (_marker: string, options: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        seen.push(options.signal);
        options.signal.addEventListener('abort', () => resolve({ kind: 'failed', cause: 'transient', evidence: { kind: 'opaque', detail: 'aborted' } }), { once: true });
      }),
  }) as unknown as ProcessInspector;

describe('marker reap: AbortSignal (PT 3G: a reap path ends at its operation bound, the marker kept and nothing unverified signalled; HB2 rule 1: the caller signal ending the wait gives unconfirmed, marker kept)', () => {
  it('abort during the grace ends the reap at once: no SIGKILL is sent and the marker is kept', async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = abortingAt(reapTime(), controller, 100);
    const { signals, kill } = signalRecorder(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    expect(signals).toEqual([{ pid: holder.child.pid, signal: 'SIGTERM', at: 0 }]);
    expect(fake.now()).toBeLessThanOrEqual(100 + SLICE_MS);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort during the grace on the recorded-group path ends the reap the same way; without an abort the group gets SIGKILL at the grace', async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const group = await spawnOnMarker(context, dir, marker, TERM_IGNORING_GROUP);
    const pgid = group.child.pid;
    const controller = new AbortController();
    const fake = abortingAt(reapTime(), controller, 100);
    const { signals, kill } = signalRecorder(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, pgid, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    expect(signals.map(({ pid, signal }) => [pid, signal])).toEqual([[-pgid, 'SIGTERM']]);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);

    const unsignalledDir = withTempDir(context);
    const unsignalledMarker = markerFile(unsignalledDir);
    const unsignalledGroup = await spawnOnMarker(context, unsignalledDir, unsignalledMarker, TERM_IGNORING_GROUP);
    const plain = reapTime();
    const plainRecorder = signalRecorder(plain);
    await reapMarkedProcesses({ inspector: testProcessInspector(), marker: unsignalledMarker, pgid: unsignalledGroup.child.pid, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill: plainRecorder.kill, timing: plain.timing, signal: new AbortController().signal });
    expect(firstAt(plainRecorder.signals, 'SIGKILL')).toBe(1000);
  });

  it('abort before the call signals nothing and keeps the marker', async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const fake = reapTime();
    const { signals, kill } = signalRecorder(fake);
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: AbortSignal.abort() });
    expect(signals).toEqual([]);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort during the SIGKILL confirmation ends the wait as unconfirmed: the marker is kept', async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = reapTime();
    const { signals, kill } = signalRecorder(fake, (pid, signal) => {
      if (signal === 'SIGKILL') controller.abort();
      return pid === holder.child.pid && signal === 'SIGKILL';
    });
    const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 500, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    const killedAt = firstAt(signals, 'SIGKILL') ?? Number.NaN;
    expect(fake.now() - killedAt).toBeLessThanOrEqual(SLICE_MS);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort after the reap has no effect', async (context) => {
    const run = async (abortAfter: boolean) => {
      const marker = markerFile(withTempDir(context));
      const world = processTable({ [SURVIVOR]: { pgid: SURVIVOR, holdsMarker: true, ignoresTerm: true, survivesKill: true } }, {});
      const controller = new AbortController();
      const fake = reapTime();
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, killGraceMs: 300, label: 'daemon', onWarning: (message) => warnings.push(message), kill: world.kill, groupPort: world.groupPort, timing: fake.timing, signal: controller.signal, inspector: world.inspector });
      if (abortAfter) controller.abort();
      return { result, signals: world.signals, warnings: warnings.map((message) => message.replace(marker, '<marker>')), end: fake.now() };
    };
    const left = await run(false);
    expect(left.result).toEqual({ removed: false });
    expect(left.signals).toEqual([
      { pid: SURVIVOR, signal: 'SIGTERM' },
      { pid: SURVIVOR, signal: 'SIGKILL' },
    ]);
    expect(left.end).toBe(300 + KILL_CONFIRM_MS);
    expect(await run(true)).toEqual(left);
  });

  it('abort never throws', async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = abortingAt(reapTime(), controller, 100);
    const { kill } = signalRecorder(fake);
    await expect(reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal })).resolves.toEqual({ removed: false });
  });

  it.for([
    ['reapMarkedProcesses', 'reap'],
    ['reconcileProcessGroup', 'reconcile'],
  ] as const)('%s: a listing that never answers is bounded by the operation signal, and nothing is signalled', async ([, kind], context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    const fake = reapTime();
    const { signals, kill } = signalRecorder(fake);
    const options = { killGraceMs: 1000, kill, timing: fake.timing, signal: controller.signal, inspector: hungListing(seen) };
    const running =
      kind === 'reap'
        ? reapMarkedProcesses({ marker, label: 'daemon', onWarning: () => undefined, ...options }).catch((error: unknown) => error)
        : reconcileProcessGroup({ pgid: 999_999, marker }, options).catch((error: unknown) => error);
    await waitFor(() => seen.length > 0, { description: 'the reap started its first probe' });
    controller.abort();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await waitFor(() => settled || seen.every((signal) => signal.aborted), { description: 'the probe saw the abort' });
    expect(seen.every((signal) => signal.aborted)).toBe(true);
    await running;
    expect(signals).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  describe('no listener is added to or left on the signal', () => {
    const listeners = (signal: AbortSignal): number => getEventListeners(signal, 'abort').length;

    it.for([
      ['a normal completion', 'normal'],
      ['an abort during the grace', 'grace'],
      ['a pre-aborted signal', 'pre-aborted'],
      ['a kill that throws EIO', 'eio'],
    ] as const)('%s', async ([, variant], context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const script = variant === 'normal' ? `trap 'exit 0' TERM; touch "$READY"; exec ${HOLD_UNTIL_SIGNALLED}` : TERM_IGNORING_HOLDER;
      const holder = await spawnOnMarker(context, dir, marker, script);
      const controller = new AbortController();
      if (variant === 'pre-aborted') controller.abort();
      const fake = variant === 'grace' ? abortingAt(reapTime(), controller, 100) : reapTime();
      const { signals, kill } = signalRecorder(fake, (pid) => {
        if (variant === 'eio' && pid === holder.child.pid) throw errnoError('EIO', pid);
        return false;
      });
      const reap = reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
      if (variant === 'eio') await expect(reap).rejects.toThrow('kill EIO');
      else await reap;
      expect(listeners(controller.signal)).toBe(0);
      if (variant === 'grace' || variant === 'pre-aborted') expect(firstAt(signals, 'SIGKILL')).toBeUndefined();
    });
  });

  it('reapMarkerDirectory forwards the signal to every marker', async (context) => {
    const reapThree = async (withSignal: boolean) => {
      const dir = withTempDir(context);
      const markerDir = path.join(dir, 'markers');
      fs.mkdirSync(markerDir);
      const holders: Held[] = [];
      for (const name of ['a', 'b', 'c']) holders.push(await spawnOnMarker(context, dir, markerFile(markerDir, name), TERM_IGNORING_HOLDER));
      const controller = new AbortController();
      const fake = withSignal ? abortingAt(reapTime(), controller, 100) : reapTime();
      const { signals, kill } = signalRecorder(fake);
      const result = await reapMarkerDirectory({
        inspector: testProcessInspector(),
        dir: markerDir,
        killGraceMs: 1500,
        label: 'daemon',
        onWarning: () => undefined,
        kill,
        timing: fake.timing,
        signal: controller.signal,
      });
      const signalsOf = (holder: Held) => signals.filter((entry) => entry.pid === holder.child.pid).map(({ signal }) => signal);
      const perHolder = holders.map(signalsOf);
      const killTimes = holders.map((holder) => signals.find((entry) => entry.pid === holder.child.pid && entry.signal === 'SIGKILL')?.at);
      if (!withSignal) await Promise.all(holders.map((holder) => holder.exited));
      return { result, perHolder, killTimes, remaining: fs.readdirSync(markerDir).sort(), elapsed: fake.now() };
    };
    const aborted = await reapThree(true);
    expect(aborted.result).toEqual({ reaped: 0, kept: 3, unreaped: [] });
    expect(aborted.remaining).toEqual(['a', 'b', 'c']);
    expect(aborted.perHolder).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGTERM']]);
    expect(aborted.elapsed).toBeLessThanOrEqual(100 + SLICE_MS);
    const patient = await reapThree(false);
    expect(patient.result).toEqual({ reaped: 3, kept: 0, unreaped: [] });
    expect(patient.remaining).toEqual([]);
    expect(patient.perHolder).toEqual([['SIGTERM', 'SIGKILL'], ['SIGTERM', 'SIGKILL'], ['SIGTERM', 'SIGKILL']]);
    for (const at of patient.killTimes) expect(at).toBeGreaterThanOrEqual(1500);
  });

  it('reapMarkerDirectory over a process listing slower than any fixed wall-clock bound reaps by the listing result alone: nothing is killed and the sweep does not fail', async (context) => {
    const dir = withTempDir(context);
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    markerFile(markerDir, 'a');
    markerFile(markerDir, 'b');
    const fake = reapTime();
    const requests: Array<{ file: string; timeoutMs: number | undefined; signalAborted: boolean | undefined }> = [];
    const slowListing: CommandRunner = async (file, _args, options) => {
      requests.push({ file, timeoutMs: options.timeoutMs, signalAborted: options.signal?.aborted });
      await sleep(fake.timing, SLOW_LISTING_MS);
      if (options.timeoutMs !== undefined && options.timeoutMs < SLOW_LISTING_MS) throw Object.assign(new Error(`${file} killed after ${options.timeoutMs} ms`), { killed: true, signal: 'SIGKILL' });
      if (options.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const inspector = createProcessInspector('lsof', { ...hostInspectorPorts(testLocks().capability), run: slowListing });
    const { signals, kill } = signalRecorder(fake);
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ signal: new AbortController().signal, dir: markerDir, killGraceMs: 1000, label: 'tool', onWarning: (message) => warnings.push(message), kill, timing: fake.timing, inspector });
    expect(result).toEqual({ reaped: 2, kept: 0, unreaped: [] });
    expect(fs.readdirSync(markerDir)).toEqual([]);
    expect(signals).toEqual([]);
    expect(warnings).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.timeoutMs === undefined && request.signalAborted === false)).toBe(true);
    expect(fake.now()).toBeGreaterThan(SLOW_LISTING_MS);
  });

  describe('no signal behaves as before', () => {
    it('the holders-only path polls in slices and SIGKILLs at the grace', async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
      const fake = reapTime();
      const { signals, kill } = signalRecorder(fake);
      const result = await reapMarkedProcesses({ inspector: testProcessInspector(), marker, killGraceMs: 300, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing });
      expect(signals.map(({ pid, signal }) => [pid, signal])).toEqual([
        [holder.child.pid, 'SIGTERM'],
        [holder.child.pid, 'SIGKILL'],
      ]);
      expect(firstAt(signals, 'SIGKILL')).toBeGreaterThanOrEqual(300);
      expect(fake.sleeps.every((ms) => ms === SLICE_MS)).toBe(true);
      expect(result).toEqual({ removed: true });
    });

    it('an options object without signal sleeps once on the recorded-group path', async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const group = await spawnOnMarker(context, dir, marker, TERM_IGNORING_GROUP);
      const fake = reapTime();
      const { signals, kill } = signalRecorder(fake);
      const result = await reconcileProcessGroup({ pgid: group.child.pid, marker }, { inspector: testProcessInspector(), killGraceMs: 1000, kill, timing: fake.timing });
      expect(fake.sleeps).toEqual([1000]);
      expect(signals.filter(({ signal }) => signal === 'SIGTERM')).toEqual([{ pid: -group.child.pid, signal: 'SIGTERM', at: 0 }]);
      const kills = signals.filter(({ signal }) => signal === 'SIGKILL');
      expect(kills[0]).toEqual({ pid: -group.child.pid, signal: 'SIGKILL', at: 1000 });
      expect(kills.every(({ at }) => at === 1000)).toBe(true);
      expect(result.outcome).toBe('unknown');
      expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    });

    it('the single-argument form that bash.ts uses still reaps the group', async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const group = await spawnOnMarker(context, dir, marker, TERM_EXITING_GROUP);
      const result = await reconcileProcessGroup({ pgid: group.child.pid, marker }, { inspector: testProcessInspector() });
      await group.exited;
      expect(result.outcome).toBe('unknown');
      expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    });
  });
});

type TableProcess = { pgid: number; holdsMarker: boolean; marker?: string; ignoresTerm: boolean; survivesKill?: boolean; signalError?: string; holdsFromListing?: number; startMs?: bigint; startUnreadable?: boolean };

const SURVIVOR = 4242;
const REFUSING = 300;

type Reuses = { atListing?: Record<number, Record<number, TableProcess>>; afterGroupRead?: Record<number, Record<number, TableProcess>>; afterStartRead?: Record<number, TableProcess> };

const processTable = (initial: Record<number, TableProcess>, exitsAfterListing: Record<number, number[]>, reuses: Reuses = {}) => {
  const table = new Map<number, TableProcess>(Object.entries(initial).map(([pid, entry]) => [Number(pid), entry]));
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let listings = 0;
  let groupReads = 0;
  const pendingStartReuse = new Map<number, TableProcess>(Object.entries(reuses.afterStartRead ?? {}).map(([pid, entry]) => [Number(pid), entry]));
  const noSuchProcess = (): NodeJS.ErrnoException => Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const hit = (target: number): number[] => (target < 0 ? [...table].filter(([, entry]) => entry.pgid === -target).map(([pid]) => pid) : table.has(target) ? [target] : []);
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const pids = hit(target);
    if (signal !== 0) signals.push({ pid: target, signal });
    if (pids.length === 0) throw noSuchProcess();
    if (signal === 0) return;
    const refusing = pids.map((pid) => table.get(pid)?.signalError).find((code) => code !== undefined);
    if (refusing !== undefined) throw errnoError(refusing, target);
    for (const pid of pids) if (signal === 'SIGKILL' ? table.get(pid)?.survivesKill !== true : !table.get(pid)?.ignoresTerm) table.delete(pid);
  };
  const reuse = (replacements: Record<number, TableProcess>): void => {
    for (const [pid, entry] of Object.entries(replacements)) table.set(Number(pid), entry);
  };
  const inspector = {
    startTimeOf: async (pid: number) => {
      const entry = table.get(pid);
      if (entry === undefined) return { kind: 'gone' };
      if (entry.startUnreadable === true) return { kind: 'failed', cause: 'deterministic', evidence: { kind: 'exit', exitCode: 1, detail: 'ps exited with 1' } };
      const replacement = pendingStartReuse.get(pid);
      if (replacement !== undefined) {
        pendingStartReuse.delete(pid);
        table.set(pid, replacement);
      }
      return { kind: 'value', value: entry.startMs ?? BigInt(pid) };
    },
    holdersOf: async (marker: string) => {
      listings += 1;
      reuse(reuses.atListing?.[listings] ?? {});
      const holders = [...table]
        .filter(([, entry]) => entry.holdsMarker && (entry.marker === undefined || entry.marker === path.basename(marker)) && listings >= (entry.holdsFromListing ?? 1))
        .map(([pid]) => pid);
      for (const pid of exitsAfterListing[listings] ?? []) table.delete(pid);
      return { kind: 'value', value: holders };
    },
    groupsOf: async (pids: readonly number[]) => {
      groupReads += 1;
      const rows = new Map(pids.filter((pid) => table.has(pid)).map((pid) => [pid, table.get(pid)!.pgid]));
      reuse(reuses.afterGroupRead?.[groupReads] ?? {});
      return { kind: 'value', value: rows };
    },
    markerState: async () => 'free',
  } as unknown as ProcessInspector;
  const groupPort = createPosixGroupPort({
    kill,
    reading: {
      successMeansRunnable: true,
      states: async (pgid) => {
        throw new Error(`the fake process table reads no run states (group ${pgid})`);
      },
    },
  });
  return { signals, kill, groupPort, inspector, alive: (pid: number): boolean => table.has(pid) };
};

const stranger = (pgid: number): TableProcess => ({ pgid, holdsMarker: false, ignoresTerm: false, startMs: 999_999n });

describe('a target is signalled only when its start time read at the listing reads the same just before the signal (decision 12: a process whose start time cannot be read is never signalled; ProcessStop HolderTargetProved)', () => {
  it('a holder outside the group whose pid is reused after the group read gets no SIGTERM', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: false }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: false } },
      {},
      { afterGroupRead: { 1: { 200: stranger(300) } } },
    );
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals.filter(({ pid }) => pid === 200)).toEqual([]);
  });

  it('a group whose only listed holder exits and whose pid and group number are reused after the group read gets no group signal', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 100: { pgid: 100, holdsMarker: true, ignoresTerm: false } }, {}, { afterGroupRead: { 1: { 100: stranger(100) } } });
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals.filter(({ pid }) => pid === -100)).toEqual([]);
  });

  it('a holder outside the group whose pid is reused after the kill pass group read gets no SIGKILL', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: false }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: true } },
      {},
      { afterGroupRead: { 2: { 200: stranger(300) } } },
    );
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals.filter(({ pid, signal }) => pid === 200 && signal === 'SIGKILL')).toEqual([]);
  });

  it('a holder outside the group whose start time cannot be read is not signalled and is reported left alone', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: false }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: false, startUnreadable: true } },
      {},
    );
    const result = await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals.filter(({ pid }) => pid === 200)).toEqual([]);
    expect(result.leftAlonePids).toEqual([200]);
    expect(result.output).toContain('process 200');
  });

  it('a group whose only listed holder has a start time that cannot be read gets no group signal', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 100: { pgid: 100, holdsMarker: true, ignoresTerm: false, startUnreadable: true } }, {});
    const result = await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals).toEqual([]);
    expect(result.leftAlonePids).toEqual([100]);
  });

  it('a marker with no recorded group: a holder whose start time cannot be read is not signalled, is reported left alone, and the marker is kept', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 200: { pgid: 200, holdsMarker: true, ignoresTerm: false, startUnreadable: true } }, {});
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'mcp', onWarning: (message) => warnings.push(message), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals).toEqual([]);
    expect(warnings).toContain(`mcp marker ${marker}: process 200 is still alive but could not be verified as belonging to this call, so it was left alone`);
    expect(result).toEqual({ removed: false });
  });

  it('a holder that dropped the marker and whose pid was then reused is not reported as a holder still alive', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: false }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: false } },
      {},
      { atListing: { 2: { 200: stranger(300) } } },
    );
    const result = await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(result.leftAlonePids).toEqual([]);
  });

  it('a marker with no recorded group: a holder that dropped the marker and whose pid was then reused is not reported as still alive', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 200: { pgid: 200, holdsMarker: true, ignoresTerm: false } }, {}, { atListing: { 2: { 200: stranger(300) } } });
    const warnings: string[] = [];
    await reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'mcp', onWarning: (message) => warnings.push(message), kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(warnings.filter((warning) => warning.includes('process 200'))).toEqual([]);
  });

  it('a live group with no listed holder in it, while holders outside it exist, is reported left alone', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 100: { pgid: 100, holdsMarker: false, ignoresTerm: true }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: false } }, {});
    const result = await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals.filter(({ pid }) => pid === -100)).toEqual([]);
    expect(result.leftAloneGroup).toBe(100);
    expect(result.output).toContain('group 100');
  });

  it('a marker with no recorded group: a holder whose pid is reused after its start time was read gets no signal', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable({ 200: { pgid: 200, holdsMarker: true, ignoresTerm: false } }, {}, { afterStartRead: { 200: stranger(300) } });
    await reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'mcp', onWarning: () => undefined, kill: world.kill, groupPort: world.groupPort, timing: reapTime().timing, inspector: world.inspector });
    expect(world.signals).toEqual([]);
  });
});

describe('a holder the group read no longer finds is never signalled by its pid (decision 12: only a process proved ours is signalled)', () => {
  it('a group member that exits between the holder listing and the group read gets no SIGTERM of its own', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: true }, 101: { pgid: 100, holdsMarker: true, ignoresTerm: false } },
      { 1: [101] },
    );
    const fake = reapTime();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: fake.timing, inspector: world.inspector });
    expect(world.signals.filter(({ signal }) => signal === 'SIGTERM')).toEqual([{ pid: -100, signal: 'SIGTERM' }]);
    expect(world.signals.filter(({ pid }) => pid === 101)).toEqual([]);
  });

  it('a holder outside the group that exits between the second listing and its group read gets no SIGKILL', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: true }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: true } },
      { 2: [200] },
    );
    const fake = reapTime();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: fake.timing, inspector: world.inspector });
    expect(world.signals).toEqual([
      { pid: -100, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGTERM' },
      { pid: -100, signal: 'SIGKILL' },
    ]);
  });

  it('a group member first listed at the kill pass is reached through its group, which that pass proves ours, even when the SIGTERM pass found no member in it', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: true, holdsFromListing: 2 }, 101: { pgid: 100, holdsMarker: true, ignoresTerm: false } },
      { 1: [101] },
    );
    const fake = reapTime();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, groupPort: world.groupPort, timing: fake.timing, inspector: world.inspector });
    expect(world.signals).toEqual([{ pid: -100, signal: 'SIGKILL' }]);
  });
});
