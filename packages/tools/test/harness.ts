import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, resolveCanonicalPath, sha256Hex } from '@momonga/foundation';
import { absoluteFrom } from '@momonga/policy';
import { FAKE_LEASE, createFakeKernelLock, fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import type { PermissionSubject } from '@momonga/policy';
import { createToolExecutor, createToolRegistry, defineTool, validateToolInput } from '@momonga/tools';
import type { AnyTool, ExecutionBatchInput, ToolCall, ToolContext, ToolDefinition, ToolExecutorOptions, ToolSet } from '@momonga/tools';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { fakeSandbox, makeBlobs, makeClock, makeIdempotency, makeLayout, minimalPolicyFor } from './helpers.ts';
import type { Layout } from './helpers.ts';

export type Input = Record<string, unknown>;

export const OPEN_SCHEMA = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } as const;

export const makeTool = (name: string, overrides: Partial<ToolDefinition<Input>> = {}): AnyTool =>
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
  } as ToolDefinition<Input>);

export const toolSetOf = async (...tools: AnyTool[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.snapshot();
};

export type Harness = ReturnType<typeof makeHarness>;

export type HarnessOptions = {
  maxInlineOutputChars?: number;
  maxParallel?: number;
  idempotencyTtlMs?: number;
  attempts?: number;
  executor?: Partial<ToolExecutorOptions>;
};

export const makeHarness = (options: HarnessOptions = {}) => {
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
    idempotency: idempotency.port,
    blobs: blobs.port,
    clock,
    processMarkerDir: markerDir,
    callLockDir,
    kernelLock,
    onWarning: (message: string) => {
      warnings.push(message);
    },
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
    ...(options.maxInlineOutputChars === undefined ? {} : { maxInlineOutputChars: options.maxInlineOutputChars }),
    ...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
    readOnlyRetry: { attempts: options.attempts ?? 3, baseMs: 0, maxMs: 0 },
    fs: hostFilesystemOf(fakePolicyFilesystem()),
    ...FAKE_LEASE,
    ...options.executor,
  });
  const session = { cwd: layout.project, readLedger: new Map<string, { sha256: string; mtimeMs: number }>() };
  const started: string[] = [];
  const input = (
    toolSet: ToolSet,
    calls: HarnessCall[],
    extra: Partial<Omit<ExecutionBatchInput, 'recoverOnly'>> & { recoverOnly?: true; mode?: PermissionMode; rules?: PermissionRule[] } = {},
  ): ExecutionBatchInput => {
    const batch = {
    calls: calls.map((entry) =>
      bindApproval(entry, toolSet, { cwd: (extra.session ?? session).cwd, home: extra.home ?? layout.home, roots: extra.roots ?? [layout.project] }),
    ),
    toolSet,
    fence: { runId: 'run-1', workerId: 'w1', leaseToken: 1 },
    runId: 'run-1',
    step: 1,
    mode: 'default',
    rules: [],
    home: layout.home,
    roots: [layout.project],
    env: { LANG: 'C' },
    session,
    sandbox: fakeSandbox,
    deadlineAt: clock.now() + 600_000,
    signal: new AbortController().signal,
    onStarted: (callId: string) => {
      started.push(callId);
    },
    ...extra,
    };
    if (extra.sandboxPolicy !== undefined) return batch as unknown as ExecutionBatchInput;
    const sandboxPolicy = minimalPolicyFor({ layout, rules: batch.rules, roots: batch.roots, ...(batch.tmpDir === undefined ? {} : { tmpDir: batch.tmpDir }) });
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

const subjectForDigest = (subject: PermissionSubject, cwd: string): unknown => {
  if (subject.kind === 'path') {
    return {
      ...subject,
      paths: subject.paths.map((target) => {
        const absolute = absoluteFrom(target, cwd);
        const resolution = resolveCanonicalPath(absolute);
        return resolution.ok ? resolution.path : absolute;
      }),
    };
  }
  if (subject.kind === 'command') {
    const resolution = resolveCanonicalPath(cwd);
    return { subject, cwd: resolution.ok ? resolution.path : null };
  }
  return subject;
};

export const expectedSubjectDigest = (subject: PermissionSubject, cwd: string): string => sha256Hex(canonicalJson(subjectForDigest(subject, cwd)));

const digestForCall = (entry: HarnessCall, toolSet: ToolSet, context: { cwd: string; home: string; roots: readonly string[] }): string => {
  const tool = toolSet.get(entry.name);
  if (tool === undefined) return UNRESOLVED_SUBJECT_DIGEST;
  const validation = validateToolInput(tool, entry.arguments);
  if (!validation.ok) return UNRESOLVED_SUBJECT_DIGEST;
  try {
    return expectedSubjectDigest(tool.subject(validation.value, context), context.cwd);
  } catch {
    return UNRESOLVED_SUBJECT_DIGEST;
  }
};

const bindApproval = (entry: HarnessCall, toolSet: ToolSet, context: { cwd: string; home: string; roots: readonly string[] }): ToolCall => {
  const { approval, ...rest } = entry;
  if (approval === undefined) return rest;
  if (typeof approval !== 'string') return { ...rest, approval };
  return { ...rest, approval: { kind: approval, subjectDigest: digestForCall(entry, toolSet, context) } };
};

export const call = (callId: string, name: string, args: unknown = {}, approval?: ApprovalSpec): HarnessCall =>
  approval === undefined ? { callId, name, arguments: args } : { callId, name, arguments: args, approval };
