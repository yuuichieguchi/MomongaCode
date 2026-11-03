import path from 'node:path';
import type { ModelsSettings, ResolvedModels, SandboxSetting, UserModels } from '@momonga/config';
import { caseSettingsFor, expandContextDataset, liveBoundsFor, runContextDataset } from '@momonga/eval';
import type { ContextCaseHost, ContextDataset, ExpandedCase, Transcript, WorkspaceStep } from '@momonga/eval';
import { momongaLayout, socketPathLimit } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { goldenRunApi } from '../client/golden-run-api.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';

export class ContextHostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextHostError';
  }
}

export type ContextRuntime = Pick<
  RuntimeClient,
  'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'resolveApproval' | 'cancel' | 'addRule' | 'retireRule' | 'addMemory' | 'setTrust' | 'close'
>;

export type ContextHostEffects = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  sessionEnv(): Promise<Record<string, string>>;
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
  ownerPid: number;
  readSecret(name: string, signal: AbortSignal): Promise<string>;
  copyProbeRecord(target: string, paths: MomongaPaths): Promise<void>;
  listRoots(): Promise<string[]>;
  readOwner(root: string): Promise<number | undefined>;
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
  for (const socket of Object.values(momongaLayout(root, platform, {}).sockets)) {
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

export type LiveSettings = {
  models: ModelsSettings;
  sandbox?: SandboxSetting;
  credentials: SecretCredential[];
  fmTargets: string[];
};

const GENERATED_KEY_PREFIX = 'MOMONGA_EVAL_KEY_';

const PROBE_TARGET_NAME = /^[A-Za-z0-9._-]+$/;

export const liveSettingsFor = (user: UserModels, alias: string): LiveSettings => {
  const members = membersOf(user.resolved, alias);
  const targets: NonNullable<ModelsSettings['targets']> = {};
  const credentials: SecretCredential[] = [];
  const fmTargets: string[] = [];
  for (const name of members) {
    const resolved = user.resolved.targets[name];
    if (resolved === undefined) throw new ContextHostError(`the alias ${alias} names the target ${name}, which is not defined`);
    const declared = user.declared.targets?.[name];
    if (declared === undefined) throw new ContextHostError(`the target ${name} is not declared in the user settings, so it cannot be copied into a case`);
    if (declared.adapter === 'fm') {
      if (!PROBE_TARGET_NAME.test(name)) throw new ContextHostError(`the fm target ${name} has a name its probe record cannot be keyed by`);
      fmTargets.push(name);
      targets[name] = declared;
      continue;
    }
    if (resolved.adapter !== 'fm' && resolved.apiKeySecret !== undefined) {
      const envName = `${GENERATED_KEY_PREFIX}${credentials.length}`;
      const { apiKeySecret: _secret, ...rest } = declared;
      credentials.push({ envName, secretName: resolved.apiKeySecret });
      targets[name] = { ...rest, apiKeyEnv: envName };
      continue;
    }
    targets[name] = declared;
  }
  return {
    models: { aliases: { [alias]: members }, targets },
    ...(user.sandbox === undefined ? {} : { sandbox: user.sandbox }),
    credentials,
    fmTargets,
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

export const ROOT_PREFIX = 'mc-';

export const sweepStaleHomes = async (effects: ContextHostEffects): Promise<string[]> => {
  const removed: string[] = [];
  for (const root of await effects.listRoots()) {
    const owner = await effects.readOwner(root);
    if (owner === undefined || effects.isAlive(owner)) continue;
    const holder = await effects.daemonHolder(momongaLayout(root, effects.platform, {}));
    if (holder !== undefined) await effects.terminate(holder);
    await effects.remove(root);
    removed.push(root);
  }
  return removed;
};

type CaseRecord = { root: string; paths: MomongaPaths | undefined; pid: number | undefined; runtime: ContextRuntime | undefined; released: boolean };

export type ContextHosts = {
  openCase(entry: ExpandedCase): Promise<ContextCaseHost>;
  dispose(): Promise<void>;
};

export const createContextHosts = (effects: ContextHostEffects, options: { settings: LiveSettings; credentialValues: Readonly<Record<string, string>> }): ContextHosts => {
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

  const prepared = async (entry: ExpandedCase, record: CaseRecord): Promise<ContextCaseHost> => {
    const { root } = record;
    await effects.writeFile(path.join(root, OWNER_FILE), String(effects.ownerPid));
    assertSocketsFit(root, effects.platform);
    const paths = momongaLayout(root, effects.platform, {});
    record.paths = paths;
    await effects.prepare(paths);
    const { models, sandbox, fmTargets } = options.settings;
    const base = { models, ...(sandbox === undefined ? {} : { sandbox }) };
    await effects.writeFile(paths.settingsFile, `${JSON.stringify(caseSettingsFor(base, { compaction: entry.compaction }), null, 2)}\n`);
    for (const target of fmTargets) await effects.copyProbeRecord(target, paths);
    const workspace = path.join(root, WORKSPACE_DIRECTORY);
    await effects.makeDirectory(workspace);
    for (const [name, content] of Object.entries(entry.files ?? {})) await effects.writeFile(path.join(workspace, name), content);
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
    return {
      cwd,
      api: goldenRunApi(runtime, await effects.sessionEnv()),
      rules: {
        add: (request) => runtime.addRule(request),
        retire: async (id) => void (await runtime.retireRule(id)),
      },
      seedMemory: async (memory) => void (await runtime.addMemory({ text: memory.text, scope: 'project', project: cwd, paths: memory.paths })),
      applyStep: (step) => effects.applyStep(cwd, step),
      close: () => release(record),
    };
  };

  let disposed = false;

  const openCase = async (entry: ExpandedCase): Promise<ContextCaseHost> => {
    if (disposed) throw new ContextInterrupted();
    const root = await effects.makeRoot();
    if (disposed) {
      await effects.remove(root);
      throw new ContextInterrupted();
    }
    const record: CaseRecord = { root, paths: undefined, pid: undefined, runtime: undefined, released: false };
    records.push(record);
    try {
      return await prepared(entry, record);
    } catch (error) {
      try {
        await release(record);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `case ${entry.id} failed to start and its temporary home was not fully released`);
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

  return { openCase, dispose };
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
  interrupt?: AbortSignal;
  onTranscript?(transcript: Transcript): Promise<void>;
};

export const runContextLive = async (effects: ContextHostEffects, input: ContextLiveInput): Promise<Transcript[]> => {
  const { interrupt } = input;
  interrupt?.throwIfAborted();
  const settings = liveSettingsFor(input.models, input.alias);
  const credentialValues = await readCredentials(effects, settings.credentials, interrupt ?? new AbortController().signal);
  await sweepStaleHomes(effects);
  const hosts = createContextHosts(effects, { settings, credentialValues });
  const bounds = liveBoundsFor(input.dataset, input.limits);
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt?.addEventListener('abort', () => reject(new ContextInterrupted()), { once: true });
  });
  const running = runContextDataset(expandContextDataset(input.dataset, input.seed), {
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
    throw new AggregateError([error, cleanup], 'the benchmark failed and its temporary homes were not fully released');
  }
};
