import path from 'node:path';
import { defineProductSchema, mcpConnectTimeoutProblem, stopValueProblem, transportUrlMessage, transportUrlProblem, isRecord } from '@momonga/foundation';
import type { ProductValidator, SandboxNetworkSetting, StopValueName } from '@momonga/foundation';
import type { AnthropicApiVersion, CapabilitiesCore, ManagedEndpointForm, DialectDefinition, HooksSettings, ImageCapability, ImageTokenModel, OutputBoundField, OutputFormatterName, TargetAnswers, TargetBilling, PermissionMode } from '@momonga/protocol';
import { OPERATION_RULE_TOOLS, priceTableProblem } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import { escapePointerSegment } from './json-file.ts';
import { MCP_EXPANSION_PATTERN, mcpServerNameProblem, mcpServerUrlProblem } from './mcp-server-rules.ts';
import { PLAN_PROFILES } from './plan-profiles.ts';
import { connectionAddressProblem } from './probe-record-key.ts';
import { describeSchemaErrors, invalidSettingsMessage, schemaProblemOf } from './schema-errors.ts';
import { BASH_ON_TIMEOUT, ISSUE_AUTHOR_ASSOCIATIONS, MCP_SERVERS_FILE_SCHEMA, apiKeyChoiceProblem, MCP_SERVER_SCHEMA, MODEL_ROLES, SETTINGS_SCHEMA, TUI_NOTIFY_MODES, TUI_SCREEN_MODES, TUI_SETTING_VALUES, TUI_THEMES } from './settings-schema.ts';
import { DEFAULT_CAPTURE_MESSAGE_CONTENT, DEFAULT_RETENTION_DAYS } from './setting-defaults.ts';

export type PermissionsSettings = {
  defaultMode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  additionalDirectories?: string[];
};

export type McpServerCallBounds = {
  timeoutMs?: number;
  idleTimeoutMs?: number;
};

export const MCP_SERVER_CALL_BOUND_KEYS = ['timeoutMs', 'idleTimeoutMs'] as const satisfies ReadonlyArray<keyof McpServerCallBounds>;

export type McpStdioServerConfig = McpServerCallBounds & {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  cwd?: string;
};

export type McpOAuthConfig = {
  clientId?: string;
  scope?: string;
  callbackPort?: number;
};

export type McpRemoteServerConfig = McpServerCallBounds & {
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

type DraftOf<Connection> = Connection extends unknown ? Omit<Connection, 'models'> : never;

export type ConnectionDraft = DraftOf<ModelConnection>;

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
  writtenCapabilities: DeclaredTargetCapabilities;
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
  writtenCapabilities: DeclaredTargetCapabilities;
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
  writtenCapabilities: DeclaredTargetCapabilities;
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
  writtenCapabilities: DeclaredTargetCapabilities;
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

export type DeclaredServer = { command: string; args: string[]; readyPath: string; modelFile?: string; endpoint?: { forms: ManagedEndpointForm[] } };

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

export type McpCallSettings = { toolIdleTimeoutNetworkMs?: number; toolIdleTimeoutStdioMs?: number; toolTotalTimeoutMs?: number };

export type SandboxSetting = 'seatbelt' | 'bubblewrap' | 'none';

export type SandboxUnixSocketsSettings = { allow?: string[] };

export type ResolvedSandboxUnixSockets = { allow: string[] };

export type OtlpSettings = { endpoint: string; headers?: Record<string, string> };

export type IssueWatchEntry = { repository: string; folder: string; forge: string; labels?: string[]; authorAssociation?: (typeof ISSUE_AUTHOR_ASSOCIATIONS)[number][]; mandate: string };

export type IssuesSettings = { watch?: IssueWatchEntry[] };

export type TelemetrySettings = { otlp?: OtlpSettings; captureMessageContent?: boolean };

export type ResolvedTelemetrySettings = { captureMessageContent: boolean };

export const resolveTelemetrySettings = (settings: TelemetrySettings | undefined): ResolvedTelemetrySettings => ({
  captureMessageContent: settings?.captureMessageContent ?? DEFAULT_CAPTURE_MESSAGE_CONTENT,
});

export type RetentionSettings = { days?: number };

export type ProjectCheckAnswer = { commands: string[] } | { declined: true };

export type ProjectChecksSettings = Record<string, ProjectCheckAnswer>;

export type McpServerApproval = string | { name: string; digest: string; config?: unknown };

export type HookApproval = string | { digest: string; event: string; group: unknown };

export type MandateApproval = string | { digest: string; document: unknown };

export type AgentApproval = { name: string; digest: string; text: string };

export type ProjectApprovalsSettings = Record<string, { hooks?: HookApproval[]; mandate?: MandateApproval; agents?: AgentApproval[] }>;

export const approvalDigest = (approval: HookApproval | MandateApproval): string => (typeof approval === 'string' ? approval : approval.digest);

export type ResolvedRetentionSettings = { days: number };

export const resolveRetentionSettings = (settings: RetentionSettings | undefined): ResolvedRetentionSettings => ({
  days: settings?.days ?? DEFAULT_RETENTION_DAYS,
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

export type BashOnTimeout = (typeof BASH_ON_TIMEOUT)[number];

export type BashSettings = { defaultTimeoutMs?: number; maxTimeoutMs?: number; onTimeout?: BashOnTimeout; backgroundTimeoutMs?: number; maxBackgroundTimeoutMs?: number; drainIdleMs?: number };

export type ToolsSettings = { deferral?: boolean; conciseDescriptions?: boolean; ripgrep?: RipgrepSetting; bash?: BashSettings; search?: { timeoutMs?: number }; operations?: { timeoutMs?: number } };

export type UpdateSettings = { stallTimeoutMs?: number };

export type CredentialsSettings = { env?: string[]; keep?: string[]; valuePatterns?: string[]; plaintextTokenFiles?: boolean };

export type NetworkSettings = { httpProxy?: string; httpsProxy?: string; noProxy?: string; extraCaFiles?: string[]; environment?: boolean };

export type LimitsSettings = { maxCostUsd?: number };

export type CeilingsSettings = { costUsd?: number; tokens?: number; timeMs?: number };

export type MandateProfileSettings = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  until?: string[];
  require?: string[];
  steps?: number;
  tokens?: number;
  costUsd?: number;
  timeMs?: number;
  retries?: number;
  onQuiescent?: 'report' | 'wait';
};

const isAbsoluteHttpUrl = (value: string): boolean => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

export type ForgeInstanceSettings = {
  id: string;
  descriptor: string;
  hosts: string[];
  apiBaseUrl: string;
  credential: ForgeCredentialSettings;
};

export type ForgeCredentialSettings = { env: string } | { secret: string };

export type OperationApprovalClass = 'rule' | 'always';

export type OperationsSettings = { protectedRefs?: string[]; approval?: Record<string, OperationApprovalClass> };

export type Settings = {
  permissions?: PermissionsSettings;
  env?: Record<string, string>;
  credentials?: CredentialsSettings;
  hooks?: Record<string, HookGroups>;
  autoMode?: AutoModeSettings;
  enabledMcpjsonServers?: McpServerApproval[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  mcp?: McpSettings;
  models?: ModelsSettings;
  autoUpdates?: boolean;
  update?: UpdateSettings;
  tui?: TuiSettings;
  gateway?: GatewaySettings;
  runtime?: RuntimeSettings;
  sandbox?: SandboxSetting;
  sandboxNetwork?: SandboxNetworkSetting;
  sandboxUnixSockets?: SandboxUnixSocketsSettings;
  telemetry?: TelemetrySettings;
  retention?: RetentionSettings;
  projectChecks?: ProjectChecksSettings;
  projectApprovals?: ProjectApprovalsSettings;
  network?: NetworkSettings;
  pricing?: PriceEntrySettings[];
  limits?: LimitsSettings;
  ceilings?: CeilingsSettings;
  mandates?: Record<string, MandateProfileSettings>;
  issues?: IssuesSettings;
  forges?: ForgeInstanceSettings[];
  operations?: OperationsSettings;
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
    throw new ConfigError(invalidSettingsMessage(source, `/mcpServers/${escapePointerSegment(name)}/type`, 'the deprecated HTTP+SSE transport is not supported; use type "http" (Streamable HTTP)'));
  }
};

const RETIRED_KEYS: ReadonlyArray<{ readonly path: readonly [string, string]; readonly sentence: string }> = [
  { path: ['models', 'targets'], sentence: 'is not a setting any more; declare each server under models.connections with its models (see README, Models).' },
  { path: ['models', 'aliases'], sentence: 'is not a setting any more; list the models to try after the model in models.fallback and choose the first with models.start (see README, Models).' },
  { path: ['mcp', 'toolIdleTimeoutMs'], sentence: 'is not a setting any more; set mcp.toolIdleTimeoutNetworkMs for the servers reached by URL and mcp.toolIdleTimeoutStdioMs for the servers started as a command.' },
  { path: ['telemetry', 'contentRetentionDays'], sentence: 'is not a setting any more; set retention.days in the user settings, the one retention period of every store.' },
];

const OLD_BILLING_SCOPE_KEY = 'alias';

const assertNoRetiredKeys = (value: unknown, source: string): void => {
  if (!isRecord(value)) return;
  for (const { path: [object, key], sentence } of RETIRED_KEYS) {
    const holder = value[object];
    if (isRecord(holder) && Object.hasOwn(holder, key)) throw new ConfigError(invalidSettingsMessage(source, `/${object}/${key}`, sentence));
  }
  const models = value['models'];
  if (!isRecord(models)) return;
  const changes = models['billingChanges'];
  if (!Array.isArray(changes)) return;
  changes.forEach((change, index) => {
    if (isRecord(change) && Object.hasOwn(change, OLD_BILLING_SCOPE_KEY)) {
      throw new ConfigError(invalidSettingsMessage(source, `/models/billingChanges/${index}/${OLD_BILLING_SCOPE_KEY}`, 'is not a setting any more; write "model" with the model it applies to (see README, Models).'));
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
      throw new ConfigError(invalidSettingsMessage(source, `/models/connections/${index}/adapter`, `the plan ${profileId} requires adapter ${required}`));
    }
  });
};

const assertTuiValues = (value: unknown, source: string): void => {
  const tui = isRecord(value) ? value['tui'] : undefined;
  if (!isRecord(tui)) return;
  for (const [name, allowed] of Object.entries(TUI_SETTING_VALUES)) {
    if (!Object.hasOwn(tui, name)) continue;
    const given: unknown = tui[name];
    if (!allowed.some((member) => member === given)) throw new ConfigError(invalidSettingsMessage(source, `/tui/${name}`, `must be one of ${allowed.join(', ')}; got ${JSON.stringify(given)}`));
  }
};

const assertApiKeyChoice = (value: unknown, source: string): void => {
  const models = isRecord(value) ? value['models'] : undefined;
  const connections = isRecord(models) ? models['connections'] : undefined;
  if (!Array.isArray(connections)) return;
  connections.forEach((connection: unknown, index) => {
    const problem = isRecord(connection) ? apiKeyChoiceProblem(connection) : undefined;
    if (problem !== undefined) throw new ConfigError(invalidSettingsMessage(source, `/models/connections/${index}`, problem));
  });
};

const assertMcpConnectTimeout = (value: unknown, source: string): void => {
  const mcp = isRecord(value) ? value['mcp'] : undefined;
  if (!isRecord(mcp) || !Object.hasOwn(mcp, 'connectTimeoutMs')) return;
  const problem = mcpConnectTimeoutProblem(mcp['connectTimeoutMs']);
  if (problem !== undefined) throw new ConfigError(invalidSettingsMessage(source, '/mcp/connectTimeoutMs', problem));
};

const assertStopValues = (value: unknown, source: string): void => {
  if (!isRecord(value)) return;
  for (const [name, { object, key }] of Object.entries(STOP_SETTING_KEYS) as Array<[StopValueName, (typeof STOP_SETTING_KEYS)[StopValueName]]>) {
    const holder = value[object];
    if (!isRecord(holder) || !Object.hasOwn(holder, key)) continue;
    const problem = stopValueProblem(name, holder[key]);
    if (problem !== undefined) throw new ConfigError(invalidSettingsMessage(source, `/${object}/${key}`, problem));
  }
};

export const assertSettings = (value: unknown, source: string): Settings => {
  if (isRecord(value) && isRecord(value['mcpServers'])) {
    for (const [name, server] of Object.entries(value['mcpServers'])) assertNotHttpSse(server, source, name);
  }
  assertNoRetiredKeys(value, source);
  assertPlanAdapters(value, source);
  assertApiKeyChoice(value, source);
  assertStopValues(value, source);
  assertMcpConnectTimeout(value, source);
  assertTuiValues(value, source);
  const verdict = validateSettings(value);
  if (!verdict.valid) throw new ConfigError(`${source}: invalid settings at ${describeSchemaErrors(verdict.errors)}`);
  const settings = verdict.value;
  (settings.credentials?.valuePatterns ?? []).forEach((pattern, index) => {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new ConfigError(`${source}: invalid settings at /credentials/valuePatterns/${index}: not a regular expression`, { cause: error });
    }
  });
  (settings.network?.extraCaFiles ?? []).forEach((file, index) => {
    if (!path.isAbsolute(file)) throw new ConfigError(`${source}: invalid settings at /network/extraCaFiles/${index}: not an absolute path`);
  });
  (settings.sandboxUnixSockets?.allow ?? []).forEach((entry, index) => {
    if (!path.isAbsolute(entry)) throw new ConfigError(`${source}: invalid settings at /sandboxUnixSockets/allow/${index}: not an absolute path`);
  });
  (settings.forges ?? []).forEach((forge, index) => {
    if (!isAbsoluteHttpUrl(forge.apiBaseUrl)) throw new ConfigError(`${source}: invalid settings at /forges/${index}/apiBaseUrl: not an absolute http or https URL`);
  });
  for (const [name, server] of Object.entries(settings.mcpServers ?? {})) {
    const pointer = `/mcpServers/${escapePointerSegment(name)}`;
    const nameProblem = mcpServerNameProblem(name);
    if (nameProblem !== undefined) throw new ConfigError(`${source}: invalid settings at ${pointer}: ${nameProblem}`);
    if (!('url' in server) || MCP_EXPANSION_PATTERN.test(server.url)) continue;
    const urlProblem = mcpServerUrlProblem(server.url, 'user');
    if (urlProblem !== undefined) throw new ConfigError(`${source}: invalid settings at ${pointer}/url: ${urlProblem.message}`);
  }
  const operations: readonly string[] = OPERATION_RULE_TOOLS;
  for (const name of Object.keys(settings.operations?.approval ?? {})) {
    if (!operations.includes(name)) throw new ConfigError(`${source}: invalid settings at /operations/approval/${escapePointerSegment(name)}: not an operation; the operations are ${operations.join(', ')}`);
  }
  (settings.models?.connections ?? []).forEach((connection, index) => {
    const problem = connectionAddressProblem(connection);
    if (problem !== undefined) throw new ConfigError(`${source}: invalid settings at /models/connections/${index}: ${problem}`);
  });
  const price = priceTableProblem(settings.pricing ?? []);
  if (price !== undefined) throw new ConfigError(`${source}: invalid settings at /pricing/${price.index}${price.field === undefined ? '' : `/${price.field}`}: ${price.reason}`);
  const endpoint = settings.telemetry?.otlp?.endpoint;
  if (endpoint !== undefined) {
    const problem = transportUrlProblem(endpoint);
    if (problem !== undefined) throw new ConfigError(invalidSettingsMessage(source, '/telemetry/otlp/endpoint', transportUrlMessage('the address', endpoint, problem)));
  }
  return settings;
};

export const assertMcpServersFile = (value: unknown, source: string): McpServersFile => {
  const verdict = validateMcpServersFile(value);
  if (verdict.valid) return verdict.value;
  throw new ConfigError(`${source}: invalid settings at ${describeSchemaErrors(verdict.errors)}`);
};

export const assertMcpServer = (value: unknown, source: string, name: string): McpServerConfig => {
  assertNotHttpSse(value, source, name);
  const verdict = validateMcpServer(value);
  if (verdict.valid) return verdict.value;
  const { pointer, reason } = schemaProblemOf(verdict.errors);
  throw new ConfigError(invalidSettingsMessage(source, `/mcpServers/${escapePointerSegment(name)}${pointer === '/' ? '' : pointer}`, reason));
};

const watchMandateProblem = (mandate: string, declared: readonly string[]): string | undefined =>
  declared.includes(mandate) ? undefined : `${JSON.stringify(mandate)} is not a mandate declared under mandates; the mandates are ${declared.length === 0 ? 'none' : declared.join(', ')}`;

const watchForgeProblem = (forge: string, declared: readonly string[]): string | undefined =>
  declared.includes(forge) ? undefined : `${JSON.stringify(forge)} is not a forge declared under forges; the forges are ${declared.length === 0 ? 'none' : declared.join(', ')}`;

export const checkIssueWatch = (settings: Settings, source: string, warnings: string[]): void => {
  const declared = Object.keys(settings.mandates ?? {});
  const forges = (settings.forges ?? []).map((forge) => forge.id);
  (settings.issues?.watch ?? []).forEach((entry, index) => {
    const problem = watchMandateProblem(entry.mandate, declared);
    if (problem !== undefined) throw new ConfigError(invalidSettingsMessage(source, `/issues/watch/${index}/mandate`, problem));
    const forgeProblem = watchForgeProblem(entry.forge, forges);
    if (forgeProblem !== undefined) throw new ConfigError(invalidSettingsMessage(source, `/issues/watch/${index}/forge`, forgeProblem));
    if (!path.isAbsolute(entry.folder)) throw new ConfigError(invalidSettingsMessage(source, `/issues/watch/${index}/folder`, `${JSON.stringify(entry.folder)} is not an absolute path; give the absolute path of the clone the run acts in`));
    if (entry.labels === undefined && entry.authorAssociation === undefined) {
      warnings.push(`${source}: issues.watch[${index}] for ${entry.repository} has no labels and no authorAssociation, so it takes no issue; add a filter`);
    }
  });
};

export const KNOWN_SETTINGS_KEYS: readonly string[] = Object.keys(SETTINGS_SCHEMA.properties);
