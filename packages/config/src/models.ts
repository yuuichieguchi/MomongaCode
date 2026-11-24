import path from 'node:path';
import { INHERITED_CLASSIFIER } from './settings-schema.ts';
import { askedPaths, endpointHostOf, redactedUrl, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';
import type { PathAsking } from '@momonga/foundation';
import {
  DEFAULT_ANTHROPIC_API_VERSION,
  MIN_OUTPUT_RESERVE,
  SERVER_KINDS,
  acceptedReasoningEfforts,
  anthropicVersionSamplingBound,
  canDoJob,
  canonOf,
  displayMapOf,
  imageCapability,
  modelJobRefusal,
  modelsForJob,
  resolveTypedModelRef,
  serverCountText,
  typedModelText,
  withDefaultTag,
} from '@momonga/protocol';
import { modelNamingOf } from './model-naming.ts';
import type { AnthropicApiVersion, ModelJob, ModelNaming, ModelOutputKind, DialectDefinition, ImageCapability, ImageTokenModel, ModelView, ModelViews, ReasoningCapability, ReasoningEffort, ServerKinds, TargetBilling } from '@momonga/protocol';
import { ConfigError, toConfigError } from './config-error.ts';
import { chainRoomVerdict, roomNumbersText } from './chain-room.ts';
import type { ChainMember } from './chain-room.ts';
import { checkModelDialects, resolveDialects } from './dialects.ts';
import { layoutOf } from './layout.ts';
import { FIVE_MINUTES_MS } from './setting-defaults.ts';
import { PLAN_PROFILES } from './plan-profiles.ts';
import { ADAPTERS } from './adapters.ts';
import type { AdapterKind, WireFacts } from './adapters.ts';
import { addressProblem, withDefaultAddress } from './probe-record-key.ts';
import type { PlanProfile } from './plan-profiles.ts';
import { PROVIDER_NAME_RULE_TEXT, derivedNameProblem, isProviderName, providerNameOf, reservedNameProblem, serverKindOf } from './provider-name.ts';
import { registeredIds, registeredServer, requireOfferedEndpointForm } from './server-registry.ts';
import type { ServerRegistry } from './server-registry.ts';
import type {
  AnthropicTarget,
  BillingChange,
  ChatCompletionsTarget,
  ManagedTarget,
  ModelConnection,
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
  ResolvedManagedTarget,
  ResolvedModelTarget,
  ResolvedOllamaTarget,
  ResolvedOpenResponsesTarget,
  ResolvedPlanTarget,
  ResolvedSystemOneTarget,
  SystemOneTarget,
  DeclaredTargetCapabilities,
  PlanTargetCapabilities,
  TargetCapabilities,
  TargetCapabilitiesCore,
} from './settings.ts';

export type ResolvedModel = ResolvedModelTarget & { canon: string; provider: string; providerWritten: boolean; ownName: string; defaultTag?: string; naming: ModelNaming; outputKind: ModelOutputKind };

export type ResolvedConnection = {
  provider: string;
  adapter: ModelConnection['adapter'];
  defaultTag?: string;
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  plan?: PlanReference;
  server?: string;
  binary?: string;
};

export type ResolvedModels = {
  connections: readonly ResolvedConnection[];
  models: ReadonlyMap<string, ResolvedModel>;
  views: ModelViews;
  chains: ReadonlyMap<string, readonly string[]>;
  start: string | undefined;
  effort?: ReasoningEffort;
  efforts: ReadonlyMap<string, ReasoningEffort>;
  fallback: readonly string[];
  roles: ModelRoles;
  classifier?: string;
  memoryReviewModel?: string;
  billingChanges: readonly BillingChange[];
  dialects: Record<string, DialectDefinition>;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  servers: ServerRegistry;
  plainHttp: readonly string[];
};

export const plainHttpWarningText = (server: string): string => `The address of ${server} is plain http to another computer: what you send to it is not encrypted.`;

export type PlanProfiles = Readonly<Record<string, PlanProfile>>;

export type ResolveModelsOptions = {
  source: string;
  warnings: string[];
  servers: ServerRegistry;
  planProfiles?: PlanProfiles;
  classifier?: string | undefined;
  memoryReviewModel?: string | undefined;
  kinds?: ServerKinds;
};

type Where = { connection: string; entry: string };

const declaredImageCapability = (imageInput: boolean | undefined, imageTokens: ImageTokenModel | undefined, where: string): ImageCapability | Record<never, never> => {
  if (imageInput === undefined && imageTokens === undefined) return {};
  try {
    return imageCapability(imageInput ?? false, imageTokens, `${where}: `);
  } catch (error) {
    throw toConfigError(error);
  }
};

const LOCAL_SERVER_DEFAULTS = { billing: 'local', maxConcurrency: 1 } as const satisfies { billing: TargetBilling; maxConcurrency: number };

const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;

const unknownServerMessage = (where: string, id: string, servers: ServerRegistry): string =>
  `${where}: server ${JSON.stringify(id)} is not a managed server this build supports; supported: ${registeredIds(servers).join(', ')}`;

const resolveManaged = (target: ManagedTarget, { connection, entry }: Where, servers: ServerRegistry): ResolvedManagedTarget => {
  const description = registeredServer(servers, target.server);
  if (description === undefined) throw new ConfigError(unknownServerMessage(connection, target.server, servers));
  requireOfferedEndpointForm(description, endpointHostOf(), connection);
  for (const field of Object.keys(target.capabilities ?? {})) {
    if (!(description.declarable as readonly string[]).includes(field)) throw new ConfigError(`${entry}: capabilities.${field} is not a field the server ${JSON.stringify(description.id)} lets a model declare; declarable: ${description.declarable.join(', ')}`);
  }
  return {
    adapter: 'managed',
    server: target.server,
    binary: target.binary ?? description.binary.defaultPath,
    readyTimeoutMs: target.readyTimeoutMs ?? description.ready.limitMs,
    model: target.model,
    ...(target.outputBoundField === undefined ? {} : { outputBoundField: target.outputBoundField }),
    toolCalling: target.toolCalling ?? 'auto',
    ...(target.capabilities === undefined ? {} : { capabilities: target.capabilities }),
    billing: target.billing ?? LOCAL_SERVER_DEFAULTS.billing,
    maxConcurrency: target.maxConcurrency ?? LOCAL_SERVER_DEFAULTS.maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
  };
};

export const baseUrlProblem = (baseUrl: string, carriesCredential: boolean): string | undefined => {
  const problem = transportUrlProblem(baseUrl);
  if (problem === 'cleartext' && carriesCredential) return `baseUrl ${redactedUrl(baseUrl)} must use https: because this connection sends a credential (http: to another computer is only allowed for a connection without one)`;
  if (problem !== undefined && problem !== 'cleartext') return transportUrlMessage('baseUrl', baseUrl, problem);
  if (baseUrl.includes('?') || baseUrl.includes('#')) return 'baseUrl must not contain a query or fragment';
  return undefined;
};

const checkBaseUrl = (baseUrl: string, where: string, carriesCredential: boolean): void => {
  const problem = baseUrlProblem(baseUrl, carriesCredential);
  if (problem !== undefined) throw new ConfigError(`${where}: ${problem}`);
};

const checkSocketPath = (socketPath: string, where: string): void => {
  if (!path.isAbsolute(socketPath)) throw new ConfigError(`${where}: socketPath ${JSON.stringify(socketPath)} must be an absolute path`);
};

export type SocketAddresses = { readonly connections: readonly { readonly socketPath?: string | undefined }[] };

export function* refusingOwnSockets({ connections }: SocketAddresses, home: string, source: string): PathAsking<void> {
  const { run } = layoutOf(home);
  for (const [index, { socketPath }] of connections.entries()) {
    if (socketPath === undefined) continue;
    if (yield* askedPaths.comparableContains(yield* askedPaths.canonicalPath(run), yield* askedPaths.canonicalPath(socketPath))) {
      throw new ConfigError(`${source}: models.connections[${index}]: socketPath ${socketPath} must not be inside ${run}`);
    }
  }
}

type RemoteTargetInput<Declared extends PlanTargetCapabilities> = {
  baseUrl?: string;
  socketPath?: string;
  apiKeyEnv?: string;
  apiKeySecret?: string;
  billing?: TargetBilling;
  capabilities: Declared;
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
};

const UNMEASURED_REMOTE_CAPABILITIES: Required<Pick<WireFacts, 'structuredOutput' | 'streaming' | 'stopSequences' | 'tokenCounting' | 'usageReported' | 'source'>> = {
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
};

const capabilityBaseOf = (adapter: Exclude<AdapterKind, 'managed'>) => ({ ...UNMEASURED_REMOTE_CAPABILITIES, ...ADAPTERS[adapter].wire });

const DEFAULT_REMOTE_MAX_CONCURRENCY = 4;
const DEFAULT_REMOTE_BILLING: TargetBilling = 'metered';
const REMOTE_SERVING = { billing: DEFAULT_REMOTE_BILLING, maxConcurrency: DEFAULT_REMOTE_MAX_CONCURRENCY };

const servingDefaultsOf = (adapter: Exclude<AdapterKind, 'managed'>): { billing: TargetBilling; maxConcurrency: number } => (adapter === 'ollama' ? LOCAL_SERVER_DEFAULTS : REMOTE_SERVING);

export const resolvedBillingOf = (adapter: Exclude<AdapterKind, 'managed'>, billing: TargetBilling | undefined): TargetBilling => billing ?? servingDefaultsOf(adapter).billing;

const checkSamplingRange = (capabilities: Pick<TargetCapabilitiesCore, 'sampling'>, where: string): void => {
  const { sampling } = capabilities;
  if (sampling?.accepts !== 'without_thinking') return;
  const { min, max } = sampling.topP;
  if (min > max) {
    throw new ConfigError(`${where}: capabilities.sampling.topP.min (${min}) must not exceed capabilities.sampling.topP.max (${max})`);
  }
};

const resolveRemote = <Declared extends PlanTargetCapabilities>(
  target: RemoteTargetInput<Declared>,
  adapter: Exclude<AdapterKind, 'managed'>,
  { connection, entry: where }: Where,
) => {
  const serving = servingDefaultsOf(adapter);
  const { baseUrl, socketPath } = target;
  const problem = addressProblem(target);
  if (problem !== undefined) throw new ConfigError(`${connection}: ${problem}`);
  if (baseUrl !== undefined) checkBaseUrl(baseUrl, connection, target.apiKeyEnv !== undefined || target.apiKeySecret !== undefined);
  if (socketPath !== undefined) checkSocketPath(socketPath, connection);
  checkSamplingRange(target.capabilities, where);
  const maxConcurrency = target.maxConcurrency ?? serving.maxConcurrency;
  const { imageInput, imageTokens, ...core } = { ...capabilityBaseOf(adapter), ...target.capabilities, maxConcurrency };
  const capabilities = {
    ...core,
    ...declaredImageCapability(imageInput, imageTokens, where),
  };
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    ...(target.apiKeySecret === undefined ? {} : { apiKeySecret: target.apiKeySecret }),
    billing: resolvedBillingOf(adapter, target.billing),
    capabilities,
    writtenCapabilities: target.capabilities,
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
  };
};

const resolveChatCompletions = (target: ChatCompletionsTarget, provider: string, where: Where): ResolvedChatCompletionsTarget => ({
  adapter: 'chat-completions',
  model: target.model,
  toolCalling: target.toolCalling ?? 'native',
  provider,
  ...resolveRemote(target, 'chat-completions', where),
});

const resolveOpenResponses = (target: OpenResponsesTarget, provider: string, where: Where): ResolvedOpenResponsesTarget => ({
  adapter: 'open-responses',
  model: target.model,
  toolCalling: target.toolCalling ?? 'native',
  provider,
  ...resolveRemote(target, 'open-responses', where),
});

const resolvePlan = (target: PlanOpenResponsesTarget, provider: string, { connection: where, entry }: Where, profiles: PlanProfiles): ResolvedPlanTarget => {
  const { profile: profileId } = target.plan;
  const profile = Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined;
  if (profile === undefined) {
    const known = Object.keys(profiles).map((id) => JSON.stringify(id)).join(', ');
    throw new ConfigError(`${where}: unknown plan profile ${JSON.stringify(profileId)}; the known profiles are ${known === '' ? 'none' : known}`);
  }
  for (const key of ['apiKeyEnv', 'apiKeySecret'] as const) {
    if (target[key] !== undefined) throw new ConfigError(`${where}: plan cannot be combined with ${key}; a plan connection takes its credential from the signed-in account`);
  }
  if (target.socketPath !== undefined) {
    throw new ConfigError(
      `${where}: plan cannot be combined with socketPath${profile.oauth === undefined ? '' : `; a plan connection sends its bearer only to ${profile.oauth.resource}`}`,
    );
  }
  const baseUrl = target.baseUrl ?? profile.targetDefaults.baseUrl;
  checkBaseUrl(baseUrl, where, true);
  if (profile.oauth !== undefined) {
    const resourceOrigin = new URL(profile.oauth.resource).origin;
    const baseOrigin = new URL(baseUrl).origin;
    if (baseOrigin !== resourceOrigin) {
      throw new ConfigError(`${where}: baseUrl ${baseUrl} has origin ${baseOrigin}, but plan profile ${profile.id} sends its bearer only to origin ${resourceOrigin}`);
    }
  }
  const declared = target.capabilities ?? {};
  checkSamplingRange(declared, entry);
  const maxConcurrency = target.maxConcurrency ?? DEFAULT_REMOTE_MAX_CONCURRENCY;
  const { imageInput, imageTokens, ...core } = { ...capabilityBaseOf('open-responses'), ...profile.targetDefaults.capabilities, ...declared, maxConcurrency };
  return {
    adapter: 'open-responses',
    ...(target.answers === undefined ? {} : { answers: target.answers }),
    model: target.model,
    baseUrl,
    provider,
    plan: target.plan,
    toolCalling: target.toolCalling ?? 'native',
    billing: target.billing ?? profile.targetDefaults.billing,
    capabilities: {
      ...core,
      ...declaredImageCapability(imageInput, imageTokens, entry),
    },
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
  };
};

const checkThinkingBudgets = (target: AnthropicTarget, where: string): void => {
  const { reasoning, maxOutputTokens } = target.capabilities;
  if (reasoning?.control !== 'thinking' || reasoning.form !== 'budget') return;
  for (const [effort, budget] of Object.entries(reasoning.budgets)) {
    if (budget >= maxOutputTokens) {
      throw new ConfigError(`${where}: capabilities.reasoning.budgets.${effort} is ${budget}, which must be below capabilities.maxOutputTokens (${maxOutputTokens})`);
    }
  }
};

const checkSamplingVersion = (target: AnthropicTarget, apiVersion: AnthropicApiVersion, where: string): void => {
  const { sampling } = target.capabilities;
  if (sampling === undefined || sampling.accepts === 'none') return;
  if (anthropicVersionSamplingBound(apiVersion).length === 0) {
    throw new ConfigError(`${where}: capabilities.sampling declares accepts ${sampling.accepts}, but apiVersion ${apiVersion} accepts no sampling parameter; declare accepts none or set apiVersion to a version that accepts them`);
  }
};

const resolveAnthropic = (target: AnthropicTarget, place: Where, warnings: string[]): ResolvedAnthropicTarget => {
  const where = place.entry;
  checkThinkingBudgets(target, where);
  const apiVersion = target.apiVersion ?? DEFAULT_ANTHROPIC_API_VERSION;
  checkSamplingVersion(target, apiVersion, where);
  if (target.capabilities.reasoning === undefined) {
    warnings.push(`${where}: capabilities.reasoning is not declared, so no thinking form is known and the model is sent no thinking request; declare { control: "thinking", form: "adaptive" | "budget" } to enable it`);
  }
  return {
    adapter: 'anthropic',
    model: target.model,
    toolCalling: 'native',
    apiVersion,
    ...resolveRemote(target, 'anthropic', place),
  };
};

const resolveOllama = (target: OllamaTarget, where: Where): ResolvedOllamaTarget => ({
  adapter: 'ollama',
  model: target.model,
  ...resolveRemote({ ...target, capabilities: target.capabilities ?? {} }, 'ollama', where),
});

const resolveSystemOne = (target: SystemOneTarget, provider: string, { connection }: Where): ResolvedSystemOneTarget => {
  checkBaseUrl(target.baseUrl, connection, target.apiKeyEnv !== undefined || target.apiKeySecret !== undefined);
  const serving = servingDefaultsOf('system-one');
  const maxConcurrency = target.maxConcurrency ?? serving.maxConcurrency;
  const capabilities: TargetCapabilities & { maxConcurrency: number } = {
    ...capabilityBaseOf('system-one'),
    contextWindow: target.capabilities.contextWindow,
    maxOutputTokens: MIN_OUTPUT_RESERVE,
    imageInput: false,
    maxConcurrency,
  };
  return {
    adapter: 'system-one',
    model: target.model,
    baseUrl: target.baseUrl,
    ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    ...(target.apiKeySecret === undefined ? {} : { apiKeySecret: target.apiKeySecret }),
    provider,
    toolCalling: 'none',
    billing: resolvedBillingOf('system-one', target.billing),
    capabilities,
    writtenCapabilities: target.capabilities,
    maxConcurrency,
    admissionTimeoutMs: target.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
  };
};

const checkJsonMode = (target: ModelTarget, where: string): void => {
  const declared = target.capabilities;
  const jsonMode = declared !== undefined && 'jsonMode' in declared ? declared.jsonMode : undefined;
  if (jsonMode !== 'json_object' || ADAPTERS[target.adapter].jsonOnlyForm) return;
  throw new ConfigError(`${where}: capabilities.jsonMode is json_object, but the adapter ${target.adapter} has no JSON-only request form; declare jsonMode none or remove it`);
};

type ResolveContext = { warnings: string[]; servers: ServerRegistry; profiles: PlanProfiles };

const resolveAdapter = (target: ModelTarget, provider: string, where: Where, { warnings, servers, profiles }: ResolveContext): ResolvedModelTarget => {
  switch (target.adapter) {
    case 'managed':
      return resolveManaged(target, where, servers);
    case 'chat-completions':
      return resolveChatCompletions(target, provider, where);
    case 'open-responses':
      return 'plan' in target ? resolvePlan(target, provider, where, profiles) : resolveOpenResponses(target, provider, where);
    case 'anthropic':
      return resolveAnthropic(target, where, warnings);
    case 'ollama':
      return resolveOllama(target, where);
    case 'system-one':
      return resolveSystemOne(target, provider, where);
  }
};

const REQUEST_OWN_HEADERS: readonly string[] = ['accept', 'anthropic-version', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'transfer-encoding', 'user-agent', 'x-api-key'];

const idempotencyKeyHeaderOf = (target: ModelTarget, where: string): { idempotencyKeyHeader?: string } => {
  const idempotencyKeyHeader = 'idempotencyKeyHeader' in target ? target.idempotencyKeyHeader : undefined;
  if (idempotencyKeyHeader === undefined) return {};
  if (REQUEST_OWN_HEADERS.includes(idempotencyKeyHeader.toLowerCase())) {
    throw new ConfigError(`${where}: idempotencyKeyHeader ${JSON.stringify(idempotencyKeyHeader)} is a header the request already carries; write the header this server reads an idempotency key from`);
  }
  return { idempotencyKeyHeader };
};

const resolveTarget = (target: ModelTarget, provider: string, where: Where, context: ResolveContext): ResolvedModelTarget => ({
  ...resolveAdapter(target, provider, where, context),
  ...('answers' in target && target.answers !== undefined ? { answers: target.answers } : {}),
  ...idempotencyKeyHeaderOf(target, where.connection),
});

const declaredCapabilitiesOf = (target: ResolvedModelTarget): { contextWindow?: number | undefined; maxOutputTokens?: number | undefined } | undefined => target.capabilities;

export const outputBoundFieldOf = (target: ResolvedModelTarget): string | undefined =>
  target.adapter === 'managed' ? target.outputBoundField : 'outputBoundField' in target.capabilities ? target.capabilities.outputBoundField : undefined;

const NO_MODELS_TEXT = 'models must list at least one model; run momonga models add to add one';
const MANAGED_NO_MODEL_TEXT = 'a managed server needs its model listed; run momonga models add to read it from the server';
const MANAGED_ONE_MODEL_TEXT = 'a managed server serves one model; list one entry';

const checkEntryCount = (connection: ModelConnection, where: string): void => {
  const count = connection.models?.length ?? 0;
  if (ADAPTERS[connection.adapter].models === 'many') {
    if (count === 0) throw new ConfigError(`${where}: ${NO_MODELS_TEXT}`);
    return;
  }
  if (count === 0) throw new ConfigError(`${where}: ${MANAGED_NO_MODEL_TEXT}`);
  if (count > 1) throw new ConfigError(`${where}: ${MANAGED_ONE_MODEL_TEXT}`);
};

const flatTargetOf = (connection: ModelConnection, index: number, ownName: string): ModelTarget => {
  const { models, provider: _provider, ...shared } = connection;
  const { id: _id, effort: _effort, ...entry } = (models ?? [])[index] as { id: string; effort?: ReasoningEffort };
  return { ...shared, ...entry, model: ownName } as ModelTarget;
};

const savedEffortOf = (connection: ModelConnection, index: number): ReasoningEffort | undefined => ((connection.models ?? [])[index] as { effort?: ReasoningEffort } | undefined)?.effort;

const declaredReasoningOf = (target: ResolvedModelTarget): ReasoningCapability | undefined => ((target.capabilities ?? {}) as { reasoning?: ReasoningCapability }).reasoning;

const checkSavedEffort = (target: ResolvedModelTarget, effort: ReasoningEffort, where: string): void => {
  const declared = declaredReasoningOf(target);
  if (declared === undefined) return;
  const accepted = acceptedReasoningEfforts(declared);
  if (!accepted.includes(effort)) throw new ConfigError(`${where}: effort ${effort} is not a level capabilities.reasoning accepts; accepted: ${accepted.join(', ')}`);
};

const checkDuplicateIds = (connection: ModelConnection, ownNames: readonly string[], defaultTag: string | undefined, source: string, key: string): void => {
  const where = `${source}: ${key}`;
  const written = (connection.models ?? []).map((entry) => entry.id);
  ownNames.forEach((ownName, index) => {
    const earlier = ownNames.indexOf(ownName);
    if (earlier === index) return;
    const here = `${where}.models[${index}]`;
    const there = `${key}.models[${earlier}]`;
    if (written[index] === written[earlier]) throw new ConfigError(`${here}: the id ${JSON.stringify(written[index])} is already listed at ${there}`);
    throw new ConfigError(`${here}: ${JSON.stringify(written[index])} is the same model as ${JSON.stringify(written[earlier])} at ${there} (an id without a tag means the tag ${defaultTag})`);
  });
};

const checkProviderName = (connection: ModelConnection, where: string, kinds: ServerKinds): void => {
  const { provider } = connection;
  if (provider === undefined) {
    const problem = derivedNameProblem(connection, kinds);
    if (problem !== undefined) throw new ConfigError(`${where}: ${problem}`);
    return;
  }
  if (!isProviderName(provider)) throw new ConfigError(`${where}.provider: ${JSON.stringify(provider)} ${PROVIDER_NAME_RULE_TEXT}`);
  const reserved = reservedNameProblem(provider, connection.adapter, kinds);
  if (reserved !== undefined) throw new ConfigError(`${where}.provider: ${reserved}`);
};

const checkDistinctProviders = (providers: readonly string[], source: string): void => {
  providers.forEach((provider, index) => {
    const earlier = providers.indexOf(provider);
    if (earlier === index) return;
    throw new ConfigError(`${source}: models.connections[${earlier}] and models.connections[${index}] both resolve to the server name ${JSON.stringify(provider)}; write "provider" on one of them`);
  });
};

const resolvedConnectionOf = (connection: ModelConnection, provider: string, defaultTag: string | undefined, first: ResolvedModelTarget): ResolvedConnection => ({
  provider,
  adapter: connection.adapter,
  ...(defaultTag === undefined ? {} : { defaultTag }),
  ...('baseUrl' in first && first.baseUrl !== undefined ? { baseUrl: first.baseUrl } : {}),
  ...('socketPath' in first && first.socketPath !== undefined ? { socketPath: first.socketPath } : {}),
  ...('apiKeyEnv' in first && first.apiKeyEnv !== undefined ? { apiKeyEnv: first.apiKeyEnv } : {}),
  ...('apiKeySecret' in first && first.apiKeySecret !== undefined ? { apiKeySecret: first.apiKeySecret } : {}),
  ...('plan' in first ? { plan: first.plan } : {}),
  ...(first.adapter === 'managed' ? { server: first.server, binary: first.binary } : {}),
});

type Configured = { connections: ResolvedConnection[]; models: Map<string, ResolvedModel>; views: ModelView[]; efforts: Map<string, ReasoningEffort> };

const resolveConnections = (connections: readonly ModelConnection[], source: string, kinds: ServerKinds, context: ResolveContext): Configured => {
  const wheres = connections.map((_connection, index) => `${source}: models.connections[${index}]`);
  const tags = connections.map((connection) => serverKindOf(connection, kinds)?.defaultTag);
  const ownNames = connections.map((connection, index) => (connection.models ?? []).map((entry) => withDefaultTag(entry.id, tags[index])));
  const targets = connections.map((connection, index) => {
    const where = wheres[index] as string;
    checkEntryCount(connection, where);
    return (ownNames[index] as string[]).map((ownName, entryIndex) => {
      const place = { connection: where, entry: `${where}.models[${entryIndex}]` };
      const flat = flatTargetOf(connection, entryIndex, ownName);
      checkJsonMode(flat, place.entry);
      return { flat, place };
    });
  });
  const premature = 'unnamed';
  targets.forEach((entries) => entries.forEach(({ flat, place }) => resolveTarget(flat, premature, place, { ...context, warnings: [] })));
  connections.forEach((connection, index) => checkDuplicateIds(connection, ownNames[index] as string[], tags[index], source, `models.connections[${index}]`));
  connections.forEach((connection, index) => checkProviderName(connection, wheres[index] as string, kinds));
  const providers = connections.map((connection) => providerNameOf(connection, kinds));
  checkDistinctProviders(providers, source);
  const configured: Configured = { connections: [], models: new Map(), views: [], efforts: new Map() };
  targets.forEach((entries, index) => {
    const provider = providers[index] as string;
    const defaultTag = tags[index];
    const resolved = entries.map(({ flat, place }) => resolveTarget(flat, provider, place, context));
    configured.connections.push(resolvedConnectionOf(connections[index] as ModelConnection, provider, defaultTag, resolved[0] as ResolvedModelTarget));
    resolved.forEach((target, entryIndex) => {
      const outputKind = ADAPTERS[target.adapter].outputKind;
      const view: ModelView = {
        canon: canonOf(provider, target.model),
        provider,
        ownName: target.model,
        ...(defaultTag === undefined ? {} : { defaultTag }),
        naming: modelNamingOf(target),
        ...(outputKind === 'text' ? {} : { outputKind }),
      };
      const saved = savedEffortOf(connections[index] as ModelConnection, entryIndex);
      if (saved !== undefined) {
        checkSavedEffort(target, saved, (entries[entryIndex] as { place: { entry: string } }).place.entry);
        configured.efforts.set(view.canon, saved);
      }
      configured.views.push(view);
      configured.models.set(view.canon, { ...target, ...view, outputKind, providerWritten: (connections[index] as ModelConnection).provider !== undefined });
    });
  });
  return configured;
};

const referenceProblem = (text: string, views: ModelViews, displays: ReadonlyMap<string, string>): { canon: string } | { problem: string } => {
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return { canon: resolution.model.canon };
  const quoted = JSON.stringify(text);
  if (resolution.kind === 'ambiguous') {
    const choices = resolution.choices.map((choice) => displays.get(choice.canon) ?? choice.canon);
    return { problem: `${quoted} is served by ${serverCountText(choices.length)} servers: ${choices.join(', ')}; write one of them` };
  }
  const configured = views.map((view) => displays.get(view.canon) ?? view.canon);
  return { problem: configured.length === 0 ? `${quoted} is not a configured model; no model is configured` : `${quoted} is not a configured model; configured models: ${configured.join(', ')}` };
};

type References = { start: string | undefined; fallback: string[]; roles: ModelRoles; billingChanges: BillingChange[]; classifier: string | undefined; memoryReviewModel: string | undefined };

const resolveReferences = (models: ModelsSettings | undefined, { classifier, memoryReviewModel }: Pick<ResolveModelsOptions, 'classifier' | 'memoryReviewModel'>, views: ModelViews, displays: ReadonlyMap<string, string>, source: string): References => {
  const byCanon = new Map(views.map((view) => [view.canon, view]));
  const canonAt = (key: string, text: string, job: ModelJob): string => {
    const outcome = referenceProblem(text, views, displays);
    if ('problem' in outcome) throw new ConfigError(`${source}: ${key}: ${outcome.problem}`);
    const view = byCanon.get(outcome.canon);
    if (view !== undefined && !canDoJob(view, job)) {
      throw new ConfigError(`${source}: ${key}: ${modelJobRefusal(displays.get(view.canon) ?? view.canon, job)}`);
    }
    return outcome.canon;
  };
  const start = models?.start === undefined ? undefined : canonAt('models.start', models.start, 'start');
  const fallback = (models?.fallback ?? []).map((text, index) => canonAt(`models.fallback[${index}]`, text, 'fallback'));
  const roles: ModelRoles = {};
  for (const [role, text] of Object.entries(models?.roles ?? {})) roles[role as ModelRole] = canonAt(`models.roles.${role}`, text, role as ModelRole);
  const billingChanges = (models?.billingChanges ?? []).map((change, index) =>
    change.model === undefined ? { from: change.from, to: change.to } : { from: change.from, to: change.to, model: canonAt(`models.billingChanges[${index}].model`, change.model, 'billing') },
  );
  return {
    start,
    fallback,
    roles,
    billingChanges,
    classifier: classifier === undefined || classifier === INHERITED_CLASSIFIER ? undefined : canonAt('autoMode.classifier', classifier, 'classifier'),
    memoryReviewModel: memoryReviewModel === undefined ? undefined : canonAt('memory.autoReviewModel', memoryReviewModel, 'memoryReview'),
  };
};

const checkBillingChanges = (changes: readonly BillingChange[], source: string): void => {
  changes.forEach((change, index) => {
    if (change.from === change.to) throw new ConfigError(`${source}: models.billingChanges[${index}]: from and to are both ${JSON.stringify(change.from)}; a change of billing kind needs two different kinds`);
  });
};

export const chainOf = (model: string, fallback: readonly string[]): string[] => [...new Set([model, ...fallback])];

const loadTimeMemberOf = (model: ResolvedModel): ChainMember => {
  const capabilities = declaredCapabilitiesOf(model);
  return {
    model: model.canon,
    facts: { outputBounded: outputBoundFieldOf(model) !== 'none', contextWindow: capabilities?.contextWindow, maxOutputTokens: capabilities?.maxOutputTokens },
    measuring: false,
  };
};

const declaresNumbers = (member: ChainMember): boolean => member.facts.contextWindow !== undefined && member.facts.maxOutputTokens !== undefined;

type Loaded = { models: ReadonlyMap<string, ResolvedModel>; chains: ReadonlyMap<string, readonly string[]>; displays: ReadonlyMap<string, string> };

const warnUnsafeChains = ({ models, chains, displays }: Loaded, source: string, warnings: string[]): void => {
  for (const [first, chain] of chains) {
    const members = chain.map((canon) => loadTimeMemberOf(models.get(canon) as ResolvedModel));
    if (!members.every(declaresNumbers)) continue;
    const verdict = chainRoomVerdict(first, members);
    if (verdict.kind !== 'refuse' || verdict.refusal.kind !== 'small_room') continue;
    const display = displays.get(first) ?? first;
    warnings.push(`${source}: models.fallback: ${display} and the models it falls back to leave no room for the input (${roomNumbersText(verdict.refusal)}); requests to ${display} will be refused until a window is declared`);
  }
};

const warnUnallowedBillingChanges = (changes: readonly BillingChange[], { models, chains, displays }: Loaded, source: string, warnings: string[]): void => {
  const warned = new Set<string>();
  for (const [first, chain] of chains) {
    for (let index = 0; index + 1 < chain.length; index += 1) {
      const current = chain[index] as string;
      const next = chain[index + 1] as string;
      const from = (models.get(current) as ResolvedModel).billing;
      const to = (models.get(next) as ResolvedModel).billing;
      if (from === to) continue;
      if (changes.some((change) => change.from === from && change.to === to && (change.model === undefined || change.model === first))) continue;
      const pair = JSON.stringify([current, next]);
      if (warned.has(pair)) continue;
      warned.add(pair);
      warnings.push(
        `${source}: models.fallback: ${displays.get(current) ?? current} (${from}) is followed by ${displays.get(next) ?? next} (${to}), and models.billingChanges allows no change from ${from} to ${to}, so a request never falls from one to the other; add { "from": "${from}", "to": "${to}" } to models.billingChanges to allow it`,
      );
    }
  }
};

export const resolveModels = (models: ModelsSettings | undefined, { source, warnings, servers, planProfiles = PLAN_PROFILES, classifier, memoryReviewModel, kinds = SERVER_KINDS }: ResolveModelsOptions): ResolvedModels => {
  const dialects = resolveDialects(models?.dialects, source);
  const configured = resolveConnections((models?.connections ?? []).map(withDefaultAddress), source, kinds, { warnings, servers, profiles: planProfiles });
  const displays = displayMapOf(configured.views);
  const references = resolveReferences(models, { classifier, memoryReviewModel }, configured.views, displays, source);
  checkModelDialects(models?.connections ?? [], dialects, source);
  checkBillingChanges(references.billingChanges, source);
  const chains = new Map(configured.views.map((view) => [view.canon, canDoJob(view, 'fallback') ? chainOf(view.canon, references.fallback) : [view.canon]]));
  const loaded: Loaded = { models: configured.models, chains, displays };
  warnUnsafeChains(loaded, source, warnings);
  warnUnallowedBillingChanges(references.billingChanges, loaded, source, warnings);
  const plainHttp = configured.connections.filter((connection) => connection.baseUrl !== undefined && transportUrlProblem(connection.baseUrl) === 'cleartext').map((connection) => connection.provider);
  warnings.push(...plainHttp.map(plainHttpWarningText));
  return {
    connections: configured.connections,
    models: configured.models,
    views: configured.views,
    chains,
    start: references.start ?? modelsForJob(configured.views, 'start')[0]?.canon,
    ...(models?.effort === undefined ? {} : { effort: models.effort }),
    efforts: configured.efforts,
    fallback: references.fallback,
    roles: references.roles,
    ...(references.classifier === undefined ? {} : { classifier: references.classifier }),
    ...(references.memoryReviewModel === undefined ? {} : { memoryReviewModel: references.memoryReviewModel }),
    billingChanges: references.billingChanges,
    dialects,
    headersTimeoutMs: models?.headersTimeoutMs ?? FIVE_MINUTES_MS,
    idleTimeoutMs: models?.idleTimeoutMs ?? FIVE_MINUTES_MS,
    servers,
    plainHttp,
  };
};

const sortedNames = (names: Iterable<string | undefined>): string[] => [...new Set([...names].flatMap((name) => name ?? []))].sort();

export const credentialEnvNames = (resolved: Pick<ResolvedModels, 'connections'>): string[] => sortedNames(resolved.connections.map((connection) => connection.apiKeyEnv));

