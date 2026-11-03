import path from 'node:path';
import type { ModelsSettings, ResolvedModels, UserModels } from '@momonga/config';
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

export const liveModelsFor = (user: UserModels, alias: string): ModelsSettings => {
  const members = membersOf(user.resolved, alias);
  const targets: NonNullable<ModelsSettings['targets']> = {};
  for (const name of members) {
    const resolved = user.resolved.targets[name];
    if (resolved === undefined) throw new ContextHostError(`the alias ${alias} names the target ${name}, which is not defined`);
    if (resolved.adapter === 'fm') {
      throw new ContextHostError(
        `the alias ${alias} reaches the fm target ${name}. Its probe record lives in the home that measured it, and each case runs in a temporary home, so the benchmark cannot reach it; use a remote target`,
      );
    }
    if (resolved.apiKeySecret !== undefined) {
      throw new ContextHostError(
        `the alias ${alias} reaches the target ${name}, whose key is the platform secret ${resolved.apiKeySecret}. Each case runs in a temporary home that cannot reach the person's secret store, so the benchmark cannot start it; give the target an apiKeyEnv and export the key instead`,
      );
    }
    const declared = user.declared.targets?.[name];
    if (declared === undefined) throw new ContextHostError(`the target ${name} is not declared in the user settings`);
    targets[name] = declared;
  }
  return { aliases: { [alias]: members }, targets };
};

type CaseRecord = { root: string; paths: MomongaPaths | undefined; pid: number | undefined; runtime: ContextRuntime | undefined; released: boolean };

export type ContextHosts = {
  openCase(entry: ExpandedCase): Promise<ContextCaseHost>;
  dispose(): Promise<void>;
};

export const createContextHosts = (effects: ContextHostEffects, options: { models: ModelsSettings }): ContextHosts => {
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
    assertSocketsFit(root, effects.platform);
    const paths = momongaLayout(root, effects.platform, {});
    record.paths = paths;
    await effects.prepare(paths);
    await effects.writeFile(paths.settingsFile, `${JSON.stringify(caseSettingsFor({ models: options.models }, { compaction: entry.compaction }), null, 2)}\n`);
    const workspace = path.join(root, WORKSPACE_DIRECTORY);
    await effects.makeDirectory(workspace);
    for (const [name, content] of Object.entries(entry.files ?? {})) await effects.writeFile(path.join(workspace, name), content);
    const cwd = await effects.canonical(workspace);
    if (record.released) throw new ContextInterrupted();
    const pid = await effects.startDaemon(root, paths, caseEnvironment(effects.env, root, effects.platform));
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
  const models = liveModelsFor(input.models, input.alias);
  const hosts = createContextHosts(effects, { models });
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
