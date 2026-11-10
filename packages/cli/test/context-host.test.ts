import { describe, expect, it, vi } from 'vitest';
import type { ResolvedChatCompletionsTarget, UserModels } from '@momonga/config';
import fs from 'node:fs';
import { CONTEXT_DATASET_FORMAT, buildContextReport, expandContextDataset, parseContextDataset } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import { FIRST_GENERATION, generationLayout, momongaLayout, socketPathLimit } from '@momonga/foundation';
import { createFakeKernelLock } from '@momonga/testkit';
import type { MomongaPaths } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import type { OutputFormatterName, PublicRunEvent } from '@momonga/protocol';
import { ContextHostError, ContextInterrupted, assertSocketsFit, caseEnvironment, liveSettingsFor, runContextLive, sweepStaleHomes, unownedHomesNotice } from '../src/eval/context-host.ts';
import type { ContextHostEffects, ContextRuntime } from '../src/eval/context-host.ts';

vi.mock('@momonga/runtime', () => {
  throw new Error('the eval host loaded the runtime; the command supplies what the host needs from it');
});

vi.mock('@momonga/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@momonga/foundation')>()),
  codeDigestOfRunningProcess: () => Promise.reject(new Error('the eval host computed the code digest; the command supplies it')),
}));

const SCRIPTED_ANSWER = { target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' } as const;

const CALLER_CODE_DIGEST = 'a'.repeat(64);

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
  resolved: { aliases: { default: ['t'], other: ['u'] }, targets: { t: target(), u: target({ model: 'other' }) }, dialects: {}, roles: {}, billingChanges: [], headersTimeoutMs: 300_000, idleTimeoutMs: 300_000, servers: { [FM_SERVER.id]: FM_SERVER } },
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
  secrets?: Record<string, string>;
  staleRoots?: { root: string; owner: number; home?: string; holder?: number; held?: boolean }[];
  unreadableRoots?: string[];
  legacyRoots?: string[];
  canonicalPrefix?: string;
};

const OWNER = 7;

const OWNER_HOME = '/home/person';

const OTHER_HOME = '/home/someone-else';

const HOME_SIDECAR_SUFFIX = '.lock';

const harness = (behaviour: Behaviour = {}) => {
  const lock = createFakeKernelLock({ inheritable: false });
  const files = new Map<string, string>();
  const startEnvs: Record<string, string>[] = [];
  const probeCopies: string[] = [];
  const endpointProbeCopies: string[] = [];
  const secretReads: string[] = [];
  const removedDirectories: string[] = [];
  const inputs: string[] = [];
  const adopted: { root: string; request: { text: string } }[] = [];
  const order: string[] = [];
  const addedRules: unknown[] = [];
  const roots = new Map<string, { removed: boolean; settings?: string; pid?: number; cwd?: string }>();
  const alive = new Set<number>();
  const terminated: number[] = [];
  const stopped: string[] = [];
  const memories: unknown[] = [];
  const trusted: string[] = [];
  const holders = new Map<string, number>();
  const sessionRoots: string[] = [];
  let counter = 0;
  let nextPid = 4000;
  const runtimeFor = (root: string): ContextRuntime => {
    const runtime = {
      createSession: async () => {
        counter += 1;
        if (behaviour.failSessionOnRoot === counter) throw new Error('the runtime refused the session');
        return { session: { id: `s${counter}`, modelAlias: 'default' } };
      },
      createRun: async (_session: string, text: string) => {
        order.push('run');
        inputs.push(text);
        return { run: { id: `r${counter}` }, location: '' };
      },
      streamEvents: async function* (): AsyncGenerator<{ data: PublicRunEvent }> {
        if (behaviour.hang === true) await new Promise<void>(() => undefined);
      },
      getRun: async (id: string) => ({ id, sessionId: `s${counter}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 } }),
      runReflection: async () => ({ job: null, charges: [], queuedAhead: 0 }),
      runAnsweredBy: async () => ({ answeredBy: [SCRIPTED_ANSWER] }),
      resolveApproval: async () => ({}),
      cancel: async () => ({ status: 200, run: {} }),
      addRule: async (request: unknown) => {
        addedRules.push(request);
        return { fact: { id: `fact-${addedRules.length}` }, size: [], warnings: [] };
      },
      retireRule: async () => ({ id: 'fact' }),
      addMemory: async (request: unknown) => void memories.push(request),
      setTrust: async (path: string) => void trusted.push(path),
      adoptGuideline: async (request: { text: string }) => {
        order.push('adopt');
        adopted.push({ root, request });
        return { version: adopted.length, text: request.text };
      },
      close: async () => void stopped.push(`close ${root}`),
    };
    return runtime as unknown as ContextRuntime;
  };
  const effects: ContextHostEffects = {
    lock,
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/home/person', XDG_CACHE_HOME: '/home/person/cache', UPSTREAM_KEY: 'k' },
    sessionEnv: async (root) => {
      sessionRoots.push(root);
      return { PATH: '/usr/bin' };
    },
    makeRoot: async () => {
      const root = `/tmp/mc-${'x'.repeat(behaviour.rootLength ?? 6)}${roots.size}`;
      roots.set(root, { removed: false });
      return root;
    },
    ownerPid: OWNER,
    ownerHome: OWNER_HOME,
    readSecret: async (name) => {
      secretReads.push(name);
      const value = behaviour.secrets?.[name];
      if (value === undefined) throw new Error(`no such secret ${name}`);
      return value;
    },
    copyProbeRecord: async (source, paths) => void probeCopies.push(`${source.target} ${source.server} ${source.binary} -> ${paths.probe}`),
    copyEndpointProbeRecord: async (probe, paths) =>
      void endpointProbeCopies.push(`${probe.endpoint} ${probe.model} -> ${paths.probe}`),
    listRoots: async () => [...roots.keys(), ...(behaviour.staleRoots ?? []).map((stale) => stale.root), ...(behaviour.unreadableRoots ?? []), ...(behaviour.legacyRoots ?? [])],
    readOwner: async (root) => {
      if (behaviour.unreadableRoots?.includes(root) === true) return 'unreadable';
      if (behaviour.legacyRoots?.includes(root) === true) return 'legacy';
      const text = files.get(`${root}/.momonga-eval-owner`);
      return text === undefined ? undefined : (JSON.parse(text) as { pid: number; home: string });
    },
    prepare: async () => undefined,
    writeFile: async (file, text) => {
      files.set(file, text);
      for (const [root, state] of roots) if (file === `${root}/.momonga/settings.json`) state.settings = text;
    },
    makeDirectory: async () => undefined,
    canonical: async (directory) => `${behaviour.canonicalPrefix ?? ''}${directory}`,
    startDaemon: async (root, _paths, env) => {
      startEnvs.push({ ...env });
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
      removedDirectories.push(directory);
      const state = roots.get(directory);
      if (state !== undefined) state.removed = true;
    },
    connect: (paths) => runtimeFor(paths.root.replace(/\/\.momonga$/, '')),
    applyStep: async () => undefined,
    after: (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    now: () => 0,
  };
  for (const stale of behaviour.staleRoots ?? []) {
    files.set(`${stale.root}/.momonga-eval-owner`, JSON.stringify({ pid: stale.owner, home: stale.home ?? OWNER_HOME }));
    nextPid += 1;
    if (stale.holder !== undefined) {
      alive.add(stale.holder);
      holders.set(stale.root, stale.holder);
    }
    if (stale.held === true) lock.holdExternally(`${stale.root}${HOME_SIDECAR_SUFFIX}`, stale.owner);
  }
  return { lock, effects, sessionRoots, roots, alive, terminated, stopped, memories, trusted, files, startEnvs, probeCopies, endpointProbeCopies, secretReads, removedDirectories, inputs, addedRules, adopted, order };
};

const input = (extra: Partial<Parameters<typeof runContextLive>[1]> = {}): Parameters<typeof runContextLive>[1] => ({
  dataset: dataset(),
  seed: 1,
  alias: 'default',
  models: userModels(),
  limits: { maxTotalTokens: 1000, defaultTimeoutMs: 60_000 },
  reflection: { pendingBoundMs: 2000, attemptBoundMs: 9000, pollMs: 100 },
  codeDigest: CALLER_CODE_DIGEST,
  ...extra,
});

const noDaemonLeft = (context: ReturnType<typeof harness>): void => {
  expect([...context.alive]).toEqual([]);
  expect([...context.roots.values()].map((state) => state.removed)).not.toContain(false);
};

describe('a live context run with a guideline', () => {
  it('guards a door for tests: every case adopts it through the run api of its own daemon, before its first run', async () => {
    const context = harness();
    await runContextLive(context.effects, input({ guideline: 'keep test names' }));
    expect(context.adopted.map((entry) => [entry.root, entry.request.text])).toEqual([
      ['/tmp/mc-xxxxxx0', 'keep test names'],
      ['/tmp/mc-xxxxxx1', 'keep test names'],
    ]);
    expect(context.order[0]).toBe('adopt');
    expect(context.order.indexOf('adopt', 1)).toBeGreaterThan(context.order.indexOf('run'));
    expect([...context.files.values()].join('\n')).not.toContain('keep test names');
    const baseline = harness();
    await runContextLive(baseline.effects, input());
    expect(baseline.adopted).toEqual([]);
  });
});

describe('what a live context run takes from its caller', () => {
  it('records the code digest its caller gives and computes nothing about the running process itself', async () => {
    const context = harness();
    const stored: Transcript[] = [];
    await runContextLive(context.effects, input({ onTranscript: async (transcript) => void stored.push(transcript) }));
    expect(stored.map((transcript) => transcript.codeDigest)).toEqual([CALLER_CODE_DIGEST, CALLER_CODE_DIGEST]);
  });
});

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

  it('asks for the session environment of every case with the root of that case', async () => {
    const context = harness();
    await runContextLive(context.effects, input());
    expect(context.sessionRoots).toEqual(['/tmp/mc-xxxxxx0', '/tmp/mc-xxxxxx1']);
  });

  it('measures the sockets on the canonical path of the home, the one the supervisor builds them from', async () => {
    const limit = socketPathLimit('darwin');
    const probe = '/tmp/mc-0';
    const suffix = Math.max(...Object.values(generationLayout(probe, FIRST_GENERATION, 'darwin').sockets).map((socket) => Buffer.byteLength(socket))) - Buffer.byteLength(probe);
    const canonicalPrefix = '/private';
    const rootLength = limit - 1 - suffix - Buffer.byteLength('/tmp/mc-') - 1;
    const plain = harness({ rootLength });
    await runContextLive(plain.effects, input());
    expect(plain.roots.size).toBe(2);
    const canonical = harness({ rootLength, canonicalPrefix });
    await expect(runContextLive(canonical.effects, input())).rejects.toThrow(new RegExp(`${canonicalPrefix}/tmp/mc-.*must be shorter than ${limit} bytes`));
    noDaemonLeft(canonical);
  });

  it('refuses a temporary home whose sockets would not fit and removes it', async () => {
    const context = harness({ rootLength: 90 });
    await expect(runContextLive(context.effects, input())).rejects.toThrow(/must be shorter than 104 bytes/);
    expect(context.alive.size).toBe(0);
    noDaemonLeft(context);
  });
});

describe('the settings, credentials and probe records of a live run', () => {
  const SECRET_VALUE = 'sk-secret-value-0123456789abcdef';

  const secretModels = (): UserModels => {
    const models = userModels();
    models.resolved.targets['t'] = target({ apiKeySecret: 'work-key' });
    models.declared.targets = { ...models.declared.targets, t: { ...declaredTarget, apiKeyEnv: undefined, apiKeySecret: 'work-key' } as never };
    return models;
  };

  it('writes the sandbox of the person into every case settings file', async () => {
    const context = harness();
    await runContextLive(context.effects, input({ models: { ...userModels(), sandbox: 'none' } }));
    const settings = [...context.roots.values()].map((state) => JSON.parse(state.settings ?? '{}'));
    expect(settings.map((entry) => entry.sandbox)).toEqual(['none', 'none']);
  });

  it('reads the secret once with the store of the person and puts it only in the environment of each daemon start', async () => {
    const context = harness({ secrets: { 'work-key': SECRET_VALUE } });
    const stored: Transcript[] = [];
    await runContextLive(context.effects, input({ models: secretModels(), onTranscript: async (transcript) => void stored.push(transcript) }));
    expect(context.secretReads).toEqual(['work-key']);
    expect(context.startEnvs.map((env) => env['MOMONGA_EVAL_KEY_0'])).toEqual([SECRET_VALUE, SECRET_VALUE]);
    const written = [...context.files.values(), JSON.stringify(stored), JSON.stringify(context.memories)];
    expect(written.some((text) => text.includes(SECRET_VALUE))).toBe(false);
    expect([...context.roots.values()].every((state) => (state.settings ?? '').includes('"apiKeyEnv": "MOMONGA_EVAL_KEY_0"'))).toBe(true);
  });

  it('starts nothing and says why when the secret cannot be read', async () => {
    const context = harness();
    await expect(runContextLive(context.effects, input({ models: secretModels() }))).rejects.toThrow(/secret work-key.*could not be read.*momonga secret set work-key/);
    expect(context.roots.size).toBe(0);
  });

  it('copies the probe record of a managed target into every case home', async () => {
    const models = userModels();
    models.resolved.targets['t'] = { adapter: 'managed', server: 'fm', binary: '/usr/bin/fm', readyTimeoutMs: 10_000, model: 'system', toolCalling: 'native', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 1000 } as unknown as ResolvedChatCompletionsTarget;
    models.declared.targets = { ...models.declared.targets, t: { adapter: 'managed', server: 'fm' } };
    const context = harness();
    await runContextLive(context.effects, input({ models }));
    expect(context.probeCopies).toEqual(['t fm /usr/bin/fm -> /tmp/mc-xxxxxx0/.momonga/state/probe', 't fm /usr/bin/fm -> /tmp/mc-xxxxxx1/.momonga/state/probe']);
  });

  it('names the endpoint probe record of a chat-completions target with toolCalling auto', () => {
    const models = userModels();
    models.resolved.targets['t'] = target({ toolCalling: 'auto' as never });
    models.declared.targets = { ...models.declared.targets, t: { ...declaredTarget, toolCalling: 'auto' } as never };
    const settings = liveSettingsFor(models, ['default']);
    expect(settings.endpointProbes).toEqual([{ endpoint: 'https://upstream.invalid/v1', model: 'm' }]);
    expect(liveSettingsFor(userModels(), ['default']).endpointProbes).toEqual([]);
  });

  it('copies the endpoint probe record of an auto target into every case home', async () => {
    const models = userModels();
    models.resolved.targets['t'] = target({ toolCalling: 'auto' as never });
    models.declared.targets = { ...models.declared.targets, t: { ...declaredTarget, toolCalling: 'auto' } as never };
    const context = harness();
    await runContextLive(context.effects, input({ models }));
    expect(context.endpointProbeCopies).toEqual([
      'https://upstream.invalid/v1 m -> /tmp/mc-xxxxxx0/.momonga/state/probe',
      'https://upstream.invalid/v1 m -> /tmp/mc-xxxxxx1/.momonga/state/probe',
    ]);
  });

  it('copies the endpoint probe record of an ollama target into every case home', async () => {
    const models = userModels();
    models.resolved.targets['t'] = { ...target(), adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3' } as never;
    models.declared.targets = { ...models.declared.targets, t: { adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } as never };
    const context = harness();
    await runContextLive(context.effects, input({ models }));
    expect(context.endpointProbeCopies).toEqual([
      'http://127.0.0.1:11434 qwen3 -> /tmp/mc-xxxxxx0/.momonga/state/probe',
      'http://127.0.0.1:11434 qwen3 -> /tmp/mc-xxxxxx1/.momonga/state/probe',
    ]);
  });
});

describe('the shipped context dataset with the fake model', () => {
  it('expands, validates and runs end to end: every run is recorded, the rules and memories reach the case, and the noise is played', async () => {
    const text = fs.readFileSync(new URL('../../eval/datasets/context.json', import.meta.url), 'utf8');
    const shipped = parseContextDataset(text, 'context.json');
    const context = harness();
    const transcripts = await runContextLive(context.effects, input({ dataset: shipped, seed: 11 }));
    const expected = shipped.cases.reduce((sum, entry) => sum + entry.runs, 0);
    expect(transcripts).toHaveLength(expected);
    expect(transcripts.every((transcript) => transcript.stopped === undefined && transcript.datasetSeed === 11)).toBe(true);
    const expandedCases = expandContextDataset(shipped, 11).cases;
    const ruleCount = expandedCases.reduce((sum, entry) => sum + entry.rules.length, 0);
    const memoryCount = expandedCases.reduce((sum, entry) => sum + (entry.memories ?? []).length, 0);
    const noiseRuns = expandedCases.reduce((sum, entry) => sum + entry.noiseTurns.length * entry.runs, 0);
    expect(context.addedRules).toHaveLength(ruleCount);
    expect(context.memories).toHaveLength(memoryCount);
    expect(context.inputs).toHaveLength(expected + noiseRuns);
    const lint = transcripts.find((transcript) => transcript.caseId === 'lint-chain-on');
    expect(Object.values(lint?.ruleIds ?? {}).sort()).toEqual(['lint-0', 'lint-1']);
    const ungolded = { ...shipped, cases: shipped.cases.map(({ gold: _anchors, ...rest }) => rest) };
    const report = buildContextReport({ dataset: ungolded, transcripts, seed: 1, datasetSeed: 11 });
    expect(report.model).toBe('fake');
    expect(transcripts.every((transcript) => transcript.answeredBy?.[0]?.answers === 'script')).toBe(true);
    expect(report.stopped).toEqual([]);
    expect(report.cases.map((entry) => entry.id)).toEqual(shipped.cases.map((entry) => entry.id));
    expect(report.noiseTokens).toBe(noiseRuns);
    noDaemonLeft(context);
  });
});

describe('a home left by a CLI that was killed', () => {
  it('is removed at the next start, with its daemon, when no one holds the lock of its sidecar, even when its marker names a live pid', async () => {
    const context = harness({ staleRoots: [{ root: '/tmp/mc-stale0', owner: OWNER, holder: 5000 }] });
    expect(await sweepStaleHomes(context.effects)).toEqual({ removed: ['/tmp/mc-stale0'], unreadable: 0, unowned: [] });
    expect(context.terminated).toEqual([5000]);
    expect(context.removedDirectories).toEqual(['/tmp/mc-stale0']);
  });

  it('skips and counts an entry it cannot read, and still removes the stale home beside it', async () => {
    const context = harness({ staleRoots: [{ root: '/tmp/mc-stale0', owner: 99 }], unreadableRoots: ['/tmp/mc-locked', '/tmp/mc-file'] });
    expect(await sweepStaleHomes(context.effects)).toEqual({ removed: ['/tmp/mc-stale0'], unreadable: 2, unowned: [] });
    expect(context.removedDirectories).toEqual(['/tmp/mc-stale0']);
  });

  it('never removes a home with an old plain-pid marker, and names it as unowned', async () => {
    const context = harness({ staleRoots: [{ root: '/tmp/mc-stale0', owner: 99 }], legacyRoots: ['/tmp/mc-old1', '/tmp/mc-old2'] });
    expect(await sweepStaleHomes(context.effects)).toEqual({ removed: ['/tmp/mc-stale0'], unreadable: 0, unowned: ['/tmp/mc-old1', '/tmp/mc-old2'] });
    expect(context.removedDirectories).toEqual(['/tmp/mc-stale0']);
  });

  it('reports the unowned homes to the caller of a live run and starts its cases', async () => {
    const context = harness({ legacyRoots: ['/tmp/mc-old1'] });
    const reported: string[][] = [];
    await runContextLive(context.effects, input({ onUnownedHomes: (roots) => void reported.push([...roots]) }));
    expect(reported).toEqual([['/tmp/mc-old1']]);
    expect(context.roots.size).toBe(2);
  });

  it('words the notice so that it names every unowned home', () => {
    expect(unownedHomesNotice(['/tmp/mc-old1', '/tmp/mc-old2'])).toContain('/tmp/mc-old1');
    expect(unownedHomesNotice(['/tmp/mc-old1', '/tmp/mc-old2'])).toContain('/tmp/mc-old2');
    expect(unownedHomesNotice(['/tmp/mc-old1']).endsWith('\n')).toBe(true);
  });

  it('reports the unreadable entries to the caller of a live run and starts its cases', async () => {
    const context = harness({ unreadableRoots: ['/tmp/mc-locked'] });
    const counts: number[] = [];
    await runContextLive(context.effects, input({ onUnreadableHomes: (count) => void counts.push(count) }));
    expect(counts).toEqual([1]);
    expect(context.roots.size).toBe(2);
  });

  it('is left alone while the lock of its sidecar is held, even when its marker names a dead pid, and when it names no owner', async () => {
    const context = harness({ staleRoots: [{ root: '/tmp/mc-live', owner: 99, holder: 5000, held: true }, { root: '/tmp/mc-foreign', owner: 99 }] });
    context.files.delete('/tmp/mc-foreign/.momonga-eval-owner');
    expect(await sweepStaleHomes(context.effects)).toEqual({ removed: [], unreadable: 0, unowned: [] });
    expect(context.removedDirectories).toEqual([]);
    expect(context.terminated).toEqual([]);
  });

  it('is swept by a live run before its own cases start, and the marker of each case names this process', async () => {
    const context = harness({ staleRoots: [{ root: '/tmp/mc-stale0', owner: 99 }] });
    await runContextLive(context.effects, input());
    expect(context.removedDirectories).toContain('/tmp/mc-stale0');
    expect(JSON.parse(context.files.get('/tmp/mc-xxxxxx0/.momonga-eval-owner') ?? 'null')).toEqual({ pid: OWNER, home: OWNER_HOME });
  });

  it('survives the sweep of a run of another momonga home, with its daemon', async () => {
    const context = harness({
      staleRoots: [
        { root: '/tmp/mc-theirs', owner: 99, home: OTHER_HOME, holder: 5000 },
        { root: '/tmp/mc-mine', owner: 98, holder: 5001 },
      ],
    });
    expect(await sweepStaleHomes(context.effects)).toEqual({ removed: ['/tmp/mc-mine'], unreadable: 0, unowned: [] });
    expect(context.removedDirectories).toEqual(['/tmp/mc-mine']);
    expect(context.terminated).toEqual([5001]);
  });
});

describe('the models of a live run', () => {
  it('copies only the target definitions the alias reaches', () => {
    expect(liveSettingsFor(userModels(), ['other']).models).toEqual({ aliases: { other: ['u'] }, targets: { u: userModels().declared.targets?.['u'] } });
  });

  it('replaces the secret of a target by a generated environment variable name and keeps the secret name out of the settings', () => {
    const models = userModels();
    models.resolved.targets['t'] = target({ apiKeySecret: 'work-key' });
    models.declared.targets = { ...models.declared.targets, t: { ...declaredTarget, apiKeySecret: 'work-key' } as never };
    const settings = liveSettingsFor(models, ['default']);
    expect(settings.credentials).toEqual([{ envName: 'MOMONGA_EVAL_KEY_0', secretName: 'work-key' }]);
    expect(JSON.stringify(settings.models)).not.toContain('work-key');
    expect(settings.models.targets?.['t']).toMatchObject({ apiKeyEnv: 'MOMONGA_EVAL_KEY_0' });
  });

  it('names the managed targets whose probe record a case needs, with the server, binary and model the probe key is read from', () => {
    const models = userModels();
    models.resolved.targets['t'] = { adapter: 'managed', server: 'fm', binary: '/usr/bin/fm', readyTimeoutMs: 10_000, model: 'system', toolCalling: 'native', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 1000 } as unknown as ResolvedChatCompletionsTarget;
    models.declared.targets = { ...models.declared.targets, t: { adapter: 'managed', server: 'fm' } };
    const settings = liveSettingsFor(models, ['default']);
    expect(settings.managedTargets).toEqual([{ target: 't', server: 'fm', binary: '/usr/bin/fm', model: 'system' }]);
    expect(settings.models.targets?.['t']).toEqual({ adapter: 'managed', server: 'fm' });
  });

  it('carries the sandbox the person set, and none when the person set none', () => {
    expect(liveSettingsFor({ ...userModels(), sandbox: 'none' }, ['default']).sandbox).toBe('none');
    expect(liveSettingsFor(userModels(), ['default'])).not.toHaveProperty('sandbox');
  });

  it('refuses an unknown alias and a target that is not declared', () => {
    expect(() => liveSettingsFor(userModels(), ['missing'])).toThrow(/alias missing is not defined/);
    const models = userModels();
    models.declared.targets = {};
    expect(() => liveSettingsFor(models, ['default'])).toThrow(ContextHostError);
  });
});

describe('the isolation of a case', () => {
  it('points HOME at the temporary home, drops the variables that relocate the cache and keeps the credential variables', () => {
    const env = caseEnvironment({ PATH: '/usr/bin', HOME: '/home/person', XDG_CACHE_HOME: '/c', XDG_DATA_HOME: '/d', UPSTREAM_KEY: 'k', EMPTY: undefined }, '/tmp/mc-abc123', 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/mc-abc123', UPSTREAM_KEY: 'k' });
  });

  it('accepts a short temporary home and refuses a long one, with the limit of the platform', () => {
    expect(() => assertSocketsFit('/tmp/mc-abc123', 'darwin')).not.toThrow();
    expect(() => assertSocketsFit(`/tmp/${'a'.repeat(69)}`, 'darwin')).toThrow(/shorter than 104 bytes on darwin/);
    expect(() => assertSocketsFit(`/tmp/${'a'.repeat(69)}`, 'linux')).not.toThrow();
  });
});

const RESOLVED_ON = {
  context: { adaptiveBudget: true, autoCompact: true, cachePrefix: true, loopGuidance: true, observedCapacity: true, outputFormatters: ['grep', 'identicalOutput', 'json', 'log'] as OutputFormatterName[], unboundedOutputReserve: true },
  tools: { conciseDescriptions: true, deferral: true },
  memory: { reflection: { enabled: true }, repositoryFacts: true },
};

describe('the identity a live run stamps on its transcripts (design core-on 3.2, test 9)', () => {
  const HEAD_CODE = 'b'.repeat(64);

  it('records the --settings overlay resolved over the defaults, and the code digest of the CLI, in every transcript', async () => {
    const context = harness();
    const stored: Transcript[] = [];
    const policy = { context: { cachePrefix: false } };
    const transcripts = await runContextLive(context.effects, input({ policy, codeDigest: HEAD_CODE, onTranscript: async (transcript) => void stored.push(transcript) }));
    expect(transcripts).toHaveLength(2);
    for (const transcript of [...transcripts, ...stored]) {
      expect(transcript.policy).toEqual({ ...RESOLVED_ON, context: { ...RESOLVED_ON.context, cachePrefix: false } });
      expect(transcript.codeDigest).toBe(HEAD_CODE);
    }
  });

  it('records the resolved on policy without an overlay', async () => {
    const context = harness();
    const transcripts = await runContextLive(context.effects, input({ codeDigest: HEAD_CODE }));
    expect(transcripts.map((transcript) => [transcript.policy, transcript.codeDigest])).toEqual([
      [RESOLVED_ON, HEAD_CODE],
      [RESOLVED_ON, HEAD_CODE],
    ]);
  });
});
