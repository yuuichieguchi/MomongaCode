import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { canonicalJson, EMPTY_FILE_RULES, sha256Hex, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import type { InstructionReader } from '@momonga/context';
import { computeFileRules } from '@momonga/policy';
import type { Capabilities, PermissionMode, RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { createSkillsPort, createWorker } from '@momonga/runtime';
import type { SkillsPort, ToolEnv, ToolRuntimePort, Worker, WorkerOptions } from '@momonga/runtime';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import { foldRunState, initialRunState, openRuntimeStore } from '@momonga/store';
import type { Claim, Run, RuntimeStore, Session } from '@momonga/store';
import { fakePolicyFilesystem, createFakeClock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { AbandonTarget, AnyTool, ToolExecutor, ToolSessionState, ToolSet } from '@momonga/tools';
import { within } from './deferred.ts';
import { createFakeGateway } from './fake-gateway.ts';
import type { FakeGateway } from './fake-gateway.ts';
import { createFakeSettings } from './fake-settings.ts';
import type { FakeSettings } from './fake-settings.ts';
import { createFakeToolbox } from './fake-tools.ts';
import type { FakeToolbox } from './fake-tools.ts';
import { createFakeTracer } from './fake-tracer.ts';
import type { FakeTracer } from './fake-tracer.ts';
import { MODEL_ALIAS, resetResponseIds } from './scripts.ts';

export const START_MS = 1_800_000_000_000;
export const LEASE_MS = 30_000;
export const DEADLINE_MS = START_MS + 3_600_000;
export const EXTRA_ROOT = '/opt/momonga-extra-root';
export const TEST_PROMPT_PREFIX = 'You are the MomongaCode test agent working in';

export const testSystemPrompt = ({ cwd }: { cwd: string; platform: string }): string => `${TEST_PROMPT_PREFIX} ${cwd}.`;

export const capabilitiesFor = (contextWindow: number, overrides: Partial<Capabilities> = {}): Capabilities => ({
  contextWindow,
  maxOutputTokens: 4096,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
  ...overrides,
});

export const fakeSandbox: Sandbox = {
  kind: 'seatbelt',
  spawn: () => {
    throw new Error('the fake sandbox does not spawn processes');
  },
};

type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  const errors: unknown[] = [];
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

export const diskSkillsPort = (home: string, trusted: () => boolean = () => true): SkillsPort =>
  createSkillsPort({ loader: createSkillLoader({ home, fileSystem: createNodeSkillFileSystem() }), settings: { trusted } });

export type FakeInstructions = InstructionReader & { files: Map<string, string>; reads: string[] };

export const createFakeInstructions = (): FakeInstructions => {
  const files = new Map<string, string>();
  const reads: string[] = [];
  return {
    files,
    reads,
    read: async (filePath) => {
      reads.push(filePath);
      const text = files.get(filePath);
      return text === undefined ? undefined : { realPath: filePath, text };
    },
    exists: async (filePath) => files.has(filePath),
    realpath: async (filePath) => filePath,
  };
};

export type EnvOptions = {
  capabilities?: Capabilities;
  mode?: PermissionMode;
  maxAttempts?: number;
  maxTotalAttempts?: number;
};

export type BatchInput = Parameters<ToolExecutor['runBatch']>[0];

export type PortCalls = {
  envFor: { sessionId: string; env: ToolEnv }[];
  toolSet: { runId: string; signal: AbortSignal | undefined; env: ToolEnv | undefined }[];
  recoveryToolSet: { signal: AbortSignal | undefined }[];
  policyFor: { sessionId: string; env: ToolEnv | undefined }[];
  abandon: { targets: AbandonTarget[]; signal: AbortSignal }[];
};

export type WorkerOverrides = Partial<Omit<WorkerOptions, 'tools'>> & { tools?: Partial<ToolRuntimePort>; toolList?: () => AnyTool[] };

export type Env = Awaited<ReturnType<typeof makeEnv>>;

export const makeEnv = async (options: EnvOptions = {}) => {
  resetResponseIds();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-worker-')));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const markers = path.join(home, '.momonga', 'run', 'markers');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(markers, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const sessionsTmpRoot = path.join(root, 'sessions');
  const sessionTmpDir = path.join(sessionsTmpRoot, 'session-tmp');
  fs.mkdirSync(sessionTmpDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(stateDir, 'runtime.db');
  const clock: FakeClock = createFakeClock(START_MS);
  const store: RuntimeStore = openRuntimeStore({
    path: dbPath,
    home,
    clock,
    leaseMs: LEASE_MS,
    maxAttempts: options.maxAttempts ?? 5,
    maxTotalAttempts: options.maxTotalAttempts ?? 50,
  });
  const gateway: FakeGateway = createFakeGateway(options.capabilities ?? capabilitiesFor(100_000));
  const settings: FakeSettings = createFakeSettings({ home, project });
  const tracer: FakeTracer = createFakeTracer();
  const toolbox: FakeToolbox = createFakeToolbox();
  const instructions = createFakeInstructions();
  const executorWarnings: string[] = [];
  const realExecutor = createToolExecutor({ fs: fakePolicyFilesystem(),
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    processMarkerDir: markers,
    onWarning: (message: string) => {
      executorWarnings.push(message);
    },
  });
  const batches: BatchInput[] = [];
  const portCalls: PortCalls = { envFor: [], toolSet: [], recoveryToolSet: [], policyFor: [], abandon: [] };
  const executor: ToolExecutor = {
    ...realExecutor,
    runBatch: (input) => {
      batches.push(input);
      return realExecutor.runBatch(input);
    },
    abandon: (targets, abandonOptions) => {
      portCalls.abandon.push({ targets: [...targets], signal: abandonOptions.signal });
      return realExecutor.abandon(targets, abandonOptions);
    },
  };
  const sandboxPolicy: SandboxPolicy = {
    writableRoots: [project],
    writeDenied: [sessionsTmpRoot], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
    readDenied: [sessionsTmpRoot],
    readAllowed: [sessionTmpDir],
    network: 'deny',
  };
  const sessionStates = new Map<string, ToolSessionState>();
  const workers: Worker[] = [];
  const fatals: Error[] = [];
  const pendingRuns: Promise<unknown>[] = [];
  let rawDb: DatabaseSync | undefined;

  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  cleanups.push(() => rawDb?.close());
  cleanups.push(async () => {
    gateway.releaseAll();
    await within(Promise.allSettled(pendingRuns), 10_000, 'abandoned worker runs to settle');
    await within(Promise.allSettled(workers.map((worker) => worker.stop())), 10_000, 'workers to stop');
  });

  const session: Session = store.createSession({
    cwd: project,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    permissionMode: options.mode ?? 'default',
    modelAlias: MODEL_ALIAS,
  });

  const snapshotTools = async (tools: AnyTool[]): Promise<ToolSet> => {
    const registry = createToolRegistry();
    for (const tool of tools) registry.register(tool);
    return registry.snapshot();
  };

  const toolRuntime = (toolList: () => AnyTool[]): ToolRuntimePort => ({
    envFor: (target: Session) => {
      const env: ToolEnv = { ...target.env };
      portCalls.envFor.push({ sessionId: target.id, env });
      return env;
    },
    toolSet: async (runId: string, toolSetOptions: { signal: AbortSignal; env: ToolEnv; additionalTools?: readonly AnyTool[] }) => {
      portCalls.toolSet.push({ runId, signal: toolSetOptions?.signal, env: toolSetOptions?.env });
      return snapshotTools([...toolList(), ...(toolSetOptions.additionalTools ?? [])]);
    },
    recoveryToolSet: async (recoveryOptions: { signal: AbortSignal }) => {
      portCalls.recoveryToolSet.push({ signal: recoveryOptions?.signal });
      return snapshotTools(toolList());
    },
    executor,
    sandbox: fakeSandbox,
    markerDir: markers,
    policyFor: async (target: Session, policyOptions: { env: ToolEnv; rules: readonly PermissionRule[] }) => {
      portCalls.policyFor.push({ sessionId: target.id, env: policyOptions?.env });
      const roots = [target.cwd, EXTRA_ROOT];
      const fileRules = computeFileRules(policyOptions.rules, roots, sessionTmpDir);
      return { roots, sandboxPolicy: { ...sandboxPolicy, fileRules }, tmpDir: sessionTmpDir, env: policyOptions?.env ?? target.env };
    },
    recoveryContextFor: async (target: Session, recoveryOptions: { env: ToolEnv }) => ({ roots: [target.cwd, EXTRA_ROOT], tmpDir: sessionTmpDir, env: recoveryOptions.env }),
    sessionState: (target: Session) => {
      const existing = sessionStates.get(target.id);
      if (existing !== undefined) return existing;
      const created: ToolSessionState = { cwd: target.cwd, readLedger: new Map() };
      sessionStates.set(target.id, created);
      return created;
    },
  });

  const worker = (workerId = 'worker-1', overrides: WorkerOverrides = {}): Worker => {
    const { tools: toolOverrides, toolList, ...rest } = overrides;
    const created = createWorker({
      store,
      gateway,
      settings,
      skills: diskSkillsPort(home, () => settings.trustedValue),
      tools: { ...toolRuntime(toolList ?? (() => toolbox.tools())), ...toolOverrides },
      tracer,
      clock,
      workerId,
      leaseMs: LEASE_MS,
      systemPrompt: testSystemPrompt,
      home,
      blobs: store.blobs,
      instructionReader: instructions,
      onFatal: (error: Error) => {
        fatals.push(error);
      },
      ...rest,
    });
    workers.push(created);
    return created;
  };

  const runOnce = (target: Worker): Promise<'idle' | 'yielded'> => {
    const running = target.runOnce();
    pendingRuns.push(running);
    return running;
  };

  const enqueue = (
    input = 'Say hello',
    extra: { limits?: Record<string, unknown>; deadlineAt?: number; history?: 'inherit' | 'fresh'; skill?: { name: string; content: string } } = {},
  ): Run =>
    createdRun(
      store.createRunAndEnqueue(session.id, {
        input,
        timeoutMs: (extra.deadlineAt ?? DEADLINE_MS) - clock.now(),
        limits: extra.limits ?? {},
        pins: {},
        ...(extra.history === undefined ? {} : { history: extra.history }),
        ...(extra.skill === undefined ? {} : { skill: extra.skill }),
      }),
    );

  const cancel = (runId: string): Run => {
    const result = store.requestCancel(runId);
    if (result.kind !== 'ok') throw new Error(`run ${runId} could not be cancelled: ${result.kind}`);
    return result.run;
  };

  const events = (runId: string): RunEvent[] => store.readRunEvents(runId, 0, 100_000);

  const ofType = <T extends RunEvent['type']>(runId: string, type: T): Extract<RunEvent, { type: T }>[] =>
    events(runId).filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

  const fold = (runId: string): RunState => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`unknown run ${runId}`);
    return events(runId).reduce(foldRunState, initialRunState({ runId, sessionId: run.sessionId }));
  };

  const run = (runId: string): Run => {
    const found = store.getRun(runId);
    if (found === undefined) throw new Error(`unknown run ${runId}`);
    return found;
  };

  const seed = (runId: string, payloads: readonly RunEventPayload[], end: 'release' | 'crash' | 'hold'): Claim => {
    const claim = store.claim('seeder');
    if (claim === null || claim.runId !== runId) throw new Error(`seeder could not claim run ${runId}`);
    const appended = store.append(claim, payloads);
    if (appended.kind !== 'ok') throw new Error('seeder lost its lease');
    if (end === 'release') {
      const released = store.release(claim, 'QUEUED');
      if (released.kind !== 'ok') throw new Error(`seeder could not release run ${runId}`);
    } else if (end === 'crash') {
      clock.advance(LEASE_MS + 1);
    }
    return claim;
  };

  const raw = (): DatabaseSync => {
    if (rawDb === undefined) {
      rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA busy_timeout = 5000');
    }
    return rawDb;
  };

  const setMode = (mode: PermissionMode): void => {
    raw().prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, session.id);
  };

  const setModelAlias = (alias: string): void => {
    raw().prepare('UPDATE sessions SET model_alias = ? WHERE id = ?').run(alias, session.id);
  };

  const resolveApproval = (runId: string, kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always', approvalId?: string): void => {
    const requests = ofType(runId, 'tool.permission.requested');
    const requested = approvalId === undefined ? requests.at(-1) : requests.find((candidate) => candidate.approvalId === approvalId);
    if (requested === undefined) throw new Error(`run ${runId} has no permission request ${approvalId ?? ''}`);
    const option = requested.options.find((candidate) => candidate.kind === kind);
    if (option === undefined) throw new Error(`permission request ${requested.approvalId} offers no ${kind} option`);
    const resolved = store.resolveApproval(requested.approvalId, option.optionId);
    if (resolved.kind !== 'ok') throw new Error(`approval ${requested.approvalId} could not be resolved: ${resolved.kind}`);
  };

  return {
    root,
    project,
    sessionTmpDir,
    home,
    markers,
    dbPath,
    clock,
    store,
    gateway,
    settings,
    tracer,
    toolbox,
    instructions,
    executor,
    executorWarnings,
    batches,
    portCalls,
    fatals,
    session,
    worker,
    runOnce,
    enqueue,
    cancel,
    events,
    ofType,
    fold,
    run,
    seed,
    raw,
    setMode,
    setModelAlias,
    resolveApproval,
    snapshotTools,
  };
};

export const createdRun = (result: ReturnType<RuntimeStore['createRunAndEnqueue']>): Run => {
  if (result.kind !== 'created' && result.kind !== 'existing') throw new Error(`expected a run, got ${result.kind}`);
  return result.run;
};

export const modelKey = (runId: string, step: number, attempt = 1): string => sha256Hex(canonicalJson([runId, step, attempt]));

export const toolKey = (runId: string, step: number, callId: string): string => sha256Hex(canonicalJson([runId, step, callId]));

export const compactKey = (runId: string, request: unknown): string => sha256Hex(canonicalJson([runId, 'compact', sha256Hex(canonicalJson(request))]));

export const bodyDigest = (body: unknown): string => sha256Hex(canonicalJson(body));

export const typesOf = (events: readonly RunEvent[]): string[] =>
  events.map((event) => event.type).filter((type, index, all) => !(type.endsWith('.delta') && all[index - 1] === type));

export const textOf = (item: unknown): string => {
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('');
};

export const finalSummaryInstruction = (reason: string): string =>
  `You have reached the ${reason} limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.`;
