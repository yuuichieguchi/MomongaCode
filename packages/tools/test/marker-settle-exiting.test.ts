import { describe, expect, it } from 'vitest';
import type { MarkerListing, MarkerSettle } from '../src/marker-settle.ts';
import { settleFinishedCommand } from '../src/marker-settle.ts';
import type { MarkerReconcileResult } from '@momonga/foundation';

const PGID = 1_999_999_021;
const HOLDER = 4242;

const FINISHED = 'Note: the command finished (exit code 0) and its output is above.';
const COULD_NOT_CHECK = (reason: string) =>
  `${FINISHED} MomongaCode could not check whether a process started by it is still running (${reason}). Nothing was stopped. It will check again before the next command that runs a process or changes files in this session.`;
const UNNAMED_RUNNING = `${FINISHED} At least one process started by it is still running and could not be identified or stopped (no process could be named). Nothing else was stopped. MomongaCode will try to stop it again, at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown.`;

type World = { listing: () => Promise<MarkerListing>; groupRuns: boolean };

const heldMarker = ({ listing, groupRuns }: World) => {
  const calls = { reaped: [] as number[], asked: [] as number[], removed: 0, discarded: 0 };
  const settle = {
    mode: 'listed' as const,
    cached: () => 'held' as const,
    state: async () => 'held' as const,
    list: listing,
    groupAlive: async (pgid: number) => {
      calls.asked.push(pgid);
      return groupRuns;
    },
    reap: async (pgid: number): Promise<MarkerReconcileResult> => {
      calls.reaped.push(pgid);
      return { outcome: 'unknown', output: '', stopped: true, stoppedHolders: [HOLDER], leftAlonePids: [], unsignalledPids: [] };
    },
    remove: async () => void calls.removed++,
    discard: async () => void calls.discarded++,
  };
  return { settle: settle as MarkerSettle, calls };
};

const finish = (settle: MarkerSettle) => settleFinishedCommand(settle, { pgid: PGID, exit: { code: 0, signal: null }, signal: new AbortController().signal });

const nobodyNamed = async (): Promise<MarkerListing> => ({ holders: [], refused: [] });

describe('a finished command whose marker is still held', () => {
  it('says nothing and keeps the marker when nobody is named and no member of its group can still run', async () => {
    const { settle, calls } = heldMarker({ listing: nobodyNamed, groupRuns: false });
    expect(await finish(settle)).toEqual([]);
    expect(calls.asked).toEqual([PGID]);
    expect(calls).toMatchObject({ reaped: [], removed: 0, discarded: 0 });
  });

  it('says a process is still running when nobody is named but a member of its group can still run', async () => {
    const { settle, calls } = heldMarker({ listing: nobodyNamed, groupRuns: true });
    expect(await finish(settle)).toEqual([UNNAMED_RUNNING]);
    expect(calls).toMatchObject({ reaped: [], removed: 0, discarded: 0 });
  });

  it('stops a named holder and reports it, as before', async () => {
    const { settle, calls } = heldMarker({ listing: async () => ({ holders: [HOLDER], refused: [] }), groupRuns: false });
    expect(await finish(settle)).toEqual(['Terminated 1 process(es) that outlived the command.']);
    expect(calls.reaped).toEqual([PGID]);
  });

  it('says it could not check, never that a process is still running, when the holder list fails, and keeps the marker', async () => {
    const { settle, calls } = heldMarker({
      listing: async () => {
        throw new Error('lsof is unavailable');
      },
      groupRuns: false,
    });
    const notes = await finish(settle);
    expect(notes).toEqual([COULD_NOT_CHECK('lsof is unavailable')]);
    expect(notes.join('\n')).not.toContain('At least one process started by it is still running');
    expect(calls).toMatchObject({ reaped: [], removed: 0, discarded: 0 });
  });

  it('says it could not check, naming the process that refused inspection, when nobody is named and no member of its group can still run, and keeps the marker', async () => {
    const { settle, calls } = heldMarker({ listing: async () => ({ holders: [], refused: [{ pid: 4343, command: 'sleep', startedAt: 0n }] }), groupRuns: false });
    expect(await finish(settle)).toEqual([COULD_NOT_CHECK('process 4343 (sleep) could not be inspected')]);
    expect(calls).toMatchObject({ reaped: [], removed: 0, discarded: 0 });
  });

  it('says it could not check when the holder list fails even while a member of its group can still run', async () => {
    const { settle } = heldMarker({
      listing: async () => {
        throw new Error('lsof is unavailable');
      },
      groupRuns: true,
    });
    expect(await finish(settle)).toEqual([COULD_NOT_CHECK('lsof is unavailable')]);
  });
});
