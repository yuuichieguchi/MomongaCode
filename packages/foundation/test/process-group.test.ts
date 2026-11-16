import { spawn, spawnSync, type ChildProcess } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupMembersReader, ProcessGroupPort } from '@momonga/foundation';
import { forceKillGroup, groupAlive, procGroupMembers, systemWaitTiming, signalGroup, signalGroupExceptLeader, terminateGroup, waitForGroupGone } from '@momonga/foundation';
import { createFakeClock, createSteppingTiming, createTempDir, killGroupsForCleanup, pollUntil, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: 4 * REAL_PROCESS_TEST_TIMEOUT_MS });


const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const makeDir = (): string => {
  const dir = createTempDir();
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
const { spawn } = require('@momonga/testkit/child-process');
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
  cleanups.push(() => killGroupsForCleanup([pgid]));
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

const FORK_LOOP_ITERATIONS = 30;

const READY_WAIT_MS = 5000;
const GRANDCHILD_DEATH_WAIT_MS = 5000;

const spawnForkLoopGroup = async (): Promise<{ pgid: number; exited: Promise<void> }> => {
  const dir = makeDir();
  const readyFile = path.join(dir, 'ready');
  const child = spawn('/bin/sh', ['-c', `trap '' TERM; touch "$DIR/ready"; while :; do /bin/sleep 60 & done`], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', DIR: dir },
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('spawn failed');
  cleanups.push(() => killGroupsForCleanup([pgid]));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await pollUntil(() => fs.existsSync(readyFile), { description: `fork-loop group ${pgid} to write ${readyFile}`, boundMs: READY_WAIT_MS });
  return { pgid, exited };
};

describe('groupAlive', () => {
  it('is true for a live detached group and false once the leader and grandchild are reaped', async () => {
    const group = await spawnGroup('normal');
    expect(await groupAlive(group.pgid)).toBe(true);
    process.kill(-group.pgid, 'SIGKILL');
    await group.exited;
    expect(await waitForGroupGone(group.pgid, systemWaitTiming.monotonicMs() + 5000)).toBe(true);
    expect(await groupAlive(group.pgid)).toBe(false);
  });

  it('treats ESRCH as gone', async () => {
    expect(await groupAlive(reapedGroupId())).toBe(false);
  });

  it('treats EPERM as alive', async () => {
    expect(process.getuid?.()).not.toBe(0);
    expect(await groupAlive(rootOwnedGroup())).toBe(true);
  });

  it.each([0, 1, -5, 1.5, Number.NaN])('refuses the unsafe group id %s', async (pgid) => {
    await expect(groupAlive(pgid)).rejects.toThrow(/refusing to signal process group/);
  });
});

describe('signalGroup', () => {
  it('delivers the signal to every member of the group', async () => {
    const group = await spawnGroup('normal');
    await signalGroup(group.pgid, 'SIGTERM');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await waitForGroupGone(group.pgid, systemWaitTiming.monotonicMs() + 5000)).toBe(true);
    expect(pidAlive(group.grandchildPid)).toBe(false);
  });

  it('tolerates ESRCH for a group that no longer exists', async () => {
    await expect(signalGroup(reapedGroupId(), 'SIGTERM')).resolves.toBe('gone');
  });

  it('answers denied, without throwing, for a group owned by another user', async () => {
    expect(process.getuid?.()).not.toBe(0);
    await expect(signalGroup(rootOwnedGroup(), 'SIGCONT')).resolves.toBe('denied');
  });

  it.each([0, 1, -5, 2.5])('refuses the unsafe group id %s', async (pgid) => {
    await expect(signalGroup(pgid, 'SIGTERM')).rejects.toThrow(/refusing to signal process group/);
  });
});

const psRows = (): Array<{ pid: number; groupId: number; startTicks: bigint }> =>
  spawnSync('ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    .stdout.split('\n')
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      const startMs = row === null ? Number.NaN : Date.parse(row[3] as string);
      return row === null || Number.isNaN(startMs) ? [] : [{ pid: Number(row[1]), groupId: Number(row[2]), startTicks: BigInt(startMs) }];
    });

const psGroupMembers: GroupMembersReader = {
  members: (pgid) => psRows().flatMap(({ pid, groupId, startTicks }) => (groupId === pgid ? [{ pid, startTicks }] : [])),
  statOf: (pid) => psRows().find((row) => row.pid === pid),
};

const listedReader = (pgid: number, pids: readonly number[]): GroupMembersReader => ({
  members: (asked) => (asked === pgid ? pids.map((pid) => ({ pid, startTicks: BigInt(pid) })) : []),
  statOf: (pid) => (pids.includes(pid) ? { groupId: pgid, startTicks: BigInt(pid) } : undefined),
});

describe('signalGroupExceptLeader', () => {
  it('delivers the signal to every member of the group but its leader', async () => {
    const group = await spawnGroup('normal');
    signalGroupExceptLeader(group.pgid, 'SIGTERM', psGroupMembers);
    expect(await waitForGroupGone(group.pgid, systemWaitTiming.monotonicMs() + 50)).toBe(false);
    await pollUntil(() => !pidAlive(group.grandchildPid), { description: 'the grandchild to die of the signal', boundMs: GRANDCHILD_DEATH_WAIT_MS });
    expect(pidAlive(group.pgid)).toBe(true);
  });

  it('tolerates a member that is gone or owned by another user', () => {
    const refusals = ['ESRCH', 'EPERM'].map((code) => Object.assign(new Error(code), { code }));
    const sent: number[] = [];
    const send = (pid: number): void => {
      sent.push(pid);
      const refusal = refusals[sent.length - 1];
      if (refusal !== undefined) throw refusal;
    };
    expect(signalGroupExceptLeader(4000, 'SIGTERM', listedReader(4000, [4000, 4001, 4002, 4003]), send)).toBe(3);
    expect(sent).toEqual([4001, 4002, 4003]);
  });

  it('signals nobody and answers 0 when the leader is the only member', () => {
    const sent: number[] = [];
    expect(signalGroupExceptLeader(4000, 'SIGTERM', listedReader(4000, [4000]), (pid) => void sent.push(pid))).toBe(0);
    expect(sent).toEqual([]);
  });

  it('propagates any other failure to signal a member', () => {
    const failure = Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    expect(() =>
      signalGroupExceptLeader(4000, 'SIGTERM', listedReader(4000, [4001]), () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it.each([0, 1, -5, 2.5])('refuses the unsafe group id %s', (pgid) => {
    expect(() => signalGroupExceptLeader(pgid, 'SIGTERM', listedReader(pgid, []))).toThrow(/refusing to signal process group/);
  });
});

describe.skipIf(process.platform !== 'linux')('procGroupMembers (Linux /proc)', () => {
  it('lists the leader and the grandchild of a live group and nothing outside it', async () => {
    const group = await spawnGroup('normal');
    const members = procGroupMembers.members(group.pgid).map(({ pid }) => pid);
    expect(members).toEqual(expect.arrayContaining([group.pgid, group.grandchildPid]));
    expect(members).not.toContain(process.pid);
    expect([...members].sort((left, right) => left - right)).toEqual(psGroupMembers.members(group.pgid).map(({ pid }) => pid).sort((left, right) => left - right));
  });
});

describe('waitForGroupGone', () => {
  it('returns false when the deadline passes while the group is still alive', async () => {
    const group = await spawnGroup('normal');
    expect(await waitForGroupGone(group.pgid, systemWaitTiming.monotonicMs() + 50)).toBe(false);
    expect(await groupAlive(group.pgid)).toBe(true);
  });

  it('returns true immediately for a group that is already gone', async () => {
    expect(await waitForGroupGone(reapedGroupId(), systemWaitTiming.monotonicMs())).toBe(true);
  });
});

describe('terminateGroup', () => {
  it('ends a cooperative group with SIGTERM within the grace and reaps the grandchild', async () => {
    const group = await spawnGroup('normal');
    const outcome = await terminateGroup(group.pgid, { graceMs: 5000 });
    expect(outcome).toBe('terminated');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await groupAlive(group.pgid)).toBe(false);
    expect(pidAlive(group.grandchildPid)).toBe(false);
  });

  it('escalates to SIGKILL after the grace when the group ignores SIGTERM', async () => {
    const group = await spawnGroup('ignore-term');
    const outcome = await terminateGroup(group.pgid, { graceMs: 200 });
    expect(outcome).toBe('killed');
    expect(await group.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await groupAlive(group.pgid)).toBe(false);
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
    cleanups.push(() => killGroupsForCleanup([pgid]));
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
    expect(await groupAlive(pgid)).toBe(false);
  });

  it('reports a group that keeps forking while SIGKILL is delivered as killed only when no member is left, and otherwise as unconfirmed within its grace', async () => {
    const iterations = FORK_LOOP_ITERATIONS;
    const outcomes: string[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const { pgid, exited } = await spawnForkLoopGroup();
      const outcome = await terminateGroup(pgid, { graceMs: 50 }).catch((error: Error) => error.message);
      await exited;
      outcomes.push((await groupAlive(pgid)) ? `${outcome} (group still alive)` : outcome);
      await killGroupsForCleanup([pgid]);
    }
    expect(outcomes.filter((outcome) => outcome !== 'killed' && !outcome.startsWith('unconfirmed'))).toEqual([]);
  });
});

describe('forceKillGroup', () => {
  it('returns true once every member of a group that keeps forking is gone', async () => {
    const outcomes: string[] = [];
    for (let iteration = 0; iteration < FORK_LOOP_ITERATIONS; iteration += 1) {
      const { pgid, exited } = await spawnForkLoopGroup();
      const gone = await forceKillGroup(pgid, { deadline: systemWaitTiming.monotonicMs() + 1000 });
      await exited;
      outcomes.push(`gone=${gone} alive=${await groupAlive(pgid)}`);
    }
    expect(outcomes).toEqual(Array.from({ length: FORK_LOOP_ITERATIONS }, () => 'gone=true alive=false'));
  });

  it('signals a live group at least once even when the deadline has already passed', async () => {
    const group = await spawnGroup('normal');
    await forceKillGroup(group.pgid, { deadline: systemWaitTiming.monotonicMs() - 1 });
    expect(await group.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await waitForGroupGone(group.pgid, systemWaitTiming.monotonicMs() + 5000)).toBe(true);
  });

  it('returns true without signalling for a group that is already gone', async () => {
    expect(await forceKillGroup(reapedGroupId(), { deadline: systemWaitTiming.monotonicMs() })).toBe(true);
  });

  it.each([0, 1, -5, 2.5])('refuses the unsafe group id %s', async (pgid) => {
    await expect(forceKillGroup(pgid, { deadline: systemWaitTiming.monotonicMs() + 100 })).rejects.toThrow(/refusing to signal process group/);
  });
});

describe('terminateGroup answers only whether the group ended, by the group probe, and makes no holder listing', () => {
  const instantTiming = () => createSteppingTiming(createFakeClock(0));

  const groupDyingOn = (fatal: NodeJS.Signals | undefined, events: string[]): ProcessGroupPort => {
    let alive = fatal !== undefined;
    return {
      signal: async (_pgid, signal) => {
        events.push(`signal ${signal}`);
        if (signal === fatal) alive = false;
        return 'sent' as const;
      },
      alive: async () => alive,
    };
  };

  it.each<[NodeJS.Signals | undefined, string, string[]]>([
    [undefined, 'gone', []],
    ['SIGTERM', 'terminated', ['signal SIGTERM']],
    ['SIGKILL', 'killed', ['signal SIGTERM', 'signal SIGKILL']],
  ])('with the group ending on %s it says %s from the group probe alone', async (fatal, word, signals) => {
    const events: string[] = [];
    expect(await terminateGroup(6000, { graceMs: 50, port: groupDyingOn(fatal, events), timing: instantTiming() })).toBe(word);
    expect(events).toEqual(signals);
  });

  it.each<NodeJS.Signals | undefined>([undefined, 'SIGTERM', 'SIGKILL'])('with the group ending on %s it never calls a holder listing handed to it', async (fatal) => {
    const events: string[] = [];
    const listings: string[] = [];
    const options = {
      graceMs: 50,
      port: groupDyingOn(fatal, events),
      timing: instantTiming(),
      outsideHolders: async (): Promise<number[]> => {
        listings.push('list');
        return [6100];
      },
    };
    expect(await terminateGroup(6000, options)).not.toBe('unconfirmed');
    expect(listings).toEqual([]);
  });

  it('exports no listing of marker holders outside a group', async () => {
    const foundation: Record<string, unknown> = await import('@momonga/foundation');
    expect(Object.keys(foundation).filter((name) => /OutsideGroup|outsideHolders/i.test(name))).toEqual([]);
  });
});
