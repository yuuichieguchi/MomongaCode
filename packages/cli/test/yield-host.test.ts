import { describe, expect, it, vi } from 'vitest';
import type { UserModels } from '@momonga/config';
import { YIELD_ACCEPTANCE, YIELD_DATASET_FORMAT, YIELD_REPORT_KIND, buildYieldReport, formatYieldReport, judgeYield, parseYieldDataset } from '@momonga/eval';
import type { EntryIo, MomongaPaths } from '@momonga/foundation';
import type { MemoryView, PublicRunEvent } from '@momonga/protocol';
import { createFakeKernelLock } from '@momonga/testkit';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { ContextInterrupted, liveSettingsFor } from '../src/eval/context-host.ts';
import { candidatesOfRun, runYieldLive } from '../src/eval/yield-host.ts';
import type { YieldHostEffects, YieldRuntime } from '../src/eval/yield-host.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { freshHome } from './fresh-home.ts';
import { userModelsOf } from './user-models.ts';
import { NO_HELPER } from './no-helper.ts';

vi.mock('@momonga/runtime', () => {
  throw new Error('the yield host loaded the runtime; the command supplies what the host needs from it');
});

const PINNED = 'p/m';
const CODE_DIGEST = 'a'.repeat(64);
const FAMILY_IDS = ['port', 'codename', 'tag', 'variable'] as const;
const anchorOf = (id: string): string => `fact-of-${id}`;
const EVERY_ANCHOR = FAMILY_IDS.map(anchorOf).join(' ');

const family = (id: string) => ({
  id,
  learn: { input: `learn ${id}`, permissionMode: 'acceptEdits', onAsk: 'allow_once', files: { 'notes.txt': 'nothing\n' }, verification: `node check-${id}.mjs` },
  reuse: { input: `reuse ${id}`, permissionMode: 'acceptEdits', onAsk: 'allow_once', graders: [{ kind: 'status', equals: 'COMPLETED' }] },
  accept: { anchors: [anchorOf(id)] },
});

const DATASET_TEXT = JSON.stringify({ format: YIELD_DATASET_FORMAT, name: 'yield', families: FAMILY_IDS.map(family) });

const dataset = () => parseYieldDataset(DATASET_TEXT, 'yield.json');

const userModels = (): UserModels =>
  userModelsOf({
    connections: [{ adapter: 'chat-completions', provider: 'p', baseUrl: 'https://upstream.invalid/v1', apiKeyEnv: 'UPSTREAM_KEY', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }],
  });

const memoryView = (id: string, text: string, runId: string, state: string, project: string): MemoryView =>
  ({
    id,
    scope: 'project',
    origin: 'trusted',
    project,
    text,
    source: { kind: 'reflection', sessionId: 's', runId, ordinal: 0 },
    createdAt: 1,
    keptAt: 1,
    kind: 'fact',
    state,
    duplicateOf: null,
    supersedes: [],
    supersededBy: [],
    retiredAt: null,
    evidence: [
      { kind: 'file', project, path: 'notes.txt', sha256: 'f'.repeat(64) },
      { kind: 'check', runId, callId: 'c', seq: 3, command: 'node check.mjs', exitCode: 0 },
      { kind: 'file', project, path: 'notes.txt', sha256: 'f'.repeat(64) },
    ],
    contributedAt: null,
    status: 'verified',
  }) as MemoryView;

type Behaviour = { candidateText?: string; hang?: boolean; failCopyTo?: string };

const harness = (behaviour: Behaviour = {}) => {
  const files = new Map<string, string>();
  const roots: string[] = [];
  const removed: string[] = [];
  const terminated: string[] = [];
  const copies: { from: string; to: string }[] = [];
  const seeded: unknown[] = [];
  const memoryFilters: unknown[] = [];
  const trusted: string[] = [];
  const inputs: { root: string; text: string }[] = [];
  const runtimeFor = (root: string): YieldRuntime => {
    const cwd = `${root}/w`;
    const runId = `run-${root}`;
    const runtime = {
      createSession: async () => ({ session: { id: `s-${root}`, model: PINNED } }),
      createRun: async (_session: string, text: string) => {
        inputs.push({ root, text });
        return { run: { id: runId }, location: '' };
      },
      streamEvents: async function* (): AsyncGenerator<{ id: number; data: PublicRunEvent }> {
        if (behaviour.hang === true) await new Promise<void>(() => undefined);
      },
      getRun: async (id: string) => ({ id, sessionId: `s-${root}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1 } }),
      runReflection: async () => ({ job: { runId, state: 'done', attempts: 1, reason: null, dropped: [], updatedAt: 0 }, charges: [], queuedAhead: 0 }),
      runAnsweredBy: async () => ({ answeredBy: [{ target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' }] }),
      reportCost: async (runIds: readonly string[]) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
      resolveApproval: async () => ({}),
      cancel: async () => ({ status: 200, run: {} }),
      addRule: async () => ({ fact: { id: 'fact' }, size: [], warnings: [] }),
      retireRule: async () => ({ id: 'fact' }),
      addMemory: async (request: unknown) => {
        seeded.push(request);
        return { id: `mem-${seeded.length}` };
      },
      memories: async (filter: unknown) => {
        memoryFilters.push(filter);
        return [
          memoryView('c1', behaviour.candidateText ?? `The values are ${EVERY_ANCHOR}.`, runId, 'candidate', cwd),
          memoryView('c2', 'The check passes.', runId, 'candidate', cwd),
          memoryView('c3', `Another run found ${EVERY_ANCHOR}.`, 'run-of-another-session', 'candidate', cwd),
        ];
      },
      setTrust: async (directory: string) => void trusted.push(directory),
      adoptGuideline: async () => ({ version: 1, text: '' }),
      close: async () => undefined,
    };
    return runtime as unknown as YieldRuntime;
  };
  const effects: YieldHostEffects = {
    lock: createFakeKernelLock({ inheritable: false }),
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/home/person', UPSTREAM_KEY: 'k' },
    sessionEnv: async () => ({ PATH: '/usr/bin' }),
    makeRoot: async () => {
      const root = `/tmp/mc-y${roots.length}`;
      roots.push(root);
      return root;
    },
    ownerPid: 7,
    ownerHome: '/home/person',
    readSecret: async (name) => Promise.reject(new Error(`no secret ${name}`)),
    copyProbeRecord: async () => undefined,
    copyEndpointProbeRecord: async () => undefined,
    listRoots: async () => [],
    readOwner: async () => undefined,
    prepare: async () => undefined,
    writeFile: async (file, text) => void files.set(file, text),
    makeDirectory: async () => undefined,
    canonical: async (directory) => directory,
    startDaemon: async () => undefined,
    refuseUnfitSockets: async () => undefined,
    terminate: async (paths: MomongaPaths) => void terminated.push(paths.root),
    remove: async (directory) => void removed.push(directory),
    connect: (paths) => runtimeFor(paths.root.replace(/\/\.momonga$/, '')),
    applyStep: async () => undefined,
    after: (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    now: () => 0,
    random: () => 0,
    copyWorkspace: async (from, to) => {
      if (behaviour.failCopyTo === to) throw new Error('the workspace could not be copied');
      copies.push({ from, to });
    },
  };
  const settingsOf = (root: string): unknown => JSON.parse(files.get(`${root}/.momonga/settings.json`) ?? 'null');
  return { effects, files, roots, removed, terminated, copies, seeded, memoryFilters, trusted, inputs, settingsOf };
};

const input = (extra: Partial<Parameters<typeof runYieldLive>[1]> = {}): Parameters<typeof runYieldLive>[1] => ({
  dataset: dataset(),
  model: PINNED,
  models: userModels(),
  reflection: { pendingBoundMs: 2000, attemptBoundMs: 9000, pollMs: 100 },
  codeDigest: CODE_DIGEST,
  interrupt: new AbortController().signal,
  ...extra,
});

describe('a live yield run', () => {
  it('gives the three sessions of a family three homes with the same settings, the verification command of the family in them', async () => {
    const context = harness();
    await runYieldLive(context.effects, input());
    expect(context.roots).toHaveLength(3 * FAMILY_IDS.length);
    const [learn, without, withArm] = context.roots.slice(0, 3).map(context.settingsOf);
    expect(learn).toEqual({ models: liveSettingsFor(userModels(), [PINNED]).models, verification: { commands: ['node check-port.mjs'] } });
    expect(without).toEqual(learn);
    expect(withArm).toEqual(learn);
    expect(context.trusted.slice(0, 3)).toEqual(['/tmp/mc-y0/w', '/tmp/mc-y1/w', '/tmp/mc-y2/w']);
    expect(context.inputs.slice(0, 3)).toEqual([
      { root: '/tmp/mc-y0', text: 'learn port' },
      { root: '/tmp/mc-y1', text: 'reuse port' },
      { root: '/tmp/mc-y2', text: 'reuse port' },
    ]);
  });

  it('writes the files of the family into the learn workspace only and copies the workspace the learn session left into both arms', async () => {
    const context = harness();
    await runYieldLive(context.effects, input());
    expect([...context.files.keys()].filter((file) => file.endsWith('/notes.txt'))).toEqual(['/tmp/mc-y0/w/notes.txt', '/tmp/mc-y3/w/notes.txt', '/tmp/mc-y6/w/notes.txt', '/tmp/mc-y9/w/notes.txt']);
    expect(context.copies.slice(0, 2)).toEqual([
      { from: '/tmp/mc-y0/w', to: '/tmp/mc-y1/w' },
      { from: '/tmp/mc-y0/w', to: '/tmp/mc-y2/w' },
    ]);
  });

  it('reads the candidates of the learn run and seeds the accepted ones in the with arm only, with the paths of their file evidence', async () => {
    const context = harness();
    const runs = await runYieldLive(context.effects, input());
    expect(context.memoryFilters[0]).toEqual({ project: '/tmp/mc-y0/w', state: 'candidate' });
    expect(context.seeded).toHaveLength(FAMILY_IDS.length);
    expect(context.seeded[0]).toEqual({ text: `The values are ${EVERY_ANCHOR}.`, scope: 'project', project: '/tmp/mc-y2/w', paths: ['notes.txt'] });
    expect(runs[0]).toMatchObject({ familyId: 'port', candidates: [{ paths: ['notes.txt'] }, { text: 'The check passes.' }], accepted: [{ paths: ['notes.txt'] }], with: { seeded: ['mem-1'] } });
    expect(runs[0]?.learn.reflection).toEqual({ state: 'done' });
    expect(runs.map((run) => run.learn.codeDigest)).toEqual(FAMILY_IDS.map(() => CODE_DIGEST));
  });

  it('opens no with arm for a family whose candidates hold no anchor', async () => {
    const context = harness({ candidateText: 'Nothing of use.' });
    const runs = await runYieldLive(context.effects, input());
    expect(context.roots).toHaveLength(2 * FAMILY_IDS.length);
    expect(context.seeded).toEqual([]);
    expect(runs.every((run) => run.with === undefined)).toBe(true);
  });

  it('stops every daemon and removes every home, also when a copy fails and when the run is interrupted', async () => {
    const done = harness();
    await runYieldLive(done.effects, input());
    expect(done.removed.sort()).toEqual([...done.roots].sort());
    expect(done.terminated).toHaveLength(done.roots.length);
    const failing = harness({ failCopyTo: '/tmp/mc-y2/w' });
    await expect(runYieldLive(failing.effects, input())).rejects.toThrow('the workspace could not be copied');
    expect(failing.removed.sort()).toEqual(['/tmp/mc-y0', '/tmp/mc-y1', '/tmp/mc-y2']);
    const hanging = harness({ hang: true });
    const controller = new AbortController();
    const running = runYieldLive(hanging.effects, input({ interrupt: controller.signal }));
    await vi.waitFor(() => expect(hanging.inputs).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(ContextInterrupted);
    expect(hanging.removed).toEqual(['/tmp/mc-y0']);
  });

  it('gives a report that fails real_model for a scripted model and says the rule of acceptance', async () => {
    const context = harness();
    const runs = await runYieldLive(context.effects, input());
    const report = buildYieldReport({ dataset: dataset(), runs, seed: 1 });
    const gate = judgeYield(report, { seed: 1 });
    expect(report).toMatchObject({ kind: YIELD_REPORT_KIND, acceptance: YIELD_ACCEPTANCE, model: 'fake', models: [PINNED], codeDigest: CODE_DIGEST });
    expect(gate.passed).toBe(false);
    expect(gate.checks.find((check) => check.name === 'real_model')?.passed).toBe(false);
    expect(formatYieldReport(report, gate)).toContain('if accepted by the dataset anchors');
  });
});

describe('the candidates of a learn run', () => {
  it('are the memories its reflection proposed that still wait, with the paths of their file evidence once each', () => {
    const views = [
      memoryView('a', 'kept', 'r1', 'candidate', '/w'),
      memoryView('b', 'of another run', 'r2', 'candidate', '/w'),
      memoryView('c', 'already rejected', 'r1', 'rejected', '/w'),
      { ...memoryView('d', 'saved by a tool', 'r1', 'candidate', '/w'), source: { kind: 'tool', sessionId: 's', runId: 'r1', step: 1, callId: 'c', seq: 1 } } as MemoryView,
    ];
    expect(candidatesOfRun(views, 'r1')).toEqual([{ text: 'kept', paths: ['notes.txt'] }]);
  });
});

const program = () => {
  const completed: number[] = [];
  const ports = {
    version: '9.9.9',
    home: freshHome(),
    cwd: '/w',
    terminal: undefined,
    stdout: { write: () => undefined },
    files: {
      readText: async (file: string) => {
        if (file !== '/w/yield.json') throw new Error(`no fixture for ${file}`);
        return DATASET_TEXT;
      },
    },
  } as unknown as CliPorts;
  const built = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/w/cache/executables' }),
    entries: {} as DaemonEntries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: (code) => completed.push(code),
  });
  built.exitOverride().configureOutput({ writeErr: () => undefined });
  for (const command of built.commands) {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    for (const nested of command.commands) nested.exitOverride().configureOutput({ writeErr: () => undefined });
  }
  return { built, completed };
};

describe('momonga eval yield', () => {
  it('is a command of eval that names the model by --model and stores its report with --report', () => {
    const command = program().built.commands.find((entry) => entry.name() === 'eval')?.commands.find((entry) => entry.name() === 'yield');
    expect(command?.options.map((option) => [option.long, option.mandatory])).toEqual([
      ['--model', true],
      ['--report', true],
    ]);
    expect(command?.description()).not.toMatch(/alias|target/i);
  });

  it('refuses a run without --model or without --report before anything starts', async () => {
    const first = program();
    await expect(first.built.parseAsync(['node', 'momonga', 'eval', 'yield', 'yield.json', '--report', 'r.json'])).rejects.toThrow(/--model/);
    const second = program();
    await expect(second.built.parseAsync(['node', 'momonga', 'eval', 'yield', 'yield.json', '--model', PINNED])).rejects.toThrow(/--report/);
    expect([...first.completed, ...second.completed]).toEqual([]);
  });
});
