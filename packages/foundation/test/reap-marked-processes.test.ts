import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { reapMarkedProcesses, reapMarkerDirectory } from '@momonga/foundation';
import type { ReapTiming } from '@momonga/foundation';

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
    return execFileSync('/usr/sbin/lsof', ['-t', '--', file], { env: { LC_ALL: 'C' }, encoding: 'utf8' })
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
  it('reaps the recorded group and removes the marker', { timeout: 30_000 }, async () => {
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

  it('prefers the pgid option over the marker content', { timeout: 30_000 }, async () => {
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

  it('with an empty marker and no pgid signals only the holders', { timeout: 30_000 }, async () => {
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
  ])('never signals %s', { timeout: 30_000 }, async (_name, pgidOf) => {
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

  it('never signals a recorded own group read from the marker content', { timeout: 30_000 }, async () => {
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

  it('escalates a SIGTERM-ignoring holder to SIGKILL once the injected clock passes killGraceMs', { timeout: 30_000 }, async () => {
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

  it('escalates a SIGTERM-ignoring holder to SIGKILL on the holders-only path once the injected clock passes killGraceMs', { timeout: 30_000 }, async () => {
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

  it('keeps the marker and warns with the label when a holder remains', { timeout: 30_000 }, async () => {
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
    it('leftAloneGroup', { timeout: 30_000 }, async () => {
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

    it('leftAlonePids', { timeout: 30_000 }, async () => {
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

    it('unsignalled', { timeout: 30_000 }, async () => {
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

    it.each(paths)('collects EPERM on %s and warns could not signal', { timeout: 30_000 }, async (_name, recordGroup) => {
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

    it.each(paths)('ignores ESRCH on %s', { timeout: 30_000 }, async (_name, recordGroup) => {
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

    it.each(paths)('throws any other signalling error on %s', { timeout: 30_000 }, async (_name, recordGroup) => {
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

  it('unlinks a symlink marker without following it', { timeout: 30_000 }, async () => {
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

  it('reports a missing marker as removed', { timeout: 30_000 }, async () => {
    const dir = makeDir();
    const fake = fakeTiming();
    const { signals, kill } = recordingKill(fake.now);
    const result = await reapMarkedProcesses({ marker: path.join(dir, 'gone'), killGraceMs: 200, label: 'tool', onWarning: () => {}, kill, timing: fake.timing });
    expect(result).toEqual({ removed: true });
    expect(signals).toEqual([]);
  });

  it('waits only through timing.sleep', { timeout: 30_000 }, async () => {
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

  it('smoke (real time)', { timeout: 30_000 }, async () => {
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
  it('reapMarkerDirectory reaps markers concurrently', { timeout: 30_000 }, async () => {
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

  it('reapMarkerDirectory on a missing directory reaps nothing', { timeout: 30_000 }, async () => {
    const dir = makeDir();
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: path.join(dir, 'missing'), killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), timing: fakeTiming().timing });
    expect(result).toEqual({ reaped: 0, kept: 0 });
    expect(warnings).toEqual([]);
  });

  it('counts a marker whose holder remains as kept', { timeout: 30_000 }, async () => {
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

  it('turns a failing target into a warning and still reaps the others', { timeout: 30_000 }, async () => {
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
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: markerDir, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), kill, timing: fake.timing });
    expect(result.reaped).toBe(2);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`kill EINVAL ${broken}`);
    for (const holder of holders) expect(await waitUntil(() => !alive(holder))).toBe(true);
  });

  it('turns a readdir error other than ENOENT into a warning', { timeout: 30_000 }, async () => {
    const dir = makeDir();
    const notADirectory = makeMarker(dir, 'file');
    const warnings: string[] = [];
    const result = await reapMarkerDirectory({ dir: notADirectory, killGraceMs: 200, label: 'tool', onWarning: (m) => warnings.push(m), timing: fakeTiming().timing });
    expect(result).toEqual({ reaped: 0, kept: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ENOTDIR');
  });
});
