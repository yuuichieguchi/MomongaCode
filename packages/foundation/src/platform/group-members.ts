import fs from 'node:fs';
import { isErrno } from './inspector-types.ts';
import { isPidDirectoryName, parseProcStat } from './linux-parsers.ts';

export type GroupMembersReader = (pgid: number) => number[];

const PROC_ROOT = '/proc';

export const procGroupMembers: GroupMembersReader = (pgid) =>
  fs
    .readdirSync(PROC_ROOT)
    .filter(isPidDirectoryName)
    .flatMap((name) => {
      let content: string;
      try {
        content = fs.readFileSync(`${PROC_ROOT}/${name}/stat`, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT', 'ESRCH')) return [];
        throw error;
      }
      return parseProcStat(content).groupId === pgid ? [Number(name)] : [];
    });
