import path from 'node:path';
import { defineProductSchema, mcpConnectTimeoutProblem, stopValueProblem, transportUrlMessage, transportUrlProblem, isRecord } from '@momonga/foundation';
import type { ProductValidator, SandboxNetworkSetting, StopValueName } from '@momonga/foundation';
import type { AnthropicApiVersion, CapabilitiesCore, ManagedEndpointForm, DialectDefinition, HooksSettings, ImageCapability, ImageTokenModel, OutputBoundField, OutputFormatterName, TargetAnswers, TargetBilling, PermissionMode } from '@momonga/protocol';
import { PLAN_PROFILES } from './plan-profiles.ts';
import { describeSchemaErrors } from './schema-errors.ts';
import { MCP_SERVERS_FILE_SCHEMA, MCP_SERVER_SCHEMA, MODEL_ROLES, SETTINGS_SCHEMA, TUI_NOTIFY_MODES, TUI_SCREEN_MODES, TUI_SETTING_VALUES, TUI_THEMES } from './settings-schema.ts';

export type PermissionsSettings = {
  defaultMode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  additionalDirectories?: string[];
};

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpOAuthConfig = {
  clientId?: string;
  scope?: string;
  callbackPort?: number;
};

export type McpRemoteServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
};

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export type ToolCallingSetting = 'auto' | 'native' | 'constrained';

export type TargetCapabilitiesCore = Omit<CapabilitiesCore, 'toolCalling' | 'probedAt' | 'maxConcurrency' | 'schemaDialect' | 'idempotencyKey'> & Partial<Pick<CapabilitiesCore, 'schemaDialect'>>;

export type DeclaredImage = ImageCapability | { imageInput?: undefined; imageTokens?: undefined };

export type TargetCapabilities = TargetCapabilitiesCore & DeclaredImage;

export type DeclaredTargetCapabilities = Pick<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens'> &
  Partial<TargetCapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel };

export type ManagedDeclaredCapabilities = { contextWindow: number; maxOutputTokens: number };

export type ManagedTarget = {
  adapter: 'managed';
  server: string;
  binary?: string;
  readyTimeoutMs?: number;
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  billing?: TargetBilling;
  model: string;
  outputBoundField?: OutputBoundField;
  toolCalling?: ToolCallingSetting;
  capabilities?: ManagedDeclaredCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ChatCompletionsTarget = {
  adapter: 'chat-completions';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  toolCalling?: ToolCallingSetting;
  billing?: TargetBilling;
  capabilities: DeclaredTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type RemoteTargetCapabilities = DeclaredTargetCapabilities;

export type OpenResponsesTarget = {
  adapter: 'open-responses';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  toolCalling?: 'native' | 'none';
  billing?: TargetBilling;
  capabilities: RemoteTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type AnthropicTarget = {
  adapter: 'anthropic';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  billing?: TargetBilling;
  apiVersion?: AnthropicApiVersion;
  capabilities: RemoteTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type OllamaTarget = {
  adapter: 'ollama';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  billing?: TargetBilling;
  capabilities: RemoteTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type PlanReference = { profile: string; account?: string };

export type PlanTargetCapabilities = Partial<TargetCapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel };

export type PlanOpenResponsesTarget = {
  adapter: 'open-responses';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  plan: PlanReference;
  toolCalling?: 'native' | 'none';
  billing?: TargetBilling;
  capabilities?: PlanTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ModelTarget = ManagedTarget | ChatCompletionsTarget | OpenResponsesTarget | PlanOpenResponsesTarget | AnthropicTarget | OllamaTarget;

type ConnectionKeys = 'adapter' | 'answers' | 'idempotencyKeyHeader' | 'billing' | 'baseUrl' | 'socketPath' | 'apiKeyEnv' | 'apiKeySecret' | 'plan' | 'apiVersion' | 'server' | 'binary' | 'readyTimeoutMs';

type EntryOf<Target extends ModelTarget> = Target extends ModelTarget ? { id: string } & Omit<Target, ConnectionKeys | 'model'> : never;

type ConnectionOf<Target extends ModelTarget> = Target extends ModelTarget
  ? Pick<Target, Extract<keyof Target, ConnectionKeys>> & { provider?: string; maxConcurrency?: number; admissionTimeoutMs?: number; models?: EntryOf<Target>[] }
  : never;

export type ModelEntry = EntryOf<ModelTarget>;

export type ModelConnection = ConnectionOf<ModelTarget>;

export type ConnectionDraft = Omit<ModelConnection, 'models'>;

export type ResolvedManagedTarget = {
  adapter: 'managed';
  server: string;
  binary: string;
  readyTimeoutMs: number;
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  outputBoundField?: OutputBoundField;
  toolCalling: ToolCallingSetting;
  capabilities?: ManagedDeclaredCapabilities;
  billing: TargetBilling;
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedChatCompletionsTarget = {
  adapter: 'chat-completions';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
  toolCalling: ToolCallingSetting;
  billing: TargetBilling;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedOpenResponsesTarget = {
  adapter: 'open-responses';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
  toolCalling: 'native' | 'none';
  billing: TargetBilling;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedPlanTargetCapabilities = Partial<Pick<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens'>> &
  Omit<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens'> &
  DeclaredImage & { maxConcurrency: number };

export type ResolvedPlanTarget = {
  adapter: 'open-responses';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl: string;
  socketPath?: undefined;
  apiKeyEnv?: undefined;
  apiKeySecret?: undefined;
  provider: string;
  plan: PlanReference;
  toolCalling: 'native' | 'none';
  billing: TargetBilling;
  capabilities: ResolvedPlanTargetCapabilities;
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedAnthropicTarget = {
  adapter: 'anthropic';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  toolCalling: 'native';
  billing: TargetBilling;
  apiVersion: AnthropicApiVersion;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedOllamaTarget = {
  adapter: 'ollama';
  answers?: TargetAnswers;
  idempotencyKeyHeader?: string;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  billing: TargetBilling;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedModelTarget =
  | ResolvedManagedTarget
  | ResolvedChatCompletionsTarget
  | ResolvedOpenResponsesTarget
  | ResolvedPlanTarget
  | ResolvedAnthropicTarget
  | ResolvedOllamaTarget;

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelRoles = Partial<Record<ModelRole, string>>;

export type BillingChange = { from: TargetBilling; to: TargetBilling; model?: string };

export type DeclaredServer = { command: string; args: string[]; readyPath: string; endpoint?: { forms: ManagedEndpointForm[] } };

export type ModelsSettings = {
  connections?: ModelConnection[];
  start?: string;
  fallback?: string[];
  billingChanges?: BillingChange[];
  servers?: Record<string, DeclaredServer>;
  dialects?: Record<string, DialectDefinition>;
  roles?: ModelRoles;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
};

export type McpCallSettings = { toolIdleTimeoutMs?: number; toolTotalTimeoutMs?: number };

export type SandboxSetting = 'seatbelt' | 'bubblewrap' | 'none';

export type SandboxUnixSocketsSettings = { allow?: string[] };

export type ResolvedSandboxUnixSockets = { allow: string[] };

export const defaultSandboxSetting = (platform: NodeJS.Platform = process.platform): SandboxSetting =>
  platform === 'darwin' ? 'seatbelt' : platform === 'linux' ? 'bubblewrap' : 'none';

export type OtlpSettings = { endpoint: string; headers?: Record<string, string> };

export type TelemetrySettings = { otlp?: OtlpSettings; captureMessageContent?: boolean; contentRetentionDays?: number };

export type ResolvedTelemetrySettings = { captureMessageContent: boolean; contentRetentionDays: number };

export const DEFAULT_CONTENT_RETENTION_DAYS = 30;

export const resolveTelemetrySettings = (settings: TelemetrySettings | undefined): ResolvedTelemetrySettings => ({
  captureMessageContent: settings?.captureMessageContent === true,
  contentRetentionDays: settings?.contentRetentionDays ?? DEFAULT_CONTENT_RETENTION_DAYS,
});

export type PriceEntrySettings = {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  outputPerMTok: number;
  currency: 'USD';
};

export type AutoModeSettings = { classifier?: string };

export type MemorySettings = { reflection?: { enabled?: boolean; maxTokens?: number }; forgetAfterDays?: number; repositoryFacts?: boolean };

export type VerificationSettings = { commands?: string[]; manifests?: string[]; required?: boolean };

export type ContextSettings = {
  adaptiveBudget?: boolean;
  autoCompact?: boolean;
  cachePrefix?: boolean;
  outputFormatters?: OutputFormatterName[];
  loopGuidance?: boolean;
  observedCapacity?: boolean;
  unboundedOutputReserve?: boolean;
};

export type RipgrepSetting = 'bundled' | 'system' | (string & {});

export type ToolsSettings = { deferral?: boolean; conciseDescriptions?: boolean; ripgrep?: RipgrepSetting };

export type CredentialsSettings = { env?: string[]; keep?: string[]; valuePatterns?: string[]; plaintextTokenFiles?: boolean };

export type NetworkSettings = { httpProxy?: string; httpsProxy?: string; noProxy?: string; extraCaFiles?: string[]; environment?: boolean };

export type Settings = {
  permissions?: PermissionsSettings;
  env?: Record<string, string>;
  credentials?: CredentialsSettings;
  hooks?: Record<string, HookGroups>;
  autoMode?: AutoModeSettings;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  mcp?: McpSettings;
  models?: ModelsSettings;
  autoUpdates?: boolean;
  tui?: TuiSettings;
  gateway?: GatewaySettings;
  runtime?: RuntimeSettings;
  sandbox?: SandboxSetting;
  sandboxNetwork?: SandboxNetworkSetting;
  sandboxUnixSockets?: SandboxUnixSocketsSettings;
  telemetry?: TelemetrySettings;
  network?: NetworkSettings;
  pricing?: PriceEntrySettings[];
  memory?: MemorySettings;
  verification?: VerificationSettings;
  context?: ContextSettings;
  tools?: ToolsSettings;
};

export type TuiTheme = (typeof TUI_THEMES)[number];

export type TuiNotify = (typeof TUI_NOTIFY_MODES)[number];

export type TuiScreen = (typeof TUI_SCREEN_MODES)[number];

export type TuiSettings = { theme?: TuiTheme; notify?: TuiNotify; screenReader?: boolean; reducedMotion?: boolean; screen?: TuiScreen; mouse?: boolean; copyOnSelect?: boolean; attachFileMentions?: boolean };

export type ResolvedTuiSettings = Required<TuiSettings>;

export const defaultTuiSettings = (): ResolvedTuiSettings => ({ theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });

export type GatewaySettings = { closeGraceMs?: number; managedServerStopGraceMs?: number };

export type RuntimeSettings = { drainTimeoutMs?: number };

export type McpSettings = McpCallSettings & { closeGraceMs?: number; connectTimeoutMs?: number };

export const STOP_SETTING_KEYS = {
  closeGraceMs: { object: 'gateway', key: 'closeGraceMs' },
  managedServerStopGraceMs: { object: 'gateway', key: 'managedServerStopGraceMs' },
  drainTimeoutMs: { object: 'runtime', key: 'drainTimeoutMs' },
  mcpCloseGraceMs: { object: 'mcp', key: 'closeGraceMs' },
} as const satisfies Record<StopValueName, { object: 'gateway' | 'runtime' | 'mcp'; key: string }>;

export type HookGroups = NonNullable<HooksSettings[keyof HooksSettings]>;

export type McpServersFile = { mcpServers?: Record<string, unknown> };

const validateSettings: ProductValidator<Settings> = defineProductSchema('config/settings', SETTINGS_SCHEMA);
const validateMcpServersFile: ProductValidator<McpServersFile> = defineProductSchema('config/mcp-servers-file', MCP_SERVERS_FILE_SCHEMA);
const validateMcpServer: ProductValidator<McpServerConfig> = defineProductSchema('config/mcp-server', MCP_SERVER_SCHEMA);

const assertNotHttpSse = (server: unknown, source: string, name: string): void => {
  if (isRecord(server) && server['type'] === 'sse') {
    throw new Error(`${source}: MCP server ${JSON.stringify(name)} uses the deprecated HTTP+SSE transport, which is not supported; use type "http" (Streamable HTTP)`);
  }
};

const OLD_MODEL_KEYS: Readonly<Record<string, string>> = {
  targets: 'models.targets is not a setting any more; declare each server under models.connections with its models (see README, Models).',
  aliases: 'models.aliases is not a setting any more; list the models to try after the model in models.fallback and choose the first with models.start (see README, Models).',
};

const OLD_BILLING_SCOPE_KEY = 'alias';

const assertNoOldModelKeys = (value: unknown, source: string): void => {
  const models = isRecord(value) ? value['models'] : undefined;
  if (!isRecord(models)) return;
  for (const [key, sentence] of Object.entries(OLD_MODEL_KEYS)) {
    if (Object.hasOwn(models, key)) throw new Error(`${source}: ${sentence}`);
  }
  const changes = models['billingChanges'];
  if (!Array.isArray(changes)) return;
  changes.forEach((change, index) => {
    if (isRecord(change) && Object.hasOwn(change, OLD_BILLING_SCOPE_KEY)) {
      throw new Error(`${source}: models.billingChanges[${index}].${OLD_BILLING_SCOPE_KEY} is not a setting any more; write "model" with the model it applies to (see README, Models).`);
    }
  });
};

const assertPlanAdapters = (value: unknown, source: string): void => {
  const models = isRecord(value) ? value['models'] : undefined;
  const connections = isRecord(models) ? models['connections'] : undefined;
  if (!Array.isArray(connections)) return;
  connections.forEach((connection: unknown, index) => {
    const plan = isRecord(connection) ? connection['plan'] : undefined;
    const profileId = isRecord(plan) ? plan['profile'] : undefined;
    if (typeof profileId !== 'string' || !Object.hasOwn(PLAN_PROFILES, profileId)) return;
    const required = (PLAN_PROFILES[profileId] as NonNullable<(typeof PLAN_PROFILES)[string]>).adapter;
    if ((connection as Record<string, unknown>)['adapter'] !== required) {
      throw new Error(`${source}: models.connections[${index}]: profile ${profileId} requires adapter ${required}`);
    }
  });
};

const assertTuiValues = (value: unknown, source: string): void => {
  const tui = isRecord(value) ? value['tui'] : undefined;
  if (!isRecord(tui)) return;
  for (const [name, allowed] of Object.entries(TUI_SETTING_VALUES)) {
    if (!Object.hasOwn(tui, name)) continue;
    const given: unknown = tui[name];
    if (!allowed.some((member) => member === given)) throw new Error(`${source}: tui.${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(given)}`);
  }
};

const assertMcpConnectTimeout = (value: unknown, source: string): void => {
  const mcp = isRecord(value) ? value['mcp'] : undefined;
  if (!isRecord(mcp) || !Object.hasOwn(mcp, 'connectTimeoutMs')) return;
  const problem = mcpConnectTimeoutProblem(mcp['connectTimeoutMs']);
  if (problem !== undefined) throw new Error(`${source}: ${problem}`);
};

const assertStopValues = (value: unknown, source: string): void => {
  if (!isRecord(value)) return;
  for (const [name, { object, key }] of Object.entries(STOP_SETTING_KEYS) as Array<[StopValueName, (typeof STOP_SETTING_KEYS)[StopValueName]]>) {
    const holder = value[object];
    if (!isRecord(holder) || !Object.hasOwn(holder, key)) continue;
    const problem = stopValueProblem(name, holder[key], `${object}.${key}`);
    if (problem !== undefined) throw new Error(`${source}: ${problem}`);
  }
};

export const assertSettings = (value: unknown, source: string): Settings => {
  if (isRecord(value) && isRecord(value['mcpServers'])) {
    for (const [name, server] of Object.entries(value['mcpServers'])) assertNotHttpSse(server, source, name);
  }
  assertNoOldModelKeys(value, source);
  assertPlanAdapters(value, source);
  assertStopValues(value, source);
  assertMcpConnectTimeout(value, source);
  assertTuiValues(value, source);
  const verdict = validateSettings(value);
  if (!verdict.valid) throw new Error(`${source}: invalid settings at ${describeSchemaErrors(verdict.errors)}`);
  const settings = verdict.value;
  (settings.credentials?.valuePatterns ?? []).forEach((pattern, index) => {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`${source}: invalid settings at /credentials/valuePatterns/${index}: not a regular expression`, { cause: error });
    }
  });
  (settings.network?.extraCaFiles ?? []).forEach((file, index) => {
    if (!path.isAbsolute(file)) throw new Error(`${source}: invalid settings at /network/extraCaFiles/${index}: not an absolute path`);
  });
  (settings.sandboxUnixSockets?.allow ?? []).forEach((entry, index) => {
    if (!path.isAbsolute(entry)) throw new Error(`${source}: invalid settings at /sandboxUnixSockets/allow/${index}: not an absolute path`);
  });
  const endpoint = settings.telemetry?.otlp?.endpoint;
  if (endpoint !== undefined) {
    const problem = transportUrlProblem(endpoint);
    if (problem !== undefined) throw new Error(`${source}: ${transportUrlMessage('telemetry.otlp.endpoint', endpoint, problem)}`);
  }
  return settings;
};

export const assertMcpServersFile = (value: unknown, source: string): McpServersFile => {
  const verdict = validateMcpServersFile(value);
  if (verdict.valid) return verdict.value;
  throw new Error(`${source}: invalid MCP server file at ${describeSchemaErrors(verdict.errors)}`);
};

export const assertMcpServer = (value: unknown, source: string, name: string): McpServerConfig => {
  assertNotHttpSse(value, source, name);
  const verdict = validateMcpServer(value);
  if (verdict.valid) return verdict.value;
  throw new Error(`${source}: invalid MCP server ${JSON.stringify(name)}: ${describeSchemaErrors(verdict.errors)}`);
};

export const KNOWN_SETTINGS_KEYS: readonly string[] = Object.keys(SETTINGS_SCHEMA.properties);
