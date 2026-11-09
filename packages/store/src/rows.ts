import { UNKNOWN_VALUE } from '@momonga/protocol';
import type { Stored } from '@momonga/protocol';
import type { DecodeContext } from './decode-context.ts';
import type { SQLOutputValue } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;

export type RowReader = {
  string(column: string): string;
  nullableString(column: string): string | null;
  number(column: string): number;
  nullableNumber(column: string): number | null;
  flag(column: string): boolean;
  json(column: string): unknown;
  nullableJson(column: string): unknown;
};

export const corrupt = (table: string, identity: string, detail: string): Error =>
  new Error(`database row ${table}[${identity}] is corrupt: ${detail}`);

export const readerFor = (table: string, identity: string, row: Row): RowReader => {
  const raw = (column: string): SQLOutputValue => {
    const value = row[column];
    if (value === undefined) throw corrupt(table, identity, `column ${column} is missing`);
    return value;
  };
  const string = (column: string): string => {
    const value = raw(column);
    if (typeof value !== 'string') throw corrupt(table, identity, `column ${column} must be TEXT, got ${typeof value}`);
    return value;
  };
  const number = (column: string): number => {
    const value = raw(column);
    if (typeof value !== 'number') throw corrupt(table, identity, `column ${column} must be INTEGER, got ${typeof value}`);
    return value;
  };
  const parse = (column: string, text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw corrupt(table, identity, `column ${column} is not valid JSON (${(error as Error).message})`);
    }
  };
  return {
    string,
    nullableString: (column) => (raw(column) === null ? null : string(column)),
    number,
    nullableNumber: (column) => (raw(column) === null ? null : number(column)),
    flag: (column) => {
      const value = number(column);
      if (value !== 0 && value !== 1) throw corrupt(table, identity, `column ${column} must be 0 or 1, got ${value}`);
      return value === 1;
    },
    json: (column) => parse(column, string(column)),
    nullableJson: (column) => (raw(column) === null ? null : parse(column, string(column))),
  };
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const expectRecord = (table: string, identity: string, column: string, value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw corrupt(table, identity, `column ${column} must be a JSON object`);
  return value;
};

export const expectStringRecord = (table: string, identity: string, column: string, value: unknown): Record<string, string> => {
  const record = expectRecord(table, identity, column, value);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw corrupt(table, identity, `column ${column} key ${key} must be a string`);
  }
  return record as Record<string, string>;
};

export { UNKNOWN_VALUE } from '@momonga/protocol';
export type { Stored } from '@momonga/protocol';

export class UnknownValueError extends Error {
  constructor(what: string) {
    super(`${what} holds a value this build does not know, so it is not acted on`);
    this.name = 'UnknownValueError';
  }
}

export const knownValue = <T extends string>(value: Stored<T>, what: string): T => {
  if (value === UNKNOWN_VALUE) throw new UnknownValueError(what);
  return value;
};

export const refuseUnknown = (what: string, values: readonly (string | null | undefined)[]): void => {
  if (values.includes(UNKNOWN_VALUE)) throw new Error(`${what} holds a value this build does not know, so it is not written`);
};

export const storedOneOf = <T extends string>(
  context: DecodeContext,
  table: string,
  identity: string,
  column: string,
  allowed: readonly T[],
  value: string,
): Stored<T> => {
  const match = allowed.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  if (context.databaseIsNewer()) return UNKNOWN_VALUE;
  throw corrupt(table, identity, `column ${column} has unexpected value "${value}"`);
};

export const expectOneOf = <T extends string>(
  table: string,
  identity: string,
  column: string,
  allowed: readonly T[],
  value: string,
): T => {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw corrupt(table, identity, `column ${column} has unexpected value "${value}"`);
  return match;
};
