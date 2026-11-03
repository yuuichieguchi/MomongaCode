import { describe, expect, it } from 'vitest';
import type { ResolvedChatCompletionsTarget, UserModels } from '@momonga/config';
import { CONTEXT_DATASET_FORMAT, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { MomongaPaths } from '@momonga/foundation';
import type { PublicRunEvent } from '@momonga/protocol';
import { ContextHostError, ContextInterrupted, assertSocketsFit, caseEnvironment, liveModelsFor, runContextLive } from '../src/eval/context-host.ts';
import type { ContextHostEffects, ContextRuntime } from '../src/eval/context-host.ts';

const target = (overrides: Partial<ResolvedChatCompletionsTarget> = {}): ResolvedChatCompletionsTarget => ({
  adapter: 'chat-completions',
  model: 'm',
  toolCalling: 'native',
  provider: 'p',
  baseUrl: 'https://upstream.invalid/v1',
  apiKeyEnv: 'UPSTREAM_KEY',
  billing: 'metered',
  capabilities: {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    structuredOutput: 'none',
    streaming: true,
    stopSequences: true,
    imageInput: false,
    parallelToolCalls: false,
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: 'estimated',
    usageReported: true,
    source: 'config',
    maxConcurrency: 4,
  },
  maxConcurrency: 4,
  admissionTimeoutMs: 30000,
  ...overrides,
});

const declaredTarget = { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', apiKeyEnv: 'UPSTREAM_KEY', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } as const;

const userModels = (): UserModels => ({
  declared: { aliases: { default: ['t'], other: ['u'] }, targets: { t: declaredTarget, u: { ...declaredTarget, model: 'other' } } },
  resolved: { aliases: { default: ['t'], other: ['u'] }, targets: { t: target(), u: target({ model: 'other' }) } },
});

const caseOf = (id: string, compaction: 'on' | 'off') => ({
  id,
  scenario: 'a',
  compaction,
  input: 'work on a',
  permissionMode: 'default',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  files: { 'src/a.ts': 'export const a = 1;\n' },
  memories: [{ text: 'a is 1', paths: ['src/a.ts'] }],
  rules: [],
  revisionDepth: 0,
  noise: { level: 0, topics: ['testing'] },
  graders: [{ kind: 'status', equals: 'COMPLETED' }],
});

const dataset = () =>
  parseContextDataset(JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'host', cases: [caseOf('a-on', 'on'), caseOf('a-off', 'off')] }), 'host.json');

type Behaviour = {
  failSessionOnRoot?: number;
  hang?: boolean;
  failStartOnRoot?: number;
  rootLength?: number;
};

const harness = (behaviour: Behaviour = {}) => {
  const roots = new Map<string, { removed: boolean; settings?: string; pid?: number; cwd?: string }>();
  const alive = new Set<number>();
  const terminated: number[] = [];
  const stopped: string[] = [];
  const memories: unknown[] = [];
  const trusted: string[] = [];
  const holders = new Map<string, number>();
  let counter = 0;
  let nextPid = 4000;
  const runtimeFor = (root: string): ContextRuntime => {
    const runtime = {
      createSession: async () => {
        counter += 1;
        if (behaviour.failSessionOnRoot === counter) throw new Error('the runtime refused the session');
        return { session: { id: `s${counter}`, modelAlias: 'default' } };
      },
      createRun: async () => ({ run: { id: `r${counter}` }, location: '' }),
      streamEvents: async function* (): AsyncGenerator<{ data: PublicRunEvent }> {
        if (behaviour.hang === true) await new Promise<void>(() => undefined);
      },
      getRun: async (id: string) => ({ id, sessionId: `s${counter}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 } }),
      resolveApproval: async () => ({}),
      cancel: async () => ({ status: 200, run: {} }),
      addRule: async () => ({ fact: { id: 'fact' }, size: [], warnings: [] }),
      retireRule: async () => ({ id: 'fact' }),
      addMemory: async (request: unknown) => void memories.push(request),
      setTrust: async (path: string) => void trusted.push(path),
      close: async () => void stopped.push(`close ${root}`),
    };
    return runtime as unknown as ContextRuntime;
  };
  const effects: ContextHostEffects = {
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/home/person', XDG_CACHE_HOME: '/home/person/cache', UPSTREAM_KEY: 'k' },
    sessionEnv: async () => ({ PATH: '/usr/bin' }),
    makeRoot: async () => {
      const root = `/tmp/mc-${'x'.repeat(behaviour.rootLength ?? 6)}${roots.size}`;
      roots.set(root, { removed: false });
      return root;
    },
    prepare: async () => undefined,
    writeFile: async (file, text) => {
      for (const [root, state] of roots) if (file === `${root}/.momonga/settings.json`) state.settings = text;
    },
    makeDirectory: async () => undefined,
    canonical: async (directory) => directory,
    startDaemon: async (root) => {
      const state = roots.get(root);
      if (state === undefined) throw new Error('unknown root');
      nextPid += 1;
      alive.add(nextPid);
      holders.set(root, nextPid);
      if (behaviour.failStartOnRoot === roots.size) throw new Error('the supervisor exited before it was ready');
      state.pid = nextPid;
      return nextPid;
    },
    daemonHolder: async (paths: MomongaPaths) => {
      for (const [root, pid] of holders) if (paths.root === `${root}/.momonga`) return pid;
      return undefined;
    },
    terminate: async (pid) => {
      terminated.push(pid);
      alive.delete(pid);
    },
    remove: async (directory) => {
      const state = roots.get(directory);
      if (state !== undefined) state.removed = true;
    },
    connect: (paths) => runtimeFor(paths.root.replace(/\/\.momonga$/, '')),
    applyStep: async () => undefined,
    after: async () => new Promise<void>(() => undefined),
  };
  return { effects, roots, alive, terminated, stopped, memories, trusted };
};

const input = (extra: Partial<Parameters<typeof runContextLive>[1]> = {}): Parameters<typeof runContextLive>[1] => ({
  dataset: dataset(),
  seed: 1,
  alias: 'default',
  models: userModels(),
  limits: { maxTotalTokens: 1000, defaultTimeoutMs: 60_000 },
  ...extra,
});

const noDaemonLeft = (context: ReturnType<typeof harness>): void => {
  expect([...context.alive]).toEqual([]);
  expect([...context.roots.values()].map((state) => state.removed)).not.toContain(false);
};

describe('a live context run', () => {
  it('gives every case its own home, daemon and settings, and stops each daemon by pid and removes each home', async () => {
    const context = harness();
    const stored: Transcript[] = [];
    const transcripts = await runContextLive(context.effects, input({ onTranscript: async (transcript) => void stored.push(transcript) }));
    expect(transcripts.map((transcript) => [transcript.caseId, transcript.datasetSeed])).toEqual([
      ['a-on', 1],
      ['a-off', 1],
    ]);
    expect(stored).toHaveLength(2);
    expect(context.roots.size).toBe(2);
    expect(context.terminated).toHaveLength(2);
    noDaemonLeft(context);
    const settings = [...context.roots.values()].map((state) => JSON.parse(state.settings ?? '{}'));
    expect(settings.map((entry) => entry.context)).toEqual([{ autoCompact: true }, { autoCompact: false }]);
    expect(settings[0]).toEqual({ models: { aliases: { default: ['t'] }, targets: { t: declaredTarget } }, context: { autoCompact: true } });
  });

  it('trusts the workspace and seeds the memory through the run api, with paths relative to the workspace', async () => {
    const context = harness();
    await runContextLive(context.effects, input());
    expect(context.trusted).toEqual(['/tmp/mc-xxxxxx0/w', '/tmp/mc-xxxxxx1/w']);
    expect(context.memories).toEqual([
      { text: 'a is 1', scope: 'project', project: '/tmp/mc-xxxxxx0/w', paths: ['src/a.ts'] },
      { text: 'a is 1', scope: 'project', project: '/tmp/mc-xxxxxx1/w', paths: ['src/a.ts'] },
    ]);
  });

  it('stops the daemons and removes the homes when a case fails, and reports the failure', async () => {
    const context = harness({ failSessionOnRoot: 2 });
    await expect(runContextLive(context.effects, input())).rejects.toThrow('the runtime refused the session');
    expect(context.roots.size).toBe(2);
    noDaemonLeft(context);
  });

  it('stops a daemon whose startup failed, found through the lock it holds', async () => {
    const context = harness({ failStartOnRoot: 1 });
    await expect(runContextLive(context.effects, input())).rejects.toThrow('the supervisor exited before it was ready');
    expect(context.terminated).toHaveLength(1);
    noDaemonLeft(context);
  });

  it('stops the daemon and removes the home when the person interrupts a running case', async () => {
    const context = harness({ hang: true });
    const interrupt = new AbortController();
    const running = runContextLive(context.effects, input({ interrupt: interrupt.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...context.alive]).toHaveLength(1);
    interrupt.abort();
    await expect(running).rejects.toThrow(ContextInterrupted);
    noDaemonLeft(context);
  });

  it('starts nothing when it is already interrupted', async () => {
    const context = harness();
    const interrupt = new AbortController();
    interrupt.abort();
    await expect(runContextLive(context.effects, input({ interrupt: interrupt.signal }))).rejects.toThrow();
    expect(context.roots.size).toBe(0);
  });

  it('refuses a temporary home whose sockets would not fit and removes it', async () => {
    const context = harness({ rootLength: 90 });
    await expect(runContextLive(context.effects, input())).rejects.toThrow(/must be shorter than 104 bytes/);
    expect(context.alive.size).toBe(0);
    noDaemonLeft(context);
  });
});

describe('the models of a live run', () => {
  it('copies only the target definitions the alias reaches', () => {
    expect(liveModelsFor(userModels(), 'other')).toEqual({ aliases: { other: ['u'] }, targets: { u: userModels().declared.targets?.['u'] } });
  });

  it('refuses a target whose key lives in the platform secret store, naming the reason', () => {
    const models = userModels();
    models.resolved.targets['t'] = target({ apiKeySecret: 'work-key' });
    expect(() => liveModelsFor(models, 'default')).toThrow(/platform secret work-key.*temporary home that cannot reach the person's secret store/);
    expect(() => liveModelsFor(models, 'default')).toThrow(ContextHostError);
  });

  it('refuses an fm target and an unknown alias', () => {
    const models = userModels();
    models.resolved.targets['t'] = { adapter: 'fm', model: 'system', toolCalling: 'native', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 1000 } as unknown as ResolvedChatCompletionsTarget;
    expect(() => liveModelsFor(models, 'default')).toThrow(/fm target t/);
    expect(() => liveModelsFor(userModels(), 'missing')).toThrow(/alias missing is not defined/);
  });
});

describe('the isolation of a case', () => {
  it('points HOME at the temporary home, drops the variables that relocate the cache and keeps the credential variables', () => {
    const env = caseEnvironment({ PATH: '/usr/bin', HOME: '/home/person', XDG_CACHE_HOME: '/c', XDG_DATA_HOME: '/d', UPSTREAM_KEY: 'k', EMPTY: undefined }, '/tmp/mc-abc123', 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/mc-abc123', UPSTREAM_KEY: 'k' });
  });

  it('accepts a short temporary home and refuses a long one, with the limit of the platform', () => {
    expect(() => assertSocketsFit('/tmp/mc-abc123', 'darwin')).not.toThrow();
    expect(() => assertSocketsFit(`/tmp/${'a'.repeat(72)}`, 'darwin')).toThrow(/shorter than 104 bytes on darwin/);
    expect(() => assertSocketsFit(`/tmp/${'a'.repeat(72)}`, 'linux')).not.toThrow();
  });
});
