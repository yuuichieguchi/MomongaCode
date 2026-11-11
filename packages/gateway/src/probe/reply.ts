import { isRecord } from '@momonga/foundation';

export { isRecord };

export type JsonObject = Record<string, unknown>;

export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

export const valueAtPath = (value: unknown, steps: readonly string[]): unknown =>
  steps.reduce<unknown>((current, step) => (Array.isArray(current) ? current[Number(step)] : field(current, step)), value);

export const firstOf = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined);

export const listedEntryOf = (modelsBody: unknown, model: string): Record<string, unknown> | undefined => {
  const data = field(modelsBody, 'data');
  const listed: unknown = Array.isArray(data) ? data.find((entry) => field(entry, 'id') === model) : undefined;
  return isRecord(listed) ? listed : undefined;
};
