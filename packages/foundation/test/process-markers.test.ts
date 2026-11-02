import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LSOF_PATH, killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { findHolders, holderGroups, reconcileProcessGroup } from '@momonga/foundation';
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
    return execFileSync(LSOF_PATH, ['-t', '--', file], { env: { LC_ALL: 'C' }, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  } catch {
    return [];
  }
};

const alive = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pgrp-')));
  tempDirs.push(dir);
  return dir;
};

const makeMarker = (dir: string, name = 'marker'): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

type Group = { pgid: number; dir: string; leaderReaped: Promise<void> };

const SANDBOX_LAUNCHER = (writable: string): string[] =>
  process.platform === 'darwin'
    ? ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)']
    : ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', writable, writable];

const startGroup = async (
  dir: string,
  script: string,
  options: { fd3?: string; sandboxed?: boolean; readyFiles?: string[] } = {},
): Promise<Group> => {
  const argv = options.sandboxed === true ? [...SANDBOX_LAUNCHER(dir), '/bin/sh', '-c', script] : ['/bin/sh', '-c', script];
  const fd = options.fd3 === undefined ? undefined : fs.openSync(options.fd3, 'r');
  try {
    const child = spawn(argv[0] as string, argv.slice(1), {
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
    if (!(await waitUntil(() => readyFiles.every((file) => fs.existsSync(file)), 10_000))) throw new Error('process group did not become ready');
    return { pgid: pid, dir, leaderReaped };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const startEscapedHolder = (marker: string): number => {
  const fd = fs.openSync(marker, 'r');
  try {
    const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.unref();
    if (child.pid === undefined) throw new Error('spawn failed');
    spawnedPids.push(child.pid);
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
};

const deadGroup = async (dir: string): Promise<number> => {
  const group = await startGroup(dir, `touch "$DIR/ready"; exec sleep 60`);
  process.kill(-group.pgid, 'SIGKILL');
  await group.leaderReaped;
  expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  return group.pgid;
};

const TERM_MARKER_SCRIPT = `trap 'echo term > "$DIR/term"; kill $! 2>/dev/null; exit 0' TERM; sleep 60 & touch "$DIR/ready"; wait`;
const IGNORING_MEMBER_SCRIPT = `trap 'echo term > "$DIR/term"; exit 0' TERM; /bin/sh -c 'trap "" TERM; touch "$DIR/member"; while :; do sleep 1; done' & touch "$DIR/ready"; wait`;
const ORPHAN_SCRIPT = `sleep 60 & touch "$DIR/ready"; exit 0`;
const CLOSED_FD_SCRIPT = `exec 3<&-; trap 'echo term > "$DIR/term"; exit 0' TERM; sleep 60 & touch "$DIR/ready"; wait`;

const expectStopped = (output: string): void => {
  expect(output).toMatch(/stopped/i);
  expect(output).toMatch(/unknown/i);
};

const expectLeftAlone = async (group: Group, result: { outcome: string; output: string }): Promise<void> => {
  expect(result.outcome).toBe('unknown');
  expect(result.output).toMatch(/could not be verified/i);
  expect(result.output).toContain(String(group.pgid));
  expect(alive(-group.pgid)).toBe(true);
  expect(fs.existsSync(path.join(group.dir, 'term'))).toBe(false);
};

describe('reconcileProcessGroup', () => {
  it('reports unknown when the group is gone and nothing holds the marker', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const pgid = await deadGroup(dir);
    const result = await reconcileProcessGroup({ pgid, marker }, { killGraceMs: 100 });
    expect(result.outcome).toBe('unknown');
    expect(result.output).toMatch(/no longer running/i);
  });

  it('sends SIGTERM to a live group whose leader holds the marker', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 3000 });
    expect(result.outcome).toBe('unknown');
    expectStopped(result.output);
    expect(fs.readFileSync(path.join(dir, 'term'), 'utf8')).toBe('term\n');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('kills a member that ignores SIGTERM after the grace period', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_MEMBER_SCRIPT, { fd3: marker, readyFiles: ['ready', 'member'] });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 300 });
    expect(result.outcome).toBe('unknown');
    expect(fs.readFileSync(path.join(dir, 'term'), 'utf8')).toBe('term\n');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('kills a group whose leader exited when a surviving member holds the marker', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, ORPHAN_SCRIPT, { fd3: marker });
    await group.leaderReaped;
    expect(alive(group.pgid)).toBe(false);
    expect(alive(-group.pgid)).toBe(true);
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100 });
    expect(result.outcome).toBe('unknown');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('kills a marker holder that escaped the group individually', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const pgid = await deadGroup(dir);
    const holder = startEscapedHolder(marker);
    expect(await waitUntil(() => alive(holder), 2000)).toBe(true);
    const result = await reconcileProcessGroup({ pgid, marker }, { killGraceMs: 100 });
    expect(result.outcome).toBe('unknown');
    expectStopped(result.output);
    expect(await waitUntil(() => !alive(holder), 5000)).toBe(true);
  });

  it('recognizes a group running under the platform sandbox launcher through the marker', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker, sandboxed: true });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 3000 });
    expect(result.outcome).toBe('unknown');
    expect(fs.readFileSync(path.join(dir, 'term'), 'utf8')).toBe('term\n');
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('leaves a group alone when it was spawned without the marker', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT);
    await expectLeftAlone(group, await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100 }));
  });

  it('leaves a group alone when it holds a different marker file', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const other = makeMarker(dir, 'other-marker');
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: other });
    await expectLeftAlone(group, await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100 }));
  });

  it('leaves a group alone when its members closed the inherited descriptor', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, CLOSED_FD_SCRIPT, { fd3: marker });
    await expectLeftAlone(group, await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100 }));
  });

  it('leaves a live group alone when the marker file is missing', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    fs.rmSync(marker);
    await expectLeftAlone(group, await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100 }));
  });

  it('does not SIGKILL a surviving non-holder after the only holder exited on TERM', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const script = `/bin/sh -c 'exec 3<&-; trap "" TERM; touch "$DIR/member"; while :; do sleep 1; done' & trap 'exit 0' TERM; touch "$DIR/ready"; wait`;
    const group = await startGroup(dir, script, { fd3: marker, readyFiles: ['ready', 'member'] });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 3000 });
    await group.leaderReaped;
    expect(result.outcome).toBe('unknown');
    expect(result.output).toMatch(/left alone/i);
    expect(alive(-group.pgid)).toBe(true);
    expect(holdersOf(marker)).toEqual([]);
  });

  it('keeps signalling other targets when one cannot be signalled and names it', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const blocked = startEscapedHolder(marker);
    const other = startEscapedHolder(marker);
    expect(await waitUntil(() => holdersOf(marker).includes(blocked) && holdersOf(marker).includes(other), 5000)).toBe(true);
    const attempts: Array<[number, string | number]> = [];
    const kill = (pid: number, signal: NodeJS.Signals | number): void => {
      attempts.push([pid, signal]);
      if (pid === blocked && signal !== 0) {
        throw Object.assign(new Error(`kill EPERM ${pid}`), { code: 'EPERM', errno: -1, syscall: 'kill' });
      }
      process.kill(pid, signal);
    };
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 300, kill });
    expect(result.outcome).toBe('unknown');
    expect(result.output).toContain(String(blocked));
    expect(attempts.some(([pid, signal]) => pid === blocked && signal === 'SIGTERM')).toBe(true);
    expect(await waitUntil(() => !alive(other), 5000)).toBe(true);
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
    expect(alive(blocked)).toBe(true);
  });
});


describe('reconcileProcessGroup structured result', () => {
  const recordingKill = () => {
    const signals: Array<[number, string | number]> = [];
    const kill = (pid: number, signal: NodeJS.Signals | number): void => {
      if (signal !== 0) signals.push([pid, signal]);
      process.kill(pid, signal);
    };
    return { signals, kill };
  };

  it('reports a live recorded group with no holder in it as leftAloneGroup and signals nothing', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, CLOSED_FD_SCRIPT, { fd3: marker });
    const { signals, kill } = recordingKill();
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100, kill });
    expect(result.leftAloneGroup).toBe(group.pgid);
    expect(result.unsignalledPids).toEqual([]);
    expect(signals).toEqual([]);
    expect(alive(-group.pgid)).toBe(true);
  });

  it('reports no leftAloneGroup and no unsignalledPids when a verified group is stopped', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 300 });
    expect(result.leftAloneGroup).toBeUndefined();
    expect(result.unsignalledPids).toEqual([]);
    expect(result.leftAlonePids).toEqual([]);
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('reports leftAloneGroup when the verified holder exits on TERM and a non-holder member survives', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const script = `/bin/sh -c 'exec 3<&-; trap "" TERM; touch "$DIR/member"; while :; do sleep 1; done' & trap 'exit 0' TERM; touch "$DIR/ready"; wait`;
    const group = await startGroup(dir, script, { fd3: marker, readyFiles: ['ready', 'member'] });
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 3000 });
    await group.leaderReaped;
    expect(result.leftAloneGroup).toBe(group.pgid);
    expect(result.unsignalledPids).toEqual([]);
    expect(alive(-group.pgid)).toBe(true);
  });

  it('reports a former holder that dropped the marker and stays alive in leftAlonePids', { timeout: 20_000 }, async () => {
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
    expect(await waitUntil(() => fs.existsSync(ready), 10_000)).toBe(true);
    expect(holdersOf(marker)).toContain(pid);
    const { signals, kill } = recordingKill();
    const result = await reconcileProcessGroup({ pgid: pid, marker }, { killGraceMs: 3000, kill });
    expect(signals.filter(([, signal]) => signal === 'SIGTERM')).toEqual([[-pid, 'SIGTERM']]);
    expect(result.leftAlonePids).toContain(pid);
    expect(alive(pid)).toBe(true);
    expect(holdersOf(marker)).toEqual([]);
  });

  it('lists a pid whose signal failed with EPERM in unsignalledPids', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const blocked = startEscapedHolder(marker);
    expect(await waitUntil(() => holdersOf(marker).includes(blocked), 5000)).toBe(true);
    const kill = (pid: number, signal: NodeJS.Signals | number): void => {
      if (pid === blocked && signal !== 0) {
        throw Object.assign(new Error(`kill EPERM ${pid}`), { code: 'EPERM', errno: -1, syscall: 'kill' });
      }
      process.kill(pid, signal);
    };
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 300, kill });
    expect(result.unsignalledPids).toEqual([blocked]);
    expect(result.leftAloneGroup).toBeUndefined();
    expect(alive(blocked)).toBe(true);
  });
});

describe('findHolders', () => {
  it('returns an empty list when nothing holds the marker', { timeout: 20_000 }, async () => {
    const marker = makeMarker(makeDir());
    expect(await findHolders(marker)).toEqual([]);
  });

  it('excludes the current process even when it holds the marker open', { timeout: 20_000 }, async () => {
    const marker = makeMarker(makeDir());
    const fd = fs.openSync(marker, 'r');
    try {
      expect(await findHolders(marker)).toEqual([]);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('returns the pid of a child that inherited the marker descriptor', { timeout: 20_000 }, async () => {
    const marker = makeMarker(makeDir());
    const holder = startEscapedHolder(marker);
    expect(await waitUntil(() => holdersOf(marker).includes(holder), 5000)).toBe(true);
    expect(await findHolders(marker)).toEqual([holder]);
  });
});

describe('holderGroups', () => {
  it('maps each holder to its process group id', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const holders = holdersOf(marker);
    expect(holders.length).toBeGreaterThan(0);
    const groups = await holderGroups(holders);
    expect(groups).toHaveLength(holders.length);
    expect(new Set(groups)).toEqual(new Set([group.pgid]));
  });

  it('maps a detached escaped holder to its own group', { timeout: 20_000 }, async () => {
    const marker = makeMarker(makeDir());
    const holder = startEscapedHolder(marker);
    expect(await waitUntil(() => holdersOf(marker).includes(holder), 5000)).toBe(true);
    expect(await holderGroups([holder])).toEqual([holder]);
  });
});

describe('reconcileProcessGroup timing injection', () => {
  const IGNORING_GROUP_SCRIPT = `trap '' TERM; touch "$DIR/ready"; while :; do sleep 1; done`;

  it('reconcileProcessGroup waits only through the injected timing', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, IGNORING_GROUP_SCRIPT, { fd3: marker });
    let current = 0;
    const sleeps: number[] = [];
    const timing: ReapTiming = {
      now: () => current,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        current += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number; at: number }> = [];
    const kill = (pid: number, signal: NodeJS.Signals | number): void => {
      if (signal !== 0) signals.push({ pid, signal, at: current });
      process.kill(pid, signal);
    };
    const hour = 3_600_000;
    const result = await reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: hour, kill, timing });
    expect(result.outcome).toBe('unknown');
    expect(signals[0]).toEqual({ pid: -group.pgid, signal: 'SIGTERM', at: 0 });
    const killed = signals.find(({ signal }) => signal === 'SIGKILL');
    expect(killed?.pid).toBe(-group.pgid);
    expect(killed?.at).toBeGreaterThanOrEqual(hour);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(hour);
    await group.leaderReaped;
    expect(await waitUntil(() => !alive(-group.pgid), 5000)).toBe(true);
  });

  it('throws a signalling error other than EPERM and ESRCH', { timeout: 20_000 }, async () => {
    const dir = makeDir();
    const marker = makeMarker(dir);
    const group = await startGroup(dir, TERM_MARKER_SCRIPT, { fd3: marker });
    const kill = (pid: number, signal: NodeJS.Signals | number): void => {
      if (signal !== 0) throw Object.assign(new Error(`kill EINVAL ${pid}`), { code: 'EINVAL', errno: -22, syscall: 'kill' });
      process.kill(pid, signal);
    };
    await expect(reconcileProcessGroup({ pgid: group.pgid, marker }, { killGraceMs: 100, kill })).rejects.toThrow('kill EINVAL');
  });
});
