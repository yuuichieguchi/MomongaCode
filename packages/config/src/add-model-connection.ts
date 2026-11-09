import path from 'node:path';
import { createKeyedSerializer, isRecord, nodeFileSystem, systemFileLockPorts, systemRandom, withFileLock, writeFileAtomically } from '@momonga/foundation';
import { maxOutputTokensFor } from '@momonga/protocol';
import type { LocalServerShape } from '@momonga/protocol';
import { readJsonFile } from './json-file.ts';
import { LOCAL_CONNECTION_TARGET_SCHEMAS } from './settings-schema.ts';

export type ModelConnection =
  | { kind: 'server'; baseUrl: string; shape: LocalServerShape; model: string; contextWindow: number }
  | { kind: 'managed'; server: string; model: string };

export type WrittenConnection = { target: string; alias: string };

type ConnectionAdapter = keyof typeof LOCAL_CONNECTION_TARGET_SCHEMAS;

const SETTINGS_FILE_MODE = 0o600;

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

const adapterOf = (connection: ModelConnection): ConnectionAdapter => (connection.kind === 'managed' ? 'managed' : ADAPTER_OF_SHAPE[connection.shape]);

const assertConnection = (connection: ModelConnection): void => {
  if (connection.kind === 'managed') return;
  if (!Number.isInteger(connection.contextWindow) || connection.contextWindow <= 0) {
    throw new Error(`the context window of ${connection.model} must be a positive whole number of tokens; enter the window the server runs this model with`);
  }
};

const declaredLocalValues = (connection: ModelConnection, adapter: ConnectionAdapter): Record<string, unknown> => {
  const declared: Record<string, unknown> = LOCAL_CONNECTION_TARGET_SCHEMAS[adapter].properties;
  return Object.fromEntries(Object.entries(LOCAL_SERVER_VALUES).filter(([field]) => Object.hasOwn(declared, field)).map(([field, value]) => [field, value(connection)]));
};

const targetOf = (connection: ModelConnection): Record<string, unknown> => {
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

const withConnection = (document: Record<string, unknown>, file: string, connection: ModelConnection): WrittenConnection => {
  const models = recordAt(document, 'models', file, 'models');
  const targets = recordAt(models, 'targets', file, 'models.targets');
  const aliases = recordAt(models, 'aliases', file, 'models.aliases');
  const name = freeName(connectionTargetName(connection.model), new Set([...Object.keys(targets), ...Object.keys(aliases)]));
  const firstTarget = Object.keys(targets).length === 0;
  models['targets'] = { ...targets, [name]: targetOf(connection) };
  models['aliases'] = { ...aliases, [name]: name, ...(firstTarget ? { default: name } : {}) };
  document['models'] = models;
  return { target: name, alias: name };
};

export const addModelConnection = async (settingsFile: string, connection: ModelConnection): Promise<WrittenConnection> => {
  assertConnection(connection);
  return serializeInProcess(settingsFile, () =>
    withFileLock(
      path.join(path.dirname(settingsFile), `${path.basename(settingsFile)}.lock`),
      async () => {
        const read = await readJsonFile(settingsFile);
        let document: Record<string, unknown> = {};
        if (read.found) {
          if (!isRecord(read.value)) throw new Error(`${settingsFile}: settings must be a JSON object`);
          document = read.value;
        }
        const written = withConnection(document, settingsFile, connection);
        await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: systemFileLockPorts.randomHex }, settingsFile, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
        return written;
      },
      { ports: systemFileLockPorts },
    ),
  );
};
