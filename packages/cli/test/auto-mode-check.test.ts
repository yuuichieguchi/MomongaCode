import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, expectTypeOf, vi } from 'vitest';
import type { UserModels, ResolvedChatCompletionsTarget } from '@momonga/config';
import { autoFitDirectoryOf } from '@momonga/config';
import { momongaPaths, nodeFileSystem, publishCurrentGeneration } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { createFakeKernelLock, createTempDir } from '@momonga/testkit';
import type { PublicRunEvent } from '@momonga/protocol';
import { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } from '@momonga/runtime';
import { autoModeCheck } from '../src/commands/auto-mode.ts';
import type { AutoModeCheckPorts, AutoModeCheckOptions } from '../src/commands/auto-mode.ts';
import type { ContextHostEffects, ContextRuntime, ContextLiveInput } from '../src/eval/context-host.ts';
import { LISTED_CONTEXT_WINDOW, LISTED_MAX_OUTPUT_TOKENS, LISTED_PLAN, MODELS_LISTING_REQUEST, PLAN_MODEL, PLAN_TARGET, PRODUCT_WRITTEN_PLAN_CONNECTION, absentGatewaySocket, listingEntry, modelsFailureOn, serveModelsListing, productWrittenPlanModels } from './fake-models-listing.ts';
import { userModelsOf } from './user-models.ts';
import { ContextHostError } from '../src/eval/context-host.ts';
import { KEYCHAIN_UNANSWERED_ADVICE, keychainFixture, outcomeOf, useLimitTimers, stillPendingAfter, settledAfter } from './keychain-fixture.ts';

const AUTO_MODE_RUNS = 148;

const WORKER = 'worker-model';
const GUARD = 'guard-model';
const PLAIN = 'plain-model';
const WORKER_MODEL = `p/${WORKER}`;
const GUARD_MODEL = `p/${GUARD}`;

const entry = (id: string, structuredOutput: 'none' | 'json_schema') => ({ id, capabilities: { contextWindow: 8192, maxOutputTokens: 1024, structuredOutput } });

const LOCAL_CONNECTION = {
  adapter: 'chat-completions',
  provider: 'p',
  baseUrl: 'http://127.0.0.1:8080/v1',
  models: [entry(WORKER, 'json_schema'), entry(GUARD, 'json_schema'), entry(PLAIN, 'none')],
};

const userModels = (): UserModels => userModelsOf({ connections: [LOCAL_CONNECTION] });

const ALL_LABELLED_PATHS = 'creds.txt .zshrc .github/workflows/ci.yml .git/hooks/pre-commit notes.md CHANGELOG.md';

type Stage = 'home' | 'run' | 'between';

type Fake = {
  effects: ContextHostEffects;
  roots: Map<string, { removed: boolean; settings?: string }>;
  started: number[];
  terminated: number[];
  connected: string[];
  sessions: { root: string; model: string | undefined }[];
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
  const daemons = new Map<string, number>();
  let streams = 0;
  const runtimeFor = (root: string): ContextRuntime =>
    ({
      createSession: async (request: { model?: string }) => {
        state.sessions.push({ root, model: request.model });
        return { session: { id: `s-${root}`, model: request.model ?? 'unset' } };
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
      reportCost: async (runIds: readonly string[]) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
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
    refuseUnfitSockets: async () => undefined,
    startDaemon: async (_root, paths) => {
      pid += 1;
      state.started.push(pid);
      daemons.set(paths.root, pid);
    },
    terminate: async (paths) => {
      const killed = daemons.get(paths.root);
      if (killed === undefined) return;
      daemons.delete(paths.root);
      state.terminated.push(killed);
    },
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
    random: () => 0,
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
  const home = createTempDir();
  homes.push(home);
  const output: string[] = [];
  const ports: AutoModeCheckPorts = {
    effects,
    models: userModels(),
    configuredClassifier: GUARD_MODEL,
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
    await autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: NEVER_INTERRUPTED });
    expect(state.roots.size).toBe(AUTO_MODE_RUNS);
    expect(state.started).toHaveLength(AUTO_MODE_RUNS);
    expect(new Set(state.sessions.map((session) => session.root)).size).toBe(AUTO_MODE_RUNS);
    expect(state.connected.every((root) => state.roots.has(root))).toBe(true);
    noDaemonOrHomeLeft(state);
  });

  it('writes autoMode.classifier and the models of the agent and of the classifier into the settings of every home (N1)', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: NEVER_INTERRUPTED });
    expect(state.roots.size).toBe(AUTO_MODE_RUNS);
    for (const entry of state.roots.values()) {
      const settings = JSON.parse(entry.settings ?? '{}') as { autoMode?: { classifier?: string }; models?: { start?: string; connections?: { models?: { id?: string }[] }[] } };
      expect(settings.autoMode?.classifier).toBe(GUARD_MODEL);
      expect(settings.models?.start).toBe(WORKER_MODEL);
      expect(settings.models?.connections?.map((connection) => connection.models?.map((model) => model.id))).toEqual([[WORKER, GUARD]]);
    }
  });

  it('pins every created session to the model of the agent', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: NEVER_INTERRUPTED });
    expect(state.sessions).toHaveLength(AUTO_MODE_RUNS);
    expect(state.sessions.filter((session) => session.model !== WORKER_MODEL)).toEqual([]);
  });

  it('writes a did_not_pass record for a classifier that allowed every labelled call, with the model of the agent recorded', async () => {
    const state = fake();
    const { ports, home, output } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: NEVER_INTERRUPTED });
    expect(outcome.measurement).toBe('did_not_pass');
    const records = recordsIn(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentModel: WORKER_MODEL,
      runs: AUTO_MODE_RUNS,
      falseAllow: { successes: 100, trials: 100 },
      falseBlock: { successes: 0, trials: 48 },
      unobserved: 0,
      version: '0.0.0-test',
      recordedAt: '2026-11-06T00:00:00.000Z',
    });
    expect(output.join('')).toContain('did not pass');
  });

  it('with no classifier named or configured, refuses with the command and the setting that give one', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    const { configuredClassifier: _configured, ...unconfigured } = ports;
    await expect(autoModeCheck({ ...unconfigured, configuredClassifier: undefined }, { agent: WORKER, signal: NEVER_INTERRUPTED })).rejects.toThrow(
      'no classifier model: name one with momonga auto-mode check <model>, or set autoMode.classifier in the user settings (/config in a session)',
    );
  });

  it('defaults the classifier to the configured autoMode.classifier', async () => {
    const state = fake();
    const { ports } = portsFor(state.effects);
    await autoModeCheck(ports, { agent: WORKER, signal: NEVER_INTERRUPTED });
    const settings = JSON.parse([...state.roots.values()][0]?.settings ?? '{}') as { autoMode?: { classifier?: string } };
    expect(settings.autoMode?.classifier).toBe(GUARD_MODEL);
  });

  it('measures a classifier without structured output like any other: the check runs the whole dataset and writes a record', async () => {
    const state = fake();
    const { ports, home } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: PLAIN, agent: WORKER, signal: NEVER_INTERRUPTED });
    expect(outcome.measurement).not.toBe('unmeasurable');
    expect(state.started).toHaveLength(AUTO_MODE_RUNS);
    expect(recordsIn(home)).toHaveLength(1);
  });

  it('prints the reason and writes nothing when no labelled decision was observed', async () => {
    const state = fake({ silent: true });
    const { ports, home, output } = portsFor(state.effects);
    const outcome = await autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: NEVER_INTERRUPTED });
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
    await expect(autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: controller.signal })).rejects.toThrow();
    expect(state.roots.size).toBeGreaterThan(0);
    expect(state.roots.size).toBeLessThan(AUTO_MODE_RUNS);
    noDaemonOrHomeLeft(state);
    expect(recordsIn(home)).toEqual([]);
  });
});

describe('the credential phase of a check against a secret store that does not answer', () => {
  const COMMAND_LIMIT_MS = 300_000;
  const FIRST_ANSWERS_AFTER_MS = 200_000;

  const secretModels = (): UserModels =>
    userModelsOf({
      connections: [
        { ...LOCAL_CONNECTION, models: [entry(WORKER, 'json_schema'), entry(PLAIN, 'none')], apiKeySecret: 'a' },
        { adapter: 'chat-completions', provider: 'q', baseUrl: 'http://127.0.0.1:8081/v1', models: [entry(GUARD, 'json_schema')], apiKeySecret: 'b' },
      ],
    });

  it('readCredentials ends at the command limit for all secrets together', async () => {
    useLimitTimers();
    const firstAnswer = Promise.withResolvers<void>();
    const keychain = keychainFixture({
      items: { a: 'key-a', b: 'key-b' },
      beforeAnswer: async (command, account) => {
        if (command !== 'find-generic-password') return;
        if (account === 'a') await firstAnswer.promise;
        if (account === 'b') keychain.control.calls = 'hang';
      },
    });
    const state = fake();
    state.effects.readSecret = (name, signal) => keychain.store.read(name, signal);
    const { ports, home } = portsFor(state.effects);
    ports.models = secretModels();
    const interrupt = new AbortController();

    const attempt = outcomeOf(autoModeCheck(ports, { classifier: GUARD, agent: WORKER, signal: interrupt.signal }));
    try {
      await keychain.arrived('find-generic-password', 1);
      await vi.advanceTimersByTimeAsync(FIRST_ANSWERS_AFTER_MS);
      firstAnswer.resolve();
      await keychain.arrived('find-generic-password', 2);
      await stillPendingAfter(attempt, COMMAND_LIMIT_MS - FIRST_ANSWERS_AFTER_MS - 1);
      await vi.advanceTimersByTimeAsync(1);
      await settledAfter(attempt);

      expect(attempt.state()).toBe('rejected');
      expect(attempt.error()).toBeInstanceOf(ContextHostError);
      expect((attempt.error() as Error).message).toBe(
        `the key of a model server is the secret b in the platform secret store, and it could not be read: the read of the secret "b" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}; run the command again`,
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

const withPlanAgent = (): UserModels => userModelsOf({ connections: [LOCAL_CONNECTION, PRODUCT_WRITTEN_PLAN_CONNECTION] });

const publishGateGateway = async (home: string, gatewaySocket: string): Promise<void> => {
  fs.mkdirSync(path.dirname(momongaPaths(home, process.platform, process.env).current), { recursive: true, mode: 0o700 });
  await publishCurrentGeneration(
    momongaPaths(home, process.platform, process.env),
    { generation: 2, version: '0.0.0-test', sockets: { gateway: gatewaySocket, runtime: '/tmp/gate-home-sockets/runtime-2.sock', supervisor: '/tmp/gate-home-sockets/supervisor-2.sock' } },
    { fs: nodeFileSystem, lock: createFakeKernelLock({ inheritable: false }) },
  );
};

const RELAY_CONNECTION_KEYS = ['adapter', 'billing', 'models', 'provider', 'socketPath'];
const RELAY_ENTRY_KEYS = ['admissionTimeoutMs', 'capabilities', 'id', 'maxConcurrency', 'toolCalling'];

describe('auto-mode check with a plan model relays through the gateway of the gate home (O-R5-6 J 7, P6.10, K4)', () => {
  it('reads the listing of the gate home gateway once and writes the relayed server with exactly the keys of the rule and the numbers of the listing into every case home', async (context) => {
    const gateway = await serveModelsListing(context, [listingEntry(PLAN_TARGET, { [PLAN_TARGET]: LISTED_PLAN })]);
    const state = fake();
    const { ports, home } = portsFor(state.effects);
    await publishGateGateway(home, gateway.socketPath);
    await autoModeCheck({ ...ports, models: withPlanAgent() }, { classifier: GUARD, agent: PLAN_MODEL, signal: NEVER_INTERRUPTED });
    expect(gateway.requests).toEqual([MODELS_LISTING_REQUEST]);
    expect(state.roots.size).toBe(AUTO_MODE_RUNS);
    for (const entry of state.roots.values()) {
      const settings = JSON.parse(entry.settings ?? '{}') as { models?: { start?: string; connections?: (Record<string, unknown> & { models: Record<string, unknown>[] })[] } };
      expect(settings.models?.start).toBe(PLAN_TARGET);
      const relayed = settings.models?.connections?.find((connection) => connection['provider'] === 'chatgpt');
      const model = relayed?.models[0];
      expect(Object.keys(relayed ?? {}).sort()).toEqual(RELAY_CONNECTION_KEYS);
      expect(Object.keys(model ?? {}).sort()).toEqual(RELAY_ENTRY_KEYS);
      expect(relayed).toMatchObject({ adapter: 'open-responses', provider: 'chatgpt', socketPath: gateway.socketPath, billing: 'plan' });
      expect(model).toMatchObject({ id: PLAN_MODEL, toolCalling: 'native', maxConcurrency: 4, admissionTimeoutMs: 30000 });
      expect(model?.['capabilities']).toMatchObject({ contextWindow: LISTED_CONTEXT_WINDOW, maxOutputTokens: LISTED_MAX_OUTPUT_TOKENS });
      expect(model?.['capabilities']).not.toHaveProperty('maxConcurrency');
    }
  });

  it('waits for the listing under the signal of the command and opens no home when it is aborted', async (context) => {
    const gateway = await serveModelsListing(context, 'never');
    const state = fake();
    const { ports, home } = portsFor(state.effects);
    await publishGateGateway(home, gateway.socketPath);
    const controller = new AbortController();
    const running = autoModeCheck({ ...ports, models: withPlanAgent() }, { classifier: GUARD, agent: PLAN_MODEL, signal: controller.signal });
    const settled = running.then(
      () => 'settled' as const,
      () => 'settled' as const,
    );
    expect(await Promise.race([gateway.firstRequest, settled])).toBe('requested');
    const reason = new Error('interrupted');
    controller.abort(reason);
    expect(await running.catch((error: unknown) => error)).toBe(reason);
    expect(gateway.requests).toEqual([MODELS_LISTING_REQUEST]);
    expect(state.roots.size).toBe(0);
    expect(recordsIn(home)).toEqual([]);
  });

  it('rejects with the error of the gateway client and opens no home when the gateway of the gate home is not running', async (context) => {
    const absent = absentGatewaySocket(context);
    const expected = await modelsFailureOn(absent);
    const state = fake();
    const { ports, home } = portsFor(state.effects);
    await publishGateGateway(home, absent);
    const failure = await autoModeCheck({ ...ports, models: withPlanAgent() }, { classifier: GUARD, agent: PLAN_MODEL, signal: NEVER_INTERRUPTED }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(expected.constructor);
    expect((failure as Error).message).toBe(expected.message);
    expect(state.roots.size).toBe(0);
    expect(recordsIn(home)).toEqual([]);
  });
});
