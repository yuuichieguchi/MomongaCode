import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ResolvedChatCompletionsTarget, UserModels } from '@momonga/config';
import { autoFitDirectoryOf } from '@momonga/config';
import type { MomongaPaths } from '@momonga/foundation';
import { createFakeKernelLock } from '@momonga/testkit';
import type { PublicRunEvent } from '@momonga/protocol';
import { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } from '@momonga/runtime';
import { autoModeCheck } from '../src/commands/auto-mode.ts';
import type { AutoModeCheckOptions, AutoModeCheckPorts } from '../src/commands/auto-mode.ts';
import { ContextHostError } from '../src/eval/context-host.ts';
import type { ContextHostEffects, ContextLiveInput, ContextRuntime } from '../src/eval/context-host.ts';
import { KEYCHAIN_UNANSWERED_ADVICE, afterPendingIo, keychainFixture, outcomeOf, useLimitTimers } from './keychain-fixture.ts';

const AUTO_MODE_RUNS = 148;

const capabilities = (structuredOutput: 'none' | 'json_schema') => ({
  contextWindow: 8192,
  maxOutputTokens: 1024,
  structuredOutput,
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency: 4,
});

const target = (model: string, structuredOutput: 'none' | 'json_schema'): ResolvedChatCompletionsTarget =>
  ({
    adapter: 'chat-completions',
    model,
    toolCalling: 'native',
    provider: 'p',
    baseUrl: 'http://127.0.0.1:8080/v1',
    billing: 'local',
    capabilities: capabilities(structuredOutput),
    maxConcurrency: 4,
    admissionTimeoutMs: 30000,
  }) as unknown as ResolvedChatCompletionsTarget;

const declared = (model: string) => ({ adapter: 'chat-completions', model, provider: 'p', baseUrl: 'http://127.0.0.1:8080/v1', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }) as const;

const userModels = (): UserModels =>
  ({
    declared: { aliases: { worker: ['w'], guard: ['g'], plain: ['n'] }, targets: { w: declared('worker-model'), g: declared('guard-model'), n: declared('plain-model') } },
    resolved: {
      aliases: { worker: ['w'], guard: ['g'], plain: ['n'] },
      targets: { w: target('worker-model', 'json_schema'), g: target('guard-model', 'json_schema'), n: target('plain-model', 'none') },
      dialects: {},
      roles: {},
    },
  }) as unknown as UserModels;

const ALL_LABELLED_PATHS = 'creds.txt .zshrc .github/workflows/ci.yml .git/hooks/pre-commit notes.md CHANGELOG.md';

type Stage = 'home' | 'run' | 'between';

type Fake = {
  effects: ContextHostEffects;
  roots: Map<string, { removed: boolean; settings?: string }>;
  started: number[];
  terminated: number[];
  connected: string[];
  sessions: { root: string; modelAlias: string | undefined }[];
  abortAt?: { stage: Stage; controller: AbortController };
};

const waitForAbort = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const fake = (options: { abortAt?: { stage: Stage; controller: AbortController }; silent?: boolean } = {}): Fake => {
  const state: Fake = { effects: undefined as unknown as ContextHostEffects, roots: new Map(), started: [], terminated: [], connected: [], sessions: [], ...(options.abortAt === undefined ? {} : { abortAt: options.abortAt }) };
  let pid = 5000;
  let streams = 0;
  const runtimeFor = (root: string): ContextRuntime =>
    ({
      createSession: async (request: { modelAlias?: string }) => {
        state.sessions.push({ root, modelAlias: request.modelAlias });
        return { session: { id: `s-${root}`, modelAlias: request.modelAlias ?? 'unset' } };
      },
      createRun: async () => ({ run: { id: `r-${root}` }, location: '' }),
      streamEvents: async function* (): AsyncGenerator<{ data: PublicRunEvent }> {
        streams += 1;
        if (state.abortAt?.stage === 'run' && streams === 2) {
          state.abortAt.controller.abort(new Error('interrupted'));
          await waitForAbort(state.abortAt.controller.signal);
        }
        if (options.silent === true) return;
        const base = { runId: `r-${root}`, sessionId: `s-${root}`, step: 1, createdAt: 1 };
        yield { data: { ...base, id: 1, seq: 1, type: 'tool.call', callId: 'c1', name: 'Write', kind: 'edit', sideEffect: 'workspace_write', rawInput: { file_path: ALL_LABELLED_PATHS, content: 'x' } } as unknown as PublicRunEvent };
        yield { data: { ...base, id: 2, seq: 2, type: 'tool.started', callId: 'c1' } as unknown as PublicRunEvent };
      },
      getRun: async (id: string) => ({ id, sessionId: `s-${root}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 } }),
      runReflection: async () => ({ job: null, charges: [], queuedAhead: 0 }),
      resolveApproval: async () => ({}),
      cancel: async () => ({ status: 200, run: {} }),
      addRule: async () => ({ fact: { id: 'fact' }, size: [], warnings: [] }),
      retireRule: async () => ({ id: 'fact' }),
      addMemory: async () => undefined,
      setTrust: async () => undefined,
      adoptGuideline: async () => ({ version: 1, text: '' }),
      close: async () => undefined,
    }) as unknown as ContextRuntime;
  state.effects = {
    lock: createFakeKernelLock({ inheritable: false }),
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/home/person' },
    sessionEnv: async () => ({ PATH: '/usr/bin' }),
    makeRoot: async () => {
      const root = `/tmp/mc-${state.roots.size}`;
      state.roots.set(root, { removed: false });
      return root;
    },
    prepare: async () => {
      if (state.abortAt?.stage === 'home' && state.roots.size === 2) {
        state.abortAt.controller.abort(new Error('interrupted'));
        await waitForAbort(state.abortAt.controller.signal);
      }
    },
    writeFile: async (file, text) => {
      for (const [root, entry] of state.roots) if (file === `${root}/.momonga/settings.json`) entry.settings = text;
    },
    makeDirectory: async () => undefined,
    canonical: async (directory) => directory,
    startDaemon: async () => {
      pid += 1;
      state.started.push(pid);
      return pid;
    },
    daemonHolder: async () => undefined,
    terminate: async (killed) => void state.terminated.push(killed),
    remove: async (directory) => {
      const entry = state.roots.get(directory);
      if (entry !== undefined) entry.removed = true;
      if (state.abortAt?.stage === 'between' && directory === '/tmp/mc-0') state.abortAt.controller.abort(new Error('interrupted'));
    },
    connect: (paths: MomongaPaths) => {
      const root = paths.root.replace(/\/\.momonga$/, '');
      state.connected.push(root);
      return runtimeFor(root);
    },
    applyStep: async () => undefined,
    after: (_milliseconds, signal) => waitForAbort(signal),
    now: () => 0,
    ownerPid: 7,
    ownerHome: '/home/person',
    readSecret: async () => {
      throw new Error('the check of a local target reads no stored key');
    },
    copyProbeRecord: async () => undefined,
    copyEndpointProbeRecord: async () => undefined,
    listRoots: async () => [],
    readOwner: async () => undefined,
  };
  return state;
};

const NEVER_INTERRUPTED = new AbortController().signal;

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const portsFor = (effects: ContextHostEffects): { ports: AutoModeCheckPorts; output: string[]; home: string } => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-check-')));
  homes.push(home);
  const output: string[] = [];
  const ports: AutoModeCheckPorts = {
    effects,
    models: userModels(),
    configuredClassifier: 'guard',
    home,
    version: '0.0.0-test',
    now: () => Date.parse('2026-11-06T00:00:00.000Z'),
    randomHex: (bytes) => '0'.repeat(bytes * 2),
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    write: (text) => void output.push(text),
  };
  return { ports, output, home };
};

const recordsIn = (home: string): unknown[] => {
  const directory = autoFitDirectoryOf(home);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as unknown);
};

const noDaemonOrHomeLeft = (state: Fake): void => {
  expect([...state.terminated].sort()).toEqual([...state.started].sort());
  expect([...state.roots.values()].filter((entry) => !entry.removed)).toEqual([]);
};

describe('auto-mode check over the embedded dataset', () => {
  it('runs each of the 148 runs in its own temporary home and daemon, and connects to no other daemon (N2)', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(state.roots.size).toBe(AUTO_MODE_RUNS);
    expect(state.started).toHaveLength(AUTO_MODE_RUNS);
    expect(new Set(state.sessions.map((session) => session.root)).size).toBe(AUTO_MODE_RUNS);
    expect(state.connected.every((root) => state.roots.has(root))).toBe(true);
    noDaemonOrHomeLeft(state);
  });

  it('writes autoMode.classifier and both aliases with their targets into the settings of every home (N1)', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(state.roots.size).toBe(AUTO_MODE_RUNS);
    for (const entry of state.roots.values()) {
      const settings = JSON.parse(entry.settings ?? '{}') as { autoMode?: { classifier?: string }; models?: { aliases?: Record<string, unknown>; targets?: Record<string, unknown> } };
      expect(settings.autoMode?.classifier).toBe('guard');
      expect(settings.models?.aliases).toEqual({ worker: ['w'], guard: ['g'] });
      expect(Object.keys(settings.models?.targets ?? {}).sort()).toEqual(['g', 'w']);
    }
  });

  it('pins every created session to the agent alias', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(state.sessions).toHaveLength(AUTO_MODE_RUNS);
    expect(state.sessions.filter((session) => session.modelAlias !== 'worker')).toEqual([]);
  });

  it('writes a did_not_pass record for a classifier that allowed every labelled call, with the agent alias recorded', async () => {
    const state = fake();
    const { ports, home, output } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(outcome.measurement).toBe('did_not_pass');
    const records = recordsIn(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentAlias: 'worker',
      runs: AUTO_MODE_RUNS,
      falseAllow: { successes: 100, trials: 100 },
      falseBlock: { successes: 0, trials: 48 },
      unobserved: 0,
      version: '0.0.0-test',
      recordedAt: '2026-11-06T00:00:00.000Z',
    });
    expect(output.join('')).toContain('did not pass');
  });

  it('defaults the classifier to the configured autoMode.classifier', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { agent: 'worker', signal: NEVER_INTERRUPTED });
    const settings = JSON.parse([...state.roots.values()][0]?.settings ?? '{}') as { autoMode?: { classifier?: string } };
    expect(settings.autoMode?.classifier).toBe('guard');
  });

  it('measures a classifier without structured output like any other: the check runs the whole dataset and writes a record', async () => {
    const state = fake();
    const { ports, home } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: 'plain', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(outcome.measurement).not.toBe('unmeasurable');
    expect(state.started).toHaveLength(AUTO_MODE_RUNS);
    expect(recordsIn(home)).toHaveLength(1);
  });

  it('prints the reason and writes nothing when no labelled decision was observed', async () => {
    const state = fake({ silent: true });
    const { ports, home, output } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: NEVER_INTERRUPTED });
    expect(outcome.measurement).toBe('unmeasurable');
    expect(output.join('')).toContain('no decision');
    expect(recordsIn(home)).toEqual([]);
    noDaemonOrHomeLeft(state);
  });
});

describe('a check aborted by its signal leaves no daemon and no home behind (C1, C2)', () => {
  it.each(['home', 'run', 'between'] as const)('when aborted at stage %s', async (stage) => {
    const controller = new AbortController();
    const state = fake({ abortAt: { stage, controller } });
    const { ports, home } = portsFor(state.effects);
    await expect(autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: controller.signal })).rejects.toThrow();
    expect(state.roots.size).toBeGreaterThan(0);
    expect(state.roots.size).toBeLessThan(AUTO_MODE_RUNS);
    noDaemonOrHomeLeft(state);
    expect(recordsIn(home)).toEqual([]);
  });
});

describe('the credential phase of a check against a secret store that does not answer', () => {
  const COMMAND_LIMIT_MS = 300_000;
  const FIRST_ANSWERS_AFTER_MS = 200_000;

  const secretModels = (): UserModels => {
    const models = userModels();
    const withSecret = (name: 'w' | 'g', secret: string): void => {
      (models.resolved.targets as Record<string, unknown>)[name] = { ...models.resolved.targets[name], apiKeySecret: secret };
      (models.declared.targets as Record<string, unknown>)[name] = { ...models.declared.targets?.[name], apiKeySecret: secret };
    };
    withSecret('w', 'a');
    withSecret('g', 'b');
    return models;
  };

  it('readCredentials ends at the command limit for all secrets together', async () => {
    useLimitTimers();
    const keychain = keychainFixture({
      items: { a: 'key-a', b: 'key-b' },
      beforeAnswer: async (command, account) => {
        if (command !== 'find-generic-password') return;
        if (account === 'a') await new Promise<void>((resolve) => void setTimeout(resolve, FIRST_ANSWERS_AFTER_MS));
        if (account === 'b') keychain.control.calls = 'hang';
      },
    });
    const state = fake();
    state.effects.readSecret = (name, signal) => keychain.store.read(name, signal);
    const { ports, home } = portsFor(state.effects);
    ports.models = secretModels();
    const interrupt = new AbortController();

    const attempt = outcomeOf(autoModeCheck(ports, { classifier: 'guard', agent: 'worker', signal: interrupt.signal }));
    try {
      await keychain.arrived('find-generic-password', 1);
      await vi.advanceTimersByTimeAsync(FIRST_ANSWERS_AFTER_MS);
      await keychain.arrived('find-generic-password', 2);
      await vi.advanceTimersByTimeAsync(COMMAND_LIMIT_MS - FIRST_ANSWERS_AFTER_MS - 1);
      await afterPendingIo();
      expect(attempt.state()).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await afterPendingIo();

      expect(attempt.state()).toBe('rejected');
      expect(attempt.error()).toBeInstanceOf(ContextHostError);
      expect((attempt.error() as Error).message).toBe(
        `the key of a target is the secret b in the platform secret store, and it could not be read: the read of the secret "b" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}; run the command again`,
      );
      expect(state.started).toEqual([]);
      expect(recordsIn(home)).toEqual([]);
    } finally {
      interrupt.abort(new Error('the test ended'));
    }
  });
});

describe('the signal of a command that reads credentials', () => {
  const sourceOf = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');

  it('a signal is required by autoModeCheck and runContextLive, and the two fallbacks are gone', () => {
    expectTypeOf<AutoModeCheckOptions['signal']>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ContextLiveInput['interrupt']>().toEqualTypeOf<AbortSignal>();
    expect(sourceOf('commands/auto-mode.ts')).not.toContain('new AbortController().signal');
    expect(sourceOf('eval/context-host.ts')).not.toContain('new AbortController().signal');
  });
});
