import path from 'node:path';
import { canonicalPath, comparableContains, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';
import { DEFAULT_ANTHROPIC_API_VERSION, OUTPUT_RESERVE, anthropicVersionSamplingBound, ceilRatio, imageCapability, marginFloorFor } from '@momonga/protocol';
import type { AnthropicApiVersion, DialectDefinition, TargetBilling } from '@momonga/protocol';
import { checkTargetDialects, resolveDialects } from './dialects.ts';
import { layoutOf } from './layout.ts';
import { PLAN_PROFILES } from './plan-profiles.ts';
import type {
  AnthropicTarget,
  BillingChange,
  ChatCompletionsTarget,
  FmTarget,
  ModelAlias,
  ModelRole,
  ModelRoles,
  ModelTarget,
  ModelsSettings,
  OllamaTarget,
  OpenResponsesTarget,
  PlanOpenResponsesTarget,
  PlanReference,
  ResolvedAnthropicTarget,
  ResolvedChatCompletionsTarget,
  ResolvedFmTarget,
  ResolvedModelTarget,
  ResolvedOllamaTarget,
  ResolvedOpenResponsesTarget,
  ResolvedPlanTarget,
  DeclaredTargetCapabilities,
  TargetCapabilities,
  TargetCapabilitiesCore,
} from './settings.ts';

export type ResolvedModels = {
  aliases: Record<string, ModelAlias>;
  targets: Record<string, ResolvedModelTarget>;
  dialects: Record<string, DialectDefinition>;
  roles: ModelRoles;
  billingChanges: BillingChange[];
};

export type ResolveModelsOptions = { source: string; home: string; warnings: string[] };

const DEFAULT_FM_NAME = 'fm';
const DEFAULT_ALIAS = 'default';

const LOCAL_SERVER_DEFAULTS = { billing: 'local', maxConcurrency: 1 } as const satisfies { billing: TargetBilling; maxConcurrency: number };

const resolveFm = (target: FmTarget): ResolvedFmTarget => ({
  adapter: 'fm',
  ...(target.model === undefined ? {} : { model: target.model }),
  ...(target.outputBoundField === undefined ? {} : { outputBoundField: target.outputBoundField }),
  toolCalling: target.toolCalling ?? 'auto',
  billing: LOCAL_SERVER_DEFAULTS.billing,
  maxConcurrency: target.maxConcurrency ?? LOCAL_SERVER_DEFAULTS.maxConcurrency,
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

type CapabilityDefaults = Omit<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens' | 'imageInput' | 'imageTokens'>;

const CHAT_COMPLETIONS_CAPABILITY_DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
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

const OLLAMA_CAPABILITY_DEFAULTS: CapabilityDefaults = {
  ...CHAT_COMPLETIONS_CAPABILITY_DEFAULTS,
  structuredOutput: 'json_schema',
  stopSequences: false,
};

const DEFAULT_REMOTE_MAX_CONCURRENCY = 4;
const DEFAULT_REMOTE_BILLING: TargetBilling = 'metered';

const checkSamplingRange = (capabilities: Pick<TargetCapabilitiesCore, 'sampling'>, where: string): void => {
  const { sampling } = capabilities;
  if (sampling?.accepts !== 'without_thinking') return;
  const { min, max } = sampling.topP;
  if (min > max) {
    throw new Error(`${where}: capabilities.sampling.topP.min (${min}) must not exceed capabilities.sampling.topP.max (${max})`);
  }
};

const resolveRemote = (
  target: RemoteTargetInput,
  defaults: CapabilityDefaults,
  home: string,
  where: string,
  serving: { billing: TargetBilling; maxConcurrency: number } = { billing: DEFAULT_REMOTE_BILLING, maxConcurrency: DEFAULT_REMOTE_MAX_CONCURRENCY },
) => {
  const { baseUrl, socketPath } = target;
  if ((baseUrl === undefined) === (socketPath === undefined)) {
    throw new Error(`${where}: exactly one of baseUrl and socketPath is required`);
  }
  if (baseUrl !== undefined) checkBaseUrl(baseUrl, where);
  if (socketPath !== undefined) checkSocketPath(socketPath, home, where);
  checkSamplingRange(target.capabilities, where);
  const maxConcurrency = target.maxConcurrency ?? serving.maxConcurrency;
  const { imageInput, imageTokens, ...core } = { ...defaults, ...target.capabilities, maxConcurrency };
  const capabilities = {
    ...core,
    ...(imageInput === undefined && imageTokens === undefined ? {} : imageCapability(imageInput ?? false, imageTokens, `${where}: `)),
  };
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    ...(target.apiKeySecret === undefined ? {} : { apiKeySecret: target.apiKeySecret }),
    billing: target.billing ?? serving.billing,
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

const resolvePlan = (target: PlanOpenResponsesTarget, where: string): ResolvedPlanTarget => {
  const { profile: profileId } = target.plan;
  if (!Object.hasOwn(PLAN_PROFILES, profileId)) {
    const known = Object.keys(PLAN_PROFILES).map((id) => JSON.stringify(id)).join(', ');
    throw new Error(`${where}: plan.profile ${JSON.stringify(profileId)} is not a shipped plan profile; the shipped profiles are ${known}`);
  }
  const profile = PLAN_PROFILES[profileId] as NonNullable<(typeof PLAN_PROFILES)[string]>;
  for (const key of ['apiKeyEnv', 'apiKeySecret'] as const) {
    if (target[key] !== undefined) throw new Error(`${where}: plan cannot be combined with ${key}; a plan target takes its credential from the signed-in account`);
  }
  if (target.socketPath !== undefined) {
    throw new Error(`${where}: plan cannot be combined with socketPath; a plan target sends its bearer only to ${profile.oauth.resource}`);
  }
  const baseUrl = target.baseUrl ?? profile.targetDefaults.baseUrl;
  checkBaseUrl(baseUrl, where);
  const resourceOrigin = new URL(profile.oauth.resource).origin;
  const baseOrigin = new URL(baseUrl).origin;
  if (baseOrigin !== resourceOrigin) {
    throw new Error(`${where}: baseUrl ${baseUrl} has origin ${baseOrigin}, but plan profile ${profile.id} sends its bearer only to origin ${resourceOrigin}`);
  }
  const declared = target.capabilities ?? {};
  checkSamplingRange(declared, where);
  const maxConcurrency = target.maxConcurrency ?? DEFAULT_REMOTE_MAX_CONCURRENCY;
  const { imageInput, imageTokens, ...core } = { ...OPEN_RESPONSES_CAPABILITY_DEFAULTS, ...profile.targetDefaults.capabilities, ...declared, maxConcurrency };
  return {
    adapter: 'open-responses',
    ...(target.answers === undefined ? {} : { answers: target.answers }),
    model: target.model,
    baseUrl,
    provider: target.provider ?? profile.id,
    plan: target.plan,
    toolCalling: target.toolCalling ?? 'native',
    billing: target.billing ?? profile.targetDefaults.billing,
    capabilities: {
      ...core,
      ...(imageInput === undefined && imageTokens === undefined ? {} : imageCapability(imageInput ?? false, imageTokens, `${where}: `)),
    },
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? 30000,
  };
};

const checkThinkingBudgets = (target: AnthropicTarget, where: string): void => {
  const { reasoning, maxOutputTokens } = target.capabilities;
  if (reasoning?.control !== 'thinking' || reasoning.form !== 'budget') return;
  for (const [effort, budget] of Object.entries(reasoning.budgets)) {
    if (budget >= maxOutputTokens) {
      throw new Error(`${where}: capabilities.reasoning.budgets.${effort} is ${budget}, which must be below capabilities.maxOutputTokens (${maxOutputTokens})`);
    }
  }
};

const checkSamplingVersion = (target: AnthropicTarget, apiVersion: AnthropicApiVersion, where: string): void => {
  const { sampling } = target.capabilities;
  if (sampling === undefined || sampling.accepts === 'none') return;
  if (anthropicVersionSamplingBound(apiVersion).length === 0) {
    throw new Error(`${where}: capabilities.sampling declares accepts ${sampling.accepts}, but apiVersion ${apiVersion} accepts no sampling parameter; declare accepts none or set apiVersion to a version that accepts them`);
  }
};

const resolveAnthropic = (target: AnthropicTarget, home: string, where: string, warnings: string[]): ResolvedAnthropicTarget => {
  checkThinkingBudgets(target, where);
  const apiVersion = target.apiVersion ?? DEFAULT_ANTHROPIC_API_VERSION;
  checkSamplingVersion(target, apiVersion, where);
  if (target.capabilities.reasoning === undefined) {
    warnings.push(`${where}: capabilities.reasoning is not declared, so no thinking form is known and the target is sent no thinking request; declare { control: "thinking", form: "adaptive" | "budget" } to enable it`);
  }
  return {
    adapter: 'anthropic',
    model: target.model,
    toolCalling: 'native',
    apiVersion,
    ...resolveRemote(target, ANTHROPIC_CAPABILITY_DEFAULTS, home, where),
  };
};

const resolveOllama = (target: OllamaTarget, home: string, where: string): ResolvedOllamaTarget => ({
  adapter: 'ollama',
  model: target.model,
  ...resolveRemote(target, OLLAMA_CAPABILITY_DEFAULTS, home, where, LOCAL_SERVER_DEFAULTS),
});

const resolveTarget = (target: ModelTarget, home: string, where: string, warnings: string[]): ResolvedModelTarget => ({
  ...resolveAdapter(target, home, where, warnings),
  ...(target.answers === undefined ? {} : { answers: target.answers }),
});

const resolveAdapter = (target: ModelTarget, home: string, where: string, warnings: string[]): ResolvedModelTarget => {
  switch (target.adapter) {
    case 'fm':
      return resolveFm(target);
    case 'chat-completions':
      return resolveChatCompletions(target, home, where);
    case 'open-responses':
      return 'plan' in target ? resolvePlan(target, where) : resolveOpenResponses(target, home, where);
    case 'anthropic':
      return resolveAnthropic(target, home, where, warnings);
    case 'ollama':
      return resolveOllama(target, home, where);
  }
};

const membersOf = (alias: ModelAlias): string[] => [alias].flat();

const billingOf = (target: ResolvedModelTarget): TargetBilling => target.billing;

const checkUnboundedAliases = (aliases: Record<string, ModelAlias>, targets: Record<string, ResolvedModelTarget>, source: string): void => {
  for (const [name, alias] of Object.entries(aliases)) {
    const members = membersOf(alias).map((member) => targets[member] as ResolvedModelTarget);
    const unbounded = members.some((member) => member.adapter !== 'fm' && member.capabilities.outputBoundField === 'none');
    if (!unbounded) continue;
    const windows: number[] = [];
    const outputs: number[] = [];
    for (const member of members) {
      const capabilities = member.adapter === 'fm' ? undefined : member.capabilities;
      if (capabilities?.contextWindow === undefined || capabilities.maxOutputTokens === undefined) break;
      windows.push(capabilities.contextWindow);
      outputs.push(capabilities.maxOutputTokens);
    }
    if (windows.length !== members.length) continue;
    const minWindow = Math.min(...windows);
    const unboundedOutputTokens = Math.max(...outputs);
    const margin = marginFloorFor(minWindow);
    const required = ceilRatio(OUTPUT_RESERVE, minWindow);
    const room = minWindow - unboundedOutputTokens - margin;
    if (room < required) {
      throw new Error(
        `${source}: models.aliases.${name} holds a target that carries no output bound (outputBoundField none), so any member can emit up to ${unboundedOutputTokens} tokens; with the smallest context window ${minWindow} and a margin of ${margin}, ${room} tokens are left for input, which is below the ${required} (a quarter of the window) that input needs`,
      );
    }
  }
};

const checkBillingChanges = (changes: readonly BillingChange[], aliases: Record<string, ModelAlias>, source: string): void => {
  changes.forEach((change, index) => {
    const where = `${source}: models.billingChanges[${index}]`;
    if (change.from === change.to) throw new Error(`${where}: from and to are both ${JSON.stringify(change.from)}; a change of billing kind needs two different kinds`);
    if (change.alias !== undefined && !Object.hasOwn(aliases, change.alias)) {
      throw new Error(`${where}: alias ${JSON.stringify(change.alias)} is not defined in models.aliases`);
    }
  });
};

const warnUnallowedBillingChanges = (
  changes: readonly BillingChange[],
  aliases: Record<string, ModelAlias>,
  targets: Record<string, ResolvedModelTarget>,
  source: string,
  warnings: string[],
): void => {
  for (const [name, alias] of Object.entries(aliases)) {
    const members = membersOf(alias);
    for (let index = 0; index + 1 < members.length; index += 1) {
      const current = members[index] as string;
      const next = members[index + 1] as string;
      const from = billingOf(targets[current] as ResolvedModelTarget);
      const to = billingOf(targets[next] as ResolvedModelTarget);
      if (from === to) continue;
      if (changes.some((change) => change.from === from && change.to === to && (change.alias === undefined || change.alias === name))) continue;
      warnings.push(
        `${source}: models.aliases.${name}: target ${JSON.stringify(current)} (${from}) is followed by ${JSON.stringify(next)} (${to}), and models.billingChanges allows no change from ${from} to ${to} for this alias, so a request never falls from one to the other; add { "from": "${from}", "to": "${to}" } to models.billingChanges to allow it`,
      );
    }
  }
};

export const resolveModels = (models: ModelsSettings | undefined, { source, home, warnings }: ResolveModelsOptions): ResolvedModels => {
  const dialects = resolveDialects(models?.dialects, source);
  const configured = Object.entries(models?.targets ?? {});
  const targets: Record<string, ResolvedModelTarget> = {};
  for (const [name, target] of configured) {
    const where = `${source}: models.targets.${name}`;
    targets[name] = resolveTarget(target, home, where, warnings);
  }
  checkTargetDialects(targets, dialects, source);
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
  const billingChanges = [...(models?.billingChanges ?? [])];
  checkBillingChanges(billingChanges, aliases, source);
  checkUnboundedAliases(aliases, targets, source);
  warnUnallowedBillingChanges(billingChanges, aliases, targets, source, warnings);
  return { aliases, targets, dialects, roles, billingChanges };
};

type ResolvedTargets = { models: { targets: Record<string, ResolvedModelTarget> } };

export const credentialEnvNames = (settings: ResolvedTargets): string[] => {
  const names = new Set<string>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter !== 'fm' && target.adapter !== 'ollama' && target.apiKeyEnv !== undefined) names.add(target.apiKeyEnv);
  }
  return [...names].sort();
};

export const secretNames = (settings: ResolvedTargets): string[] => {
  const names = new Set<string>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter !== 'fm' && target.adapter !== 'ollama' && target.apiKeySecret !== undefined) names.add(target.apiKeySecret);
  }
  return [...names].sort();
};

export const planAccountNames = (settings: ResolvedTargets): PlanReference[] => {
  const seen = new Map<string, PlanReference>();
  for (const target of Object.values(settings.models.targets)) {
    if (target.adapter === 'fm' || !('plan' in target) || target.plan.account === undefined) continue;
    seen.set(JSON.stringify([target.plan.profile, target.plan.account]), target.plan);
  }
  return [...seen.values()].sort((a, b) => a.profile.localeCompare(b.profile) || (a.account as string).localeCompare(b.account as string));
};
