import type { RunEventPayload } from './run-types.ts';

export type StoredRenames = Readonly<Record<string, string>>;

export const withCurrentNames = <Value>(record: Readonly<Record<string, Value>>, renames: StoredRenames): Record<string, Value> => {
  const current: Record<string, Value> = {};
  for (const [name, value] of Object.entries(record)) {
    const renamed = Object.hasOwn(renames, name) ? renames[name] : undefined;
    if (renamed === undefined) current[name] = value;
    else if (!Object.hasOwn(record, renamed)) current[renamed] = value;
  }
  return current;
};

export const EVENT_PAYLOAD_RENAMES: Readonly<Partial<Record<RunEventPayload['type'], StoredRenames>>> = {
  'tool.permission.classified': { alias: 'model' },
};
