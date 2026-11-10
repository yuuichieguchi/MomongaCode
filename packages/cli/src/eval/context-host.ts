import path from 'node:path';
import {
  MANAGED_SERVERS,
  SERVER_KINDS,
  TARGET_PROBING_MESSAGE,
  displayMapOf,
  escapeTerminalLine,
  isProbingCapabilities,
  isUnavailableCapabilities,
  modelRefErrorOf,
  notListedMessage,
  resolveTypedModelRef,
  typedModelText,
} from '@momonga/protocol';
import type { Capabilities, ProbingCapabilities, UnavailableCapabilities } from '@momonga/protocol';
import { PLAN_PROFILES, planModelsEdit, probeRecordKeyOf, registeredServer } from '@momonga/config';
import type { ConnectionDraft, EndpointProbeKey, ModelEntry, ModelsOperation, ModelsOperations, ModelsSettings, OpenResponsesTarget, ResolvedModel, ResolvedModels, ResolvedPlanTarget, SandboxSetting, UserModels } from '@momonga/config';
import { caseSettingsFor, expandContextDataset, failedWithCleanup, liveBoundsFor, runContextDataset } from '@momonga/eval';
import type { ContextCaseHost, ContextDataset, ExpandedCase, PolicyOverlay, Transcript, WorkspaceStep } from '@momonga/eval';
import { FIRST_GENERATION, claimPathOf, fixedSocket, generationLayout, isRecord, momongaLayout, socketPathLimit } from '@momonga/foundation';
import type { KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { createGatewayClient } from '../client/gateway-client.ts';
import { goldenRunApi } from '../client/golden-run-api.ts';
import type { ReflectionSettle } from '../client/golden-run-api.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';

export class ContextHostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextHostError';
  }
}

export type ContextRuntime = Pick<
  RuntimeClient,
  'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'runReflection' | 'runAnsweredBy' | 'resolveApproval' | 'cancel' | 'addRule' | 'retireRule' | 'addMemory' | 'adoptGuideline' | 'setTrust' | 'close'
>;

export type ContextHostEffects = {
  lock: KernelLockMechanism;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  sessionEnv(root: string): Promise<Record<string, string>>;
  makeRoot(): Promise<string>;
  prepare(paths: MomongaPaths): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
  makeDirectory(directory: string): Promise<void>;
  canonical(directory: string): Promise<string>;
  startDaemon(root: string, paths: MomongaPaths, env: Readonly<Record<string, string>>): Promise<number>;
  daemonHolder(paths: MomongaPaths): Promise<number | undefined>;
  terminate(pid: number): Promise<void>;
  remove(directory: string): Promise<void>;
  connect(paths: MomongaPaths): ContextRuntime;
  applyStep(cwd: string, step: WorkspaceStep): Promise<void>;
  after(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
  ownerPid: number;
  ownerHome: string;
  readSecret(name: string, signal: AbortSignal): Promise<string>;
  copyProbeRecord(source: ManagedRecordSource, paths: MomongaPaths): Promise<void>;
  copyEndpointProbeRecord(probe: EndpointProbe, paths: MomongaPaths): Promise<void>;
  listRoots(): Promise<string[]>;
  readOwner(root: string): Promise<EvalOwner | 'legacy' | 'unreadable' | undefined>;
};

const WORKSPACE_DIRECTORY = 'w';

const ISOLATED_VARIABLES = ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'LOCALAPPDATA', 'APPDATA'] as const;

export const caseEnvironment = (base: Readonly<Record<string, string | undefined>>, root: string, platform: NodeJS.Platform): Record<string, string> => {
  const entries = Object.entries({ ...base, HOME: root, ...(platform === 'win32' ? { USERPROFILE: root } : {}) }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !(ISOLATED_VARIABLES as readonly string[]).includes(entry[0]),
  );
  return Object.fromEntries(entries);
};

export const assertSocketsFit = (root: string, platform: NodeJS.Platform): void => {
  const limit = socketPathLimit(platform);
  for (const socket of Object.values(generationLayout(root, FIRST_GENERATION, platform).sockets)) {
    const bytes = Buffer.byteLength(socket);
    if (bytes >= limit) {
      throw new ContextHostError(`the socket ${socket} of the temporary home would be ${bytes} bytes, but a socket path must be shorter than ${limit} bytes on ${platform}; the benchmark needs a shorter temporary directory`);
    }
  }
};

export const pinnedModelOf = (user: UserModels, text: string): string => {
  const { views } = user.resolved;
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind !== 'found') throw modelRefErrorOf(text, resolution, views);
  return resolution.model.canon;
};

const chainMembersOf = (models: ResolvedModels, model: string): ResolvedModel[] => {
  const chain = models.chains.get(model);
  if (chain === undefined) throw new ContextHostError(modelRefErrorOf(model, { kind: 'not_found' }, models.views).message);
  return chain.map((canon) => {
    const member = models.models.get(canon);
    if (member === undefined) throw new TypeError(`the chain of ${model} names ${canon}, which the resolved settings do not hold`);
    return member;
  });
};

export type SecretCredential = { envName: string; secretName: string };

export type EndpointProbe = EndpointProbeKey;

export type LiveSettings = {
  endpointProbes: EndpointProbe[];
  operations: ModelsOperations;
  models: ModelsSettings;
  sandbox?: SandboxSetting;
  credentials: SecretCredential[];
  managedTargets: ManagedRecordSource[];
};

const GENERATED_KEY_PREFIX = 'MOMONGA_EVAL_KEY_';

export type ManagedRecordSource = { model: string; server: string; binary: string; upstream: string };

export type ListedTargetCapabilities = Capabilities | ProbingCapabilities | UnavailableCapabilities;

export type PlanRelay = { planRelaySocket: string; listed: Readonly<Record<string, ListedTargetCapabilities>> };

export const readPlanRelay = async (planRelaySocket: string, signal: AbortSignal | undefined): Promise<PlanRelay> => {
  const gateway = createGatewayClient({ resolveSocket: fixedSocket(planRelaySocket) });
  try {
    const entries = await gateway.models(signal);
    return { planRelaySocket, listed: Object.fromEntries(entries.flatMap((entry) => entry.chain.map((member) => [member.model, member.capabilities]))) };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    await gateway.close();
  }
};

export const needsPlanRelay = (user: UserModels, models: readonly string[]): boolean => models.some((model) => chainMembersOf(user.resolved, model).some((member) => 'plan' in member));

type ImagePairField = 'imageInput' | 'imageTokens';

type ListedField = Exclude<keyof ResolvedPlanTarget['capabilities'] & keyof Capabilities, 'contextWindow' | 'maxOutputTokens' | 'maxConcurrency' | ImagePairField>;

type RelayedCapabilities = OpenResponsesTarget['capabilities'];

type ImagePair = Pick<RelayedCapabilities, ImagePairField>;

const LISTED_FIELDS: Record<ListedField | 'imagePair', true> = {
  promptCache: true,
  sampling: true,
  reasoning: true,
  structuredOutput: true,
  jsonMode: true,
  streaming: true,
  stopSequences: true,
  outputBoundField: true,
  systemRole: true,
  toolPlacement: true,
  inputKinds: true,
  parallelToolCalls: true,
  allowedTools: true,
  schemaDialect: true,
  tokenCounting: true,
  tokenErrorRatio: true,
  usageReported: true,
  source: true,
  imagePair: true,
};

const isListedField = (key: string): key is ListedField => key !== 'imagePair' && Object.hasOwn(LISTED_FIELDS, key);

const imagePairOf = (side: { imageInput: boolean | undefined; imageTokens: ImagePair['imageTokens'] | undefined }): ImagePair => ({
  ...(side.imageInput === undefined ? {} : { imageInput: side.imageInput }),
  ...(side.imageTokens === undefined ? {} : { imageTokens: side.imageTokens }),
});

const putField = <Holder, Field extends keyof Holder>(holder: Holder, field: Field, value: Holder[Field]): void => {
  holder[field] = value;
};

const describedEntryOf = (display: string, canon: string, relay: PlanRelay): Capabilities => {
  const entry = Object.hasOwn(relay.listed, canon) ? relay.listed[canon] : undefined;
  if (entry === undefined) throw new ContextHostError(`the model ${display} is not in the model list of the running gateway`);
  if (isUnavailableCapabilities(entry)) throw new ContextHostError(notListedMessage(entry));
  if (isProbingCapabilities(entry)) throw new ContextHostError(TARGET_PROBING_MESSAGE);
  return entry;
};

const relayedCapabilitiesOf = (display: string, resolved: ResolvedModel & ResolvedPlanTarget, relay: PlanRelay): RelayedCapabilities => {
  const entry = describedEntryOf(display, resolved.canon, relay);
  const { maxConcurrency: _maxConcurrency, contextWindow: _contextWindow, maxOutputTokens: _maxOutputTokens, imageInput, imageTokens, ...core } = resolved.capabilities;
  const capabilities: RelayedCapabilities = {
    ...core,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    ...imagePairOf(entry.imageInput === undefined ? { imageInput, imageTokens } : { imageInput: entry.imageInput, imageTokens: entry.imageTokens }),
  };
  const listed: Partial<Pick<RelayedCapabilities, ListedField>> = entry;
  for (const field of Object.keys(LISTED_FIELDS).filter(isListedField)) {
    if (capabilities[field] !== undefined && listed[field] !== undefined) putField(capabilities, field, listed[field]);
  }
  return capabilities;
};

type Json = Record<string, unknown>;

const declaredCapabilitiesOf = (member: ResolvedModel): Json | undefined => {
  if (member.capabilities === undefined) return undefined;
  if (!('maxConcurrency' in member.capabilities)) return { ...member.capabilities };
  const { maxConcurrency: _maxConcurrency, ...declared } = member.capabilities;
  return declared;
};

const entryOf = (member: ResolvedModel, capabilities: Json | undefined): Json => ({
  id: member.ownName,
  ...(capabilities === undefined ? {} : { capabilities }),
  ...(member.adapter === 'anthropic' || member.adapter === 'ollama' ? {} : { toolCalling: member.toolCalling }),
  ...(member.adapter === 'managed' && member.outputBoundField !== undefined ? { outputBoundField: member.outputBoundField } : {}),
  maxConcurrency: member.maxConcurrency,
  admissionTimeoutMs: member.admissionTimeoutMs,
});

const sharedOf = (member: ResolvedModel): Json => ({ provider: member.provider, billing: member.billing, ...(member.answers === undefined ? {} : { answers: member.answers }) });

const declaredProgramOf = (models: ResolvedModels, id: string): ModelsOperation | undefined => {
  if (MANAGED_SERVERS.some((server) => server.id === id)) return undefined;
  const description = registeredServer(models.servers, id);
  if (description === undefined) throw new ContextHostError(`the managed server ${id} is not registered in the user settings, so it cannot be copied into a case`);
  return { kind: 'declareServer', id, command: description.binary.defaultPath, args: description.launch.argv, readyPath: description.ready.path };
};

const addOperation = (connection: Json, model: Json): ModelsOperation => ({ kind: 'addModel', choice: { connection: connection as ConnectionDraft, model: model as ModelEntry } });

const BUILT_IN_SERVERS = Object.fromEntries(MANAGED_SERVERS.map((server) => [server.id, server]));

export const liveSettingsFor = (user: UserModels, models: readonly string[], relay?: PlanRelay): LiveSettings => {
  const { resolved } = user;
  const displays = displayMapOf(resolved.views);
  const displayOf = (canon: string): string => displays.get(canon) ?? canon;
  const operations: ModelsOperation[] = [];
  const credentials: SecretCredential[] = [];
  const credentialEnv = new Map<string, string>();
  const managedTargets: ManagedRecordSource[] = [];
  const endpointProbes: EndpointProbe[] = [];
  const declared = new Set<string>();
  const copied = new Set<string>();
  const keyOf = (member: ResolvedModel): Json => {
    if (!('apiKeySecret' in member) || member.apiKeySecret === undefined) return 'apiKeyEnv' in member && member.apiKeyEnv !== undefined ? { apiKeyEnv: member.apiKeyEnv } : {};
    const known = credentialEnv.get(member.provider);
    if (known !== undefined) return { apiKeyEnv: known };
    const envName = `${GENERATED_KEY_PREFIX}${credentials.length}`;
    credentials.push({ envName, secretName: member.apiKeySecret });
    credentialEnv.set(member.provider, envName);
    return { apiKeyEnv: envName };
  };
  const copyMember = (member: ResolvedModel): void => {
    if (copied.has(member.canon)) return;
    copied.add(member.canon);
    if ('plan' in member) {
      if (relay === undefined) throw new ContextHostError(`the model ${displayOf(member.canon)} uses a ${member.plan.profile} plan sign-in, which a case home can reach only through the gateway of this home; this command has no relay for it`);
      operations.push(addOperation({ adapter: 'open-responses', socketPath: relay.planRelaySocket, ...sharedOf(member) }, entryOf(member, relayedCapabilitiesOf(displayOf(member.canon), member, relay))));
      return;
    }
    if (member.adapter === 'managed') {
      managedTargets.push({ model: member.canon, server: member.server, binary: member.binary, upstream: member.model });
      const program = declared.has(member.server) ? undefined : declaredProgramOf(resolved, member.server);
      declared.add(member.server);
      if (program !== undefined) operations.push(program);
      operations.push(addOperation({ adapter: 'managed', server: member.server, binary: member.binary, readyTimeoutMs: member.readyTimeoutMs, ...sharedOf(member) }, entryOf(member, declaredCapabilitiesOf(member))));
      return;
    }
    const recordKey = probeRecordKeyOf(member.canon, member);
    if (recordKey?.kind === 'endpoint') endpointProbes.push(recordKey.key);
    const address = member.socketPath === undefined ? { baseUrl: member.baseUrl } : { socketPath: member.socketPath };
    const apiVersion = member.adapter === 'anthropic' ? { apiVersion: member.apiVersion } : {};
    operations.push(addOperation({ adapter: member.adapter, ...address, ...keyOf(member), ...apiVersion, ...sharedOf(member) }, entryOf(member, declaredCapabilitiesOf(member))));
  };
  for (const model of models) for (const member of chainMembersOf(resolved, model)) copyMember(member);
  const [start] = models;
  if (start !== undefined) operations.push({ kind: 'setStart', model: start });
  const fallback = resolved.fallback.filter((canon) => copied.has(canon));
  if (fallback.length > 0) operations.push({ kind: 'setFallback', models: fallback });
  for (const change of resolved.billingChanges) {
    if (change.model === undefined || copied.has(change.model)) operations.push({ kind: 'allowBillingChange', ...change });
  }
  const [first, ...rest] = operations;
  if (first === undefined) throw new ContextHostError('a case home needs at least one model');
  const plan = planModelsEdit({}, [first, ...rest], { kinds: SERVER_KINDS, planProfiles: PLAN_PROFILES, servers: BUILT_IN_SERVERS });
  if ('refused' in plan) throw new ContextHostError(`the settings of a case home could not be built: ${plan.refused.message}`);
  const written = plan.document['models'];
  if (!isRecord(written)) throw new TypeError('the planned settings of a case home hold no models');
  return {
    operations: [first, ...rest],
    models: written,
    ...(user.sandbox === undefined ? {} : { sandbox: user.sandbox }),
    credentials,
    managedTargets,
    endpointProbes,
  };
};

export const readCredentials = async (
  effects: Pick<ContextHostEffects, 'readSecret'>,
  credentials: readonly SecretCredential[],
  signal: AbortSignal,
): Promise<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const credential of credentials) {
    try {
      values[credential.envName] = await effects.readSecret(credential.secretName, signal);
    } catch (error) {
      throw new ContextHostError(
        `the key of a model server is the secret ${credential.secretName} in the platform secret store, and it could not be read: ${error instanceof Error ? error.message : String(error)}. The benchmark reads it with the same store the gateway uses; store it with momonga secret set ${credential.secretName}`,
        { cause: error },
      );
    }
  }
  return values;
};

export const OWNER_FILE = '.momonga-eval-owner';

export type EvalOwner = { pid: number; home: string };

export const ownerRecord = (owner: EvalOwner): string => JSON.stringify({ pid: owner.pid, home: owner.home });

export const isLegacyOwnerMarker = (text: string): boolean => /^\d+\s*$/.test(text);

export const parseEvalOwner = (text: string): EvalOwner | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { pid, home } = parsed as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || typeof home !== 'string') return undefined;
  return { pid, home };
};

export const ROOT_PREFIX = 'momonga-eval-';

export const unreadableHomesNotice = (count: number): string =>
  `${count} temporary ${count === 1 ? 'entry' : 'entries'} of an earlier run could not be read and ${count === 1 ? 'was' : 'were'} skipped\n`;

export const unownedHomesNotice = (roots: readonly string[]): string =>
  `${escapeTerminalLine(`${roots.length} temporary ${roots.length === 1 ? 'entry' : 'entries'} of an earlier run ${roots.length === 1 ? 'carries' : 'carry'} an old owner marker that names no owner and ${roots.length === 1 ? 'was' : 'were'} left in place: ${roots.join(', ')}`)}\n`;

export type SweepResult = { removed: string[]; unreadable: number; unowned: string[] };

export const sweepStaleHomes = async (effects: ContextHostEffects): Promise<SweepResult> => {
  const removed: string[] = [];
  const unowned: string[] = [];
  let unreadable = 0;
  for (const root of await effects.listRoots()) {
    const owner = await effects.readOwner(root);
    if (owner === 'unreadable') {
      unreadable += 1;
      continue;
    }
    if (owner === 'legacy') {
      unowned.push(root);
      continue;
    }
    if (owner === undefined || owner.home !== effects.ownerHome) continue;
    const claim = await effects.lock.claim(claimPathOf(effects.lock, root, 'sidecar'));
    if (claim.kind === 'held') continue;
    try {
      const holder = await effects.daemonHolder(momongaLayout(root, effects.platform, {}));
      if (holder !== undefined) await effects.terminate(holder);
      await effects.remove(root);
    } catch (error) {
      claim.lock.release();
      throw error;
    }
    claim.lock.dispose();
    removed.push(root);
  }
  return { removed, unreadable, unowned };
};

type CaseRecord = { root: string; paths: MomongaPaths | undefined; pid: number | undefined; runtime: ContextRuntime | undefined; released: boolean };

export type ContextHosts = {
  openCase(entry: ExpandedCase): Promise<ContextCaseHost>;
  dispose(): Promise<void>;
};

const BENCHMARK_GUIDELINE_REPORT = { source: 'context improve benchmark' } as const;

export type ReflectionBounds = Pick<ReflectionSettle, 'pendingBoundMs' | 'attemptBoundMs' | 'pollMs'>;

export type HomeSpec = { label: string; settings: Record<string, unknown>; files?: Readonly<Record<string, string>> };

export type OpenedHome = { cwd: string; env: Record<string, string>; runtime: ContextRuntime; api: ContextCaseHost['api']; close(): Promise<void> };

export type Homes = {
  open(spec: HomeSpec): Promise<OpenedHome>;
  dispose(): Promise<void>;
};

export type HomesOptions = {
  credentialValues: Readonly<Record<string, string>>;
  reflection: ReflectionBounds;
  managedTargets: readonly ManagedRecordSource[];
  endpointProbes: readonly EndpointProbe[];
  guideline?: string;
  interrupt?: AbortSignal;
};

export const createHomes = (effects: ContextHostEffects, options: HomesOptions): Homes => {
  const records: CaseRecord[] = [];

  const release = async (record: CaseRecord): Promise<void> => {
    if (record.released) return;
    record.released = true;
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    if (record.runtime !== undefined) {
      const { runtime } = record;
      await attempt(() => runtime.close());
    }
    const { paths } = record;
    const pid = record.pid ?? (paths === undefined ? undefined : await effects.daemonHolder(paths));
    if (pid !== undefined) await attempt(() => effects.terminate(pid));
    await attempt(() => effects.remove(record.root));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `releasing the temporary home ${record.root} failed ${failures.length} times`);
  };

  const prepared = async (spec: HomeSpec, record: CaseRecord): Promise<OpenedHome> => {
    const { root } = record;
    await effects.writeFile(path.join(root, OWNER_FILE), ownerRecord({ pid: effects.ownerPid, home: effects.ownerHome }));
    assertSocketsFit(await effects.canonical(root), effects.platform);
    const paths = momongaLayout(root, effects.platform, {});
    record.paths = paths;
    await effects.prepare(paths);
    await effects.writeFile(paths.settingsFile, `${JSON.stringify(spec.settings, null, 2)}\n`);
    for (const source of options.managedTargets) await effects.copyProbeRecord(source, paths);
    for (const probe of options.endpointProbes) await effects.copyEndpointProbeRecord(probe, paths);
    const workspace = path.join(root, WORKSPACE_DIRECTORY);
    await effects.makeDirectory(workspace);
    for (const [name, content] of Object.entries(spec.files ?? {})) await effects.writeFile(path.join(workspace, name), content);
    const cwd = await effects.canonical(workspace);
    if (record.released) throw new ContextInterrupted();
    const pid = await effects.startDaemon(root, paths, { ...caseEnvironment(effects.env, root, effects.platform), ...options.credentialValues });
    record.pid = pid;
    if (record.released) {
      await effects.terminate(pid);
      throw new ContextInterrupted();
    }
    const runtime = effects.connect(paths);
    record.runtime = runtime;
    await runtime.setTrust(cwd, 'trusted');
    if (options.guideline !== undefined) await runtime.adoptGuideline({ text: options.guideline, parent: null, report: { ...BENCHMARK_GUIDELINE_REPORT } });
    const env = await effects.sessionEnv(root);
    return {
      cwd,
      env,
      runtime,
      api: goldenRunApi(runtime, env, {
        ...options.reflection,
        now: () => effects.now(),
        wait: (milliseconds, signal) => effects.after(milliseconds, signal ?? new AbortController().signal),
        ...(options.interrupt === undefined ? {} : { signal: options.interrupt }),
      }),
      close: () => release(record),
    };
  };

  let disposed = false;

  const open = async (spec: HomeSpec): Promise<OpenedHome> => {
    if (disposed) throw new ContextInterrupted();
    const root = await effects.makeRoot();
    if (disposed) {
      await effects.remove(root);
      throw new ContextInterrupted();
    }
    const record: CaseRecord = { root, paths: undefined, pid: undefined, runtime: undefined, released: false };
    records.push(record);
    try {
      return await prepared(spec, record);
    } catch (error) {
      try {
        await release(record);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `${spec.label} failed to start and its temporary home was not fully released`);
      }
      throw error;
    }
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    const failures: unknown[] = [];
    for (const record of records) {
      try {
        await release(record);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `releasing the temporary homes failed ${failures.length} times`);
  };

  return { open, dispose };
};

export const createContextHosts = (
  effects: ContextHostEffects,
  options: { settings: LiveSettings; credentialValues: Readonly<Record<string, string>>; reflection: ReflectionBounds; policy?: PolicyOverlay; guideline?: string; interrupt?: AbortSignal },
): ContextHosts => {
  const { models, sandbox, managedTargets, endpointProbes } = options.settings;
  const base = { models, ...(sandbox === undefined ? {} : { sandbox }) };
  const homes = createHomes(effects, {
    credentialValues: options.credentialValues,
    reflection: options.reflection,
    managedTargets,
    endpointProbes,
    ...(options.guideline === undefined ? {} : { guideline: options.guideline }),
    ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
  });

  const openCase = async (entry: ExpandedCase): Promise<ContextCaseHost> => {
    const home = await homes.open({
      label: `case ${entry.id}`,
      settings: caseSettingsFor(base, { compaction: entry.compaction, ...(options.policy === undefined ? {} : { policy: options.policy }) }),
      ...(entry.files === undefined ? {} : { files: entry.files }),
    });
    const { cwd, runtime } = home;
    return {
      cwd,
      api: home.api,
      rules: {
        add: (request) => runtime.addRule(request),
        retire: async (id) => void (await runtime.retireRule(id)),
      },
      seedMemory: async (memory) => void (await runtime.addMemory({ text: memory.text, scope: 'project', project: cwd, paths: memory.paths })),
      applyStep: (step) => effects.applyStep(cwd, step),
      close: home.close,
    };
  };

  return { openCase, dispose: homes.dispose };
};

export class ContextInterrupted extends Error {
  constructor() {
    super('interrupted: the running case was abandoned, its daemon stopped and its temporary home removed');
    this.name = 'ContextInterrupted';
  }
}

export type ContextLiveInput = {
  dataset: ContextDataset;
  seed: number;
  model: string;
  models: UserModels;
  limits: { maxTotalTokens: number; defaultTimeoutMs: number };
  reflection: ReflectionBounds;
  codeDigest: string;
  policy?: PolicyOverlay;
  guideline?: string;
  interrupt?: AbortSignal;
  onTranscript?(transcript: Transcript): Promise<void>;
  onUnreadableHomes?(count: number): void;
  onUnownedHomes?(roots: readonly string[]): void;
  planRelaySocket?(): Promise<string>;
};

export const runContextLive = async (effects: ContextHostEffects, input: ContextLiveInput): Promise<Transcript[]> => {
  const { interrupt } = input;
  interrupt?.throwIfAborted();
  const relay = needsPlanRelay(input.models, [input.model]) && input.planRelaySocket !== undefined ? await readPlanRelay(await input.planRelaySocket(), interrupt) : undefined;
  const settings = liveSettingsFor(input.models, [input.model], relay);
  const credentialValues = await readCredentials(effects, settings.credentials, interrupt ?? new AbortController().signal);
  const swept = await sweepStaleHomes(effects);
  if (swept.unreadable > 0) input.onUnreadableHomes?.(swept.unreadable);
  if (swept.unowned.length > 0) input.onUnownedHomes?.(swept.unowned);
  const hosts = createContextHosts(effects, {
    settings,
    credentialValues,
    reflection: input.reflection,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.guideline === undefined ? {} : { guideline: input.guideline }),
    ...(interrupt === undefined ? {} : { interrupt }),
  });
  const bounds = liveBoundsFor(input.dataset, input.limits);
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt?.addEventListener('abort', () => reject(new ContextInterrupted()), { once: true });
  });
  const running = runContextDataset(expandContextDataset(input.dataset, input.seed), {
    policy: input.policy ?? {},
    codeDigest: input.codeDigest,
    openCase: hosts.openCase,
    model: input.model,
    bounds,
    deadline: (caseId, signal) => {
      const milliseconds = bounds.caseDeadlineMs[caseId];
      if (milliseconds === undefined) throw new ContextHostError(`case ${caseId} has no deadline`);
      return effects.after(milliseconds, signal);
    },
    ...(input.onTranscript === undefined ? {} : { onTranscript: input.onTranscript }),
  });
  let outcome: Awaited<typeof running>;
  try {
    outcome = await Promise.race([running, interrupted]);
  } catch (error) {
    await settle(hosts, error);
    void running.catch(() => undefined);
    throw error;
  }
  await hosts.dispose();
  return outcome.transcripts;
};

const settle = async (hosts: ContextHosts, error: unknown): Promise<void> => {
  try {
    await hosts.dispose();
  } catch (cleanup) {
    throw failedWithCleanup(error, cleanup, 'the benchmark failed and its temporary homes were not fully released');
  }
};
