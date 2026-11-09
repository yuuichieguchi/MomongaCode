import { describe, expect, it } from 'vitest';
import { reconcileProcessGroup } from '@momonga/foundation';
import type { MarkerReconcileResult, ProcessGroupPort, ProcessInspector, ReapTiming } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { reapHolders } from '../src/process-markers.ts';

type Proc = { start: number; group: number; holds: boolean; survives?: NodeJS.Signals[] };

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
      procs.set(STRANGER, { start: 900, group: GROUP, holds: false });
    };
    const alone = worldOf({ [ENTRY]: { start: 100, group: GROUP, holds: true } }, { afterFirstGroups: leaveAndReuse });
    await reconcile(alone, GROUP);
    expect(targetsOf(alone)).not.toContain(-GROUP);
    expect(targetsOf(alone)).not.toContain(STRANGER);
    expect(targetsOf(alone)).toContain(ENTRY);

    const withSecond = worldOf(
      { [ENTRY]: { start: 100, group: GROUP, holds: true }, [SECOND_ENTRY]: { start: 110, group: GROUP, holds: true } },
      { afterFirstGroups: (procs) => void (procs.get(ENTRY)!.group = ENTRY) },
    );
    await reconcile(withSecond, GROUP);
    expect(withSecond.sent).toContainEqual({ target: -GROUP, signal: 'SIGTERM' });
    expect(targetsOf(withSecond)).toContain(ENTRY);
  });

  it('an entry that gave the marker up after the listing does not prove its group', async () => {
    const world = worldOf(
      { [ENTRY]: { start: 100, group: GROUP, holds: true }, [STRANGER]: { start: 120, group: GROUP, holds: false } },
      { afterFirstGroups: (procs) => void (procs.get(ENTRY)!.holds = false) },
    );
    await reconcile(world, GROUP);
    expect(targetsOf(world)).not.toContain(-GROUP);
  });

  it('a holder that left the group and closed the descriptor is not signalled, alone or through its old group', async () => {
    const world = worldOf(
      { [ENTRY]: { start: 100, group: GROUP, holds: true } },
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
      { [OUTSIDE]: { start: 300, group: 60_000, holds: true, survives: ['SIGTERM'] } },
      { onFirstSleep: (procs) => void procs.set(OUTSIDE, { start: 300, group: 60_000, holds: false }) },
    );
    const result = await reconcile(world, GROUP);
    expect(result.leftAlonePids).not.toContain(OUTSIDE);
    expect(world.sent).not.toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
  });
});

describe('the stop says it stopped the command only after a fresh listing shows no holder outside the group', () => {
  it('says stopped when the listing after the last signal shows no holder outside the proved group', async () => {
    const OUTSIDE = 80_005;
    const world = worldOf({ [ENTRY]: { start: 100, group: GROUP, holds: true, survives: ['SIGTERM'] }, [OUTSIDE]: { start: 400, group: OUTSIDE, holds: true, survives: ['SIGTERM'] } });
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

  it('does not say stopped and carries the survivor notice while a holder outside the group still holds after SIGKILL', async () => {
    const OUTSIDE = 80_005;
    const world = worldOf({
      [ENTRY]: { start: 100, group: GROUP, holds: true },
      [OUTSIDE]: { start: 400, group: OUTSIDE, holds: true, survives: ['SIGTERM', 'SIGKILL'] },
    });
    const result = await reconcile(world, GROUP);
    expect(world.sent).toContainEqual({ target: OUTSIDE, signal: 'SIGKILL' });
    expect(result.output).not.toContain('The interrupted command was stopped.');
    expect(result.output).toContain(`marker ${MARKER_NAME}`);
    expect(result.output).toContain(`run /markers ignore ${MARKER_NAME}`);
  });
});

describe('a group with no holder left carries the survivor notice', () => {
  it('names the marker and /markers ignore, as the survivor notice does', async () => {
    const world = worldOf({ [STRANGER]: { start: 900, group: GROUP, holds: false } });
    const result = await reconcile(world, GROUP);
    expect(targetsOf(world)).toEqual([]);
    expect(result.output).toContain(`marker ${MARKER_NAME}`);
    expect(result.output).toContain(`run /markers ignore ${MARKER_NAME}`);
  });
});

describe('a holder signalled under its own proof must still hold the marker at the signal', () => {
  const HOLDER = 70_001;
  const SAME_SECOND = 1_700_000_000_000;

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
