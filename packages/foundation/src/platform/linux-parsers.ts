export type ProcStat = { state: string; parentPid: number; groupId: number; startTicks: bigint };

const FIELDS_AFTER_COMM_BEFORE_STARTTIME = 19;

export const parseProcStat = (content: string): ProcStat => {
  const commEnd = content.lastIndexOf(')');
  if (commEnd === -1) throw new Error(`/proc/<pid>/stat has no closing parenthesis for comm: ${JSON.stringify(content)}`);
  const fields = content
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const [state, parentPid, groupId] = fields;
  const startTicks = fields[FIELDS_AFTER_COMM_BEFORE_STARTTIME];
  if (state === undefined || parentPid === undefined || groupId === undefined || startTicks === undefined) {
    throw new Error(`/proc/<pid>/stat has too few fields after comm: ${JSON.stringify(content)}`);
  }
  if (!/^\d+$/.test(startTicks) || !/^-?\d+$/.test(parentPid) || !/^-?\d+$/.test(groupId)) {
    throw new Error(`/proc/<pid>/stat has non-numeric ppid, pgrp or starttime: ${JSON.stringify(content)}`);
  }
  return { state, parentPid: Number(parentPid), groupId: Number(groupId), startTicks: BigInt(startTicks) };
};

export const parseBootTimeSeconds = (content: string): number => {
  const match = /^btime\s+(\d+)$/m.exec(content);
  if (match === null) throw new Error('/proc/stat has no btime line');
  return Number(match[1]);
};

const AT_NULL = 0n;
const AT_CLKTCK = 17n;

export type AuxvLayout = { wordBytes: 4 | 8; littleEndian: boolean };

export const auxvLayoutOf = (arch: string, endianness: 'LE' | 'BE'): AuxvLayout => ({
  wordBytes: arch === 'x64' || arch.endsWith('64') ? 8 : 4,
  littleEndian: endianness === 'LE',
});

export const parseClockTicksPerSecond = (auxv: Uint8Array, layout: AuxvLayout): number => {
  const view = new DataView(auxv.buffer, auxv.byteOffset, auxv.byteLength);
  const read = (offset: number): bigint =>
    layout.wordBytes === 8 ? view.getBigUint64(offset, layout.littleEndian) : BigInt(view.getUint32(offset, layout.littleEndian));
  for (let offset = 0; offset + 2 * layout.wordBytes <= auxv.byteLength; offset += 2 * layout.wordBytes) {
    const type = read(offset);
    if (type === AT_NULL) break;
    if (type === AT_CLKTCK) return Number(read(offset + layout.wordBytes));
  }
  throw new Error('the auxiliary vector has no AT_CLKTCK entry');
};

export const isPidDirectoryName = (name: string): boolean => /^[1-9]\d*$/.test(name);
