import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { transportUrlMessage, transportUrlProblem, isRecord } from '@momonga/foundation';
import type { CapabilitiesCore, HooksSettings, ImageCapability, ImageTokenModel, TargetBilling, PermissionMode } from '@momonga/protocol';
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

export type FmToolCalling = 'auto' | 'native' | 'constrained';

export type TargetCapabilitiesCore = Omit<CapabilitiesCore, 'toolCalling' | 'probedAt' | 'maxConcurrency'>;

export type TargetCapabilities = TargetCapabilitiesCore & ImageCapability;

export type DeclaredTargetCapabilities = Pick<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens'> &
  Partial<TargetCapabilitiesCore> & { imageInput?: boolean; imageTokens?: ImageTokenModel };

export type FmTarget = {
  adapter: 'fm';
  model?: string;
  toolCalling?: FmToolCalling;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ChatCompletionsTarget = {
  adapter: 'chat-completions';
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
  toolCalling?: FmToolCalling;
  billing?: TargetBilling;
  capabilities: DeclaredTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type RemoteTargetCapabilities = DeclaredTargetCapabilities;

export type OpenResponsesTarget = {
  adapter: 'open-responses';
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
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  billing?: TargetBilling;
  capabilities: RemoteTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ModelTarget = FmTarget | ChatCompletionsTarget | OpenResponsesTarget | AnthropicTarget;

export type ResolvedFmTarget = {
  adapter: 'fm';
  model: string;
  toolCalling: FmToolCalling;
  billing: 'local';
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedChatCompletionsTarget = {
  adapter: 'chat-completions';
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  provider: string;
  toolCalling: FmToolCalling;
  billing: TargetBilling;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedOpenResponsesTarget = {
  adapter: 'open-responses';
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

export type ResolvedAnthropicTarget = {
  adapter: 'anthropic';
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  toolCalling: 'native';
  billing: TargetBilling;
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedModelTarget =
  | ResolvedFmTarget
  | ResolvedChatCompletionsTarget
  | ResolvedOpenResponsesTarget
  | ResolvedAnthropicTarget;

export type ModelAlias = string | string[];

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelRoles = Partial<Record<ModelRole, string>>;

export type ModelsSettings = {
  aliases?: Record<string, ModelAlias>;
  targets?: Record<string, ModelTarget>;
  roles?: ModelRoles;
};

export type SandboxSetting = 'seatbelt' | 'bubblewrap' | 'none';

export const defaultSandboxSetting = (platform: NodeJS.Platform = process.platform): SandboxSetting =>
  platform === 'darwin' ? 'seatbelt' : platform === 'linux' ? 'bubblewrap' : 'none';

export type OtlpSettings = { endpoint: string; headers?: Record<string, string> };

export type TelemetrySettings = { otlp?: OtlpSettings; captureMessageContent?: boolean };

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

export type MemorySettings = { reflection?: { enabled?: boolean; maxTokens?: number }; forgetAfterDays?: number };

export type VerificationSettings = { commands?: string[]; manifests?: string[] };

export type ContextSettings = { adaptiveBudget?: boolean; autoCompact?: boolean };

export type Settings = {
  permissions?: PermissionsSettings;
  env?: Record<string, string>;
  hooks?: Record<string, HookGroups>;
  autoMode?: AutoModeSettings;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  models?: ModelsSettings;
  autoUpdates?: boolean;
  sandbox?: SandboxSetting;
  telemetry?: TelemetrySettings;
  pricing?: PriceEntrySettings[];
  memory?: MemorySettings;
  verification?: VerificationSettings;
  context?: ContextSettings;
};

export type HookGroups = NonNullable<HooksSettings[keyof HooksSettings]>;

export type McpServersFile = { mcpServers?: Record<string, unknown> };

const ajv = new Ajv2020.default({ strict: true, discriminator: true });
const validateSettings: ValidateFunction<Settings> = ajv.compile<Settings>(SETTINGS_SCHEMA);
const validateMcpServersFile: ValidateFunction<McpServersFile> = ajv.compile<McpServersFile>(MCP_SERVERS_FILE_SCHEMA);
const validateMcpServer: ValidateFunction<McpServerConfig> = ajv.compile<McpServerConfig>(MCP_SERVER_SCHEMA);

const describeErrors = (errors: ErrorObject[] | null | undefined): string => {
  const first = errors?.[0];
  if (first === undefined) return '/: schema violation';
  const additional = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${additional}`;
  return `${pointer === '' ? '/' : pointer}: ${first.message ?? 'schema violation'}`;
};

const assertNotHttpSse = (server: unknown, source: string, name: string): void => {
  if (isRecord(server) && server['type'] === 'sse') {
    throw new Error(`${source}: MCP server ${JSON.stringify(name)} uses the deprecated HTTP+SSE transport, which is not supported; use type "http" (Streamable HTTP)`);
  }
};

export const assertSettings = (value: unknown, source: string): Settings => {
  if (isRecord(value) && isRecord(value['mcpServers'])) {
    for (const [name, server] of Object.entries(value['mcpServers'])) assertNotHttpSse(server, source, name);
  }
  if (!validateSettings(value)) throw new Error(`${source}: invalid settings at ${describeErrors(validateSettings.errors)}`);
  const endpoint = value.telemetry?.otlp?.endpoint;
  if (endpoint !== undefined) {
    const problem = transportUrlProblem(endpoint);
    if (problem !== undefined) throw new Error(`${source}: ${transportUrlMessage('telemetry.otlp.endpoint', endpoint, problem)}`);
  }
  return value;
};

export const assertMcpServersFile = (value: unknown, source: string): McpServersFile => {
  if (validateMcpServersFile(value)) return value;
  throw new Error(`${source}: invalid MCP server file at ${describeErrors(validateMcpServersFile.errors)}`);
};

export const assertMcpServer = (value: unknown, source: string, name: string): McpServerConfig => {
  assertNotHttpSse(value, source, name);
  if (validateMcpServer(value)) return value;
  throw new Error(`${source}: invalid MCP server ${JSON.stringify(name)}: ${describeErrors(validateMcpServer.errors)}`);
};

export const KNOWN_SETTINGS_KEYS: readonly string[] = Object.keys(SETTINGS_SCHEMA.properties);
