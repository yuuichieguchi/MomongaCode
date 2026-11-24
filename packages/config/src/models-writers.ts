import path from 'node:path';
import { answeredLater, isRecord } from '@momonga/foundation';
import {
  PROVIDER_NAME_PATTERN,
  SERVER_ADAPTER_LABELS,
  SERVER_KINDS,
  canonOf,
  displayMapOf,
  modelRefErrorOf,
  resolveTypedModelRef,
  typedModelText,
  withDefaultTag,
} from '@momonga/protocol';
import { modelNamingOf } from './model-naming.ts';
import type { ModelView, ModelViews, ReasoningEffort, ServerKinds, TargetBilling } from '@momonga/protocol';
import { askerOf } from './asker.ts';
import type { Asker } from './asker.ts';
import { ConfigError } from './config-error.ts';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import { userModelsOf } from './layers.ts';
import { refusingOwnSockets } from './models.ts';
import type { PlanProfiles, ResolvedModels } from './models.ts';
import { endpointKeyOf } from './probe-record-key.ts';
import { providerNameOf, reservedNameProblem, serverKindOf } from './provider-name.ts';
import type { ProviderNameInput } from './provider-name.ts';
import { serverRegistryOf } from './server-registry.ts';
import { INHERITED_CLASSIFIER, MODEL_ROLES } from './settings-schema.ts';
import { assertSettings } from './settings.ts';
import type { ConnectionDraft, ModelEntry, ModelRole } from './settings.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export type ModelsOperation =
  | { kind: 'addModel'; choice: { connection: ConnectionDraft; model: ModelEntry } }
  | { kind: 'removeModel'; model: string }
  | { kind: 'removeConnection'; provider: string; forgetServer?: boolean }
  | { kind: 'setStart'; model: string | null }
  | { kind: 'setFallback'; models: readonly string[] }
  | { kind: 'allowBillingChange'; from: TargetBilling; to: TargetBilling; model?: string }
  | { kind: 'forbidBillingChange'; from: TargetBilling; to: TargetBilling; model?: string }
  | { kind: 'setRole'; job: ModelRole; model: string | null }
  | { kind: 'setClassifier'; model: string | null }
  | { kind: 'setMemoryReviewModel'; model: string }
  | { kind: 'setModelField'; model: string; path: readonly string[]; value: unknown }
  | { kind: 'setConnectionField'; provider: string; path: readonly string[]; value: unknown }
  | { kind: 'setProvider'; provider: string; name: string | null }
  | { kind: 'declareServer'; id: string; command: string; args: readonly string[]; readyPath: string }
  | { kind: 'setServerField'; id: string; field: 'command' | 'args' | 'readyPath' | 'modelFile'; value: unknown }
  | { kind: 'forgetServer'; id: string }
  | { kind: 'setTimeouts'; headersTimeoutMs?: number; idleTimeoutMs?: number }
  | { kind: 'setEffort'; effort: ReasoningEffort | undefined }
  | { kind: 'setDialects'; dialects: object };

export type ModelsOperations = readonly [ModelsOperation, ...ModelsOperation[]];

export type ModelsEditRefusalCode = 'would_not_load' | 'unresolved' | 'name_taken' | 'reserved_name' | 'duplicate' | 'in_use' | 'invalid_value';

export type ModelsEditRefusal = { code: ModelsEditRefusalCode; message: string };

export type ModelsReference = { kind: 'start' | 'fallback' | 'role' | 'classifier' | 'memoryReview' | 'billing'; position?: number; job?: string };

export type ModelsEditPlan = { document: Record<string, unknown>; references: ModelsReference[]; warnings: string[]; summaries: string[]; model?: string } | { refused: ModelsEditRefusal };

export type ModelsEditResult = { wrote: boolean; summaries: string[]; model?: string };

export type ModelsEditPorts = { kinds: ServerKinds; planProfiles?: PlanProfiles };

export class ModelsEditRefused extends Error {
  readonly code: ModelsEditRefusalCode;

  constructor(code: ModelsEditRefusalCode, message: string) {
    super(message);
    this.name = 'ModelsEditRefused';
    this.code = code;
  }
}

const refuse = (code: ModelsEditRefusalCode, message: string): never => {
  throw new ModelsEditRefused(code, message);
};

const SOURCE = 'settings';
const SOURCE_PREFIX = `${SOURCE}: `;
const NOT_SAVED = 'Not saved: ';
const NAME_RULE_TEXT = 'Use lower-case letters, digits, . _ - and start with a lower-case letter.';

const sentenceOf = (message: string): string => (message.startsWith(SOURCE_PREFIX) ? message.slice(SOURCE_PREFIX.length) : message);

type Json = Record<string, unknown>;

type Place = { connection: number; entry: number };

type State = { document: Json; providers: readonly (string | undefined)[]; views: ModelViews; displays: ReadonlyMap<string, string>; grid: string[][]; places: ReadonlyMap<string, Place> };

type Loaded = { resolved: ResolvedModels; warnings: string[] };

const recordAt = (holder: Json, key: string): Json => {
  const value = holder[key];
  if (isRecord(value)) return value;
  const created: Json = {};
  holder[key] = created;
  return created;
};

const modelsIn = (document: Json): Json => recordAt(document, 'models');

const connectionsIn = (document: Json): Json[] => {
  const models = modelsIn(document);
  if (!Array.isArray(models['connections'])) models['connections'] = [];
  return models['connections'] as Json[];
};

const entriesIn = (connection: Json): Json[] => {
  if (!Array.isArray(connection['models'])) connection['models'] = [];
  return connection['models'] as Json[];
};

const dropIfEmpty = (holder: Json, key: string): void => {
  const value = holder[key];
  if (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0) delete holder[key];
};

const loadedOf = (document: Json, ports: ModelsEditPorts): Loaded => {
  let settings;
  try {
    settings = assertSettings(document, SOURCE);
    serverRegistryOf(settings.models?.servers, SOURCE);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return refuse('invalid_value', sentenceOf(error.message));
  }
  const warnings: string[] = [];
  try {
    const resolved = userModelsOf(settings, { source: SOURCE, warnings, kinds: ports.kinds, ...(ports.planProfiles === undefined ? {} : { planProfiles: ports.planProfiles }) });
    return { resolved, warnings: warnings.map(sentenceOf) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return refuse('would_not_load', `${NOT_SAVED}${sentenceOf(error.message)}`);
  }
};

const writtenConnections = (document: Json): unknown[] => {
  const models = document['models'];
  const connections = isRecord(models) ? models['connections'] : undefined;
  return Array.isArray(connections) ? connections : [];
};

const writtenEntries = (connection: Json): unknown[] => (Array.isArray(connection['models']) ? connection['models'] : []);

const writtenText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const nameInputOf = (connection: Json): ProviderNameInput | undefined => {
  const adapter = writtenText(connection['adapter']);
  if (adapter === undefined) return undefined;
  const plan = connection['plan'];
  const profile = isRecord(plan) ? writtenText(plan['profile']) : undefined;
  return {
    adapter,
    provider: writtenText(connection['provider']),
    baseUrl: writtenText(connection['baseUrl']),
    socketPath: writtenText(connection['socketPath']),
    server: writtenText(connection['server']),
    plan: isRecord(plan) && profile !== undefined ? { profile, account: writtenText(plan['account']) } : undefined,
  };
};

const writtenNameOf = (connection: unknown, kinds: ServerKinds): string | undefined => {
  const input = isRecord(connection) ? nameInputOf(connection) : undefined;
  if (input === undefined) return undefined;
  try {
    return providerNameOf(input, kinds);
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
};

const tagOf = (connection: Json, kinds: ServerKinds): string | undefined => serverKindOf({ adapter: String(connection['adapter']) }, kinds)?.defaultTag;

const writtenViewsOf = (connection: unknown, provider: string | undefined, kinds: ServerKinds): ModelView[] => {
  if (provider === undefined || !isRecord(connection)) return [];
  const defaultTag = tagOf(connection, kinds);
  return writtenEntries(connection).map((entry) => {
    const ownName = withDefaultTag(String(isRecord(entry) ? entry['id'] : undefined), defaultTag);
    return { canon: canonOf(provider, ownName), provider, ownName, ...(defaultTag === undefined ? {} : { defaultTag }), naming: modelNamingOf(connection) };
  });
};

const readState = (document: Json, kinds: ServerKinds): State => {
  const connections = writtenConnections(document);
  const providers = connections.map((connection) => writtenNameOf(connection, kinds));
  const rows = connections.map((connection, index) => writtenViewsOf(connection, providers[index], kinds));
  const views = rows.flat();
  const grid = rows.map((row) => row.map((view) => view.canon));
  const places = new Map(grid.flatMap((canons, connection) => canons.map((canon, entry): [string, Place] => [canon, { connection, entry }])));
  return { document, providers, views, displays: displayMapOf(views), grid, places };
};

const displayIn = (state: State, canon: string): string => state.displays.get(canon) ?? canon;

const notConfigured = (state: State, canon: string): never => refuse('unresolved', modelRefErrorOf(canon, { kind: 'not_found' }, state.views, 'gateway').message);

const placeOf = (state: State, canon: string): Place => state.places.get(canon) ?? notConfigured(state, canon);

const requireConfigured = (state: State, canon: string): string => {
  placeOf(state, canon);
  return canon;
};

const namesOrNone = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));

const connectionIndexOf = (state: State, provider: string): number => {
  const index = state.providers.indexOf(provider);
  return index >= 0 ? index : refuse('unresolved', `The server "${provider}" is not configured. Configured servers: ${namesOrNone(state.providers.flatMap((name) => name ?? []))}.`);
};

const canonOfText = (state: State, text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const resolution = resolveTypedModelRef(typedModelText(text), state.views);
  return resolution.kind === 'found' ? resolution.model.canon : undefined;
};

type Moves = ReadonlyMap<string, string | null>;

const rewriteReferences = (document: Json, state: State, moves: Moves): ModelsReference[] => {
  const references: ModelsReference[] = [];
  const models = modelsIn(document);
  const movedTo = (text: unknown): string | null | undefined => {
    const canon = canonOfText(state, text);
    return canon === undefined ? undefined : moves.get(canon);
  };
  const rewrite = (holder: Json, key: string, reference: ModelsReference): boolean => {
    const target = movedTo(holder[key]);
    if (target === undefined) return false;
    references.push(reference);
    if (target === null) delete holder[key];
    else holder[key] = target;
    return target === null;
  };
  const rewriteList = (key: string, moved: (entry: unknown, index: number) => unknown[] | undefined): void => {
    const written = models[key];
    if (!Array.isArray(written)) return;
    const kept = (written as unknown[]).flatMap((entry, index) => moved(entry, index) ?? [entry]);
    models[key] = kept;
    if (kept.length < written.length) dropIfEmpty(models, key);
  };
  rewrite(models, 'start', { kind: 'start' });
  rewriteList('fallback', (text, index) => {
    const target = movedTo(text);
    if (target === undefined) return undefined;
    references.push({ kind: 'fallback', position: index + 1 });
    return target === null ? [] : [target];
  });
  const roles = models['roles'];
  if (isRecord(roles) && Object.keys(roles).filter((job) => rewrite(roles, job, { kind: 'role', job })).length > 0) dropIfEmpty(models, 'roles');
  const autoMode = document['autoMode'];
  if (isRecord(autoMode) && rewrite(autoMode, 'classifier', { kind: 'classifier' })) dropIfEmpty(document, 'autoMode');
  const memory = document['memory'];
  if (isRecord(memory) && rewrite(memory, 'autoReviewModel', { kind: 'memoryReview' })) dropIfEmpty(document, 'memory');
  rewriteList('billingChanges', (change) => {
    const target = isRecord(change) ? movedTo(change['model']) : undefined;
    if (target === undefined) return undefined;
    references.push({ kind: 'billing' });
    return target === null ? [] : [{ ...(change as Json), model: target }];
  });
  return references;
};

const rewriteMoved = (document: Json, state: State, kinds: ServerKinds): ModelsReference[] => {
  const after = readState(document, kinds).grid;
  const moves = new Map<string, string>();
  state.grid.forEach((canons, connection) =>
    canons.forEach((canon, entry) => {
      const moved = after[connection]?.[entry];
      if (moved !== undefined && moved !== canon) moves.set(canon, moved);
    }),
  );
  return rewriteReferences(document, state, moves);
};

type Applied = { references?: ModelsReference[]; model?: (after: State) => string; summary: (after: State, last: Loaded) => string };

const countText = (count: number): string => `${count} ${count === 1 ? 'model' : 'models'}`;

const endpointIdentityOf = (connection: Json): string => {
  if (typeof connection['socketPath'] === 'string') return endpointKeyOf({ kind: 'unix', socketPath: connection['socketPath'] });
  return typeof connection['baseUrl'] === 'string' ? endpointKeyOf({ kind: 'tcp', baseUrl: connection['baseUrl'] }) : '';
};

const planIdentityOf = (connection: Json): string | undefined => (isRecord(connection['plan']) ? JSON.stringify([connection['plan']['profile'], connection['plan']['account']]) : undefined);

const identityOf = (connection: Json): string => {
  const plan = planIdentityOf(connection);
  if (plan !== undefined) return JSON.stringify(['plan', connection['adapter'], plan]);
  if (connection['adapter'] === 'managed') return JSON.stringify(['managed', connection['server'], connection['binary']]);
  return JSON.stringify(['address', connection['adapter'], endpointIdentityOf(connection)]);
};

const withoutDerivableProvider = (draft: Json, kinds: ServerKinds): Json => {
  const { provider, ...unnamed } = draft;
  if (provider === undefined) return unnamed;
  try {
    return providerNameOf(unnamed as Parameters<typeof providerNameOf>[0], kinds) === provider ? unnamed : draft;
  } catch (error) {
    if (error instanceof ConfigError) return draft;
    throw error;
  }
};

const addModel = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'addModel' }>, ports: ModelsEditPorts): Applied => {
  const draft = structuredClone(operation.choice.connection) as Json;
  const connections = connectionsIn(document);
  const id = withDefaultTag(operation.choice.model.id, tagOf(draft, ports.kinds));
  const entry = { ...structuredClone(operation.choice.model), id } as Json;
  const found = connections.findIndex((connection) => identityOf(connection) === identityOf(draft));
  if (found < 0) {
    connections.push({ ...withoutDerivableProvider(draft, ports.kinds), models: [entry] });
    const place = { connection: connections.length - 1, entry: 0 };
    const canon = (after: State): string => after.grid[place.connection]?.[place.entry] as string;
    return { model: canon, summary: (after) => `Added ${displayIn(after, canon(after))}. It is used from the next request.` };
  }
  const connection = connections[found] as Json;
  const entries = entriesIn(connection);
  const tag = tagOf(connection, ports.kinds);
  const present = entries.findIndex((existing) => withDefaultTag(String(existing['id']), tag) === id);
  if (present >= 0) {
    const canon = (after: State): string => after.grid[found]?.[present] as string;
    return { model: canon, summary: (after) => `${displayIn(after, canon(after))} is already in your settings.` };
  }
  entries.push(entry);
  const canon = (after: State): string => after.grid[found]?.[entries.length - 1] as string;
  return { model: canon, summary: (after) => `Added ${displayIn(after, canon(after))}. It is used from the next request.` };
};

const removeModel = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'removeModel' }>): Applied => {
  const place = placeOf(state, operation.model);
  const references = rewriteReferences(document, state, new Map([[operation.model, null]]));
  const connections = connectionsIn(document);
  const entries = entriesIn(connections[place.connection] as Json);
  entries.splice(place.entry, 1);
  if (entries.length === 0) connections.splice(place.connection, 1);
  const display = displayIn(state, operation.model);
  return { references, summary: () => `Removed ${display}.` };
};

const removeConnection = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'removeConnection' }>): Applied => {
  const index = connectionIndexOf(state, operation.provider);
  const canons = state.grid[index] as string[];
  const references = rewriteReferences(document, state, new Map(canons.map((canon) => [canon, null])));
  const [removed] = connectionsIn(document).splice(index, 1);
  const models = modelsIn(document);
  if (operation.forgetServer === true && isRecord(models['servers']) && typeof removed?.['server'] === 'string') {
    delete models['servers'][removed['server']];
    dropIfEmpty(models, 'servers');
  }
  return { references, summary: () => `Removed ${operation.provider} and its ${countText(canons.length)}.` };
};

const setStart = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setStart' }>): Applied => {
  const models = modelsIn(document);
  const { model } = operation;
  if (model === null) {
    delete models['start'];
    return { summary: () => 'New sessions start with the first model in your settings.' };
  }
  models['start'] = requireConfigured(state, model);
  return { summary: (after) => `New sessions start with ${displayIn(after, model)}.` };
};

const setFallback = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setFallback' }>): Applied => {
  const order = [...new Set(operation.models.map((model) => requireConfigured(state, model)))];
  const models = modelsIn(document);
  if (order.length === 0) {
    delete models['fallback'];
    return { summary: () => 'Fallback order cleared.' };
  }
  models['fallback'] = order;
  return { summary: (after) => `Fallback order saved: ${order.map((model) => displayIn(after, model)).join(' → ')}` };
};

type BillingOperation = Extract<ModelsOperation, { kind: 'allowBillingChange' | 'forbidBillingChange' }>;

const sameBillingChange = (state: State, operation: BillingOperation) => (change: Json): boolean =>
  change['from'] === operation.from && change['to'] === operation.to && canonOfText(state, change['model']) === operation.model;

const billingChangesIn = (document: Json): Json[] => {
  const models = modelsIn(document);
  if (!Array.isArray(models['billingChanges'])) models['billingChanges'] = [];
  return models['billingChanges'] as Json[];
};

const allowBillingChange = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'allowBillingChange' }>): Applied => {
  const { from, to, model } = operation;
  if (model !== undefined) requireConfigured(state, model);
  const scope = model === undefined ? '' : ` for ${displayIn(state, model)}`;
  const changes = billingChangesIn(document);
  if (changes.some(sameBillingChange(state, operation))) refuse('duplicate', `Requests may already fall from ${from} to ${to}${scope}; nothing changed.`);
  changes.push(model === undefined ? { from, to } : { from, to, model });
  return { summary: () => `Requests may now fall from ${from} to ${to}${scope}.` };
};

const forbidBillingChange = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'forbidBillingChange' }>): Applied => {
  const { from, to, model } = operation;
  if (model !== undefined) requireConfigured(state, model);
  const scope = model === undefined ? '' : ` for ${displayIn(state, model)}`;
  const models = document['models'];
  const same = sameBillingChange(state, operation);
  const written = isRecord(models) ? models['billingChanges'] : undefined;
  if (!isRecord(models) || !Array.isArray(written) || !(written as Json[]).some(same)) {
    return { summary: () => `Requests were not allowed to fall from ${from} to ${to}${scope}; nothing changed.` };
  }
  models['billingChanges'] = (written as Json[]).filter((change) => !same(change));
  dropIfEmpty(models, 'billingChanges');
  return { summary: () => `Requests may no longer fall from ${from} to ${to}${scope}.` };
};

const JOB_LABELS: Readonly<Record<ModelRole, string>> = { compaction: 'Summaries', reflection: 'Reflection', analysis: 'Analysis', subagent: 'Subagents' };

const SESSION_MODEL_TEXT = "the session's model";

const setRole = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setRole' }>): Applied => {
  const { job, model } = operation;
  if (!MODEL_ROLES.includes(job)) refuse('invalid_value', `"${String(job)}" is not a job a model can be chosen for; the jobs are ${MODEL_ROLES.join(', ')}.`);
  if (model === null) {
    const models = document['models'];
    const written = isRecord(models) ? models['roles'] : undefined;
    if (isRecord(models) && isRecord(written) && Object.hasOwn(written, job)) {
      delete written[job];
      dropIfEmpty(models, 'roles');
    }
    return { summary: () => `${JOB_LABELS[job]} now uses ${SESSION_MODEL_TEXT}.` };
  }
  recordAt(modelsIn(document), 'roles')[job] = requireConfigured(state, model);
  return { summary: (after) => `${JOB_LABELS[job]} now uses ${displayIn(after, model)}.` };
};

const setClassifier = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setClassifier' }>): Applied => {
  const { model } = operation;
  if (model === null) {
    const written = document['autoMode'];
    if (isRecord(written) && Object.hasOwn(written, 'classifier')) {
      delete written['classifier'];
      dropIfEmpty(document, 'autoMode');
    }
    return { summary: () => `The auto-mode classifier is now ${SESSION_MODEL_TEXT}.` };
  }
  if (model === INHERITED_CLASSIFIER) {
    recordAt(document, 'autoMode')['classifier'] = INHERITED_CLASSIFIER;
    return { summary: () => `The auto-mode classifier is now ${SESSION_MODEL_TEXT}.` };
  }
  recordAt(document, 'autoMode')['classifier'] = requireConfigured(state, model);
  return { summary: (after) => `The auto-mode classifier is now ${displayIn(after, model)}.` };
};

const setMemoryReviewModel = (document: Json, state: State, { model }: Extract<ModelsOperation, { kind: 'setMemoryReviewModel' }>): Applied => {
  recordAt(document, 'memory')['autoReviewModel'] = requireConfigured(state, model);
  return { summary: (after) => `The memory auto review model is now ${displayIn(after, model)}.` };
};

type FieldKind = 'toggle' | 'duration' | 'plain';

type FieldRow = { label: string; kind?: FieldKind; labels?: Readonly<Record<string, string>>; unset?: string };

const ADAPTER_LABELS: Readonly<Record<string, string>> = SERVER_ADAPTER_LABELS;

const CONNECTION_FIELDS: Readonly<Record<string, FieldRow>> = {
  adapter: { label: 'API', labels: ADAPTER_LABELS },
  baseUrl: { label: 'Address' },
  socketPath: { label: 'Socket' },
  apiKeyEnv: { label: 'Key' },
  apiKeySecret: { label: 'Key' },
  'plan.account': { label: 'Plan account', unset: 'Any account' },
  server: { label: 'Server program' },
  binary: { label: 'Program file' },
  readyTimeoutMs: { label: 'Start wait', kind: 'duration' },
  billing: { label: 'Billing' },
  apiVersion: { label: 'API version' },
  answers: { label: 'Who answers', labels: { model: 'A model', script: 'A script' } },
  idempotencyKeyHeader: { label: 'Idempotency key header' },
  maxConcurrency: { label: 'Concurrent requests' },
  admissionTimeoutMs: { label: 'Wait for a free slot', kind: 'duration' },
};

const ENTRY_FIELDS: Readonly<Record<string, FieldRow>> = {
  effort: { label: 'Reasoning effort' },
  toolCalling: { label: 'Tool calling' },
  outputBoundField: { label: 'Output limit field' },
  maxConcurrency: { label: 'Concurrent requests' },
  admissionTimeoutMs: { label: 'Wait for a free slot', kind: 'duration' },
  'capabilities.contextWindow': { label: 'Context window' },
  'capabilities.maxOutputTokens': { label: 'Output limit' },
  'capabilities.structuredOutput': { label: 'Structured output' },
  'capabilities.jsonMode': { label: 'JSON mode' },
  'capabilities.tokenCounting': { label: 'Token counting' },
  'capabilities.source': { label: 'Source of the numbers' },
  'capabilities.streaming': { label: 'Streaming', kind: 'toggle' },
  'capabilities.stopSequences': { label: 'Stop sequences', kind: 'toggle' },
  'capabilities.imageInput': { label: 'Image input', kind: 'toggle' },
  'capabilities.parallelToolCalls': { label: 'Parallel tool calls', kind: 'toggle' },
  'capabilities.usageReported': { label: 'Usage reported', kind: 'toggle' },
  'capabilities.imageTokens': { label: 'Image tokens' },
  'capabilities.imageTokens.pixelsPerToken': { label: 'Pixels per image token' },
  'capabilities.imageTokens.maxTokens': { label: 'Largest image' },
  'capabilities.imageTokens.minTokens': { label: 'Smallest image' },
  'capabilities.allowedTools': { label: 'Allowed tool forms' },
  'capabilities.schemaDialect': { label: 'Schema dialect' },
  'capabilities.tokenErrorRatio': { label: 'Token count error' },
  'capabilities.reasoning': { label: 'Reasoning' },
  'capabilities.promptCache': { label: 'Prompt cache' },
  'capabilities.sampling': { label: 'Sampling' },
  'capabilities.outputBoundField': { label: 'Output limit field' },
  'capabilities.systemRole': { label: 'System role' },
  'capabilities.toolPlacement': { label: 'Tool placement' },
  'capabilities.inputKinds': { label: 'Input kinds' },
};

const ENTRY_FIELD_PREFIX = 'models[].';

const TIMEOUT_FIELDS: Readonly<Record<string, FieldRow>> = {
  'models.headersTimeoutMs': { label: 'Wait for the first reply', kind: 'duration' },
  'models.idleTimeoutMs': { label: 'Wait without any data', kind: 'duration' },
};

const CONNECTION_FIELD_KEYS = ['adapter', 'baseUrl', 'socketPath', 'apiKeyEnv', 'apiKeySecret', 'plan.account', 'server', 'binary', 'readyTimeoutMs', 'billing', 'apiVersion', 'answers', 'idempotencyKeyHeader', 'maxConcurrency', 'admissionTimeoutMs'] as const;

const ENTRY_FIELD_KEYS = [
  'effort',
  'toolCalling',
  'outputBoundField',
  'maxConcurrency',
  'admissionTimeoutMs',
  'capabilities.contextWindow',
  'capabilities.maxOutputTokens',
  'capabilities.structuredOutput',
  'capabilities.jsonMode',
  'capabilities.streaming',
  'capabilities.stopSequences',
  'capabilities.imageInput',
  'capabilities.imageTokens.pixelsPerToken',
  'capabilities.imageTokens.maxTokens',
  'capabilities.imageTokens.minTokens',
  'capabilities.parallelToolCalls',
  'capabilities.allowedTools',
  'capabilities.schemaDialect',
  'capabilities.tokenCounting',
  'capabilities.tokenErrorRatio',
  'capabilities.usageReported',
  'capabilities.reasoning.*',
  'capabilities.promptCache.*',
  'capabilities.sampling.*',
  'capabilities.source',
  'capabilities.outputBoundField',
  'capabilities.systemRole',
  'capabilities.toolPlacement',
  'capabilities.inputKinds.*',
] as const;

const ENTRY_ID_FIELD = 'id';

const MODEL_FIELD_KEYS: readonly string[] = [ENTRY_ID_FIELD, ...ENTRY_FIELD_KEYS];

const FAMILY_MARK = '.*';

const FIELD_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

const fieldIsIn = (table: readonly string[], keyPath: readonly string[]): boolean => {
  if (keyPath.length === 0 || !keyPath.every((segment) => FIELD_SEGMENT_PATTERN.test(segment))) return false;
  const field = keyPath.join('.');
  return table.some((key) => {
    const family = key.endsWith(FAMILY_MARK);
    const name = family ? key.slice(0, -FAMILY_MARK.length) : key;
    return name === field || name.startsWith(`${field}.`) || (family && field.startsWith(`${name}.`));
  });
};

const FIELD_SUBJECTS = { model: MODEL_FIELD_KEYS, server: CONNECTION_FIELD_KEYS } as const;

export type FieldSubject = keyof typeof FIELD_SUBJECTS;

const tableFieldOf = (subject: FieldSubject, keyPath: readonly string[]): string => {
  const field = keyPath.join('.');
  if (fieldIsIn(FIELD_SUBJECTS[subject], keyPath)) return field;
  return refuse('invalid_value', `"${field}" is not a field of a ${subject} that can be set. The fields are: ${FIELD_SUBJECTS[subject].join(', ')}.`);
};

export const settableFieldPath = (subject: FieldSubject, field: string): string[] => {
  const keyPath = field.split('.');
  tableFieldOf(subject, keyPath);
  return keyPath;
};

const rowIn = (table: Readonly<Record<string, FieldRow>>, field: string): FieldRow | undefined => {
  const parts = field.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const key = parts.slice(0, length).join('.');
    if (Object.hasOwn(table, key)) return table[key];
  }
  return undefined;
};

const fieldRowOf = (field: string): FieldRow | undefined => {
  if (Object.hasOwn(TIMEOUT_FIELDS, field)) return TIMEOUT_FIELDS[field];
  return field.startsWith(ENTRY_FIELD_PREFIX) ? rowIn(ENTRY_FIELDS, field.slice(ENTRY_FIELD_PREFIX.length)) : rowIn(CONNECTION_FIELDS, field);
};

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

export const durationText = (milliseconds: number): string => {
  if (milliseconds % MINUTE_MS === 0) return `${milliseconds / MINUTE_MS} min`;
  return milliseconds % SECOND_MS === 0 ? `${milliseconds / SECOND_MS} s` : `${milliseconds} ms`;
};

export const fieldLabel = (field: string): string => fieldRowOf(field)?.label ?? field;

export const fieldValueText = (field: string, value: unknown): string => {
  const row = fieldRowOf(field);
  if (value === undefined) return row?.unset ?? (row?.kind === 'toggle' ? 'not declared' : 'not set');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return row?.kind === 'duration' ? durationText(value) : String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'string') return row?.labels !== undefined && Object.hasOwn(row.labels, value) ? (row.labels[value] as string) : value;
  return JSON.stringify(value);
};

const setAt = (holder: Json, keyPath: readonly string[], value: unknown): void => {
  const [key, ...rest] = keyPath;
  if (key === undefined) return refuse('invalid_value', 'A field needs a name.');
  if (rest.length > 0) {
    if (value !== undefined || isRecord(holder[key])) setAt(recordAt(holder, key), rest, value);
    return;
  }
  if (value === undefined) delete holder[key];
  else holder[key] = structuredClone(value);
};

const renameModel = (document: Json, state: State, model: string, value: unknown, kinds: ServerKinds): Applied => {
  if (typeof value !== 'string') return refuse('invalid_value', 'A model needs an id. To take the model out of your settings, remove it.');
  const place = placeOf(state, model);
  const connection = connectionsIn(document)[place.connection] as Json;
  (entriesIn(connection)[place.entry] as Json)[ENTRY_ID_FIELD] = withDefaultTag(value, tagOf(connection, kinds));
  const references = rewriteMoved(document, state, kinds);
  const before = displayIn(state, model);
  return { references, summary: (after) => `Renamed ${before} to ${displayIn(after, after.grid[place.connection]?.[place.entry] as string)}.` };
};

const setModelField = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setModelField' }>, ports: ModelsEditPorts): Applied => {
  const { model, value } = operation;
  const place = placeOf(state, model);
  const written = tableFieldOf('model', operation.path);
  if (written === ENTRY_ID_FIELD) return renameModel(document, state, model, value, ports.kinds);
  const entry = entriesIn(connectionsIn(document)[place.connection] as Json)[place.entry] as Json;
  setAt(entry, operation.path, value);
  const field = `${ENTRY_FIELD_PREFIX}${written}`;
  const canon = (after: State): string => after.grid[place.connection]?.[place.entry] as string;
  if (value === undefined) return { summary: (after) => `Cleared ${fieldLabel(field)} of ${displayIn(after, canon(after))}.` };
  return { summary: (after) => `Set ${fieldLabel(field)} of ${displayIn(after, canon(after))} to ${fieldValueText(field, value)}.` };
};

const EXCLUSIVE_FIELDS: Readonly<Record<string, string>> = { baseUrl: 'socketPath', socketPath: 'baseUrl', apiKeyEnv: 'apiKeySecret', apiKeySecret: 'apiKeyEnv' };

const reservedRefusal = (name: unknown, adapter: unknown, kinds: ServerKinds): void => {
  if (typeof name !== 'string' || typeof adapter !== 'string') return;
  const problem = reservedNameProblem(name, adapter, kinds);
  if (problem !== undefined) refuse('reserved_name', problem);
};

const setConnectionField = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setConnectionField' }>, ports: ModelsEditPorts): Applied => {
  const index = connectionIndexOf(state, operation.provider);
  const connection = connectionsIn(document)[index] as Json;
  const field = tableFieldOf('server', operation.path);
  const { value } = operation;
  if (field === 'adapter') reservedRefusal(connection['provider'], value, ports.kinds);
  setAt(connection, operation.path, value);
  if (value !== undefined && Object.hasOwn(EXCLUSIVE_FIELDS, field)) delete connection[EXCLUSIVE_FIELDS[field] as string];
  if (field === 'adapter') {
    const tag = tagOf(connection, ports.kinds);
    for (const entry of entriesIn(connection)) entry['id'] = withDefaultTag(String(entry['id']), tag);
  }
  const references = rewriteMoved(document, state, ports.kinds);
  const name = (after: State): string => after.providers[index] ?? operation.provider;
  if (value === undefined) return { references, summary: (after) => `Cleared ${fieldLabel(field)} of ${name(after)}.` };
  return { references, summary: (after) => `Set ${fieldLabel(field)} of ${name(after)} to ${fieldValueText(field, value)}.` };
};

const setProvider = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'setProvider' }>, ports: ModelsEditPorts): Applied => {
  const index = connectionIndexOf(state, operation.provider);
  const connection = connectionsIn(document)[index] as Json;
  const { name } = operation;
  if (name === null) {
    delete connection['provider'];
    const references = rewriteMoved(document, state, ports.kinds);
    return { references, summary: (after) => `${operation.provider} is now named ${after.providers[index] ?? operation.provider}.` };
  }
  if (!PROVIDER_NAME_PATTERN.test(name)) refuse('invalid_value', NAME_RULE_TEXT);
  if (state.providers.some((other, otherIndex) => otherIndex !== index && other === name)) refuse('name_taken', `${name} is already used by another server.`);
  reservedRefusal(name, connection['adapter'], ports.kinds);
  connection['provider'] = name;
  const references = rewriteMoved(document, state, ports.kinds);
  return { references, summary: () => `Renamed ${operation.provider} to ${name}.` };
};

const declaredServersIn = (document: Json): Json => recordAt(modelsIn(document), 'servers');

const declaredServerOf = (document: Json, id: string): Json => {
  const servers = modelsIn(document)['servers'];
  if (isRecord(servers) && Object.hasOwn(servers, id) && isRecord(servers[id])) return servers[id];
  return refuse('unresolved', `The server program "${id}" is not declared. Declared server programs: ${namesOrNone(Object.keys(isRecord(servers) ? servers : {}))}.`);
};

const declareServer = (document: Json, operation: Extract<ModelsOperation, { kind: 'declareServer' }>): Applied => {
  const { id, command, args, readyPath } = operation;
  const servers = declaredServersIn(document);
  if (Object.hasOwn(servers, id) || Object.hasOwn(serverRegistryOf(undefined, SOURCE), id)) refuse('name_taken', `${id} is already used by another server.`);
  servers[id] = { command, args: [...args], readyPath };
  return { summary: () => `Declared the server program ${id}.` };
};

const SERVER_FIELDS: readonly string[] = ['command', 'args', 'readyPath', 'modelFile'];

const setServerField = (document: Json, operation: Extract<ModelsOperation, { kind: 'setServerField' }>): Applied => {
  const { id, field, value } = operation;
  if (!SERVER_FIELDS.includes(field)) refuse('invalid_value', `"${String(field)}" is not a field of a server program; the fields are ${SERVER_FIELDS.join(', ')}.`);
  const server = declaredServerOf(document, id);
  if (field === 'modelFile' && value === '') delete server[field];
  else server[field] = structuredClone(value);
  return { summary: () => `Set ${field} of ${id}.` };
};

const forgetServer = (document: Json, state: State, operation: Extract<ModelsOperation, { kind: 'forgetServer' }>): Applied => {
  const { id } = operation;
  declaredServerOf(document, id);
  const user = writtenConnections(document).findIndex((connection) => isRecord(connection) && connection['server'] === id);
  if (user >= 0) refuse('in_use', `${id} is used by ${state.providers[user] ?? `models.connections[${user}]`}; remove that server first.`);
  const models = modelsIn(document);
  delete declaredServersIn(document)[id];
  dropIfEmpty(models, 'servers');
  return { summary: () => `Forgot the server program ${id}.` };
};

const setTimeouts = (document: Json, operation: Extract<ModelsOperation, { kind: 'setTimeouts' }>): Applied => {
  const models = modelsIn(document);
  if (operation.headersTimeoutMs !== undefined) models['headersTimeoutMs'] = operation.headersTimeoutMs;
  if (operation.idleTimeoutMs !== undefined) models['idleTimeoutMs'] = operation.idleTimeoutMs;
  return { summary: (_after, last) => `Waits saved: first reply ${durationText(last.resolved.headersTimeoutMs)}, no data ${durationText(last.resolved.idleTimeoutMs)}.` };
};

export const EVERY_MODEL_EFFORT_LABEL = 'Reasoning effort of a model with none saved';

const setEffort = (document: Json, operation: Extract<ModelsOperation, { kind: 'setEffort' }>): Applied => {
  const models = modelsIn(document);
  if (operation.effort === undefined) {
    delete models['effort'];
    return { summary: () => `Cleared ${EVERY_MODEL_EFFORT_LABEL}.` };
  }
  models['effort'] = operation.effort;
  return { summary: () => `Set ${EVERY_MODEL_EFFORT_LABEL} to ${operation.effort}.` };
};

const setDialects = (document: Json, operation: Extract<ModelsOperation, { kind: 'setDialects' }>): Applied => {
  modelsIn(document)['dialects'] = structuredClone(operation.dialects);
  return { summary: () => 'Schema dialects saved.' };
};

const apply = (document: Json, state: State, operation: ModelsOperation, ports: ModelsEditPorts): Applied => {
  switch (operation.kind) {
    case 'addModel':
      return addModel(document, state, operation, ports);
    case 'removeModel':
      return removeModel(document, state, operation);
    case 'removeConnection':
      return removeConnection(document, state, operation);
    case 'setStart':
      return setStart(document, state, operation);
    case 'setFallback':
      return setFallback(document, state, operation);
    case 'allowBillingChange':
      return allowBillingChange(document, state, operation);
    case 'forbidBillingChange':
      return forbidBillingChange(document, state, operation);
    case 'setRole':
      return setRole(document, state, operation);
    case 'setClassifier':
      return setClassifier(document, state, operation);
    case 'setMemoryReviewModel':
      return setMemoryReviewModel(document, state, operation);
    case 'setModelField':
      return setModelField(document, state, operation, ports);
    case 'setConnectionField':
      return setConnectionField(document, state, operation, ports);
    case 'setProvider':
      return setProvider(document, state, operation, ports);
    case 'declareServer':
      return declareServer(document, operation);
    case 'setServerField':
      return setServerField(document, operation);
    case 'forgetServer':
      return forgetServer(document, state, operation);
    case 'setTimeouts':
      return setTimeouts(document, operation);
    case 'setEffort':
      return setEffort(document, operation);
    case 'setDialects':
      return setDialects(document, operation);
  }
};

const planned = (given: unknown, operations: ModelsOperations, ports: ModelsEditPorts): Exclude<ModelsEditPlan, { refused: ModelsEditRefusal }> => {
  if (!isRecord(given)) return refuse('invalid_value', 'The settings must be a JSON object.');
  let state = readState(structuredClone(given), ports.kinds);
  const references: ModelsReference[] = [];
  const summaries: ((last: Loaded) => string)[] = [];
  const models: string[] = [];
  for (const operation of operations) {
    const document = structuredClone(state.document);
    const applied = apply(document, state, operation, ports);
    references.push(...(applied.references ?? []));
    const after = readState(document, ports.kinds);
    state = after;
    summaries.push((last) => applied.summary(after, last));
    if (applied.model !== undefined) models.push(applied.model(after));
  }
  const last = loadedOf(state.document, ports);
  const [model] = models;
  return { document: state.document, references, warnings: last.warnings, summaries: summaries.map((summary) => summary(last)), ...(model === undefined ? {} : { model }) };
};

export const planModelsEdit = (document: unknown, operations: ModelsOperations, ports: ModelsEditPorts): ModelsEditPlan => {
  try {
    return planned(document, operations, ports);
  } catch (error) {
    if (error instanceof ModelsEditRefused) return { refused: { code: error.code, message: error.message } };
    throw error;
  }
};

export type EditModelsSettingsOptions = { lock: KernelLockMechanism; signal: AbortSignal; planProfiles?: PlanProfiles };

const refuseOwnSockets = async (document: Json, home: string, { paths, signal }: Asker): Promise<void> => {
  const connections = writtenConnections(document).map((connection) => ({ socketPath: isRecord(connection) ? writtenText(connection['socketPath']) : undefined }));
  try {
    await answeredLater(refusingOwnSockets({ connections }, home, SOURCE), paths, signal);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ModelsEditRefused('would_not_load', `${NOT_SAVED}${sentenceOf(error.message)}`);
  }
};

export const editModelsSettings = async (home: string, settingsFile: string, operations: ModelsOperations, options: EditModelsSettingsOptions): Promise<ModelsEditResult> => {
  let result: ModelsEditResult | undefined;
  const asker = askerOf(options.signal);
  await editUserSettings(
    settingsFile,
    async (document) => {
      const plan = planModelsEdit(document, operations, { kinds: SERVER_KINDS, ...(options.planProfiles === undefined ? {} : { planProfiles: options.planProfiles }) });
      if ('refused' in plan) throw new ModelsEditRefused(plan.refused.code, plan.refused.message);
      await refuseOwnSockets(plan.document, home, asker);
      const wrote = JSON.stringify(plan.document) !== JSON.stringify(document);
      result = { wrote, summaries: plan.summaries, ...(plan.model === undefined ? {} : { model: plan.model }) };
      if (!wrote) return false;
      for (const key of Object.keys(document)) delete document[key];
      Object.assign(document, plan.document);
      return true;
    },
    settingsWriterPorts(home, { lock: options.lock, signal: options.signal }),
  );
  if (result === undefined) throw new TypeError(`${settingsFile}: the settings writer ended without a result`);
  return result;
};

export const serverNameFromCommand = (command: string, taken: ReadonlySet<string>, platform: NodeJS.Platform): string | undefined => {
  const file = platform === 'win32' ? path.win32.basename(command) : path.posix.basename(command);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const name = stem.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z]+/, '');
  if (name === '') return undefined;
  if (!taken.has(name)) return name;
  let suffix = 2;
  while (taken.has(`${name}-${suffix}`)) suffix += 1;
  return `${name}-${suffix}`;
};
