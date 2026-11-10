import { parseOutsideJson } from '../json-depth.ts';
import type { StartTime } from './inspector-types.ts';

export const parseJsonArray = (text: string): unknown[] => {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parsed: unknown = parseOutsideJson(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
};

export const parsePidList = (text: string): number[] =>
  parseJsonArray(text).map((value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`holder list entry is not a positive integer: ${JSON.stringify(value)}`);
    return value;
  });

export const parseStartTime = (text: string): StartTime | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error(`creation time is not an integer: ${JSON.stringify(trimmed)}`);
  return BigInt(trimmed);
};
