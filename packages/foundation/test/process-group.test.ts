import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupAlive, signalGroup, terminateGroup, waitForGroupGone } from '@momonga/foundation';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const forceKillGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    return;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pg-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

interface SpawnedGroup {
  child: ChildProcess;
  pgid: number;
  grandchildPid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const GROUP_SCRIPT = `
const { spawn } = require('node:child_process');
const ignoreTerm = process.argv[1] === 'ignore-term';
if (ignoreTerm) process.on('SIGTERM', () => undefined);
const grandchild = ignoreTerm
  ? spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: 'ignore' })
  : spawn('sleep', ['300'], { stdio: 'ignore' });
setInterval(() => undefined, 1000);
process.stdout.write('ready ' + grandchild.pid + '\\n');
`;

const spawnGroup = async (mode: 'normal' | 'ignore-term'): Promise<SpawnedGroup> => {
  const child = spawn(process.execPath, ['-e', GROUP_SCRIPT, mode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('spawn failed');
  cleanups.push(() => forceKillGroup(pgid));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /ready (\d+)\n/.exec(buffer);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error('group leader exited before ready')));
  });
  return { child, pgid, grandchildPid, exited };
};

const rootOwnedGroup = (): number => {
  const listing = spawnSync('ps', ['-A', '-o', 'pgid=,uid='], { encoding: 'utf8' }).stdout;
  const ownersByGroup = new Map<number, Set<number>>();
  for (const line of listing.split('\n')) {
    const [pgid, uid] = line.trim().split(/\s+/).map(Number);
    if (pgid === undefined || uid === undefined || !Number.isInteger(pgid) || pgid <= 1) continue;
    const owners = ownersByGroup.get(pgid) ?? new Set<number>();
    owners.add(uid);
    ownersByGroup.set(pgid, owners);
  }
  for (const [pgid, owners] of ownersByGroup) {
    if (owners.size === 1 && owners.has(0)) return pgid;
  }
  throw new Error('no process group owned entirely by root');
};

const reapedGroupId = (): number => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(result.stdout);
};

describe('groupAlive', () => {
  it('is true for a live detached group and false once the leader and grandchild are reaped', async () => {
    const group = await spawnGroup('normal');
    expect(groupAlive(group.pgid)).toBe(true);
    process.kill(-group.pgid, 'SIGKILL');
    await group.exited;
    expect(await waitForGroupGone(group.pgid, Date.now() + 5000)).toBe(true);
    expect(groupAlive(group.pgid)).toBe(false);
  });

  it('treats ESRCH as gone', () => {
    expect(groupAlive(reapedGroupId())).toBe(false);
  });

  it('treats EPERM as alive', () => {
    expect(process.getuid?.()).not.toBe(0);
    expect(groupAlive(rootOwnedGroup())).toBe(true);
  });

  it.each([0, 1, -5, 1.5, Number.NaN])('refuses the unsafe group id %s', (pgid) => {
    expect(() => groupAlive(pgid)).toThrow(/refusing to signal process group/);
  });
});

describe('signalGroup', () => {
  it('delivers the signal to every member of the group', async () => {
    const group = await spawnGroup('normal');
    signalGroup(group.pgid, 'SIGTERM');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await waitForGroupGone(group.pgid, Date.now() + 5000)).toBe(true);
    expect(pidAlive(group.grandchildPid)).toBe(false);
  });

  it('tolerates ESRCH for a group that no longer exists', () => {
    expect(() => signalGroup(reapedGroupId(), 'SIGTERM')).not.toThrow();
  });

  it('tolerates EPERM for a group owned by another user', () => {
    expect(process.getuid?.()).not.toBe(0);
    expect(() => signalGroup(rootOwnedGroup(), 'SIGCONT')).not.toThrow();
  });

  it.each([0, 1, -5, 2.5])('refuses the unsafe group id %s', (pgid) => {
    expect(() => signalGroup(pgid, 'SIGTERM')).toThrow(/refusing to signal process group/);
  });
});

describe('waitForGroupGone', () => {
  it('returns false when the deadline passes while the group is still alive', async () => {
    const group = await spawnGroup('normal');
    expect(await waitForGroupGone(group.pgid, Date.now() + 50)).toBe(false);
    expect(groupAlive(group.pgid)).toBe(true);
  });

  it('returns true immediately for a group that is already gone', async () => {
    expect(await waitForGroupGone(reapedGroupId(), Date.now())).toBe(true);
  });
});

describe('terminateGroup', () => {
  it('ends a cooperative group with SIGTERM within the grace and reaps the grandchild', async () => {
    const group = await spawnGroup('normal');
    const outcome = await terminateGroup(group.pgid, { graceMs: 5000 });
    expect(outcome).toBe('terminated');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(groupAlive(group.pgid)).toBe(false);
    expect(pidAlive(group.grandchildPid)).toBe(false);
  });

  it('escalates to SIGKILL after the grace when the group ignores SIGTERM', async () => {
    const group = await spawnGroup('ignore-term');
    const outcome = await terminateGroup(group.pgid, { graceMs: 200 });
    expect(outcome).toBe('killed');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(groupAlive(group.pgid)).toBe(false);
    expect(pidAlive(group.grandchildPid)).toBe(false);
  });

  it('returns gone without signalling when the group no longer exists', async () => {
    expect(await terminateGroup(reapedGroupId(), { graceMs: 100 })).toBe('gone');
  });

  it('terminates a group whose readiness is signalled through a ready file', async () => {
    const dir = makeDir();
    const readyFile = path.join(dir, 'ready');
    const child = spawn(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setInterval(() => undefined, 1000)`],
      { detached: true, stdio: 'ignore' },
    );
    const pgid = child.pid;
    if (pgid === undefined) throw new Error('spawn failed');
    cleanups.push(() => forceKillGroup(pgid));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    await new Promise<void>((resolve) => {
      const watcher = fs.watch(dir, () => {
        if (fs.existsSync(readyFile) && fs.readFileSync(readyFile, 'utf8') === String(pgid)) {
          watcher.close();
          resolve();
        }
      });
      if (fs.existsSync(readyFile) && fs.readFileSync(readyFile, 'utf8') === String(pgid)) {
        watcher.close();
        resolve();
      }
    });
    expect(await terminateGroup(pgid, { graceMs: 5000 })).toBe('terminated');
    expect(await exited).toBe('SIGTERM');
    expect(groupAlive(pgid)).toBe(false);
  });
});
