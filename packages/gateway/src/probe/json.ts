export type JsonObject = Record<string, unknown>;

import { isRecord, parseOutsideJson } from '@momonga/foundation';

export { isRecord };

export const parseJson = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

export const firstOf = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined);

export const listedEntryOf = (modelsBody: unknown, model: string): Record<string, unknown> | undefined => {
  const data = field(modelsBody, 'data');
  const listed: unknown = Array.isArray(data) ? data.find((entry) => field(entry, 'id') === model) : undefined;
  return isRecord(listed) ? listed : undefined;
};
