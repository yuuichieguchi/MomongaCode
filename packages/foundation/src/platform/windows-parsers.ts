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

export const parseStartTimeMs = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error(`creation time is not an integer: ${JSON.stringify(trimmed)}`);
  return Number(trimmed);
};

export const descendantsOf = (rows: readonly WindowsProcessRow[], root: number): WindowsProcessRow[] => {
  const children = new Map<number, WindowsProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const rootRow = rows.find((row) => row.pid === root);
  const found: WindowsProcessRow[] = [];
  const visit = (parentPid: number, parentStartMs: number | undefined): void => {
    for (const child of children.get(parentPid) ?? []) {
      if (child.pid === parentPid || (parentStartMs !== undefined && child.startMs < parentStartMs)) continue;
      found.push(child);
      visit(child.pid, child.startMs);
    }
  };
  visit(root, rootRow?.startMs);
  return found;
};

export const groupMembers = (rows: readonly WindowsProcessRow[], root: number): number[] => {
  const rootAlive = rows.some((row) => row.pid === root);
  return [...(rootAlive ? [root] : []), ...descendantsOf(rows, root).map((row) => row.pid)];
};

export const groupOfPid = (rows: readonly WindowsProcessRow[], pid: number, candidates: readonly number[]): number => {
  for (const candidate of candidates) {
    if (groupMembers(rows, candidate).includes(pid)) return candidate;
  }
  return pid;
};
