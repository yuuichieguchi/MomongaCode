import path from 'node:path';
import { STOP_VALUE_NAMES, defineProductSchema, stopValueProblem, transportUrlMessage, transportUrlProblem, isRecord } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import type { AnthropicApiVersion, CapabilitiesCore, DialectDefinition, HooksSettings, ImageCapability, ImageTokenModel, OutputBoundField, OutputFormatterName, TargetAnswers, TargetBilling, PermissionMode } from '@momonga/protocol';
import { PLAN_PROFILES } from './plan-profiles.ts';
import { describeSchemaErrors } from './schema-errors.ts';
import { MCP_SERVERS_FILE_SCHEMA, MCP_SERVER_SCHEMA, MODEL_ROLES, SETTINGS_SCHEMA } from './settings-schema.ts';

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

export type TargetCapabilitiesCore = Omit<CapabilitiesCore, 'toolCalling' | 'probedAt' | 'maxConcurrency' | 'schemaDialect'> & Partial<Pick<CapabilitiesCore, 'schemaDialect'>>;

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
  model?: string;
  outputBoundField?: OutputBoundField;
  toolCalling?: ToolCallingSetting;
  capabilities?: ManagedDeclaredCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ChatCompletionsTarget = {
  adapter: 'chat-completions';
  answers?: TargetAnswers;
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
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
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
  toolCalling?: 'native' | 'none';
  billing?: TargetBilling;
  capabilities: RemoteTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type AnthropicTarget = {
  adapter: 'anthropic';
  answers?: TargetAnswers;
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
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  plan: PlanReference;
  provider?: string;
  toolCalling?: 'native' | 'none';
  billing?: TargetBilling;
  capabilities?: PlanTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ModelTarget = ManagedTarget | ChatCompletionsTarget | OpenResponsesTarget | PlanOpenResponsesTarget | AnthropicTarget | OllamaTarget;

export type ResolvedManagedTarget = {
  adapter: 'managed';
  server: string;
  binary: string;
  readyTimeoutMs: number;
  answers?: TargetAnswers;
  model?: string;
  outputBoundField?: OutputBoundField;
  toolCalling: ToolCallingSetting;
  capabilities?: ManagedDeclaredCapabilities;
  billing: 'local';
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedChatCompletionsTarget = {
  adapter: 'chat-completions';
  answers?: TargetAnswers;
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

export type ModelAlias = string | string[];

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelRoles = Partial<Record<ModelRole, string>>;

export type BillingChange = { from: TargetBilling; to: TargetBilling; alias?: string };

export type ModelsSettings = {
  aliases?: Record<string, ModelAlias>;
  billingChanges?: BillingChange[];
  targets?: Record<string, ModelTarget>;
  dialects?: Record<string, DialectDefinition>;
  roles?: ModelRoles;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
};

export type McpCallSettings = { toolIdleTimeoutMs?: number; toolTotalTimeoutMs?: number };

export type SandboxSetting = 'seatbelt' | 'bubblewrap' | 'none';

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

export type VerificationSettings = { commands?: string[]; manifests?: string[] };

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

export type CredentialsSettings = { env?: string[]; keep?: string[]; valuePatterns?: string[] };

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
  mcp?: McpCallSettings;
  models?: ModelsSettings;
  autoUpdates?: boolean;
  gateway?: GatewaySettings;
  sandbox?: SandboxSetting;
  telemetry?: TelemetrySettings;
  network?: NetworkSettings;
  pricing?: PriceEntrySettings[];
  memory?: MemorySettings;
  verification?: VerificationSettings;
  context?: ContextSettings;
  tools?: ToolsSettings;
};

export type GatewaySettings = { closeGraceMs?: number; managedServerStopGraceMs?: number };

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

const assertPlanAdapters = (value: unknown, source: string): void => {
  const models = isRecord(value) ? value['models'] : undefined;
  const targets = isRecord(models) ? models['targets'] : undefined;
  if (!isRecord(targets)) return;
  for (const [name, target] of Object.entries(targets)) {
    const plan = isRecord(target) ? target['plan'] : undefined;
    const profileId = isRecord(plan) ? plan['profile'] : undefined;
    if (typeof profileId !== 'string' || !Object.hasOwn(PLAN_PROFILES, profileId)) continue;
    const required = (PLAN_PROFILES[profileId] as NonNullable<(typeof PLAN_PROFILES)[string]>).adapter;
    if ((target as Record<string, unknown>)['adapter'] !== required) {
      throw new Error(`${source}: models.targets.${name}: profile ${profileId} requires adapter ${required}`);
    }
  }
};

const assertGatewayStopValues = (value: unknown, source: string): void => {
  const gateway = isRecord(value) ? value['gateway'] : undefined;
  if (!isRecord(gateway)) return;
  for (const name of STOP_VALUE_NAMES) {
    if (!Object.hasOwn(gateway, name)) continue;
    const problem = stopValueProblem(name, gateway[name]);
    if (problem !== undefined) throw new Error(`${source}: gateway.${problem}`);
  }
};

export const assertSettings = (value: unknown, source: string): Settings => {
  if (isRecord(value) && isRecord(value['mcpServers'])) {
    for (const [name, server] of Object.entries(value['mcpServers'])) assertNotHttpSse(server, source, name);
  }
  assertPlanAdapters(value, source);
  assertGatewayStopValues(value, source);
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
