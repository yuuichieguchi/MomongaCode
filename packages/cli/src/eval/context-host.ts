import path from 'node:path';
import { escapeTerminalLine } from '@momonga/protocol';
import { probeRecordKeyOf } from '@momonga/config';
import type { EndpointProbeKey } from '@momonga/config';
import type { ModelsSettings, ResolvedModels, SandboxSetting, UserModels } from '@momonga/config';
import { caseSettingsFor, expandContextDataset, failedWithCleanup, liveBoundsFor, runContextDataset } from '@momonga/eval';
import type { ContextCaseHost, ContextDataset, ExpandedCase, PolicyOverlay, Transcript, WorkspaceStep } from '@momonga/eval';
import { FIRST_GENERATION, generationLayout, momongaLayout, socketPathLimit } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
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
  isAlive(pid: number): boolean;
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

const membersOf = (models: ResolvedModels, alias: string): string[] => {
  const value = models.aliases[alias];
  if (value === undefined) throw new ContextHostError(`the alias ${alias} is not defined in models.aliases; --alias names one of ${Object.keys(models.aliases).join(', ')}`);
  return [value].flat();
};

export type SecretCredential = { envName: string; secretName: string };

export type EndpointProbe = EndpointProbeKey;

export type LiveSettings = {
  endpointProbes: EndpointProbe[];
  models: ModelsSettings;
  sandbox?: SandboxSetting;
  credentials: SecretCredential[];
  managedTargets: ManagedRecordSource[];
};

const GENERATED_KEY_PREFIX = 'MOMONGA_EVAL_KEY_';

export type ManagedRecordSource = { target: string; server: string; binary: string; model: string | undefined };

export const liveSettingsFor = (user: UserModels, aliases: readonly string[]): LiveSettings => {
  const targets: NonNullable<ModelsSettings['targets']> = {};
  const aliasMembers: Record<string, string[]> = {};
  const credentials: SecretCredential[] = [];
  const managedTargets: ManagedRecordSource[] = [];
  const endpointProbes: EndpointProbe[] = [];
  const copied = new Set<string>();
  const copyTarget = (alias: string, name: string): void => {
    if (copied.has(name)) return;
    copied.add(name);
    const resolved = user.resolved.targets[name];
    if (resolved === undefined) throw new ContextHostError(`the alias ${alias} names the target ${name}, which is not defined`);
    const declared = user.declared.targets?.[name];
    if (declared === undefined) throw new ContextHostError(`the target ${name} is not declared in the user settings, so it cannot be copied into a case`);
    const recordKey = probeRecordKeyOf(name, resolved);
    if (resolved.adapter === 'managed') {
      managedTargets.push({ target: name, server: resolved.server, binary: resolved.binary, model: resolved.model });
      targets[name] = declared;
      return;
    }
    if (recordKey?.kind === 'endpoint') {
      endpointProbes.push(recordKey.key);
    }
    if ('apiKeySecret' in resolved && resolved.apiKeySecret !== undefined && 'apiKeySecret' in declared) {
      const envName = `${GENERATED_KEY_PREFIX}${credentials.length}`;
      const { apiKeySecret: _secret, ...rest } = declared;
      credentials.push({ envName, secretName: resolved.apiKeySecret });
      targets[name] = { ...rest, apiKeyEnv: envName };
      return;
    }
    targets[name] = declared;
  };
  for (const alias of aliases) {
    if (Object.hasOwn(aliasMembers, alias)) continue;
    const members = membersOf(user.resolved, alias);
    aliasMembers[alias] = members;
    for (const name of members) copyTarget(alias, name);
  }
  return {
    models: { aliases: aliasMembers, targets },
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
        `the key of a target is the secret ${credential.secretName} in the platform secret store, and it could not be read: ${error instanceof Error ? error.message : String(error)}. The benchmark reads it with the same store the gateway uses; store it with momonga secret set ${credential.secretName}`,
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
    if (owner === undefined || owner.home !== effects.ownerHome || effects.isAlive(owner.pid)) continue;
    const holder = await effects.daemonHolder(momongaLayout(root, effects.platform, {}));
    if (holder !== undefined) await effects.terminate(holder);
    await effects.remove(root);
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
  alias: string;
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
};

export const runContextLive = async (effects: ContextHostEffects, input: ContextLiveInput): Promise<Transcript[]> => {
  const { interrupt } = input;
  interrupt?.throwIfAborted();
  const settings = liveSettingsFor(input.models, [input.alias]);
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
    modelAlias: input.alias,
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
