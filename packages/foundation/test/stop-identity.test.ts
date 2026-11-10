import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProbeFailedError, reapMarkedProcesses, reconcileProcessGroup } from '@momonga/foundation';
import type { MarkerReconcileResult, ProbeResult, ProcessGroupPort, ProcessInspector, ReapTiming } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { reapHolders } from '../src/process-markers.ts';

const markerDirs: string[] = [];

afterEach(() => {
  for (const dir of markerDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const realMarker = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stop-id-')));
  markerDirs.push(dir);
  const marker = path.join(dir, 'call-7f2a');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

type Proc = { start: bigint; group: number; holds: boolean; survives?: NodeJS.Signals[] };

type Hooks = { afterFirstHolders?: (procs: Map<number, Proc>) => void; afterFirstGroups?: (procs: Map<number, Proc>) => void; onFirstSleep?: (procs: Map<number, Proc>) => void };

const MARKER = '/momonga/run/g3/markers/g3/call-7f2a';
const MARKER_NAME = 'call-7f2a';

const esrch = (): NodeJS.ErrnoException => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });

const worldOf = (initial: Record<number, Proc>, hooks: Hooks = {}) => {
  const procs = new Map<number, Proc>(Object.entries(initial).map(([pid, proc]) => [Number(pid), { ...proc }]));
  const sent: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
  let holdersRead = false;
  let groupsRead = false;
  let slept = false;
  const holders = (): number[] => [...procs].filter(([, proc]) => proc.holds).map(([pid]) => pid);
  const inspector: ProcessInspector = {
    startTimeOf: async (pid) => {
      const proc = procs.get(pid);
      return proc === undefined ? { kind: 'gone' } : { kind: 'value', value: proc.start };
    },
    holdersOf: async () => {
      const value = holders();
      if (!holdersRead) {
        holdersRead = true;
        hooks.afterFirstHolders?.(procs);
      }
      return { kind: 'value', value };
    },
    groupsOf: async (pids) => {
      const value = new Map(pids.flatMap((pid) => (procs.has(pid) ? [[pid, procs.get(pid)!.group] as [number, number]] : [])));
      if (!groupsRead) {
        groupsRead = true;
        hooks.afterFirstGroups?.(procs);
      }
      return { kind: 'value', value };
    },
    markerState: async () => (holders().length > 0 ? 'held' : 'free'),
  };
  const deliver = (pid: number, signal: NodeJS.Signals): void => {
    if (!procs.get(pid)?.survives?.includes(signal)) procs.delete(pid);
  };
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    sent.push({ target, signal });
    if (signal === 0) return;
    const victims = target < 0 ? [...procs].filter(([, proc]) => proc.group === -target).map(([pid]) => pid) : procs.has(target) ? [target] : [];
    if (victims.length === 0) throw esrch();
    for (const pid of victims) deliver(pid, signal);
  };
  const groupPort: ProcessGroupPort = {
    signal: async (pgid, signal) => kill(-pgid, signal),
    alive: async (pgid) => [...procs.values()].some((proc) => proc.group === pgid),
  };
  const clock = createFakeClock(0);
  const timing: ReapTiming = {
    now: () => clock.now(),
    sleep: async (ms) => {
      if (!slept) {
        slept = true;
        hooks.onFirstSleep?.(procs);
      }
      clock.advance(ms);
    },
  };
  return { procs, sent, inspector, kill, groupPort, timing };
};

type World = ReturnType<typeof worldOf>;

const reconcile = (world: World, pgid: number): Promise<MarkerReconcileResult> =>
  reconcileProcessGroup(
    { pgid, marker: MARKER },
    { killGraceMs: 100, kill: world.kill, groupPort: world.groupPort, timing: world.timing, inspector: world.inspector, signal: new AbortController().signal },
  );

const targetsOf = (world: World): number[] => world.sent.filter(({ signal }) => signal !== 0).map(({ target }) => target);

const GROUP = 50_000;
const ENTRY = 50_001;
const SECOND_ENTRY = 50_003;
const STRANGER = 50_002;

describe('a group is signalled only when one entry is, at the signal, alive with its start time, holding the marker and in that group', () => {
  it('an entry that left the group by setsid does not prove the old group id now reused by a stranger, and another fully matching entry does', async () => {
    const leaveAndReuse = (procs: Map<number, Proc>): void => {
      procs.get(ENTRY)!.group = ENTRY;
      procs.set(STRANGER, { start: 900n, group: GROUP, holds: false });
    };
    const alone = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true } }, { afterFirstGroups: leaveAndReuse });
    await reconcile(alone, GROUP);
    expect(targetsOf(alone)).not.toContain(-GROUP);
    expect(targetsOf(alone)).not.toContain(STRANGER);
    expect(targetsOf(alone)).toContain(ENTRY);

    const withSecond = worldOf(
      { [ENTRY]: { start: 100n, group: GROUP, holds: true }, [SECOND_ENTRY]: { start: 110n, group: GROUP, holds: true } },
      { afterFirstGroups: (procs) => void (procs.get(ENTRY)!.group = ENTRY) },
    );
    await reconcile(withSecond, GROUP);
    expect(withSecond.sent).toContainEqual({ target: -GROUP, signal: 'SIGTERM' });
    expect(targetsOf(withSecond)).toContain(ENTRY);
  });

  it('an entry that gave the marker up after the listing does not prove its group', async () => {
    const world = worldOf(
      { [ENTRY]: { start: 100n, group: GROUP, holds: true }, [STRANGER]: { start: 120n, group: GROUP, holds: false } },
      { afterFirstGroups: (procs) => void (procs.get(ENTRY)!.holds = false) },
    );
    await reconcile(world, GROUP);
    expect(targetsOf(world)).not.toContain(-GROUP);
  });

  it('a holder that left the group and closed the descriptor is not signalled, alone or through its old group', async () => {
    const world = worldOf(
      { [ENTRY]: { start: 100n, group: GROUP, holds: true } },
      {
        afterFirstGroups: (procs) => {
          const entry = procs.get(ENTRY)!;
          entry.group = ENTRY;
          entry.holds = false;
        },
      },
    );
    await reconcile(world, GROUP);
    expect(targetsOf(world)).toEqual([]);
  });

  it('a listed process whose pid was reused within the same start second by a non-holder is not reported as left alone', async () => {
    const OUTSIDE = 60_001;
    const world = worldOf(
      { [OUTSIDE]: { start: 300n, group: 60_000, holds: true, survives: ['SIGTERM'] } },
      { onFirstSleep: (procs) => void procs.set(OUTSIDE, { start: 300n, group: 60_000, holds: false }) },
    );
    const result = await reconcile(world, GROUP);
    expect(result.leftAlonePids).not.toContain(OUTSIDE);
    expect(world.sent).not.toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
  });
});

describe('the stop says it stopped the command only after a fresh listing shows no holder outside the group', () => {
  it('says stopped when the listing after the last signal shows no holder outside the proved group', async () => {
    const OUTSIDE = 80_005;
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true, survives: ['SIGTERM'] }, [OUTSIDE]: { start: 400n, group: OUTSIDE, holds: true, survives: ['SIGTERM'] } });
    let listingsAfterKill = 0;
    const listing = world.inspector.holdersOf.bind(world.inspector);
    world.inspector.holdersOf = async (...args) => {
      if (world.sent.some(({ signal }) => signal === 'SIGKILL')) listingsAfterKill += 1;
      return listing(...args);
    };
    const result = await reconcile(world, GROUP);
    expect(world.sent).toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
    expect(listingsAfterKill).toBeGreaterThan(0);
    expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    expect(result.output).not.toContain('/markers ignore');
  });

  it('does not say stopped and reports by the facts a holder outside the group that still holds after SIGKILL', async () => {
    const OUTSIDE = 80_005;
    const world = worldOf({
      [ENTRY]: { start: 100n, group: GROUP, holds: true },
      [OUTSIDE]: { start: 400n, group: OUTSIDE, holds: true, survives: ['SIGTERM', 'SIGKILL'] },
    });
    const result = await reconcile(world, GROUP);
    expect(world.sent).toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
    expect(result.output).not.toContain('The interrupted command was stopped.');
    expect(result.output).toContain(`Still running but no longer verified as belonging to this call, so left alone: process ${OUTSIDE}.`);
    expect(result.leftAlonePids).toEqual([OUTSIDE]);
    expect(result.output).not.toContain('retries');
    expect(result.output).not.toContain('/markers ignore');
  });

  it('says stopped when a holder outside the group lets the marker go during the final listing loop after SIGKILL', async () => {
    const OUTSIDE = 80_005;
    const world = worldOf({ [OUTSIDE]: { start: 400n, group: OUTSIDE, holds: true, survives: ['SIGTERM', 'SIGKILL'] } });
    let listingsAfterKill = 0;
    const listing = world.inspector.holdersOf.bind(world.inspector);
    world.inspector.holdersOf = async (...args) => {
      if (world.sent.some(({ signal }) => signal === 'SIGKILL')) {
        listingsAfterKill += 1;
        if (listingsAfterKill === 2) world.procs.delete(OUTSIDE);
      }
      return listing(...args);
    };
    const result = await reconcile(world, GROUP);
    expect(world.sent).toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
    expect(result.output.startsWith('The interrupted command was stopped.')).toBe(true);
    expect(result.leftAlonePids).toEqual([]);
  });
});

describe('a group with no holder left is reported by the facts, not by the final notice of the four chances', () => {
  it('names the group left alone and neither the retries nor /markers ignore', async () => {
    const world = worldOf({ [STRANGER]: { start: 900n, group: GROUP, holds: false } });
    const result = await reconcile(world, GROUP);
    expect(targetsOf(world)).toEqual([]);
    expect(result.leftAloneGroup).toBe(GROUP);
    expect(result.output).toContain(`Still running but no longer verified as belonging to this call, so left alone: group ${GROUP}.`);
    expect(result.output).not.toContain('retries');
    expect(result.output).not.toContain('/markers ignore');
  });
});

describe('a holder signalled under its own proof must still hold the marker at the signal', () => {
  const HOLDER = 70_001;
  const SAME_SECOND = 1_700_000_000_000n;

  const reap = (world: World) => reapHolders({ marker: MARKER, killGraceMs: 100, kill: world.kill, timing: world.timing, inspector: world.inspector, signal: new AbortController().signal });

  it('does not signal a pid reused within the same start second by a process that does not hold the marker', async () => {
    const world = worldOf(
      { [HOLDER]: { start: SAME_SECOND, group: HOLDER, holds: true } },
      { afterFirstHolders: (procs) => void procs.set(HOLDER, { start: SAME_SECOND, group: 70_100, holds: false }) },
    );
    await reap(world);
    expect(targetsOf(world)).toEqual([]);
  });

  it('does not signal a holder that closed the marker descriptor between the listing and the signal', async () => {
    const world = worldOf({ [HOLDER]: { start: SAME_SECOND, group: HOLDER, holds: true } }, { afterFirstHolders: (procs) => void (procs.get(HOLDER)!.holds = false) });
    await reap(world);
    expect(targetsOf(world)).toEqual([]);
  });
});

type Event = 'list' | 'sleep' | `start ${number}` | `send ${number} ${string}`;

const recorded = (world: World): Event[] => {
  const events: Event[] = [];
  const { holdersOf, startTimeOf } = world.inspector;
  world.inspector.holdersOf = async (...args) => {
    events.push('list');
    return holdersOf.call(world.inspector, ...args);
  };
  world.inspector.startTimeOf = async (pid, options) => {
    events.push(`start ${pid}`);
    return startTimeOf.call(world.inspector, pid, options);
  };
  const sleep = world.timing.sleep;
  world.timing.sleep = async (ms) => {
    events.push('sleep');
    return sleep(ms);
  };
  const kill = world.kill;
  const recordingKill = (target: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) events.push(`send ${target} ${signal}`);
    kill(target, signal);
  };
  Object.assign(world, { kill: recordingKill });
  return events;
};

const beforeFirstSleep = (events: readonly Event[]): Event[] => events.slice(0, events.indexOf('sleep') === -1 ? events.length : events.indexOf('sleep'));

describe('one hold read per pass: a pass takes one listing, and each send re-reads only the start time and, for a group, the group of the entry (design 19.6 point 11)', () => {
  it('a SIGTERM pass over 50 holders outside the group and one in it makes exactly one listing', async () => {
    const outside: Record<number, Proc> = {};
    for (let index = 0; index < 50; index += 1) outside[90_000 + index] = { start: BigInt(1000 + index), group: 90_000 + index, holds: true };
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true }, ...outside });
    const events = recorded(world);
    await reconcile(world, GROUP);
    const pass = beforeFirstSleep(events);
    expect(pass.filter((event) => event === 'list')).toEqual(['list']);
    expect(pass.filter((event) => event.startsWith('send ')).length).toBe(51);
  });

  it('reads each holder start time at most twice in the pass', async () => {
    const outside: Record<number, Proc> = {};
    for (let index = 0; index < 50; index += 1) outside[90_000 + index] = { start: BigInt(1000 + index), group: 90_000 + index, holds: true };
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true }, ...outside });
    const events = recorded(world);
    await reconcile(world, GROUP);
    const pass = beforeFirstSleep(events);
    for (const pid of [ENTRY, ...Object.keys(outside).map(Number)]) expect(pass.filter((event) => event === `start ${pid}`).length).toBeLessThanOrEqual(2);
  });

  it('a group target is proved by the first matching entry and the search stops there', async () => {
    const THIRD_ENTRY = 50_005;
    const world = worldOf({
      [ENTRY]: { start: 100n, group: GROUP, holds: true },
      [SECOND_ENTRY]: { start: 110n, group: GROUP, holds: true },
      [THIRD_ENTRY]: { start: 120n, group: GROUP, holds: true },
    });
    const events = recorded(world);
    await reconcile(world, GROUP);
    const pass = beforeFirstSleep(events);
    expect(pass.filter((event) => event.startsWith('send '))).toEqual([`send ${-GROUP} SIGTERM`]);
    expect(pass.filter((event) => event === `start ${ENTRY}`).length).toBe(2);
    expect(pass.filter((event) => event === `start ${SECOND_ENTRY}`).length).toBe(1);
    expect(pass.filter((event) => event === `start ${THIRD_ENTRY}`).length).toBe(1);
  });

  it('the next entry proves the group when the first one changed its start time before the send', async () => {
    const world = worldOf(
      { [ENTRY]: { start: 100n, group: GROUP, holds: true }, [SECOND_ENTRY]: { start: 110n, group: GROUP, holds: true } },
      { afterFirstGroups: (procs) => void (procs.get(ENTRY)!.start = 101n) },
    );
    await reconcile(world, GROUP);
    expect(world.sent).toContainEqual({ target: -GROUP, signal: 'SIGTERM' });
  });
});

describe('the windows of a stop: the reap after the reconcile makes no listing of its own (design 19.6 point 10)', () => {
  const OUTSIDE = 80_005;
  const KILL_GRACE_MS = 100;

  const keptWorld = () => worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true }, [OUTSIDE]: { start: 400n, group: OUTSIDE, holds: true, survives: ['SIGTERM', 'SIGKILL'] } });

  const reapWorld = async (world: World, marker: string, warnings: string[]) =>
    reapMarkedProcesses({ marker, pgid: GROUP, killGraceMs: KILL_GRACE_MS, label: 'daemon', onWarning: (message) => warnings.push(message), kill: world.kill, groupPort: world.groupPort, timing: world.timing, inspector: world.inspector, signal: new AbortController().signal });

  it('a reap of a recorded group makes exactly the listings of its reconcile', async () => {
    const alone = keptWorld();
    const aloneEvents = recorded(alone);
    await reconcileProcessGroup({ pgid: GROUP, marker: realMarker() }, { killGraceMs: KILL_GRACE_MS, kill: alone.kill, groupPort: alone.groupPort, timing: alone.timing, inspector: alone.inspector, signal: new AbortController().signal });
    const reaped = keptWorld();
    const reapedEvents = recorded(reaped);
    await reapWorld(reaped, realMarker(), []);
    expect(reapedEvents.filter((event) => event === 'list').length).toBe(aloneEvents.filter((event) => event === 'list').length);
  });

  it('the kept warning names the holders of the last listing of the reconcile', async () => {
    const world = keptWorld();
    const marker = realMarker();
    const warnings: string[] = [];
    expect(await reapWorld(world, marker, warnings)).toEqual({ removed: false });
    expect(warnings).toContain(`daemon marker ${marker} kept: process ${OUTSIDE} still hold it after cleanup; the next start will retry`);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('the final loop polls the listing until its window ends while a holder survives SIGKILL, within the clock bound of the stop', async () => {
    const world = keptWorld();
    const events = recorded(world);
    await reconcile(world, GROUP);
    const lastSend = events.map((event) => event.startsWith('send ')).lastIndexOf(true);
    const after = events.slice(lastSend + 1);
    expect(after.filter((event) => event === 'list').length).toBeGreaterThan(1);
    expect(after[after.length - 1]).toBe('list');
  });
});

describe('a listing that cannot be made ends the stop with "could not check", never with a stop word or a survivor claim (design 19.6 point 9)', () => {
  const COULD_NOT_CHECK = 'MomongaCode could not check whether a process started by the interrupted command is still running (';
  const SLOW: ProbeResult<number[]> = { kind: 'failed', cause: 'transient', evidence: { kind: 'timeout', detail: 'the listing was slow' } };

  const expectNoClaim = (output: string): void => {
    expect(output).not.toContain('The interrupted command was stopped');
    expect(output).not.toContain('no longer running');
    expect(output).not.toContain('Still running but');
    expect(output).not.toContain('may still be running');
    expect(output).not.toContain('/markers ignore');
  };

  it('a first listing that fails after its retries resolves with could not check, Nothing was stopped, and no signal', async () => {
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true } });
    world.inspector.holdersOf = async () => SLOW;
    const result = await reconcile(world, GROUP);
    expect(result.output.startsWith(COULD_NOT_CHECK)).toBe(true);
    expect(result.output).toContain('). Nothing was stopped.');
    expect(result.stopped).toBe(false);
    expect(targetsOf(world)).toEqual([]);
    expectNoClaim(result.output);
  });

  it('a listing after SIGTERM that fails after its retries resolves with could not check, stopped, and no SIGKILL', async () => {
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true, survives: ['SIGTERM'] } });
    const listing = world.inspector.holdersOf.bind(world.inspector);
    world.inspector.holdersOf = async (...args) => (world.sent.some(({ signal }) => signal === 'SIGTERM') ? SLOW : listing(...args));
    const result = await reconcile(world, GROUP);
    expect(targetsOf(world)).toEqual([-GROUP]);
    expect(result.output.startsWith(COULD_NOT_CHECK)).toBe(true);
    expect(result.output).not.toContain('Nothing was stopped');
    expect(result.stopped).toBe(true);
    expectNoClaim(result.output);
  });

  it('a listing ended by the asker signal resolves with could not check and no signal', async () => {
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true } });
    const asker = new AbortController();
    world.inspector.holdersOf = async () => {
      asker.abort();
      return { kind: 'failed', cause: 'deterministic', evidence: { kind: 'errno', code: 'ABORT_ERR', detail: 'The operation was aborted' } };
    };
    const result = await reconcileProcessGroup(
      { pgid: GROUP, marker: MARKER },
      { killGraceMs: 100, kill: world.kill, groupPort: world.groupPort, timing: world.timing, inspector: world.inspector, signal: asker.signal },
    );
    expect(result.output.startsWith(COULD_NOT_CHECK)).toBe(true);
    expect(result.stopped).toBe(false);
    expect(targetsOf(world)).toEqual([]);
    expectNoClaim(result.output);
  });

  it('a sweep whose listing fails after its retries still rejects with the probe error and keeps the marker', async () => {
    const world = worldOf({ [ENTRY]: { start: 100n, group: GROUP, holds: true } });
    world.inspector.holdersOf = async () => SLOW;
    const marker = realMarker();
    await expect(
      reapMarkedProcesses({ marker, pgid: GROUP, killGraceMs: 100, label: 'tool', onWarning: () => undefined, kill: world.kill, groupPort: world.groupPort, timing: world.timing, inspector: world.inspector, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ProbeFailedError);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
