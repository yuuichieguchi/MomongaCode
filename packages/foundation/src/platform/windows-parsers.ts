import { parseOutsideJson } from '../json-depth.ts';

export type WindowsProcessRow = { pid: number; ppid: number; startMs: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const integerField = (row: Record<string, unknown>, name: string): number => {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`process table row has no integer ${name}: ${JSON.stringify(row)}`);
  return value;
};

export const parseJsonArray = (text: string): unknown[] => {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parsed: unknown = parseOutsideJson(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
};

export const parseProcessTable = (text: string): WindowsProcessRow[] =>
  parseJsonArray(text).map((row) => {
    if (!isRecord(row)) throw new Error(`process table row is not an object: ${JSON.stringify(row)}`);
    return { pid: integerField(row, 'pid'), ppid: integerField(row, 'ppid'), startMs: integerField(row, 'startMs') };
  });

export const parsePidList = (text: string): number[] =>
  parseJsonArray(text).map((value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`holder list entry is not a positive integer: ${JSON.stringify(value)}`);
    return value;
  });

export const parseStartTimeMs = (text: string): bigint | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error(`creation time is not an integer: ${JSON.stringify(trimmed)}`);
  return BigInt(trimmed);
};

export type GroupLedger = Map<number, number>;

export const groupMembers = (rows: readonly WindowsProcessRow[], root: number, ledger: GroupLedger): number[] => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const rootRow = byPid.get(root);
  if (rootRow !== undefined && ledger.get(root) !== rootRow.startMs) {
    ledger.clear();
    ledger.set(root, rootRow.startMs);
  }
  const children = new Map<number, WindowsProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const pending = [...ledger];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const [parentPid, parentStartMs] = next;
    for (const child of children.get(parentPid) ?? []) {
      if (child.pid === parentPid || child.startMs < parentStartMs || ledger.has(child.pid)) continue;
      ledger.set(child.pid, child.startMs);
      pending.push([child.pid, child.startMs]);
    }
  }
  const members = [...ledger].filter(([pid, startMs]) => byPid.get(pid)?.startMs === startMs).map(([pid]) => pid);
  if (members.length === 0) ledger.clear();
  return members;
};

export const groupOfPid = (rows: readonly WindowsProcessRow[], pid: number, candidates: readonly number[]): number => {
  for (const candidate of candidates) {
    if (groupMembers(rows, candidate, new Map()).includes(pid)) return candidate;
  }
  return pid;
};
