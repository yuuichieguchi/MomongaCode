import { nodeFileSystemSync } from '../node-file-system.ts';
import { isErrno } from './inspector-types.ts';
import { isPidDirectoryName, parseProcStat } from './linux-parsers.ts';

export type GroupMember = { pid: number; startTicks: bigint };

export type MemberStat = { groupId: number; startTicks: bigint };

export type GroupMembersReader = {
  members(pgid: number): GroupMember[];
  statOf(pid: number): MemberStat | undefined;
};

const PROC_ROOT = '/proc';

const procStatOf = (pid: number): MemberStat | undefined => {
  let content: string;
  try {
    content = nodeFileSystemSync.readTextFileSync(`${PROC_ROOT}/${pid}/stat`);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ESRCH')) return undefined;
    throw error;
  }
  const { groupId, startTicks } = parseProcStat(content);
  return { groupId, startTicks };
};

export const procGroupMembers: GroupMembersReader = {
  members: (pgid) =>
    nodeFileSystemSync
      .readdirSync(PROC_ROOT)
      .filter(isPidDirectoryName)
      .flatMap((name) => {
        const pid = Number(name);
        const stat = procStatOf(pid);
        return stat !== undefined && stat.groupId === pgid ? [{ pid, startTicks: stat.startTicks }] : [];
      }),
  statOf: procStatOf,
};
