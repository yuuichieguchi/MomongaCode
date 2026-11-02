import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Capabilities, PermissionMode } from '@momonga/protocol';
import { MCP_SERVERS_FILE_SCHEMA, MCP_SERVER_SCHEMA, SETTINGS_SCHEMA } from './settings-schema.ts';

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

export type McpRemoteServerConfig = {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export type FmToolCalling = 'auto' | 'native' | 'constrained';

export type TargetCapabilities = Omit<Capabilities, 'toolCalling' | 'probedAt' | 'maxConcurrency'>;

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
  toolCalling?: 'native' | 'constrained';
  capabilities: Pick<TargetCapabilities, 'contextWindow' | 'maxOutputTokens'> & Partial<TargetCapabilities>;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

export type ModelTarget = FmTarget | ChatCompletionsTarget;

export type ResolvedFmTarget = {
  adapter: 'fm';
  model: string;
  toolCalling: FmToolCalling;
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedChatCompletionsTarget = {
  adapter: 'chat-completions';
  model: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  toolCalling: 'native' | 'constrained';
  capabilities: TargetCapabilities & { maxConcurrency: number };
  maxConcurrency: number;
  admissionTimeoutMs: number;
};

export type ResolvedModelTarget = ResolvedFmTarget | ResolvedChatCompletionsTarget;

export type ModelAlias = string | string[];

export type ModelsSettings = {
  aliases?: Record<string, ModelAlias>;
  targets?: Record<string, ModelTarget>;
};

export type SandboxSetting = 'seatbelt' | 'none';

export type OtlpSettings = { endpoint: string; headers?: Record<string, string> };

export type TelemetrySettings = { otlp?: OtlpSettings };

export type Settings = {
  permissions?: PermissionsSettings;
  env?: Record<string, string>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  models?: ModelsSettings;
  autoUpdates?: boolean;
  sandbox?: SandboxSetting;
  telemetry?: TelemetrySettings;
};

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

export const assertSettings = (value: unknown, source: string): Settings => {
  if (validateSettings(value)) return value;
  throw new Error(`${source}: invalid settings at ${describeErrors(validateSettings.errors)}`);
};

export const assertMcpServersFile = (value: unknown, source: string): McpServersFile => {
  if (validateMcpServersFile(value)) return value;
  throw new Error(`${source}: invalid MCP server file at ${describeErrors(validateMcpServersFile.errors)}`);
};

export const assertMcpServer = (value: unknown, source: string, name: string): McpServerConfig => {
  if (validateMcpServer(value)) return value;
  throw new Error(`${source}: invalid MCP server ${JSON.stringify(name)}: ${describeErrors(validateMcpServer.errors)}`);
};

export const KNOWN_SETTINGS_KEYS: readonly string[] = Object.keys(SETTINGS_SCHEMA.properties);
