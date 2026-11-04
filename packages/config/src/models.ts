import path from 'node:path';
import { canonicalPath, comparableContains, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';
import { imageCapability } from '@momonga/protocol';
import type { TargetBilling } from '@momonga/protocol';
import { layoutOf } from './layout.ts';
import type {
  AnthropicTarget,
  ChatCompletionsTarget,
  FmTarget,
  ModelAlias,
  ModelRole,
  ModelRoles,
  ModelTarget,
  ModelsSettings,
  OpenResponsesTarget,
  ResolvedAnthropicTarget,
  ResolvedChatCompletionsTarget,
  ResolvedFmTarget,
  ResolvedModelTarget,
  ResolvedOpenResponsesTarget,
  DeclaredTargetCapabilities,
  TargetCapabilities,
  TargetCapabilitiesCore,
} from './settings.ts';

export type ResolvedModels = {
  aliases: Record<string, ModelAlias>;
  targets: Record<string, ResolvedModelTarget>;
  roles: ModelRoles;
};

export type ResolveModelsOptions = { source: string; home: string; warnings: string[] };

const DEFAULT_FM_NAME = 'fm';
const DEFAULT_ALIAS = 'default';

const resolveFm = (target: FmTarget): ResolvedFmTarget => ({
  adapter: 'fm',
  model: target.model ?? 'default',
  toolCalling: target.toolCalling ?? 'auto',
  billing: 'local',
  maxConcurrency: target.maxConcurrency ?? 1,
  admissionTimeoutMs: target.admissionTimeoutMs ?? 30000,
});

const checkBaseUrl = (baseUrl: string, where: string): void => {
  const problem = transportUrlProblem(baseUrl);
  if (problem !== undefined) throw new Error(`${where}: ${transportUrlMessage('baseUrl', baseUrl, problem)}`);
  if (baseUrl.includes('?') || baseUrl.includes('#')) throw new Error(`${where}: baseUrl must not contain a query or fragment`);
};

const checkSocketPath = (socketPath: string, home: string, where: string): void => {
  if (!path.isAbsolute(socketPath)) throw new Error(`${where}: socketPath ${JSON.stringify(socketPath)} must be an absolute path`);
  if (comparableContains(canonicalPath(layoutOf(home).run), canonicalPath(socketPath))) {
    throw new Error(`${where}: socketPath ${socketPath} must not be inside ${layoutOf(home).run}`);
  }
};

type RemoteTargetInput = {
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  billing?: TargetBilling;
  capabilities: DeclaredTargetCapabilities;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

type CapabilityDefaults = Omit<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens'> & { imageInput: false };

const CHAT_COMPLETIONS_CAPABILITY_DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
};

const OPEN_RESPONSES_CAPABILITY_DEFAULTS: CapabilityDefaults = {
  ...CHAT_COMPLETIONS_CAPABILITY_DEFAULTS,
  stopSequences: false,
};

const ANTHROPIC_CAPABILITY_DEFAULTS: CapabilityDefaults = {
  ...OPEN_RESPONSES_CAPABILITY_DEFAULTS,
  parallelToolCalls: true,
  tokenCounting: 'exact',
  promptCache: { kind: 'breakpoints', maxBreakpoints: 4 },
};

const DEFAULT_REMOTE_MAX_CONCURRENCY = 4;
const DEFAULT_REMOTE_BILLING: TargetBilling = 'metered';

const resolveRemote = (target: RemoteTargetInput, defaults: CapabilityDefaults, home: string, where: string) => {
  const { baseUrl, socketPath } = target;
  if ((baseUrl === undefined) === (socketPath === undefined)) {
    throw new Error(`${where}: exactly one of baseUrl and socketPath is required`);
  }
  if (baseUrl !== undefined) checkBaseUrl(baseUrl, where);
  if (socketPath !== undefined) checkSocketPath(socketPath, home, where);
  const maxConcurrency = target.maxConcurrency ?? DEFAULT_REMOTE_MAX_CONCURRENCY;
  const { imageInput, imageTokens, ...core } = { ...defaults, ...target.capabilities, maxConcurrency };
  const capabilities = { ...core, ...imageCapability(imageInput, imageTokens, `${where}: `) };
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    ...(target.apiKeySecret === undefined ? {} : { apiKeySecret: target.apiKeySecret }),
    billing: target.billing ?? DEFAULT_REMOTE_BILLING,
    capabilities,
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? 30000,
  };
};

const resolveChatCompletions = (target: ChatCompletionsTarget, home: string, where: string): ResolvedChatCompletionsTarget => ({
  adapter: 'chat-completions',
  model: target.model,
  toolCalling: target.toolCalling ?? 'native',
  provider: target.provider,
  ...resolveRemote(target, CHAT_COMPLETIONS_CAPABILITY_DEFAULTS, home, where),
});

const resolveOpenResponses = (target: OpenResponsesTarget, home: string, where: string): ResolvedOpenResponsesTarget => ({
  adapter: 'open-responses',
  model: target.model,
  toolCalling: target.toolCalling ?? 'native',
  provider: target.provider,
  ...resolveRemote(target, OPEN_RESPONSES_CAPABILITY_DEFAULTS, home, where),
});

const resolveAnthropic = (target: AnthropicTarget, home: string, where: string): ResolvedAnthropicTarget => ({
  adapter: 'anthropic',
  model: target.model,
  toolCalling: 'native',
  ...resolveRemote(target, ANTHROPIC_CAPABILITY_DEFAULTS, home, where),
});

const resolveTarget = (target: ModelTarget, home: string, where: string): ResolvedModelTarget => {
  switch (target.adapter) {
    case 'fm':
      return resolveFm(target);
    case 'chat-completions':
      return resolveChatCompletions(target, home, where);
    case 'open-responses':
      return resolveOpenResponses(target, home, where);
    case 'anthropic':
      return resolveAnthropic(target, home, where);
  }
};

export const resolveModels = (models: ModelsSettings | undefined, { source, home, warnings }: ResolveModelsOptions): ResolvedModels => {
  const configured = Object.entries(models?.targets ?? {});
  const targets: Record<string, ResolvedModelTarget> = {};
  for (const [name, target] of configured) {
    const where = `${source}: models.targets.${name}`;
    targets[name] = resolveTarget(target, home, where);
  }
  if (configured.length === 0) targets[DEFAULT_FM_NAME] = resolveFm({ adapter: 'fm' });

  const aliases: Record<string, ModelAlias> = { ...models?.aliases };
  for (const [alias, value] of Object.entries(aliases)) {
    for (const member of [value].flat()) {
      if (!Object.hasOwn(targets, member)) {
        throw new Error(`${source}: models.aliases.${alias} names target ${JSON.stringify(member)}, which is not defined in models.targets`);
      }
    }
  }
  if (!Object.hasOwn(aliases, DEFAULT_ALIAS)) {
    const first = Object.keys(targets)[0] as string;
    aliases[DEFAULT_ALIAS] = [first];
    if (configured.length > 0) {
      warnings.push(`${source}: models.aliases has no "default" alias; using the first target ${JSON.stringify(first)}`);
    }
  }
  const roles: ModelRoles = {};
  for (const [role, alias] of Object.entries(models?.roles ?? {})) {
    if (!Object.hasOwn(aliases, alias)) {
      throw new Error(`${source}: models.roles.${role} names alias ${JSON.stringify(alias)}, which is not defined in models.aliases`);
    }
    roles[role as ModelRole] = alias;
  }
  return { aliases, targets, roles };
};

type ResolvedTargets = { models: { targets: Record<string, ResolvedModelTarget> } };

export const credentialEnvNames = (settings: ResolvedTargets): string[] => {
  const names = new Set<string>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter !== 'fm' && target.apiKeyEnv !== undefined) names.add(target.apiKeyEnv);
  }
  return [...names].sort();
};

export const secretNames = (settings: ResolvedTargets): string[] => {
  const names = new Set<string>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter !== 'fm' && target.apiKeySecret !== undefined) names.add(target.apiKeySecret);
  }
  return [...names].sort();
};
