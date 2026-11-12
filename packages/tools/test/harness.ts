import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, nodeFileSystem, resolveCanonicalPath, sha256Hex, systemRandom, truncationMarker, validateUntrusted, momongaLayout } from '@momonga/foundation';
import { absoluteFrom } from '@momonga/policy';
import { TEST_TOOL_LIMITS, unconfiguredNetworkOf, FAKE_LEASE, createFakeKernelLock, driveFakeTime, fakePolicyFilesystem, hostFilesystemOf, testPaths, testProcessInspector } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import type { PermissionSubject } from '@momonga/policy';
import { approvalDescriptionOf, createHostRipgrepLocator, createToolExecutor, subjectDigestOf, createToolRegistry, defineTool, nodeShellHost, schemaIdentity } from '@momonga/tools';
import { pinnedRipgrepPath } from '../../../test/support/pinned-ripgrep.ts';
import type { AnyTool, ToolSessionState, CallOutputFit, ExecutionBatchInput, OutputCall, OutputFit, ShellHost, SideEffectBinding, ToolBody, ToolCall, ToolContext, ToolDefinition, ToolExecutorOptions, ToolSet, WorkTreeObserver } from '@momonga/tools';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode, SideEffect } from '@momonga/protocol';
import { fakeSandbox, makeBlobs, makeClock, makeIdempotency, makeLayout, minimalPolicyFor } from './helpers.ts';
import type { Layout } from './helpers.ts';
import { syncPaths } from '@momonga/foundation';

export type Input = Record<string, unknown>;

export const DEFAULT_OUTPUT_LIMIT_CHARS = 30_000;

export const charFit = (limit: number): OutputFit => ({
  fits: async (text) => text.length <= limit,
  fit: async (text, handle) => {
    if (text.length <= limit) return text;
    const marker = truncationMarker(text.length, handle, 'ReadOutput');
    const kept = Math.max(0, limit - marker.length - 2);
    return [text.slice(0, Math.ceil(kept / 2)), marker, text.slice(text.length - Math.floor(kept / 2))].filter((part) => part !== '').join('\n');
  },
});

export type FitAsk = { readonly text: string; readonly call: OutputCall };

export const askingFit = (inner: OutputFit): { port: OutputFit; asks: FitAsk[] } => {
  const asks: FitAsk[] = [];
  return {
    asks,
    port: {
      ...inner,
      fits: async (text, call) => {
        asks.push({ text, call });
        return inner.fits(text, call);
      },
      fit: async (text, handle, call) => {
        asks.push({ text, call });
        return inner.fit(text, handle, call);
      },
    },
  };
};

const ANSWERING_PROBE = 'which port answers this text';

export const callAnsweredBy = async (seen: CallOutputFit, asked: { asks: readonly FitAsk[] }): Promise<OutputCall | undefined> => {
  await seen.fits(ANSWERING_PROBE);
  return asked.asks.find((ask) => ask.text === ANSWERING_PROBE)?.call;
};

export const OPEN_SCHEMA = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } as const;

type KeepsBinding = { sideEffect?: never; subjectKind?: never; subject?: never };

type KeepsNoneSubject = { sideEffect: SideEffect; subjectKind: 'none'; subject?: never };

export const makeTool = (name: string, overrides: Partial<ToolBody<Input>> & (KeepsBinding | KeepsNoneSubject | SideEffectBinding<Input>) = {}): AnyTool =>
  defineTool<Input>({
    name,
    description: `${name} test tool`,
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: OPEN_SCHEMA,
    title: () => `${name} title`,
    timeoutMs: 60_000,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => ({ status: 'completed', output: `${name} ok` }),
    ...overrides,
  });

export const toolSetOf = async (...tools: AnyTool[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.snapshot();
};

export type Harness = ReturnType<typeof makeHarness>;

export const fakeTimedShellHost = (timers: FakeTimers): ShellHost => {
  const host = nodeShellHost();
  return { ...host, child: { ...host.child, setTimeout: (callback, ms) => timers.setTimeout(callback, ms), clearTimeout: (handle) => timers.clearTimeout(handle) } };
};

export const onFakeTime = async <T>(timers: FakeTimers, work: Promise<T>, horizonMs: number, description: string): Promise<{ value: T; atMs: number }> => {
  let settled: { value: T; atMs: number } | undefined;
  let failure: { error: unknown } | undefined;
  work.then(
    (value) => {
      settled = { value, atMs: timers.monotonicMs() };
    },
    (error: unknown) => {
      failure = { error };
    },
  );
  await driveFakeTime(timers, { done: () => settled !== undefined || failure !== undefined, horizonAt: timers.monotonicMs() + horizonMs, description });
  if (failure !== undefined) throw failure.error;
  if (settled === undefined) throw new Error(`${description} did not settle`);
  return settled;
};

export type HarnessOptions = {
  outputLimitChars?: number;
  maxParallel?: number;
  idempotencyTtlMs?: number;
  attempts?: number;
  executor?: Partial<ToolExecutorOptions> & { workTreeObserver?: WorkTreeObserver };
};

export const makeHarness = (options: HarnessOptions = {}) => {
  const { workTreeObserver, ...executorOptions } = options.executor ?? {};
  const layout: Layout = makeLayout();
  const clock = makeClock();
  const idempotency = makeIdempotency(clock);
  const blobs = makeBlobs();
  const markerDir = path.join(layout.root, 'markers');
  fs.mkdirSync(markerDir, { mode: 0o700 });
  const callLockDir = path.join(layout.root, 'call-locks');
  fs.mkdirSync(callLockDir, { mode: 0o700 });
  const kernelLock = createFakeKernelLock({ inheritable: false });
  const warnings: string[] = [];
  const executor = createToolExecutor({
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem,
    outboundNetwork: unconfiguredNetworkOf,
    idempotency: idempotency.port,
    blobs: blobs.port,
    clock,
    processMarkerDir: markerDir,
    callLockDir,
    layout: momongaLayout(layout.home, process.platform, process.env),
    kernelLock,
    onWarning: (message: string) => {
      warnings.push(message);
    },
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
    ...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
    readOnlyRetry: { attempts: options.attempts ?? 3, baseMs: 0, maxMs: 0 },
    fs: hostFilesystemOf(fakePolicyFilesystem()),
    ...FAKE_LEASE,
    ...executorOptions,
    reap: { inspector: testProcessInspector(), ...executorOptions.reap },
  });
  const session = { cwd: layout.project, workingDirectory: layout.project, readLedger: new Map<string, { sha256: string; mtimeMs: number }>() };
  const started: string[] = [];
  const input = async (
    toolSet: ToolSet,
    calls: HarnessCall[],
    extra: Partial<Omit<ExecutionBatchInput, 'recoverOnly'>> & { recoverOnly?: true; mode?: PermissionMode; rules?: PermissionRule[] } = {},
  ): Promise<ExecutionBatchInput> => {
    const batch = {
    calls: await Promise.all(
      calls.map((entry) =>
        bindApproval(entry, toolSet, { cwd: (extra.session ?? session).cwd, workingDirectory: (extra.session ?? session).workingDirectory, home: extra.home ?? layout.home, roots: extra.roots ?? [layout.project], session: extra.session ?? session }),
      ),
    ),
    toolSet,
    limits: TEST_TOOL_LIMITS,
    fence: { runId: 'run-1', workerId: 'w1', leaseToken: 1 },
    runId: 'run-1',
    step: 1,
    mode: 'manual',
    rules: [],
    home: layout.home,
    roots: [layout.project],
    env: { LANG: 'C' },
    session,
    sandbox: fakeSandbox,
    deadlineAt: clock.now() + 600_000,
    outputFit: charFit(options.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS),
    reconcileFit: charFit(options.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS),
    signal: new AbortController().signal,
    onStarted: (callId: string) => {
      started.push(callId);
    },
    ...(workTreeObserver === undefined ? {} : { workTreeObserver }),
    ...extra,
    };
    if (extra.ripgrep === undefined) Object.assign(batch, { ripgrep: createHostRipgrepLocator({ setting: pinnedRipgrepPath(), env: batch.env }) });
    if (extra.sandboxPolicy !== undefined) return batch as unknown as ExecutionBatchInput;
    const sandboxPolicy = await minimalPolicyFor({ layout, rules: batch.rules, roots: batch.roots, ...(batch.tmpDir === undefined ? {} : { tmpDir: batch.tmpDir }) });
    return { ...batch, sandboxPolicy } as unknown as ExecutionBatchInput;
  };
  return { layout, markerDir, callLockDir, kernelLock, clock, idempotency, blobs, executor, session, started, input, warnings };
};

export type ExecuteFn = (input: Input, ctx: ToolContext, prepared: Record<string, unknown> | undefined) => ReturnType<ToolDefinition<Input>['execute']>;

export type ApprovalKind = 'allow_once' | 'allow_always';

export type BoundApproval = { kind: ApprovalKind; subjectDigest: string };

export type ApprovalSpec = ApprovalKind | BoundApproval;

export type HarnessCall = { callId: string; name: string; arguments: unknown; approval?: ApprovalSpec; inputResponses?: Record<string, unknown> };

export const UNRESOLVED_SUBJECT_DIGEST = 'unresolved-subject';

type BindingContext = { cwd: string; workingDirectory: string; home: string; roots: readonly string[]; session: ToolSessionState };

const digestForTool = async (tool: AnyTool, value: unknown, context: BindingContext): Promise<string> => {
  const subjectContext = { cwd: context.cwd, workingDirectory: context.workingDirectory, home: context.home, roots: context.roots, paths: testPaths() };
  const described = await approvalDescriptionOf(tool, value, subjectContext, { ...subjectContext, files: nodeFileSystem, session: context.session, signal: new AbortController().signal });
  return subjectDigestOf(tool.subject(value, subjectContext), described, context.cwd, syncPaths.resolveCanonicalPath);
};

export const expectedDigestOf = (tool: AnyTool, input: unknown, harness: { layout: Layout; session: ToolSessionState }): Promise<string> =>
  digestForTool(tool, input, { cwd: harness.session.cwd, workingDirectory: harness.session.workingDirectory, home: harness.layout.home, roots: [harness.layout.project], session: harness.session });

const digestForCall = async (entry: HarnessCall, toolSet: ToolSet, context: BindingContext): Promise<string> => {
  const tool = toolSet.get(entry.name);
  if (tool === undefined) return UNRESOLVED_SUBJECT_DIGEST;
  const value: unknown = typeof entry.arguments === 'string' ? JSON.parse(entry.arguments) : entry.arguments;
  if (!validateUntrusted(schemaIdentity(tool), tool.inputSchema, value).valid) return UNRESOLVED_SUBJECT_DIGEST;
  try {
    return await digestForTool(tool, value, context);
  } catch {
    return UNRESOLVED_SUBJECT_DIGEST;
  }
};

const bindApproval = async (entry: HarnessCall, toolSet: ToolSet, context: BindingContext): Promise<ToolCall> => {
  const { approval, ...rest } = entry;
  if (approval === undefined) return rest;
  if (typeof approval !== 'string') return { ...rest, approval };
  return { ...rest, approval: { kind: approval, subjectDigest: await digestForCall(entry, toolSet, context) } };
};

export const call = (callId: string, name: string, args: unknown = {}, approval?: ApprovalSpec): HarnessCall =>
  approval === undefined ? { callId, name, arguments: args } : { callId, name, arguments: args, approval };
