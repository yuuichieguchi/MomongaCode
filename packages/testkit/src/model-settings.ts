export const SCRIPTED_PROVIDER = 'scripted';
export const SCRIPTED_MODEL_ID = 'scripted-model';
export const SCRIPTED_MODEL = `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL_ID}`;

const DEFAULT_ADAPTER = 'chat-completions';
const DEFAULT_CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 } as const;
const ADDRESSED_ADAPTERS: readonly string[] = ['chat-completions', 'open-responses', 'ollama'];
const KEYED_ADAPTERS: readonly string[] = ['anthropic'];
const ENTRY_KEYS: readonly string[] = ['id', 'capabilities', 'toolCalling', 'entry'];

export type ModelSpec = {
  provider?: string;
  adapter?: string;
  id?: string;
  capabilities?: Record<string, unknown> | null;
  toolCalling?: string;
  entry?: Record<string, unknown>;
  [connectionKey: string]: unknown;
};

export type ModelSettingsSpec = {
  models?: readonly ModelSpec[];
  [modelsKey: string]: unknown;
};

export type ModelSettingsConnection = { adapter: string; provider: string; models: Record<string, unknown>[]; [key: string]: unknown };

export type ModelSettings = { models: { connections: ModelSettingsConnection[]; [key: string]: unknown } };

const defaultBaseUrlOf = (provider: string): string => `http://${provider}.invalid/v1`;

const hasAddress = (spec: ModelSpec): boolean => spec['baseUrl'] !== undefined || spec['socketPath'] !== undefined || spec['plan'] !== undefined;

const hasKey = (spec: ModelSpec): boolean => spec['apiKeyEnv'] !== undefined || spec['apiKeySecret'] !== undefined;

const needsCapabilities = (adapter: string, spec: ModelSpec): boolean => adapter !== 'managed' && spec['plan'] === undefined;

const entryOf = (adapter: string, spec: ModelSpec): Record<string, unknown> => {
  const capabilities = spec.capabilities === null ? undefined : (spec.capabilities ?? (needsCapabilities(adapter, spec) ? { ...DEFAULT_CAPABILITIES } : undefined));
  return {
    id: spec.id ?? SCRIPTED_MODEL_ID,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(spec.toolCalling === undefined ? {} : { toolCalling: spec.toolCalling }),
    ...spec.entry,
  };
};

const connectionOf = (adapter: string, provider: string, spec: ModelSpec): ModelSettingsConnection => {
  const written = Object.fromEntries(Object.entries(spec).filter(([key]) => !ENTRY_KEYS.includes(key) && key !== 'adapter' && key !== 'provider'));
  return {
    adapter,
    provider,
    ...(ADDRESSED_ADAPTERS.includes(adapter) && !hasAddress(spec) ? { baseUrl: defaultBaseUrlOf(provider) } : {}),
    ...(KEYED_ADAPTERS.includes(adapter) && !hasKey(spec) ? { apiKeyEnv: 'SCRIPTED_API_KEY' } : {}),
    ...written,
    models: [],
  };
};

export const modelSettings = (spec: ModelSettingsSpec = {}): ModelSettings => {
  const { models = [{}], ...rest } = spec;
  const connections: ModelSettingsConnection[] = [];
  for (const model of models) {
    const adapter = model.adapter ?? DEFAULT_ADAPTER;
    const provider = model.provider ?? SCRIPTED_PROVIDER;
    const existing = connections.find((connection) => connection.provider === provider);
    const connection = existing ?? connectionOf(adapter, provider, model);
    if (existing === undefined) connections.push(connection);
    connection.models.push(entryOf(adapter, model));
  }
  return { models: { connections, ...rest } };
};
