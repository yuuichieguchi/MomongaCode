import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { canonicalJson, EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, fixedRolePort, HOST_RULE_ENFORCEMENT, nodeFileSystem, openDatabase, sha256Hex, systemRandom } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import type { InstructionReader } from '@momonga/context';
import { computeFileRules } from '@momonga/policy';
import { applyCapabilityOverride } from '@momonga/protocol';
import type { Capabilities, CapabilityOverride, Mandate, PermissionMode, RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { createAgentLoader } from '@momonga/agents';
import { contributionAtTerminal, createSkillsPort, createWorker } from '@momonga/runtime';
import type { AgentCatalogPort, EvidenceRun, GovernancePort, HistoryPort, MemoryPort, SkillsPort, ToolEnv, ToolRuntimePort, Worker, WorkerOptions } from '@momonga/runtime';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import { blobDirectoryOf, createBlobStore, createJournalReader, foldRunState, initialRunState, openRuntimeStore } from '@momonga/store';
import type { Claim, ContributionPreparer, ReportReply, Run, RuntimeStore, Session } from '@momonga/store';
import { UNCONFIGURED_NETWORK, FAKE_LEASE, fakePolicyFilesystem, hostFilesystemOf, createFakeClock, createFakeKernelLock, testProbes, testPaths } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { createGitWorkTreeObserver, createHostRipgrepLocator, createToolExecutor, createToolRegistry, nodeShellHost } from '@momonga/tools';
import { pinnedRipgrepPath } from '../../../../test/support/pinned-ripgrep.ts';
import type { AbandonTarget, AnyTool, ToolExecutor, ToolSessionState, ToolSet } from '@momonga/tools';
import { evidenceHandler, fidelityHandler, inheritPlanHandler, inheritedWindowHandler, reflectionInputHandler, reportHandler, verdictHandler } from '../../src/memory/journal-thread.ts';
import type { JournalHandler } from '../../src/memory/journal-thread.ts';
import { systemTimers } from '../../src/service/timers.ts';
import { within } from './deferred.ts';
import { createFakeGateway } from './fake-gateway.ts';
import type { FakeGateway } from './fake-gateway.ts';
import { createFakeSettings } from './fake-settings.ts';
import type { FakeSettings } from './fake-settings.ts';
import { createFakeToolbox } from './fake-tools.ts';
import type { FakeToolbox } from './fake-tools.ts';
import { createFakeTracer } from './fake-tracer.ts';
import type { FakeTracer } from './fake-tracer.ts';
import { MODEL_ID, resetResponseIds } from './scripts.ts';
import { fixedSandboxBindings, fixedTracers } from '@momonga/runtime';

import { createFakeRuleVerifier } from './fake-rule-verifier.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

export const START_MS = 1_800_000_000_000;
export const LEASE_MS = 30_000;
export const DEADLINE_MS = START_MS + 3_600_000;
export const EXTRA_ROOT = '/opt/momonga-extra-root';
export const TEST_PROMPT_PREFIX = 'You are the MomongaCode test agent working in';

export const testSystemPrompt = ({ cwd }: { cwd: string; platform: string }): string => `${TEST_PROMPT_PREFIX} ${cwd}.`;

export const capabilitiesFor = (contextWindow: number, overrides: CapabilityOverride = {}): Capabilities =>
  applyCapabilityOverride(
    {
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
    },
    overrides,
  );

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

export const inertMemoryPort: MemoryPort = { load: async () => ({ prepare: async () => undefined, ranked: () => [], hasMore: () => false, matchCap: () => undefined, tools: [] }) };

export const inertHistoryPort: HistoryPort = { load: () => ({ tools: [] }) };

export const inertGovernancePort: GovernancePort = { load: () => ({ tools: [] }) };

export const unavailableEvidenceRun = (): EvidenceRun => async () => ({ exitCode: 128 });

export const diskSkillsPort = (home: string, trusted: () => boolean = () => true): SkillsPort =>
  createSkillsPort({ loader: createSkillLoader({ home, fileSystem: createNodeSkillFileSystem() }), settings: { trusted } });

export const diskAgentCatalog = (home: string, trusted: () => boolean = () => true): AgentCatalogPort => {
  const loader = createAgentLoader({ home, fileSystem: createNodeSkillFileSystem() });
  return { load: (session) => loader.load({ projectRoot: session.cwd, trusted: trusted() }) };
};

export type FakeInstructions = InstructionReader & { files: Map<string, string>; reads: string[] };

export const createFakeInstructions = (): FakeInstructions => {
  const files = new Map<string, string>();
  const reads: string[] = [];
  return {
    files,
    reads,
    contains: (directory, candidate) => testPaths().comparableContains(directory, candidate),
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
  preparer?: ContributionPreparer;
  onDecode?: (rows: number, bytes: number) => void;
  onEncode?: (kind: string, bytes: number) => void;
};

export type BatchInput = Parameters<ToolExecutor['runBatch']>[0];

export type PortCalls = {
  envFor: { sessionId: string; env: ToolEnv }[];
  toolSet: { runId: string; signal: AbortSignal | undefined; env: ToolEnv | undefined }[];
  recoveryToolSet: { signal: AbortSignal | undefined; additionalTools: readonly AnyTool[] }[];
  policyFor: { sessionId: string; env: ToolEnv | undefined }[];
  abandon: { targets: AbandonTarget[]; signal: AbortSignal }[];
};

export type WorkerOverrides = Partial<Omit<WorkerOptions, 'tools'>> & { tools?: Partial<ToolRuntimePort>; toolList?: () => AnyTool[] };

export type Env = Awaited<ReturnType<typeof makeEnv>>;

export type ContributionItems = Extract<RunEventPayload, { type: 'context.contribution' }>['items'];

const inProcessFacts = (dbPath: string, handlerFor: (reader: ReturnType<typeof createJournalReader>) => JournalHandler) => async (request: object): Promise<never> => {
  const db = openDatabase(dbPath);
  try {
    return (await handlerFor(createJournalReader(db))(request as Record<string, unknown>, () => undefined)) as never;
  } finally {
    db.close();
  }
};

const inProcessFidelity = (dbPath: string) => async (request: object): Promise<never> => {
  const db = openDatabase(dbPath);
  try {
    const handler = fidelityHandler({
      reader: createJournalReader(db),
      blobs: createBlobStore(db, createFakeClock(START_MS), blobDirectoryOf(dbPath)),
      current: { progress: undefined },
      gateFor: () => ({ unit: () => undefined }),
    });
    return (await handler(request as Record<string, unknown>, () => undefined)) as never;
  } finally {
    db.close();
  }
};

export const journalReaderPreparer = (dbPath: string): ContributionPreparer => ({
  inheritPlan: inProcessFacts(dbPath, inheritPlanHandler),
  inheritedWindow: inProcessFacts(dbPath, inheritedWindowHandler),
  verdict: inProcessFacts(dbPath, verdictHandler),
  evidence: inProcessFacts(dbPath, evidenceHandler),
  reflectionInput: inProcessFacts(dbPath, reflectionInputHandler),
  fidelity: inProcessFidelity(dbPath),
  report: async (request) => {
    const db = openDatabase(dbPath);
    try {
      return (await reportHandler(db, createJournalReader(db))(request, () => undefined)) as ReportReply;
    } finally {
      db.close();
    }
  },
  measure: async (request) => {
    const db = openDatabase(dbPath);
    try {
      return createJournalReader(db).measure(contributionAtTerminal, request);
    } finally {
      db.close();
    }
  },
});

export const makeEnv = async (options: EnvOptions = {}) => {
  resetResponseIds();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-worker-')));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const markers = path.join(home, '.momonga', 'run', 'markers');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(markers, { recursive: true, mode: 0o700 });
  const callLocks = path.join(home, '.momonga', 'run', 'call-locks');
  fs.mkdirSync(callLocks, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const sessionsTmpRoot = path.join(root, 'sessions');
  const sessionTmpDir = path.join(sessionsTmpRoot, 'session-tmp');
  fs.mkdirSync(sessionTmpDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(stateDir, 'runtime.db');
  const clock: FakeClock = createFakeClock(START_MS);
  const scriptedContributions = new Map<string, ContributionItems>();
  const store: RuntimeStore = openRuntimeStore({ unaskedCommands: UNASKED_COMMANDS,
    path: dbPath,
    home,
    clock,
    leaseMs: LEASE_MS,
    maxAttempts: options.maxAttempts ?? 5,
    maxTotalAttempts: options.maxTotalAttempts ?? 50,
    preparer: options.preparer ?? {
      ...journalReaderPreparer(dbPath),
      measure: async (request) => {
        const items = scriptedContributions.get(request.runId);
        if (items === undefined) return journalReaderPreparer(dbPath).measure(request);
        return { lastSeq: store.getRun(request.runId)?.lastSeq ?? -1, contribution: { type: 'context.contribution', items } };
      },
    },
    ...(options.onDecode === undefined ? {} : { onDecode: options.onDecode }),
    ...(options.onEncode === undefined ? {} : { onEncode: options.onEncode }),
  });
  const gateway: FakeGateway = createFakeGateway(options.capabilities ?? capabilitiesFor(100_000));
  const settings: FakeSettings = createFakeSettings({ home, project });
  gateway.alsoListed = () => (settings.classifierModel === undefined ? [] : [settings.classifierModel]);
  const tracer: FakeTracer = createFakeTracer();
  const toolbox: FakeToolbox = createFakeToolbox();
  const instructions = createFakeInstructions();
  const executorWarnings: string[] = [];
  const realExecutor = createToolExecutor({
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem, outboundNetwork: UNCONFIGURED_NETWORK, fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
    idempotency: store.idempotency,
    blobs: store.blobs,
    clock,
    processMarkerDir: markers,
    callLockDir: callLocks,
    kernelLock: createFakeKernelLock({ inheritable: false }),
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
    permissionMode: options.mode ?? 'manual',
    model: MODEL_ID,
  });

  const snapshotTools = async (tools: AnyTool[]): Promise<ToolSet> => {
    const registry = createToolRegistry();
    for (const tool of tools) registry.register(tool);
    return registry.snapshot();
  };

  const toolRuntime = (toolList: () => AnyTool[]): ToolRuntimePort => ({
    workTreeObserver: (target: Session) => createGitWorkTreeObserver({ storeDir: path.join(stateDir, 'observer'), workTree: target.cwd, trusted: false }),
    envFor: (target: Session) => {
      const env: ToolEnv = { ...target.env };
      portCalls.envFor.push({ sessionId: target.id, env });
      return env;
    },
    toolSet: async (runId: string, toolSetOptions: { signal: AbortSignal; env: ToolEnv; additionalTools?: readonly AnyTool[]; only?: readonly string[] }) => {
      portCalls.toolSet.push({ runId, signal: toolSetOptions?.signal, env: toolSetOptions?.env });
      const registry = createToolRegistry();
      for (const tool of [...toolList(), ...(toolSetOptions.additionalTools ?? [])]) registry.register(tool);
      return registry.snapshot(toolSetOptions.only === undefined ? {} : { only: toolSetOptions.only });
    },
    recoveryToolSet: async (recoveryOptions: { signal: AbortSignal; additionalTools?: readonly AnyTool[] }) => {
      const additionalTools = recoveryOptions.additionalTools ?? [];
      portCalls.recoveryToolSet.push({ signal: recoveryOptions?.signal, additionalTools });
      return snapshotTools([...toolList(), ...additionalTools]);
    },
    executor,
    sandboxes: fixedSandboxBindings(fakeSandbox),
    ripgrepLocator: (env) => createHostRipgrepLocator({ setting: pinnedRipgrepPath(), env }),
    shellHost: nodeShellHost(),
    markerDir: markers,
    policyFor: async (target: Session, policyOptions: { env: ToolEnv; rules: readonly PermissionRule[] }) => {
      portCalls.policyFor.push({ sessionId: target.id, env: policyOptions?.env });
      const roots = [target.cwd, EXTRA_ROOT];
      const fileRules = await computeFileRules(policyOptions.rules, roots, sessionTmpDir, HOST_RULE_ENFORCEMENT, testProbes());
      return { roots, sandboxPolicy: { ...sandboxPolicy, fileRules }, tmpDir: sessionTmpDir, env: policyOptions?.env ?? target.env };
    },
    recoveryContextFor: async (target: Session, recoveryOptions: { env: ToolEnv }) => ({ roots: [target.cwd, EXTRA_ROOT], tmpDir: sessionTmpDir, env: recoveryOptions.env }),
    sessionState: (target: Session) => {
      const existing = sessionStates.get(target.id);
      if (existing !== undefined) return existing;
      const created: ToolSessionState = { cwd: target.cwd, workingDirectory: target.cwd, readLedger: new Map() };
      sessionStates.set(target.id, created);
      return created;
    },
  });

  const ruleVerifier = createFakeRuleVerifier();

  const worker = (workerId = 'worker-1', overrides: WorkerOverrides = {}): Worker => {
    const { tools: toolOverrides, toolList, ...rest } = overrides;
    const created = createWorker({
      store,
      gateway,
      settings,
      skills: diskSkillsPort(home, () => settings.trustedValue),
      memories: inertMemoryPort,
      history: inertHistoryPort,
      governance: inertGovernancePort,
      tools: { ...toolRuntime(toolList ?? (() => toolbox.tools())), ...toolOverrides },
      ruleVerifier,
      tracers: fixedTracers(tracer),
      clock,
      workerId,
      role: fixedRolePort('serving'),
      leaseMs: LEASE_MS,
      random: () => 0.5,
      platform: process.platform,
      timers: systemTimers,
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
    extra: { limits?: Record<string, unknown>; deadlineAt?: number; history?: 'inherit' | 'fresh'; skill?: { name: string; content: string }; mandate?: Mandate } = {},
  ): Run =>
    createdRun(
      store.createRunAndEnqueue(session.id, {
        input,
        timeoutMs: (extra.deadlineAt ?? DEADLINE_MS) - clock.now(),
        limits: extra.limits ?? {},
        pins: {},
        ...(extra.history === undefined ? {} : { history: extra.history }),
        ...(extra.skill === undefined ? {} : { skill: extra.skill }),
        ...(extra.mandate === undefined ? {} : { mandate: extra.mandate }),
      }),
    );

  const cancel = async (runId: string): Promise<Run> => {
    const result = await store.requestCancel(runId);
    if (result.kind !== 'ok') throw new Error(`run ${runId} could not be cancelled: ${result.kind}`);
    return result.run;
  };

  const cancelToEnd = async (runId: string): Promise<Run> => {
    const requested = await cancel(runId);
    if (requested.status !== 'CANCELLING') throw new Error(`run ${runId} should become CANCELLING, got ${requested.status}`);
    const failures: unknown[] = [];
    const finished = await store.finishCancelled((error) => void failures.push(error));
    if (failures.length > 0) throw failures[0];
    if (!finished.includes(runId)) throw new Error(`the sweep did not finish run ${runId}`);
    return run(runId);
  };

  const scriptContribution = (runId: string, items: ContributionItems): void => {
    scriptedContributions.set(runId, items);
  };

  const deadLetterAll = async (): Promise<string[]> => {
    const failures: unknown[] = [];
    const ended = await store.deadLetterExhausted((error) => void failures.push(error));
    if (failures.length > 0) throw failures[0];
    return ended;
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

  const seed = async (runId: string, payloads: readonly RunEventPayload[], end: 'release' | 'crash' | 'hold'): Promise<Claim> => {
    const claim = store.claim('seeder');
    if (claim === null || claim.runId !== runId) throw new Error(`seeder could not claim run ${runId}`);
    const appended = store.append(claim, payloads);
    if (appended.kind !== 'ok') throw new Error('seeder lost its lease');
    if (end === 'release') {
      const released = await store.release(claim, 'QUEUED');
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

  const setModel = (model: string): void => {
    raw().prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, session.id);
  };

  const resolveApproval = async (runId: string, kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always', approvalId?: string): Promise<void> => {
    const requests = ofType(runId, 'tool.permission.requested');
    const requested = approvalId === undefined ? requests.at(-1) : requests.find((candidate) => candidate.approvalId === approvalId);
    if (requested === undefined) throw new Error(`run ${runId} has no permission request ${approvalId ?? ''}`);
    const option = requested.options.find((candidate) => candidate.kind === kind);
    if (option === undefined) throw new Error(`permission request ${requested.approvalId} offers no ${kind} option`);
    const resolved = await store.resolveApproval(requested.approvalId, option.optionId);
    if (resolved.kind !== 'ok') throw new Error(`approval ${requested.approvalId} could not be resolved: ${resolved.kind}`);
  };

  return {
    root,
    project,
    sessionTmpDir,
    home,
    markers,
    callLocks,
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
    cancelToEnd,
    deadLetterAll,
    scriptContribution,
    events,
    ofType,
    fold,
    run,
    seed,
    raw,
    setMode,
    setModel,
    resolveApproval,
    snapshotTools,
    ruleVerifier,
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
