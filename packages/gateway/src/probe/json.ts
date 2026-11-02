export type JsonObject = Record<string, unknown>;

import { isRecord } from '@momonga/foundation';

export { isRecord };

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

export const firstOf = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined);
