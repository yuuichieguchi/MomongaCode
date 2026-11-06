import { execFileSync, spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LSOF_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, killPidsForCleanup, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext, TrackedChild } from '@momonga/testkit';
import { MarkerReapError, createProcessInspector, hostInspectorPorts, reapMarkedProcesses, reapMarkedProcessesWithReport, reapMarkerDirectory, reconcileProcessGroup } from '@momonga/foundation';
import type { CommandRunner, ProcessInspector, ReapTiming } from '@momonga/foundation';

const SIGTERM_GRACE_TEST_TIMEOUT_MS = REAL_PROCESS_TEST_TIMEOUT_MS;
const SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS = REAL_PROCESS_TEST_TIMEOUT_MS;
const SIGTERM_GRACE_PLUS_SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS = SIGTERM_GRACE_TEST_TIMEOUT_MS + SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS;
const MARKER_FAN_OUT_TEST_TIMEOUT_MS = 4 * REAL_PROCESS_TEST_TIMEOUT_MS;

const spawnedGroups: number[] = [];
const spawnedPids: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
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

const waitUntil = async (condition: () => boolean, attempts = 500): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reap-')));
  tempDirs.push(dir);
  return dir;
};

const makeMarker = (dir: string, name = 'marker', content = ''): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, content, { mode: 0o600 });
  return marker;
};

type FakeTiming = { timing: ReapTiming; sleeps: number[]; now(): number };

const fakeTiming = (): FakeTiming => {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    timing: {
      now: () => current,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        current += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
  };
};

type Signalled = { pid: number; signal: NodeJS.Signals | 0; at: number };

const recordingKill = (clock: () => number, intercept: (pid: number, signal: NodeJS.Signals | 0) => boolean = () => false) => {
  const signals: Signalled[] = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) signals.push({ pid, signal, at: clock() });
    if (intercept(pid, signal)) return;
    process.kill(pid, signal);
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
    const argv = options.ignoreTerm === true ? ['/bin/sh', '-c', "trap '' TERM; exec /bin/sleep 60"] : ['/bin/sleep', '60'];
    const child = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error('spawn failed');
    spawnedPids.push(pid);
    spawnedGroups.push(pid);
    if (!(await waitUntil(() => holdersOf(marker).includes(pid)))) throw new Error('holder did not open the marker');
    return pid;
  } finally {
    fs.closeSync(fd);
  }
};

const TERM_MARKER_SCRIPT = `trap 'echo term > "$DIR/term"; kill $! 2>/dev/null; exit 0' TERM; sleep 60 & touch "$DIR/ready"; wait`;
const IGNORING_GROUP_SCRIPT = `trap '' TERM; touch "$DIR/ready"; while :; do sleep 1; done`;
const CLOSED_FD_SCRIPT = `exec 3<&-; trap 'exit 0' TERM; sleep 60 & touch "$DIR/ready"; wait`;
const MEMBER_WITHOUT_FD_SCRIPT = `/bin/sh -c 'exec 3<&-; echo $$ > "$DIR/member.pid"; exec sleep 60' & trap 'exit 0' TERM; touch "$DIR/ready"; wait`;

const nonZero = (signals: readonly Signalled[]): Array<[number, NodeJS.Signals | 0]> => signals.map(({ pid, signal }) => [pid, signal]);

describe('reapMarkedProcesses', () => {
  it('reaps the recorded group and removes the marker', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    fs.writeFileSync(marker, `${group.pgid}\n`);
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 10_000, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(nonZero(signals)[0]).toEqual([-group.pgid, 'SIGTERM']);
    expect(fs.readFileSync(path.join(dir, 'term'), 'utf8')).toBe('term\n');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('prefers the pgid option over the marker content', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const decoyDir = makeDir();
    const marker = makeMarker(dir);
    const decoy = await startGroup(decoyDir, TERM_MARKER_SCRIPT);
    fs.writeFileSync(marker, `${decoy.pgid}\n`);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker, pgid: group.pgid, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(nonZero(signals)[0]).toEqual([-group.pgid, 'SIGTERM']);
    expect(signals.some(({ pid }) => Math.abs(pid) === decoy.pgid)).toBe(false);
    expect(alive(-decoy.pgid)).toBe(true);
    expect(fs.existsSync(path.join(decoyDir, 'term'))).toBe(false);
  });

  it('with an empty marker and no pgid signals only the holders', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, MEMBER_WITHOUT_FD_SCRIPT, { fd3: marker, readyFiles: ['ready', 'member.pid'] });
    const member = Number(fs.readFileSync(path.join(dir, 'member.pid'), 'utf8').trim());
    const holders = holdersOf(marker);
    expect(holders).toEqual([group.pgid]);
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
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
  ])('never signals %s', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async (_name, pgidOf) => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker);
    const pgid = pgidOf();
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker, pgid, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(({ pid }) => pid === holder)).toBe(true);
  });

  it('never signals a recorded own group read from the marker content', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker);
    fs.writeFileSync(marker, `${ownGroup()}\n`);
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    await reapMarkedProcesses({ marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(({ pid }) => pid === holder)).toBe(true);
  });

  it('escalates a SIGTERM-ignoring holder to SIGKILL once the injected clock passes killGraceMs', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_GROUP_SCRIPT, { fd3: marker });
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker, pgid: group.pgid, killGraceMs: 600_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
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

  it('escalates a SIGTERM-ignoring holder to SIGKILL on the holders-only path once the injected clock passes killGraceMs', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: true });
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker, killGraceMs: 500, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals[0]).toEqual({ pid: holder, signal: 'SIGTERM', at: 0 });
    const killed = signals.find(({ signal }) => signal === 'SIGKILL');
    expect(killed?.pid).toBe(holder);
    expect(killed?.at).toBeGreaterThanOrEqual(500);
    expect(fake.sleeps.every((ms) => ms === 25)).toBe(true);
    expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('keeps the marker and warns with the label when a holder remains', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const stubborn = await startHolder(marker);
    const other = await startHolder(marker);
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now, (pid, signal) => pid === stubborn && signal !== 0);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
    expect(warnings).toEqual([`tool marker ${marker} kept: process ${stubborn} still hold it after cleanup; the next start will retry`]);
    expect(signals.some(({ pid, signal }) => pid === other && signal === 'SIGTERM')).toBe(true);
    expect(await waitUntil(() => !alive(other))).toBe(true);
    expect(alive(stubborn)).toBe(true);
  });

  describe('prefixes the leftAloneGroup, leftAlonePids and unsignalled warnings with the label', () => {
    it('leftAloneGroup', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const group = await startGroup(dir, CLOSED_FD_SCRIPT, { fd3: marker });
      const fake = fakeTiming();
      const { signals, kill } = recordingKill(fake.now);
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, pgid: group.pgid, killGraceMs: 200, label: 'mcp', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
      expect(result).toEqual({ removed: true });
      expect(warnings).toEqual([`mcp marker ${marker}: group ${group.pgid} is still alive but no marker holder is in it, so it was left alone`]);
      expect(signals).toEqual([]);
      expect(alive(-group.pgid)).toBe(true);
    });

    it('leftAlonePids', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const fd = fs.openSync(marker, 'r');
      const ready = path.join(dir, 'ready');
      const source = "const fs = require('node:fs'); process.on('SIGTERM', () => fs.closeSync(3)); fs.writeFileSync(process.env.READY_FILE, ''); setInterval(() => {}, 1 << 30);";
      const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin', READY_FILE: ready } });
      fs.closeSync(fd);
      child.unref();
      const pid = child.pid;
      if (pid === undefined) throw new Error('spawn failed');
      spawnedGroups.push(pid);
      expect(await waitUntil(() => fs.existsSync(ready) && holdersOf(marker).includes(pid))).toBe(true);
      const kill = (target: number, signal: NodeJS.Signals | 0): void => {
        process.kill(target, signal);
      };
      const terminated = waitUntil(() => !holdersOf(marker).includes(pid));
      const timing: ReapTiming = {
        now: () => 0,
        sleep: async () => {
          await terminated;
        },
      };
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, pgid: pid, killGraceMs: 200, label: 'mcp', onWarning: (m) => warnings.push(m), kill, timing });
      expect(result).toEqual({ removed: true });
      expect(warnings).toContain(`mcp marker ${marker}: process ${pid} dropped the marker but is still alive, so it was left alone`);
      expect(alive(pid)).toBe(true);
    });

    it('unsignalled', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const blocked = await startHolder(marker);
      const fake = fakeTiming();
      const { kill } = recordingKill(fake.now, (pid, signal) => {
        if (pid === blocked && signal !== 0) throw errnoError('EPERM', pid);
        return false;
      });
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, killGraceMs: 200, label: 'mcp', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
      expect(result).toEqual({ removed: false });
      expect(warnings).toContain(`mcp marker ${marker}: could not signal process ${blocked}`);
      expect(warnings).toContain(`mcp marker ${marker} kept: process ${blocked} still hold it after cleanup; the next start will retry`);
      expect(alive(blocked)).toBe(true);
    });
  });

  describe('one signalling rule for both reap paths', () => {
    const paths = [
      ['the holders-only path', false],
      ['the recorded-group path', true],
    ] as const;

    it.each(paths)('collects EPERM on %s and warns could not signal', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async (_name, recordGroup) => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const blocked = await startHolder(marker);
      const fake = fakeTiming();
      const { kill } = recordingKill(fake.now, (pid, signal) => {
        if (Math.abs(pid) === blocked && signal !== 0) throw errnoError('EPERM', pid);
        return false;
      });
      const warnings: string[] = [];
      await reapMarkedProcesses({ marker, ...(recordGroup ? { pgid: blocked } : {}), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
      expect(warnings.filter((m) => m.startsWith(`tool marker ${marker}: could not signal process `))).toHaveLength(1);
      expect(warnings.find((m) => m.includes('could not signal'))).toContain(String(blocked));
    });

    it.each(paths)('ignores ESRCH on %s', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async (_name, recordGroup) => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const holder = await startHolder(marker);
      const fake = fakeTiming();
      const { kill } = recordingKill(fake.now, (pid, signal) => {
        if (Math.abs(pid) === holder && signal !== 0) throw errnoError('ESRCH', pid);
        return false;
      });
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, ...(recordGroup ? { pgid: holder } : {}), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
      expect(result).toEqual({ removed: false });
      expect(warnings.some((m) => m.includes('could not signal'))).toBe(false);
      expect(warnings).toContain(`tool marker ${marker} kept: process ${holder} still hold it after cleanup; the next start will retry`);
    });

    it.each(paths)('throws any other signalling error on %s', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async (_name, recordGroup) => {
      const dir = makeDir();
      const marker = makeMarker(dir);
      const holder = await startHolder(marker);
      const fake = fakeTiming();
      const { kill } = recordingKill(fake.now, (pid, signal) => {
        if (Math.abs(pid) === holder && signal !== 0) throw errnoError('EINVAL', pid);
        return false;
      });
      await expect(
        reapMarkedProcesses({ marker, ...(recordGroup ? { pgid: holder } : {}), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing }),
      ).rejects.toThrow(`kill EINVAL`);
    });
  });

  it('unlinks a symlink marker without following it', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const target = makeMarker(dir, 'target', 'keep me');
    const marker = path.join(dir, 'marker');
    fs.symlinkSync(target, marker);
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(() => fs.lstatSync(marker)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(marker);
    expect(signals).toEqual([]);
  });

  it('reports a missing marker as removed', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker: path.join(dir, 'gone'), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals).toEqual([]);
  });

  it('reports that nothing was stopped for a missing marker', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const fake = fakeTiming();
    const { kill } = recordingKill(fake.now);
    const result = await reapMarkedProcessesWithReport({ marker: path.join(dir, 'gone'), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true, stopped: false, uninspectable: [] });
  });

  it('reports that a recorded group was stopped', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    fs.writeFileSync(marker, `${group.pgid}\n`);
    const fake = fakeTiming();
    const { kill } = recordingKill(fake.now);
    const result = await reapMarkedProcessesWithReport({ marker, killGraceMs: 10_000, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true, stopped: true, uninspectable: [] });
    await group.leaderReaped;
  });

  it('reports that a holder without a recorded group was stopped', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: false });
    const result = await reapMarkedProcessesWithReport({ marker, killGraceMs: 300, label: 'tool', onWarning: () => {} });
    expect(result).toEqual({ removed: true, stopped: true, uninspectable: [] });
    expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('waits only through timing.sleep', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_GROUP_SCRIPT, { fd3: marker });
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const hour = 3_600_000;
    const result = await reapMarkedProcesses({ marker, pgid: group.pgid, killGraceMs: hour, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(fake.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(hour);
    expect(signals.find(({ signal }) => signal === 'SIGKILL')?.at).toBeGreaterThanOrEqual(hour);
  });

  it('smoke (real time)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const holder = await startHolder(marker, { ignoreTerm: true });
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs: 300, label: 'tool', onWarning: (m) => warnings.push(m) });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(await waitUntil(() => !alive(holder))).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('reapMarkerDirectory', () => {
  it('reapMarkerDirectory reaps markers concurrently', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
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
    const events: string[] = [];
    let current = 0;
    let pendingFirst: Array<() => void> = [];
    let released = false;
    const timing: ReapTiming = {
      now: () => current,
      sleep: async (ms: number) => {
        events.push(`sleep:${ms}`);
        current += ms;
        if (released) {
          await new Promise((resolve) => setImmediate(resolve));
          return;
        }
        await new Promise<void>((resolve) => {
          pendingFirst.push(resolve);
          if (pendingFirst.length === groups.length) {
            released = true;
            for (const release of pendingFirst) release();
            pendingFirst = [];
          }
        });
      },
    };
    const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) events.push(`kill:${pid}:${signal}`);
      process.kill(pid, signal);
    };
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: markerDir, killGraceMs: 1000, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing });
    expect(released).toBe(true);
    expect(result).toEqual({ reaped: 3, kept: 0 });
    const firstKill = events.findIndex((event) => event.endsWith('SIGKILL'));
    const sleepsBeforeKill = events.slice(0, firstKill).filter((event) => event.startsWith('sleep:'));
    expect(sleepsBeforeKill.length).toBeGreaterThanOrEqual(groups.length);
    for (const group of groups) expect(events.indexOf(`kill:${-group.pgid}:SIGTERM`)).toBeLessThan(firstKill);
    expect(fs.readdirSync(markerDir)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reapMarkerDirectory on a missing directory reaps nothing', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: path.join(dir, 'missing'), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), timing: fakeTiming().timing });
    expect(result).toEqual({ reaped: 0, kept: 0 });
    expect(warnings).toEqual([]);
  });

  it('counts a marker whose holder remains as kept', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    const kept = makeMarker(markerDir, 'kept');
    const reaped = makeMarker(markerDir, 'reaped');
    const stubborn = await startHolder(kept);
    const other = await startHolder(reaped);
    const fake = fakeTiming();
    const { kill } = recordingKill(fake.now, (pid, signal) => pid === stubborn && signal !== 0);
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result).toEqual({ reaped: 1, kept: 1 });
    expect(fs.readdirSync(markerDir)).toEqual(['kept']);
    expect(warnings).toEqual([`tool marker ${kept} kept: process ${stubborn} still hold it after cleanup; the next start will retry`]);
    expect(await waitUntil(() => !alive(other))).toBe(true);
  });

  it('reaps the other markers when one target fails, then reports the failure instead of counting it', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    const failing = makeMarker(markerDir, 'failing');
    const first = makeMarker(markerDir, 'first');
    const second = makeMarker(markerDir, 'second');
    const broken = await startHolder(failing);
    const holders = [await startHolder(first), await startHolder(second)];
    const fake = fakeTiming();
    const { kill } = recordingKill(fake.now, (pid, signal) => {
      if (pid === broken && signal !== 0) throw errnoError('EINVAL', pid);
      return false;
    });
    const outcome = await reapMarkerDirectory({ dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: () => undefined, kill, timing: fake.timing }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(MarkerReapError);
    expect((outcome as MarkerReapError).message).toContain(`${failing}: kill EINVAL ${broken}`);
    expect((outcome as MarkerReapError).errors).toHaveLength(1);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(failing)).toBe(true);
    for (const holder of holders) expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('propagates a readdir error other than ENOENT', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeDir();
    const notADirectory = makeMarker(dir, 'file');
    await expect(reapMarkerDirectory({ dir: notADirectory, killGraceMs: 200, label: 'tool', onWarning: () => undefined, timing: fakeTiming().timing })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

const SLICE_MS = 25;
const REMOVED_PS_PROBE_TIMEOUT_MS = 2000;
const SLOW_LISTING_MS = 5 * REMOVED_PS_PROBE_TIMEOUT_MS;

type AbortableTiming = { timing: ReapTiming; sleeps: number[]; now(): number };

const abortableTiming = (trigger: { controller: AbortController; at: number } | undefined, onSleep: () => void = () => undefined): AbortableTiming => {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    timing: {
      now: () => current,
      sleep: async (ms: number) => {
        onSleep();
        sleeps.push(ms);
        current += ms;
        if (trigger !== undefined && current >= trigger.at && !trigger.controller.signal.aborted) trigger.controller.abort();
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
  };
};

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
    return { child, exited: exitOf(child) };
  } finally {
    fs.closeSync(fd);
  }
};

const TERM_IGNORING_HOLDER = `trap '' TERM; touch "$READY"; exec /bin/sleep 60`;
const TERM_IGNORING_GROUP = `trap '' TERM; touch "$READY"; while :; do /bin/sleep 1; done`;
const TERM_EXITING_GROUP = `trap 'exit 0' TERM; /bin/sleep 60 & touch "$READY"; wait`;

const markerFile = (dir: string, name = 'marker'): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

type SignalRecord = { pid: number; signal: NodeJS.Signals; at: number };

const signalRecorder = (now: () => number, intercept: (pid: number, signal: NodeJS.Signals) => boolean = () => false) => {
  const signals: SignalRecord[] = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) {
      signals.push({ pid, signal, at: now() });
      if (intercept(pid, signal)) return;
    }
    process.kill(pid, signal);
  };
  return { signals, kill };
};

const firstAt = (signals: readonly SignalRecord[], signal: NodeJS.Signals): number | undefined => signals.find((entry) => entry.signal === signal)?.at;

const T = { timeout: SIGTERM_GRACE_PLUS_SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS };

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
  it('abort during the grace ends the reap at once: no SIGKILL is sent and the marker is kept', T, async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = abortableTiming({ controller, at: 100 });
    const { signals, kill } = signalRecorder(fake.now);
    const result = await reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    expect(signals).toEqual([{ pid: holder.child.pid, signal: 'SIGTERM', at: 0 }]);
    expect(fake.now()).toBeLessThanOrEqual(100 + SLICE_MS);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort during the grace on the recorded-group path ends the reap the same way; without an abort the group gets SIGKILL at the grace', T, async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const group = await spawnOnMarker(context, dir, marker, TERM_IGNORING_GROUP);
    const pgid = group.child.pid;
    const controller = new AbortController();
    const fake = abortableTiming({ controller, at: 100 });
    const { signals, kill } = signalRecorder(fake.now);
    const result = await reapMarkedProcesses({ marker, pgid, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    expect(signals.map(({ pid, signal }) => [pid, signal])).toEqual([[-pgid, 'SIGTERM']]);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);

    const unsignalledDir = withTempDir(context);
    const unsignalledMarker = markerFile(unsignalledDir);
    const unsignalledGroup = await spawnOnMarker(context, unsignalledDir, unsignalledMarker, TERM_IGNORING_GROUP);
    const plain = abortableTiming(undefined);
    const plainRecorder = signalRecorder(plain.now);
    await reapMarkedProcesses({ marker: unsignalledMarker, pgid: unsignalledGroup.child.pid, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill: plainRecorder.kill, timing: plain.timing, signal: new AbortController().signal });
    expect(firstAt(plainRecorder.signals, 'SIGKILL')).toBe(1000);
  });

  it('abort before the call signals nothing and keeps the marker', T, async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const fake = abortableTiming(undefined);
    const { signals, kill } = signalRecorder(fake.now);
    const result = await reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: AbortSignal.abort() });
    expect(signals).toEqual([]);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort during the SIGKILL confirmation ends the wait as unconfirmed: the marker is kept', T, async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = abortableTiming(undefined);
    const { signals, kill } = signalRecorder(fake.now, (pid, signal) => {
      if (signal === 'SIGKILL') controller.abort();
      return pid === holder.child.pid && signal === 'SIGKILL';
    });
    const result = await reapMarkedProcesses({ marker, killGraceMs: 500, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
    const killedAt = firstAt(signals, 'SIGKILL') ?? Number.NaN;
    expect(fake.now() - killedAt).toBeLessThanOrEqual(SLICE_MS);
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('abort after the reap has no effect', T, async (context) => {
    const run = async (abortAfter: boolean) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
      const controller = new AbortController();
      const fake = abortableTiming(undefined);
      const { signals, kill } = signalRecorder(fake.now, (pid, signal) => pid === holder.child.pid && signal === 'SIGKILL');
      const warnings: string[] = [];
      const result = await reapMarkedProcesses({ marker, killGraceMs: 300, label: 'daemon', onWarning: (message) => warnings.push(message), kill, timing: fake.timing, signal: controller.signal });
      if (abortAfter) controller.abort();
      return { result, signals: signals.map(({ signal, at }) => [signal, at]), warnings: warnings.map((message) => message.replace(marker, '<marker>').replace(String(holder.child.pid), '<pid>')), end: fake.now() };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('abort never throws', T, async (context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
    const controller = new AbortController();
    const fake = abortableTiming({ controller, at: 100 });
    const { kill } = signalRecorder(fake.now);
    await expect(reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal })).resolves.toEqual({ removed: false });
  });

  it.for([
    ['reapMarkedProcesses', 'reap'],
    ['reconcileProcessGroup', 'reconcile'],
  ] as const)('%s: a listing that never answers is bounded by the operation signal, and nothing is signalled', T, async ([, kind], context) => {
    const dir = withTempDir(context);
    const marker = markerFile(dir);
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    const fake = abortableTiming(undefined);
    const { signals, kill } = signalRecorder(fake.now);
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
    ] as const)('%s', T, async ([, variant], context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const script = variant === 'normal' ? `trap 'exit 0' TERM; touch "$READY"; exec /bin/sleep 60` : TERM_IGNORING_HOLDER;
      const holder = await spawnOnMarker(context, dir, marker, script);
      const controller = new AbortController();
      if (variant === 'pre-aborted') controller.abort();
      const fake = abortableTiming(variant === 'grace' ? { controller, at: 100 } : undefined);
      const { signals, kill } = signalRecorder(fake.now, (pid) => {
        if (variant === 'eio' && pid === holder.child.pid) throw errnoError('EIO', pid);
        return false;
      });
      const reap = reapMarkedProcesses({ marker, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing, signal: controller.signal });
      if (variant === 'eio') await expect(reap).rejects.toThrow('kill EIO');
      else await reap;
      expect(listeners(controller.signal)).toBe(0);
      if (variant === 'grace' || variant === 'pre-aborted') expect(firstAt(signals, 'SIGKILL')).toBeUndefined();
    });
  });

  it('reapMarkerDirectory forwards the signal to every marker', { timeout: MARKER_FAN_OUT_TEST_TIMEOUT_MS }, async (context) => {
    const reapThree = async (withSignal: boolean) => {
      const dir = withTempDir(context);
      const markerDir = path.join(dir, 'markers');
      fs.mkdirSync(markerDir);
      const holders: Held[] = [];
      for (const name of ['a', 'b', 'c']) holders.push(await spawnOnMarker(context, dir, markerFile(markerDir, name), TERM_IGNORING_HOLDER));
      const controller = new AbortController();
      const fake = abortableTiming(withSignal ? { controller, at: 100 } : undefined);
      const { signals, kill } = signalRecorder(fake.now);
      const result = await reapMarkerDirectory({
        dir: markerDir,
        killGraceMs: 1500,
        label: 'daemon',
        onWarning: () => undefined,
        kill,
        timing: fake.timing,
        ...(withSignal ? { signal: controller.signal } : {}),
      });
      const signalsOf = (holder: Held) => signals.filter((entry) => entry.pid === holder.child.pid).map(({ signal }) => signal);
      const perHolder = holders.map(signalsOf);
      const killTimes = holders.map((holder) => signals.find((entry) => entry.pid === holder.child.pid && entry.signal === 'SIGKILL')?.at);
      if (!withSignal) await Promise.all(holders.map((holder) => holder.exited));
      return { result, perHolder, killTimes, remaining: fs.readdirSync(markerDir).sort(), elapsed: fake.now() };
    };
    const aborted = await reapThree(true);
    expect(aborted.result).toEqual({ reaped: 0, kept: 3 });
    expect(aborted.remaining).toEqual(['a', 'b', 'c']);
    expect(aborted.perHolder).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGTERM']]);
    expect(aborted.elapsed).toBeLessThanOrEqual(100 + SLICE_MS);
    const patient = await reapThree(false);
    expect(patient.result).toEqual({ reaped: 3, kept: 0 });
    expect(patient.remaining).toEqual([]);
    expect(patient.perHolder).toEqual([['SIGTERM', 'SIGKILL'], ['SIGTERM', 'SIGKILL'], ['SIGTERM', 'SIGKILL']]);
    for (const at of patient.killTimes) expect(at).toBeGreaterThanOrEqual(1500);
  });

  it('reapMarkerDirectory over a process listing slower than any fixed wall-clock bound reaps by the listing result alone: nothing is killed and the sweep does not fail', T, async (context) => {
    const dir = withTempDir(context);
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    markerFile(markerDir, 'a');
    markerFile(markerDir, 'b');
    const fake = abortableTiming(undefined);
    const requests: Array<{ file: string; timeoutMs: number | undefined; signalAborted: boolean | undefined }> = [];
    const slowListing: CommandRunner = async (file, _args, options) => {
      requests.push({ file, timeoutMs: options.timeoutMs, signalAborted: options.signal?.aborted });
      await fake.timing.sleep(SLOW_LISTING_MS);
      if (options.timeoutMs !== undefined && options.timeoutMs < SLOW_LISTING_MS) throw Object.assign(new Error(`${file} killed after ${options.timeoutMs} ms`), { killed: true, signal: 'SIGKILL' });
      if (options.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const inspector = createProcessInspector('darwin', { ...hostInspectorPorts(), run: slowListing });
    const { signals, kill } = signalRecorder(fake.now);
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: markerDir, killGraceMs: 1000, label: 'tool', onWarning: (message) => warnings.push(message), kill, timing: fake.timing, inspector });
    expect(result).toEqual({ reaped: 2, kept: 0 });
    expect(fs.readdirSync(markerDir)).toEqual([]);
    expect(signals).toEqual([]);
    expect(warnings).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.timeoutMs === undefined && request.signalAborted === false)).toBe(true);
    expect(fake.now()).toBeGreaterThan(SLOW_LISTING_MS);
  });

  describe('no signal behaves as before', () => {
    it('the holders-only path polls in slices and SIGKILLs at the grace', { timeout: SIGTERM_GRACE_PLUS_SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS }, async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const holder = await spawnOnMarker(context, dir, marker, TERM_IGNORING_HOLDER);
      const fake = abortableTiming(undefined);
      const { signals, kill } = signalRecorder(fake.now);
      const result = await reapMarkedProcesses({ marker, killGraceMs: 300, label: 'daemon', onWarning: () => undefined, kill, timing: fake.timing });
      expect(signals.map(({ pid, signal }) => [pid, signal])).toEqual([
        [holder.child.pid, 'SIGTERM'],
        [holder.child.pid, 'SIGKILL'],
      ]);
      expect(firstAt(signals, 'SIGKILL')).toBeGreaterThanOrEqual(300);
      expect(fake.sleeps.every((ms) => ms === SLICE_MS)).toBe(true);
      expect(result).toEqual({ removed: true });
    });

    it('an options object without signal sleeps once on the recorded-group path', { timeout: SIGTERM_GRACE_PLUS_SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS }, async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const group = await spawnOnMarker(context, dir, marker, TERM_IGNORING_GROUP);
      const fake = abortableTiming(undefined);
      const { signals, kill } = signalRecorder(fake.now);
      const result = await reconcileProcessGroup({ pgid: group.child.pid, marker }, { killGraceMs: 1000, kill, timing: fake.timing });
      expect(fake.sleeps).toEqual([1000]);
      expect(signals.filter(({ signal }) => signal === 'SIGTERM')).toEqual([{ pid: -group.child.pid, signal: 'SIGTERM', at: 0 }]);
      const kills = signals.filter(({ signal }) => signal === 'SIGKILL');
      expect(kills[0]).toEqual({ pid: -group.child.pid, signal: 'SIGKILL', at: 1000 });
      expect(kills.every(({ at }) => at === 1000)).toBe(true);
      expect(result.outcome).toBe('unknown');
      expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    });

    it('the single-argument form that bash.ts uses still reaps the group', { timeout: SIGTERM_GRACE_PLUS_SIGKILL_CONFIRMATION_TEST_TIMEOUT_MS }, async (context) => {
      const dir = withTempDir(context);
      const marker = markerFile(dir);
      const group = await spawnOnMarker(context, dir, marker, TERM_EXITING_GROUP);
      const result = await reconcileProcessGroup({ pgid: group.child.pid, marker });
      await group.exited;
      expect(result.outcome).toBe('unknown');
      expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    });
  });
});

type TableProcess = { pgid: number; holdsMarker: boolean; ignoresTerm: boolean; holdsFromListing?: number };

const processTable = (initial: Record<number, TableProcess>, exitsAfterListing: Record<number, number[]>) => {
  const table = new Map<number, TableProcess>(Object.entries(initial).map(([pid, entry]) => [Number(pid), entry]));
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let listings = 0;
  const noSuchProcess = (): NodeJS.ErrnoException => Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const hit = (target: number): number[] => (target < 0 ? [...table].filter(([, entry]) => entry.pgid === -target).map(([pid]) => pid) : table.has(target) ? [target] : []);
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const pids = hit(target);
    if (signal !== 0) signals.push({ pid: target, signal });
    if (pids.length === 0) throw noSuchProcess();
    if (signal === 0) return;
    for (const pid of pids) if (signal === 'SIGKILL' || !table.get(pid)?.ignoresTerm) table.delete(pid);
  };
  const inspector = {
    startTimeOf: async (pid: number) => (table.has(pid) ? { kind: 'value', value: 0 } : { kind: 'gone' }),
    holdersOf: async () => {
      listings += 1;
      const holders = [...table].filter(([, entry]) => entry.holdsMarker && listings >= (entry.holdsFromListing ?? 1)).map(([pid]) => pid);
      for (const pid of exitsAfterListing[listings] ?? []) table.delete(pid);
      return { kind: 'value', value: holders };
    },
    groupsOf: async (pids: readonly number[]) => ({ kind: 'value', value: new Map(pids.filter((pid) => table.has(pid)).map((pid) => [pid, table.get(pid)!.pgid])) }),
    markerState: async () => 'free',
  } as unknown as ProcessInspector;
  return { signals, kill, inspector };
};

describe('a holder the group read no longer finds is never signalled by its pid (decision 12: only a process proved ours is signalled)', () => {
  it('a group member that exits between the holder listing and the group read gets no SIGTERM of its own', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: true }, 101: { pgid: 100, holdsMarker: true, ignoresTerm: false } },
      { 1: [101] },
    );
    const fake = fakeTiming();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, timing: fake.timing, inspector: world.inspector });
    expect(world.signals.filter(({ signal }) => signal === 'SIGTERM')).toEqual([{ pid: -100, signal: 'SIGTERM' }]);
    expect(world.signals.filter(({ pid }) => pid === 101)).toEqual([]);
  });

  it('a holder outside the group that exits between the second listing and its group read gets no SIGKILL', async (context) => {
    const marker = markerFile(withTempDir(context));
    const world = processTable(
      { 100: { pgid: 100, holdsMarker: true, ignoresTerm: true }, 200: { pgid: 200, holdsMarker: true, ignoresTerm: true } },
      { 2: [200] },
    );
    const fake = fakeTiming();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, timing: fake.timing, inspector: world.inspector });
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
    const fake = fakeTiming();
    await reconcileProcessGroup({ pgid: 100, marker }, { killGraceMs: 1000, kill: world.kill, timing: fake.timing, inspector: world.inspector });
    expect(world.signals).toEqual([{ pid: -100, signal: 'SIGKILL' }]);
  });
});
