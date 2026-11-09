import { describe, expect, it } from 'vitest';
import { signalGroupExceptLeader } from '@momonga/foundation';
import type { GroupMembersReader } from '@momonga/foundation';

const PGID = 4000;
const FOLLOWER = 4001;
const OTHER_FOLLOWER = 4002;

type Stat = { groupId: number; startTicks: bigint };

const readerOf = (listed: Array<{ pid: number; startTicks: bigint }>, now: Record<number, Stat | undefined>, events: string[] = []): GroupMembersReader => ({
  members: (pgid) => (pgid === PGID ? listed : []),
  statOf: (pid) => {
    events.push(`stat ${pid}`);
    return now[pid];
  },
});

describe('signalGroupExceptLeader signals a follower only when its stat, read again before the send, still shows its start ticks and the group', () => {
  it('signals a follower whose start ticks and group are unchanged, reading its stat immediately before each send', () => {
    const events: string[] = [];
    const reader = readerOf(
      [
        { pid: PGID, startTicks: 5n },
        { pid: FOLLOWER, startTicks: 10n },
        { pid: OTHER_FOLLOWER, startTicks: 11n },
      ],
      { [FOLLOWER]: { groupId: PGID, startTicks: 10n }, [OTHER_FOLLOWER]: { groupId: PGID, startTicks: 11n } },
      events,
    );
    signalGroupExceptLeader(PGID, 'SIGTERM', reader, (pid) => void events.push(`send ${pid}`));
    expect(events).toEqual([`stat ${FOLLOWER}`, `send ${FOLLOWER}`, `stat ${OTHER_FOLLOWER}`, `send ${OTHER_FOLLOWER}`]);
  });

  it('does not signal a follower whose pid was reused by a process in another group between the read and the send', () => {
    const sent: number[] = [];
    const reader = readerOf([{ pid: FOLLOWER, startTicks: 10n }], { [FOLLOWER]: { groupId: 7000, startTicks: 10n } });
    signalGroupExceptLeader(PGID, 'SIGTERM', reader, (pid) => void sent.push(pid));
    expect(sent).toEqual([]);
  });

  it('does not signal a follower whose start ticks differ from the listed ones', () => {
    const sent: number[] = [];
    const reader = readerOf([{ pid: FOLLOWER, startTicks: 10n }], { [FOLLOWER]: { groupId: PGID, startTicks: 11n } });
    signalGroupExceptLeader(PGID, 'SIGTERM', reader, (pid) => void sent.push(pid));
    expect(sent).toEqual([]);
  });

  it('does not signal a follower that is gone when its stat is read again', () => {
    const sent: number[] = [];
    const reader = readerOf([{ pid: FOLLOWER, startTicks: 10n }], { [FOLLOWER]: undefined });
    signalGroupExceptLeader(PGID, 'SIGTERM', reader, (pid) => void sent.push(pid));
    expect(sent).toEqual([]);
  });
});
