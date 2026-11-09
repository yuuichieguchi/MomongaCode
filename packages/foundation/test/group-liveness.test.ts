import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessGroupPort, groupTerminationBoundMs, terminateGroup } from '@momonga/foundation';
import type { CommandOptions, CommandRunner, FileIdentity, GroupTiming, ProcFs } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';

const PGID = 1_999_999_001;
const UNRELATED_PGID = 1_999_999_002;

type Member = { pid: number; ours: boolean; darwinStat: string; linuxState: string };

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`kill ${code}`), { code });

const canBeSignalled = (member: Member): boolean => member.ours && member.darwinStat !== 'Z' && !member.darwinStat.slice(1).includes('E');

const fakeGroup = (members: Member[], onKill: (member: Member) => void) => {
  const signals: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation((target: number, signal?: string | number) => {
    if (target !== -PGID) throw errno('ESRCH');
    signals.push(String(signal));
    if (members.length === 0) throw errno('ESRCH');
    const reached = members.filter(canBeSignalled);
    if (reached.length === 0) throw errno('EPERM');
    if (signal === 'SIGKILL') for (const member of reached) onKill(member);
    return true;
  });
  return { signals };
};

const fakeTiming = (): { timing: GroupTiming; now(): number } => {
  const clock = createFakeClock(0);
  return {
    now: () => clock.now(),
    timing: {
      now: () => clock.now(),
      sleep: async (ms) => {
        clock.advance(ms);
      },
    },
  };
};

type PsCall = { args: readonly string[]; options: CommandOptions };

const psRunner = (members: Member[], calls: PsCall[]): CommandRunner => async (_file, args, options) => {
  calls.push({ args, options });
  const rows = [...members.map((member) => `${PGID} ${member.darwinStat}`), `${UNRELATED_PGID} Ss`];
  return { exitCode: 0, stdout: rows.map((row) => `  ${row}`).join('\n') + '\n', stderr: '' };
};

const procStat = (pid: number, state: string, pgid: number): string => `${pid} (sh) ${state} 1 ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`;

const fakeProcfs = (members: Member[]): ProcFs => {
  const unused = async (): Promise<never> => {
    throw errno('ENOENT');
  };
  return {
    list: async (directory) => {
      if (directory !== '/proc') throw errno('ENOENT');
      return ['self', ...members.map((member) => String(member.pid)), '77'];
    },
    readText: async (file) => {
      if (file === '/proc/77/stat') return procStat(77, 'S', UNRELATED_PGID);
      const member = members.find((candidate) => file === `/proc/${candidate.pid}/stat`);
      if (member === undefined) throw errno('ENOENT');
      return procStat(member.pid, member.linuxState, PGID);
    },
    readBytes: unused,
    identityOf: unused as () => Promise<FileIdentity>,
    birthMsOf: unused,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a group is alive while a member remains that can still run (EPERM from kill(-pgid, 0) alone means neither)', () => {
  it('darwin: a group whose only member is exiting after SIGKILL is killed, not reported as surviving', async () => {
    const members: Member[] = [{ pid: PGID, ours: true, darwinStat: 'S', linuxState: 'S' }];
    fakeGroup(members, (member) => void (member.darwinStat = '?E'));
    const calls: PsCall[] = [];
    const port = createProcessGroupPort('darwin', { run: psRunner(members, calls), env: {} });
    const { timing } = fakeTiming();
    const stop = new AbortController().signal;
    expect(await terminateGroup(PGID, { graceMs: 100, port, timing, signal: stop })).toBe('killed');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options.signal === stop)).toBe(true);
  });

  it('darwin: a member of another user that can still run keeps the group alive, and the stop is unconfirmed within one grace after SIGKILL', async () => {
    const members: Member[] = [{ pid: PGID + 5, ours: false, darwinStat: 'Ss', linuxState: 'S' }];
    fakeGroup(members, () => undefined);
    const port = createProcessGroupPort('darwin', { run: psRunner(members, []), env: {} });
    expect(await port.alive(PGID, { signal: new AbortController().signal })).toBe(true);
    const fake = fakeTiming();
    expect(await terminateGroup(PGID, { graceMs: 100, port, timing: fake.timing, signal: new AbortController().signal })).toBe('unconfirmed');
    expect(fake.now()).toBeLessThanOrEqual(groupTerminationBoundMs(100));
  });

  it('linux: EPERM for a group whose only member is a zombie is gone, and EPERM for a running member of another user is alive', async () => {
    const zombie: Member[] = [{ pid: PGID, ours: false, darwinStat: 'Z', linuxState: 'Z' }];
    fakeGroup(zombie, () => undefined);
    const stop = new AbortController().signal;
    expect(await createProcessGroupPort('linux', { run: psRunner([], []), env: {}, procfs: fakeProcfs(zombie) }).alive(PGID, { signal: stop })).toBe(false);
    vi.restoreAllMocks();
    const running: Member[] = [{ pid: PGID + 5, ours: false, darwinStat: 'S', linuxState: 'S' }];
    fakeGroup(running, () => undefined);
    expect(await createProcessGroupPort('linux', { run: psRunner([], []), env: {}, procfs: fakeProcfs(running) }).alive(PGID, { signal: stop })).toBe(true);
  });

  it('the wait after SIGKILL is the grace of the operation, with no fixed floor', () => {
    expect(groupTerminationBoundMs(100) - groupTerminationBoundMs(0)).toBe(200);
  });

  it('with a grace of 0 the group is checked once after SIGKILL', async () => {
    const members: Member[] = [{ pid: PGID, ours: true, darwinStat: 'S', linuxState: 'S' }];
    fakeGroup(members, () => void members.splice(0));
    const port = createProcessGroupPort('darwin', { run: psRunner(members, []), env: {} });
    const fake = fakeTiming();
    expect(await terminateGroup(PGID, { graceMs: 0, port, timing: fake.timing, signal: new AbortController().signal })).toBe('killed');
    expect(fake.now()).toBeLessThanOrEqual(groupTerminationBoundMs(0));
  });
});
