import path from 'node:path';
import { DEFAULT_LOCK_TIMEOUT_MS, comparablePath, createKeyedSerializer, isRecord, nodeFileSystem, systemFileLockPorts, systemRandom, withFileLock, writeFileAtomically } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { maxOutputTokensFor } from '@momonga/protocol';
import type { LocalServerShape } from '@momonga/protocol';
import { settingsLockPath } from './file-lock.ts';
import { readJsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';
import { LOCAL_CONNECTION_TARGET_SCHEMAS } from './settings-schema.ts';

export type ModelConnection =
  | { kind: 'server'; baseUrl: string; shape: LocalServerShape; model: string; contextWindow: number }
  | { kind: 'managed'; server: string }
  | { kind: 'plan'; profile: string; model: string };

export type WrittenConnection = { target: string; alias: string };

type ConnectionAdapter = keyof typeof LOCAL_CONNECTION_TARGET_SCHEMAS;

const SETTINGS_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const ADAPTER_OF_SHAPE: Readonly<Record<LocalServerShape, ConnectionAdapter>> = { ollama: 'ollama', openai: 'chat-completions' };

const LOCAL_SERVER_VALUES: Readonly<Record<'billing' | 'maxConcurrency' | 'provider', (connection: ModelConnection) => unknown>> = {
  billing: () => 'local',
  maxConcurrency: () => 1,
  provider: (connection) => {
    if (connection.kind !== 'server') throw new Error('a provider name is derived only from the base URL of a server');
    return `local-${new URL(connection.baseUrl).port}`;
  },
};

const serializeInProcess = createKeyedSerializer();

type LocalConnection = Exclude<ModelConnection, { kind: 'plan' }>;

const adapterOf = (connection: LocalConnection): ConnectionAdapter => (connection.kind === 'managed' ? 'managed' : ADAPTER_OF_SHAPE[connection.shape]);

const PLAN_ADAPTER = 'open-responses';

const assertConnection = (connection: ModelConnection): void => {
  if (connection.kind !== 'server') return;
  if (!Number.isInteger(connection.contextWindow) || connection.contextWindow <= 0) {
    throw new Error(`the context window of ${connection.model} must be a positive whole number of tokens; enter the window the server runs this model with`);
  }
};

const declaredLocalValues = (connection: ModelConnection, adapter: ConnectionAdapter): Record<string, unknown> => {
  const declared: Record<string, unknown> = LOCAL_CONNECTION_TARGET_SCHEMAS[adapter].properties;
  return Object.fromEntries(Object.entries(LOCAL_SERVER_VALUES).filter(([field]) => Object.hasOwn(declared, field)).map(([field, value]) => [field, value(connection)]));
};

const targetOf = (connection: ModelConnection): Record<string, unknown> => {
  if (connection.kind === 'plan') return { adapter: PLAN_ADAPTER, model: connection.model, plan: { profile: connection.profile } };
  const adapter = adapterOf(connection);
  const local = declaredLocalValues(connection, adapter);
  if (connection.kind === 'managed') return { adapter, server: connection.server, ...local };
  return {
    adapter,
    model: connection.model,
    baseUrl: connection.baseUrl,
    ...local,
    capabilities: { contextWindow: connection.contextWindow, maxOutputTokens: maxOutputTokensFor(connection.contextWindow) },
  };
};

export const connectionTargetName = (model: string): string => {
  const dashed = model.replace(/[^A-Za-z0-9._-]+/g, '-');
  return /^[A-Za-z]/.test(dashed) ? dashed : `model-${dashed}`;
};

const freeName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

const recordAt = (document: Record<string, unknown>, key: string, file: string, where: string): Record<string, unknown> => {
  const value = document[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${file}: "${where}" must be an object`);
  return value;
};

const nameSourceOf = (connection: ModelConnection): string => (connection.kind === 'managed' ? connection.server : connection.model);

const isSamePlanTarget = (connection: Extract<ModelConnection, { kind: 'plan' }>, target: unknown): boolean =>
  isRecord(target) && target['adapter'] === PLAN_ADAPTER && target['model'] === connection.model && isRecord(target['plan']) && target['plan']['profile'] === connection.profile;

const membersOf = (alias: unknown): readonly unknown[] => (Array.isArray(alias) ? alias : [alias]);

const existingPlanTarget = (connection: ModelConnection, targets: Record<string, unknown>, aliases: Record<string, unknown>): WrittenConnection | undefined => {
  if (connection.kind !== 'plan') return undefined;
  const name = Object.keys(targets).find((candidate) => isSamePlanTarget(connection, targets[candidate]));
  if (name === undefined) return undefined;
  const alias = Object.hasOwn(aliases, name) && membersOf(aliases[name]).includes(name) ? name : Object.keys(aliases).find((candidate) => membersOf(aliases[candidate]).includes(name));
  return { target: name, alias: alias ?? name };
};

type Placed = { written: WrittenConnection; changed: boolean };

const withConnection = (document: Record<string, unknown>, file: string, connection: ModelConnection): Placed => {
  const models = recordAt(document, 'models', file, 'models');
  const targets = recordAt(models, 'targets', file, 'models.targets');
  const aliases = recordAt(models, 'aliases', file, 'models.aliases');
  const existing = existingPlanTarget(connection, targets, aliases);
  if (existing !== undefined) return { written: existing, changed: false };
  const name = freeName(connectionTargetName(nameSourceOf(connection)), new Set([...Object.keys(targets), ...Object.keys(aliases)]));
  const firstTarget = Object.keys(targets).length === 0;
  models['targets'] = { ...targets, [name]: targetOf(connection) };
  models['aliases'] = { ...aliases, [name]: [name], ...(firstTarget ? { default: [name] } : {}) };
  document['models'] = models;
  return { written: { target: name, alias: name }, changed: true };
};

export type EditUserSettingsOptions = { ports?: FileLockPorts; lockTimeoutMs?: number; signal: AbortSignal };

const documentOf = async (settingsFile: string): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(settingsFile);
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new Error(`${settingsFile}: settings must be a JSON object`);
  return read.value;
};

export const editUserSettings = async (
  home: string,
  settingsFile: string,
  edit: (document: Record<string, unknown>) => boolean,
  options: EditUserSettingsOptions,
): Promise<void> => {
  const ports = options.ports ?? systemFileLockPorts;
  await nodeFileSystem.mkdir(path.dirname(settingsFile), PRIVATE_DIRECTORY_MODE);
  await nodeFileSystem.mkdir(layoutOf(home).run, PRIVATE_DIRECTORY_MODE);
  await serializeInProcess(
    comparablePath(settingsFile),
    () =>
      withFileLock(
        settingsLockPath(home, settingsFile),
        async () => {
          const document = await documentOf(settingsFile);
          if (!edit(document)) return;
          await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: ports.randomHex }, settingsFile, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
        },
        { ports, signal: options.signal, timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS },
      ),
    options.signal,
  );
};

export const addModelConnection = async (home: string, settingsFile: string, connection: ModelConnection, signal: AbortSignal): Promise<WrittenConnection> => {
  assertConnection(connection);
  const placed: { written?: WrittenConnection } = {};
  await editUserSettings(home, settingsFile, (document) => {
    const { written, changed } = withConnection(document, settingsFile, connection);
    placed.written = written;
    return changed;
  }, { signal });
  if (placed.written === undefined) throw new Error(`${settingsFile}: the connection was not placed`);
  return placed.written;
};
