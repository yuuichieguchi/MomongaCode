import { providerNameOf } from '@momonga/config';
import type { ProviderNameInput } from '@momonga/config';
import { HOST_READ_BOUND_MS, isRecord, operationLimit, systemTiming } from '@momonga/foundation';
import type { LimitTiming } from '@momonga/foundation';
import { SERVER_KINDS, withDefaultTag } from '@momonga/protocol';

export const SETTINGS_CHANGE_LIMIT_LABEL = 'the settings change of plan-real-check';

export type WrittenModel = { readonly provider: string; readonly ownName: string; readonly defaultTag?: string };

const optionalText = (record: Record<string, unknown>, key: string): string | undefined => (typeof record[key] === 'string' ? record[key] : undefined);

const nameInputOf = (connection: Record<string, unknown>): ProviderNameInput | undefined => {
  const adapter = optionalText(connection, 'adapter');
  if (adapter === undefined) return undefined;
  const plan = connection['plan'];
  const profile = isRecord(plan) ? optionalText(plan, 'profile') : undefined;
  return {
    adapter,
    provider: optionalText(connection, 'provider'),
    baseUrl: optionalText(connection, 'baseUrl'),
    socketPath: optionalText(connection, 'socketPath'),
    server: optionalText(connection, 'server'),
    plan: isRecord(plan) && profile !== undefined ? { profile, account: optionalText(plan, 'account') } : undefined,
  };
};

const writtenConnectionsOf = (document: unknown): Record<string, unknown>[] => {
  const models = isRecord(document) ? document['models'] : undefined;
  const connections = isRecord(models) ? models['connections'] : undefined;
  return Array.isArray(connections) ? connections.filter(isRecord) : [];
};

export const writtenEntryOf = (document: unknown, model: WrittenModel): Record<string, unknown> => {
  const connection = writtenConnectionsOf(document).find((candidate) => {
    const input = nameInputOf(candidate);
    return input !== undefined && providerNameOf(input, SERVER_KINDS) === model.provider;
  });
  if (connection === undefined) throw new Error(`the settings have no connection ${model.provider}`);
  const entries = Array.isArray(connection['models']) ? connection['models'].filter(isRecord) : [];
  const entry = entries.find((candidate) => typeof candidate['id'] === 'string' && withDefaultTag(candidate['id'], model.defaultTag) === model.ownName);
  if (entry === undefined) throw new Error(`the settings have no model entry ${model.ownName} in the connection ${model.provider}`);
  return entry;
};

export const settingsChangeWithin = async (interrupt: AbortSignal, change: (signal: AbortSignal) => Promise<void>, timing: LimitTiming = systemTiming): Promise<void> => {
  const limit = operationLimit(interrupt, HOST_READ_BOUND_MS, SETTINGS_CHANGE_LIMIT_LABEL, timing);
  try {
    await change(limit.signal);
  } finally {
    limit.dispose();
  }
};
