import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeWorkspaceFiles, parseDataset, treeDigest } from '@momonga/eval';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort, launchGroupLeader } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { PublicRunEvent } from '@momonga/protocol';
import { createFakeKernelLock, createTempDir } from '@momonga/testkit';
import { runBenchLive } from '../src/commands/bench.ts';
import type { BenchHostEffects } from '../src/commands/bench.ts';
import { runGoldenLive } from '../src/commands/evaluate.ts';
import { nodeWorkspaceProbeOf } from '../src/node-ports.ts';
import { userModelsOf } from './user-models.ts';

const PINNED = 'p/m';
const T0 = 1_800_000_000_000;
const BUGGY = 'exports.add = (a, b) => a - b;\n';
const TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\n";

const created: string[] = [];

const createWorkspaceProbe = nodeWorkspaceProbeOf(
  {
    start: async (command, cwd, env) => {
      const { pgid, onExit } = await launchGroupLeader({ file: '/bin/sh', args: ['-c', command], cwd, env, stdio: ['ignore', 'ignore', 'ignore'], protection: CONTROL_PLANE_LAUNCH });
      if (pgid === undefined) throw new Error('the command started with no process group');
      return { pgid, exited: new Promise((resolve, reject) => onExit(({ code }) => resolve({ code }), reject)) };
    },
  },
  hostProcessGroupPort(),
);
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = createTempDir();
  created.push(dir);
  return dir;
};

const userModels = () =>
  userModelsOf({
    connections: [{ adapter: 'chat-completions', provider: 'p', baseUrl: 'https://upstream.invalid/v1', apiKeyEnv: 'UPSTREAM_KEY', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }],
    start: PINNED,
  });

const benchmarkDir = async (): Promise<string> => {
  const dir = tempDir('mm-isolation-bench-');
  const write = (relative: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  write('repos/fix/src/add.js', BUGGY);
  write('repos/fix/test/add.test.js', TEST);
  write('solutions/fix/src/add.js', 'exports.add = (a, b) => a + b;\n');
  write(
    'benchmark.json',
    JSON.stringify({
      format: 'momonga-bench/1',
      name: 'fixture',
      repositories: { fix: { directory: 'repos/fix', digest: await treeDigest(nodeWorkspaceFiles, path.join(dir, 'repos/fix')) } },
      tasks: [
        {
          id: 'fix',
          repository: 'fix',
          taskType: 'bug_fix',
          difficulty: 'easy',
          labelledBy: 'fixture',
          labelledAt: '2026-11-06',
          prompt: 'Fix add.',
          permissionMode: 'acceptEdits',
          onAsk: 'allow_once',
          runs: 2,
          budget: { maxSteps: 10, maxTotalTokens: 100000, timeoutMs: 60000 },
          setup: [],
          graderFiles: {},
          declaration: [],
          oracle: [{ id: 'tests', kind: 'command', run: 'node --test', expectExit: 0, evidence: 'unit', timeoutMs: 30000 }],
          reference: { directory: 'solutions/fix' },
        },
      ],
    }),
  );
  return dir;
};

type Session = { id: string; root: string; cwd: string; permissionMode: string; model: string };
type Run = { id: string; sessionId: string; timeoutMs: number; limits: { maxSteps?: number; maxTotalTokens?: number } };

const harness = () => {
  const roots: string[] = [];
  const connected: string[] = [];
  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>();
  const removed: string[] = [];
  const runtimeFor = (root: string) => ({
    createSession: async (input: { cwd: string; permissionMode: string; model?: string }) => {
      const session: Session = { id: `s-${sessions.size + 1}`, root, cwd: input.cwd, permissionMode: input.permissionMode, model: input.model ?? 'none' };
      sessions.set(session.id, session);
      return { session: { id: session.id, model: session.model } };
    },
    createRun: async (sessionId: string, _text: string, options: { timeoutMs?: number; limits?: { maxSteps?: number; maxTotalTokens?: number } }) => {
      const run: Run = { id: `r-${runs.size + 1}`, sessionId, timeoutMs: options.timeoutMs ?? 1000, limits: options.limits ?? {} };
      runs.set(run.id, run);
      return { run: { id: run.id }, location: '' };
    },
    streamEvents: async function* (runId: string): AsyncGenerator<{ id: number; data: PublicRunEvent }> {
      const run = runs.get(runId) as Run;
      const data = { runId, sessionId: run.sessionId, step: 0, id: 1, seq: 1, createdAt: T0 + 1, type: 'run.status', from: 'RUNNING', to: 'COMPLETED' } as unknown as PublicRunEvent;
      yield { id: 1, data };
    },
    getRun: async (runId: string) => {
      const run = runs.get(runId) as Run;
      return {
        id: run.id,
        sessionId: run.sessionId,
        status: 'COMPLETED',
        createdAt: T0,
        deadlineAt: T0 + run.timeoutMs,
        limits: run.limits,
        step: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        origin: 'trusted',
        agent: 'main',
        report: { declaration: null },
      };
    },
    getSession: async (sessionId: string) => {
      const session = sessions.get(sessionId) as Session;
      return { id: session.id, permissionMode: session.permissionMode, model: session.model };
    },
    runReflection: async () => ({ job: null, charges: [], queuedAhead: 0 }),
    runAnsweredBy: async () => ({ answeredBy: [{ target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' }] }),
    reportCost: async (runIds: readonly string[]) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
    resolveApproval: async () => ({}),
    cancel: async () => ({ status: 200, run: {} }),
    addRule: async () => ({}),
    retireRule: async () => ({}),
    addMemory: async () => ({}),
    adoptGuideline: async () => ({}),
    setTrust: async () => undefined,
    close: async () => undefined,
  });
  const effects = {
    lock: createFakeKernelLock({ inheritable: false }),
    platform: process.platform,
    env: { PATH: process.env['PATH'], UPSTREAM_KEY: 'k' },
    sessionEnv: async () => ({ PATH: process.env['PATH'] ?? '' }),
    makeRoot: async () => {
      const root = tempDir('mm-isolation-case-');
      roots.push(root);
      return root;
    },
    ownerPid: 7,
    ownerHome: '/home/person',
    readSecret: async (name: string) => Promise.reject(new Error(`no secret ${name}`)),
    copyProbeRecord: async () => undefined,
    copyEndpointProbeRecord: async () => undefined,
    listRoots: async () => [],
    readOwner: async () => undefined,
    prepare: async (paths: MomongaPaths) => void fs.mkdirSync(paths.root, { recursive: true }),
    writeFile: async (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    makeDirectory: async (directory: string) => void fs.mkdirSync(directory, { recursive: true }),
    canonical: async (directory: string) => fs.realpathSync(directory),
    startDaemon: async () => undefined,
    refuseUnfitSockets: async () => undefined,
    terminate: async () => undefined,
    remove: async (directory: string) => void removed.push(directory),
    connect: (paths: MomongaPaths) => {
      connected.push(paths.root);
      return runtimeFor(paths.root);
    },
    applyStep: async () => undefined,
    after: async () => undefined,
    now: () => 0,
  } as unknown as BenchHostEffects;
  return { effects, roots, connected, sessions, removed };
};

const within = (file: string, roots: readonly string[]): boolean => roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));

const reflection = { pendingBoundMs: 2000, attemptBoundMs: 9000, pollMs: 100 };

describe('a measurement runs in homes the harness made (DECISION-3)', () => {
  it('eval bench gives every trial its own home: its daemon, its store and its workspace, and connects to no other home', async () => {
    const context = harness();
    const dir = await benchmarkDir();
    const env = { PATH: process.env['PATH'] ?? '' };
    const { report } = await runBenchLive(context.effects, {
      benchmarkFile: path.join(dir, 'benchmark.json'),
      model: PINNED,
      models: userModels(),
      probe: createWorkspaceProbe(env),
      files: nodeWorkspaceFiles,
      codeDigest: 'a'.repeat(64),
      groupBy: 'model',
      reflection,
      interrupt: new AbortController().signal,
    });
    expect(context.roots).toHaveLength(2);
    expect(context.connected.every((root) => within(root, context.roots))).toBe(true);
    expect(new Set(context.connected.map((root) => context.roots.find((home) => within(root, [home])))).size).toBe(2);
    const sessions = [...context.sessions.values()];
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(within(session.cwd, [session.root.replace(/[/\\]\.momonga$/, '')])).toBe(true);
      expect(fs.readFileSync(path.join(session.cwd, 'src/add.js'), 'utf8')).toBe(BUGGY);
      expect(session.model).toBe(PINNED);
    }
    expect(context.removed.sort()).toEqual([...context.roots].sort());
    expect(report.tasks).toEqual([expect.objectContaining({ task: 'fix', trials: 2 })]);
  });

  it('eval <dataset> gives every run of a case its own home with the files of the case, on the start model of the settings', async () => {
    const context = harness();
    const dataset = parseDataset(
      JSON.stringify({
        format: 'momonga-eval/1',
        name: 'golden',
        cases: [{ id: 'one', input: 'say hi', permissionMode: 'acceptEdits', onAsk: 'allow_once', runs: 2, minPassRate: 1, files: { 'notes.txt': 'n\n' }, graders: [{ kind: 'status', equals: 'COMPLETED' }] }],
      }),
      'golden.json',
    );
    await runGoldenLive(context.effects, { dataset, models: userModels(), reflection, interrupt: new AbortController().signal, oracleOf: async () => Promise.reject(new Error('the case has no oracle')) });
    expect(context.roots).toHaveLength(2);
    expect(context.connected.every((root) => within(root, context.roots))).toBe(true);
    const sessions = [...context.sessions.values()];
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(within(session.cwd, context.roots)).toBe(true);
      expect(fs.readFileSync(path.join(session.cwd, 'notes.txt'), 'utf8')).toBe('n\n');
      expect(session.model).toBe(PINNED);
    }
    expect(context.removed.sort()).toEqual([...context.roots].sort());
  });
});
