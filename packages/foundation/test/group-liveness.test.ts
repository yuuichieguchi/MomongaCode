import { afterEach, describe, expect, it, vi } from 'vitest';
import { KILL_CONFIRM_MS, POLL_INTERVAL_MS, ProbeFailedError, canStillRun, createProcessGroupPort, groupTerminationBoundMs, reconcileProcessGroup, terminateGroup } from '@momonga/foundation';
import type { CommandOptions, CommandRunner, FileIdentity, ProcessGroupPort, ProcessInspector, ProcFs, Timing } from '@momonga/foundation';
import { createFakeClock, createSteppingTiming, sleepDrivenTiming } from '@momonga/testkit';

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

const fakeTiming = (): { timing: Timing; now(): number } => {
  const clock = createFakeClock(0);
  return { now: () => clock.now(), timing: createSteppingTiming(clock) };
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

  it('darwin: a member of another user that can still run keeps the group alive, and the stop is unconfirmed once the window K after SIGKILL has passed', async () => {
    const members: Member[] = [{ pid: PGID + 5, ours: false, darwinStat: 'Ss', linuxState: 'S' }];
    fakeGroup(members, () => undefined);
    const port = createProcessGroupPort('darwin', { run: psRunner(members, []), env: {} });
    expect(await port.alive(PGID, { signal: new AbortController().signal })).toBe(true);
    const fake = fakeTiming();
    expect(await terminateGroup(PGID, { graceMs: 100, port, timing: fake.timing, signal: new AbortController().signal })).toBe('unconfirmed');
    expect(fake.now()).toBeGreaterThanOrEqual(100 + KILL_CONFIRM_MS);
    expect(fake.now()).toBeLessThanOrEqual(100 + KILL_CONFIRM_MS + 2 * 10);
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

  it('only the wait before SIGKILL depends on the grace; the window after it is K and the two polls for every grace', () => {
    expect(groupTerminationBoundMs(100) - groupTerminationBoundMs(0)).toBe(100);
    expect(groupTerminationBoundMs(0)).toBe(KILL_CONFIRM_MS + 2 * POLL_INTERVAL_MS);
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

describe('one liveness rule for every reader of a group (process-markers, Linux, older kernels, abort)', () => {
  const noHolders = {
    startTimeOf: async () => ({ kind: 'gone' }),
    holdersOf: async () => ({ kind: 'value', value: [] }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    markerState: async () => 'free',
  } as unknown as ProcessInspector;

  const reapTiming = (): Timing => {
    const clock = createFakeClock(0);
    return sleepDrivenTiming({ now: () => clock.now(), sleep: async (ms) => void clock.advance(ms) });
  };

  const groupRefusesSignals = (target: number): void => {
    throw errno(target === -PGID ? 'EPERM' : 'ESRCH');
  };

  it('reconcile reads the group through the group port: EPERM for a group whose only member is exiting is no longer running', async () => {
    const members: Member[] = [{ pid: PGID, ours: true, darwinStat: '?E', linuxState: 'S' }];
    const groupPort = createProcessGroupPort('darwin', { run: psRunner(members, []), env: {}, kill: groupRefusesSignals });
    const result = await reconcileProcessGroup(
      { pgid: PGID, marker: '/nonexistent-marker' },
      { killGraceMs: 100, kill: groupRefusesSignals, timing: reapTiming(), inspector: noHolders, groupPort, signal: new AbortController().signal },
    );
    expect(result.leftAloneGroup).toBeUndefined();
    expect(result.output).toContain('no longer running');
  });

  it('reconcile keeps a group with a running member of another user as still running', async () => {
    const members: Member[] = [{ pid: PGID + 5, ours: false, darwinStat: 'Ss', linuxState: 'S' }];
    const groupPort = createProcessGroupPort('darwin', { run: psRunner(members, []), env: {}, kill: groupRefusesSignals });
    const result = await reconcileProcessGroup(
      { pgid: PGID, marker: '/nonexistent-marker' },
      { killGraceMs: 100, kill: groupRefusesSignals, timing: reapTiming(), inspector: noHolders, groupPort, signal: new AbortController().signal },
    );
    expect(result.leftAloneGroup).toBe(PGID);
  });

  it('linux: kill(-pgid, 0) succeeds for a group of only zombies, so success is not an answer there and the states decide', async () => {
    const zombies: Member[] = [{ pid: PGID, ours: true, darwinStat: 'Z', linuxState: 'Z' }];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stop = new AbortController().signal;
    expect(await createProcessGroupPort('linux', { run: psRunner([], []), env: {}, procfs: fakeProcfs(zombies) }).alive(PGID, { signal: stop })).toBe(false);
    const running: Member[] = [{ pid: PGID, ours: true, darwinStat: 'S', linuxState: 'S' }];
    expect(await createProcessGroupPort('linux', { run: psRunner([], []), env: {}, procfs: fakeProcfs(running) }).alive(PGID, { signal: stop })).toBe(true);
  });

  it('darwin: success from kill(-pgid, 0) is an answer, because XNU counts only members it could signal', async () => {
    const calls: PsCall[] = [];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await createProcessGroupPort('darwin', { run: psRunner([], calls), env: {} }).alive(PGID, { signal: new AbortController().signal })).toBe(true);
    expect(calls).toEqual([]);
  });

  it('the dead state x of older Linux kernels cannot run, like X and Z', async () => {
    expect(['x', 'X', 'Z', 'RE', '?E'].map(canStillRun)).toEqual([false, false, false, false, false]);
    expect(['R', 'S', 'Ss', 'D', 'T', 'I', 'U'].map(canStillRun)).toEqual([true, true, true, true, true, true, true]);
    const dead: Member[] = [{ pid: PGID, ours: false, darwinStat: 'Z', linuxState: 'x' }];
    fakeGroup(dead, () => undefined);
    expect(await createProcessGroupPort('linux', { run: psRunner([], []), env: {}, procfs: fakeProcfs(dead) }).alive(PGID, { signal: new AbortController().signal })).toBe(false);
  });

  it('an abort ends the stop at the next poll as unconfirmed, without waiting out the grace', async () => {
    const fake = fakeTiming();
    const controller = new AbortController();
    let probes = 0;
    const port: ProcessGroupPort = {
      signal: async () => 'sent' as const,
      alive: async () => {
        probes += 1;
        if (probes === 3) controller.abort();
        return true;
      },
    };
    expect(await terminateGroup(PGID, { graceMs: 1000, port, timing: fake.timing, signal: controller.signal })).toBe('unconfirmed');
    expect(fake.now()).toBeLessThan(100);
  });

  it('a state read that the abort ends is unconfirmed, not a thrown failure', async () => {
    const fake = fakeTiming();
    const controller = new AbortController();
    const port: ProcessGroupPort = {
      signal: async () => 'sent' as const,
      alive: async (_pgid, { signal }) => {
        if (fake.now() >= 30) controller.abort();
        if (signal?.aborted === true) throw new ProbeFailedError('reading the run states', { kind: 'failed', cause: 'transient', evidence: { kind: 'opaque', detail: 'aborted' } });
        return true;
      },
    };
    expect(await terminateGroup(PGID, { graceMs: 1000, port, timing: fake.timing, signal: controller.signal })).toBe('unconfirmed');
    expect(fake.now()).toBeLessThan(100);
  });
});
