import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, canonicalPath, comparableFromParts, containsByComponents, computeBackoff, fileRuleFingerprint, hostKernelLock, hostReapTiming, locateThroughFiles, momongaLayout, reapMarkedProcessesWithReport, sha256Hex, writableAreaOf, writableCheckOf } from '@momonga/foundation';
import type { Clock, FileRuleProvenance, KernelLockMechanism, PathResolution, ProcessInspector, ReapReport, ReapTiming, SignalSender, UninspectableRegistry } from '@momonga/foundation';
import { absoluteFrom, createGlobDeadline, decide, fileRuleSpecsOf, globBudgetMs, prepareGlobs, settleGlobs, suggestAllowRule } from '@momonga/policy';
import type { Decision, PermissionRule, PermissionSubject, PolicyHostFilesystem } from '@momonga/policy';
import { permissionDeniedOutput } from '@momonga/protocol';
import type { ApprovalBasis, ElicitationRequestView, PermissionDenial, PermissionMode, ToolAwait, ToolKind } from '@momonga/protocol';
import { SANDBOX_STOP_BOUND_MS, SandboxPolicyError, canonicalParentForm } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { EarlierAttemptNotStoppedError, createCallLocks } from './call-lock.ts';
import type { CallLock } from './call-lock.ts';
import { readOnlyContextOf } from './read-only-call.ts';
import { createReadAccessMatcher } from './read-access.ts';
import type { ReadFamilyTool } from './read-access.ts';
import type { ReadAccessMatcher } from './read-access.ts';
import type { PreToolHookVerdict, ToolHooks } from './hooks/events.ts';
import type { AutoClassifier, BackgroundJobs, BlobPort, IdempotencyPort, LeaseFence, LeasedIdempotencyPort, LeasedOutcome, ToolIdempotencyLookup, ToolIdempotencyRecord } from './ports.ts';
import type { ToolSet } from './registry.ts';
import { cancellableTimer } from './timers.ts';
import { MINIMUM_INLINE_OUTPUT_CHARS, truncateOutput } from './truncate.ts';
import { ToolExecutionError, ToolInputError, ToolInputRequired, TransientToolError } from './types.ts';
import type { AnyTool, ReconcileContext, ReconcileResult, ToolContent, ToolContext, ToolPending, ToolResult, ToolResume, ToolSessionState } from './types.ts';
import { validateToolInput } from './validate.ts';

const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 30_000;
const DEFAULT_MAX_PARALLEL = 8;
const DEFAULT_READ_ONLY_RETRY = { attempts: 3, baseMs: 200, maxMs: 2000 } as const;
const ABORT_SETTLE_LIMIT_MS = 2000;

export const heldCallWaitMs = (heartbeatMs: number): number => heartbeatMs + ABORT_SETTLE_LIMIT_MS + SANDBOX_STOP_BOUND_MS;

const DEFAULT_RECONCILE_GRACE_MS = 2000;
const DEFAULT_RECONCILE_CAP_MS = 30_000;
const ABANDON_KILL_GRACE_MS = 2000;
const UNKNOWN_EFFECTS_NOTICE = 'Its side effects are unknown; inspect the current state before retrying.';

export type ToolCall = {
  callId: string;
  name: string;
  arguments: string | unknown;
  approval?: { kind: 'allow_once' | 'allow_always'; subjectDigest: string };
  inputResponses?: Record<string, unknown>;
};

type BatchCallbacks = {
  leaseLost?(): boolean;
  onLeaseLost?(): void;
  onOutcome?(outcome: ResultOutcome): void;
  traceparentFor?(callId: string): { traceparent: string; tracestate?: string } | undefined;
  onStarted?(callId: string, idemKey: string, basis: ApprovalBasis): void | Promise<void>;
  onUpdate?(callId: string, content: ToolContent[]): void;
};

type BatchCore = BatchCallbacks & {
  calls: readonly ToolCall[];
  toolSet: ToolSet;
  fence: LeaseFence;
  runId: string;
  step: number;
  mode: PermissionMode;
  home: string;
  roots: readonly string[];
  readRoots?: readonly string[];
  tmpDir?: string;
  env: Readonly<Record<string, string>>;
  session: ToolSessionState;
  deadlineAt: number;
  signal: AbortSignal;
  inlineLimitForReconcile?: number;
  inlineLimitForExecution?: () => Promise<number>;
  hooks?: ToolHooks;
  classifier?: AutoClassifier;
  onHalt?(reason: string, hookEvent: 'PreToolUse' | 'PostToolUse'): void;
};

export type ExecutionBatchInput = BatchCore & {
  rules: PermissionRule[];
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  recoverOnly?: undefined;
};

export type RecoveryBatchInput = BatchCore & {
  rules: readonly [];
  recoverOnly: true;
};

export type BatchInput = ExecutionBatchInput | RecoveryBatchInput;

export type ResultOutcome = {
  callId: string;
  kind: 'result';
  result: ToolResult & { truncated?: true; handle?: string; denial?: PermissionDenial };
  idemKey?: string;
  reconciled?: ReconcileResult['outcome'];
};

export type NeedsApprovalOutcome = {
  callId: string;
  kind: 'needs_approval';
  decision: Decision;
  subjectDigest: string;
  suggestedRule?: string;
  title: string;
  toolKind: ToolKind;
  locations?: { path: string; line?: number }[];
};

export type NeedsInputOutcome = {
  callId: string;
  kind: 'needs_input';
  server: string;
  requests: ElicitationRequestView[];
};

export type DeferredOutcome = { callId: string; kind: 'deferred' };

export type WaitingOutcome = { callId: string; kind: 'waiting'; awaits: ToolAwait; wakeAt?: number };

export type CallOutcome = ResultOutcome | NeedsApprovalOutcome | NeedsInputOutcome | DeferredOutcome | WaitingOutcome;

export type ToolExecutorOptions = {
  idempotency: IdempotencyPort;
  blobs: BlobPort;
  clock: Clock;
  idempotencyTtlMs?: number;
  maxInlineOutputChars?: number;
  readOnlyRetry?: { attempts: number; baseMs: number; maxMs: number };
  maxParallel?: number;
  jobs?: BackgroundJobs;
  processMarkerDir: string;
  callLockDir: string;
  kernelLock?: KernelLockMechanism;
  fs: PolicyHostFilesystem;
  leaseMs: number;
  heartbeatMs: number;
  reconcileCapMs?: number;
  reconcileGraceMs?: number;
  onWarning(message: string): void;
  reap?: { kill?: SignalSender; timing?: ReapTiming; killGraceMs?: number; inspector?: ProcessInspector; uninspectable?: UninspectableRegistry };
};

export type AbandonTarget = { callId: string; idemKey: string };

export type AbandonOutcome = { idemKey: string; callId: string; outcome: 'unknown' };

export type ReleaseTarget = { callId: string; name: string; idemKey: string };

export type ToolExecutor = {
  runBatch(input: BatchInput): Promise<CallOutcome[]>;
  abandon(targets: readonly AbandonTarget[], options: { signal: AbortSignal }): Promise<AbandonOutcome[]>;
  release(targets: readonly ReleaseTarget[], options: { toolSet: () => Promise<ToolSet>; signal: AbortSignal }): Promise<void>;
};

export type InspectableToolExecutor = ToolExecutor & { inFlightKeys(): ReadonlySet<string> };

type ExecutionPlan = {
  kind: 'execution';
  call: ToolCall;
  tool: AnyTool;
  input: unknown;
  gate: Gate;
  key: string;
  batch: ExecutionBatchInput;
  recovered?: ToolIdempotencyRecord;
  gateRan: boolean;
  hookInput?: unknown;
  basis?: ApprovalBasis;
};

type RecoveryPlan = {
  kind: 'recovery';
  call: ToolCall;
  tool: AnyTool;
  input: unknown;
  key: string;
  batch: RecoveryBatchInput;
};

type RunPlan = ExecutionPlan | RecoveryPlan;

type Gate = { subject: PermissionSubject; access: BatchAccess };

type GateTarget = { input: unknown; subject: PermissionSubject; hookInput?: unknown; basis?: ApprovalBasis };

const allowBasisOf = (decision: Decision): ApprovalBasis => {
  if (decision.basis === undefined) throw new Error(`an allow decision from ${decision.source} carries no basis`);
  return decision.basis;
};

const requireBasis = (target: GateTarget): ApprovalBasis => {
  if (target.basis === undefined) throw new Error('a call reached execution without a recorded approval basis');
  return target.basis;
};

type GateStage = 'enforce' | 'preview';

type Admission = { kind: 'outcome'; outcome: CallOutcome } | { kind: 'run'; plan: RunPlan };

type AbortReason = 'timeout' | 'cancelled';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isStoredResultOutcome = (value: unknown): value is ResultOutcome =>
  isRecord(value) &&
  value['kind'] === 'result' &&
  typeof value['callId'] === 'string' &&
  isRecord(value['result']) &&
  (value['result']['status'] === 'completed' || value['result']['status'] === 'failed') &&
  typeof value['result']['output'] === 'string';

const storedOutcome = (stored: unknown): ResultOutcome => {
  if (!isStoredResultOutcome(stored)) throw new TypeError('idempotency record holds a malformed completed outcome');
  return stored;
};

const readDeniedPath = (subject: PermissionSubject, access: ReadAccessMatcher, cwd: string): string | undefined => {
  if (subject.kind !== 'path' || !access.deniesAnything) return undefined;
  return subject.paths.find((target) => access.blocks(target, cwd));
};

const readRuleToolOf = (subjectTool: string): ReadFamilyTool => (subjectTool === 'Grep' || subjectTool === 'Glob' ? subjectTool : 'Read');

const ruleBlock = (subject: PermissionSubject, access: BatchAccess, cwd: string): { target: string; provenance: FileRuleProvenance } | undefined => {
  if (subject.kind !== 'path') return undefined;
  const tool = readRuleToolOf(subject.tool);
  for (const target of subject.paths) {
    const provenance = access.blockedBy(target, cwd, tool) ?? (subject.access === 'write' ? access.writeBlockedBy(target, cwd) : undefined);
    if (provenance !== undefined) return { target, provenance };
  }
  return undefined;
};

const describeProvenance = ({ ruleText, layer, source }: FileRuleProvenance): string => `${ruleText} (${layer}: ${source})`;

const parentCanonicalKey = (target: string): string => {
  const directory = path.dirname(target);
  const name = path.basename(target);
  const { parts, caseInsensitive } = locateThroughFiles(directory);
  return path.join(comparableFromParts(parts, caseInsensitive), caseInsensitive ? name.toLowerCase() : name);
};

const lexicalAncestorsOf = (target: string): string[] => {
  const found: string[] = [];
  for (let current = path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) found.push(current);
  return found;
};

const launcherGuardKeys = (literals: readonly string[]): Set<string> =>
  new Set(
    literals
      .flatMap((literal) => [literal, canonicalParentForm(literal)])
      .flatMap((literal) => [literal, ...lexicalAncestorsOf(literal)])
      .map(parentCanonicalKey),
  );

const isEmptyRegularFile = (target: string): boolean => {
  const stat = fs.lstatSync(target);
  return stat.isFile() && stat.size === 0;
};

const requireResolvable = (entry: string): void => {
  try {
    canonicalPath(entry);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    for (let ancestor = path.dirname(entry); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      let real: string;
      try {
        real = canonicalPath(ancestor);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== 'ENOTDIR') throw inner;
        continue;
      }
      if (isEmptyRegularFile(real)) return;
      throw error;
    }
    throw error;
  }
};

const createWriteGuard = (batch: ExecutionBatchInput): ((subject: PermissionSubject, cwd: string) => string | undefined) => {
  batch.sandboxPolicy.writableRoots.forEach(canonicalPath);
  const layout = momongaLayout(batch.home);
  const homeGuards = new Set([layout.root, layout.keychains]);
  const approvalGated = new Set(batch.sandboxPolicy.protectedSet.paths);
  const entries = batch.sandboxPolicy.writeDenied.filter((entry) => homeGuards.has(entry) || !approvalGated.has(entry));
  const guards = entries.map((entry) => {
    requireResolvable(entry);
    return locateThroughFiles(entry).parts;
  });
  const launcherKeys = launcherGuardKeys(batch.sandboxPolicy.writeDeniedLiterals);
  const blocksLauncher = (target: string): boolean => launcherKeys.has(parentCanonicalKey(target));
  const exempt = batch.tmpDir === undefined ? undefined : locateThroughFiles(batch.tmpDir).parts;
  const blocks = (target: string): boolean => {
    const { parts, caseInsensitive } = locateThroughFiles(target);
    const exemptContains = exempt !== undefined && containsByComponents(exempt, parts, caseInsensitive);
    return guards.some((guard) => containsByComponents(guard, parts, caseInsensitive)) && !exemptContains;
  };
  return (subject, cwd) => {
    if (subject.kind !== 'path' || subject.access !== 'write') return undefined;
    return subject.paths.find((target) => {
      const lexical = path.resolve(cwd, target);
      return blocks(absoluteFrom(target, cwd)) || blocks(lexical) || blocksLauncher(lexical);
    });
  };
};

type BatchAccess = ReadAccessMatcher & {
  writeDeniedPath: (subject: PermissionSubject, cwd: string) => string | undefined;
  isWritable: (absolute: string) => boolean;
};

const rootsOf = (batch: BatchCore): readonly string[] => (batch.tmpDir === undefined ? batch.roots : [...batch.roots, batch.tmpDir]);

const digestSubject = (subject: PermissionSubject, cwd: string, canonicalise: (absolute: string) => PathResolution): unknown => {
  if (subject.kind === 'path') {
    return {
      ...subject,
      paths: subject.paths.map((target) => {
        const absolute = absoluteFrom(target, cwd);
        const real = canonicalise(absolute);
        if (!real.ok) throw new Error(`${absolute} cannot be resolved to a real location`);
        return real.path;
      }),
    };
  }
  if (subject.kind === 'command') {
    const canonicalCwd = canonicalise(cwd);
    if (!canonicalCwd.ok) throw new Error(`session cwd ${cwd} cannot be resolved to a real location`);
    return { subject, cwd: canonicalCwd.path };
  }
  return subject;
};

export const subjectDigestOf = (subject: PermissionSubject, cwd: string, canonicalise: (absolute: string) => PathResolution): string =>
  sha256Hex(canonicalJson(digestSubject(subject, cwd, canonicalise)));

const failedOutcome = (callId: string, output: string): ResultOutcome => ({
  callId,
  kind: 'result',
  result: { status: 'failed', output },
});

const deniedOutcome = (callId: string, denial: PermissionDenial): ResultOutcome => ({
  callId,
  kind: 'result',
  result: { status: 'failed', output: permissionDeniedOutput(denial), denial },
});

const describeThrown = (toolName: string, error: unknown): string => {
  if (error instanceof ToolInputError || error instanceof ToolExecutionError || error instanceof TransientToolError) return error.message;
  return `Internal error in ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
};

const hasUnknownEffects = (tool: AnyTool): boolean => tool.sideEffect !== 'read_only';

const cancelledOutput = (tool: AnyTool): string =>
  hasUnknownEffects(tool) ? `${tool.name} was cancelled. ${UNKNOWN_EFFECTS_NOTICE}` : `${tool.name} was cancelled`;

const timedOutOutput = (tool: AnyTool, ms: number): string =>
  hasUnknownEffects(tool) ? `${tool.name} timed out after ${ms} ms. ${UNKNOWN_EFFECTS_NOTICE}` : `${tool.name} timed out after ${ms} ms`;

const interruptedOutput = (tool: AnyTool): string =>
  `An earlier attempt of ${tool.name} was interrupted before it reported a result. Its effect is unknown; inspect the current state before retrying.`;

const idempotencyKeyFor = (runId: string, step: number, callId: string): string => sha256Hex(canonicalJson([runId, step, callId]));

const createLimiter = (limit: number): { acquire(): Promise<() => void> } => {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return {
    acquire: async () => {
      if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
      else active += 1;
      return release;
    },
  };
};

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(handle);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const handle = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

const settleWithin = async (pending: Promise<unknown>, ms: number): Promise<void> => {
  const timer = cancellableTimer(ms);
  try {
    await Promise.race([pending, timer.done]);
  } finally {
    timer.cancel();
  }
};

export const createToolExecutor = (options: ToolExecutorOptions): InspectableToolExecutor => {
  if (options.maxInlineOutputChars !== undefined && options.maxInlineOutputChars < MINIMUM_INLINE_OUTPUT_CHARS) {
    throw new RangeError(`maxInlineOutputChars must be at least ${MINIMUM_INLINE_OUTPUT_CHARS}`);
  }
  const { idempotency, blobs, clock } = options;
  const ttlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxInlineOutputChars = options.maxInlineOutputChars ?? DEFAULT_MAX_INLINE_OUTPUT_CHARS;
  const retry = options.readOnlyRetry ?? DEFAULT_READ_ONLY_RETRY;
  const maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;
  const reconcileCapMs = options.reconcileCapMs ?? DEFAULT_RECONCILE_CAP_MS;
  const reconcileGraceMs = options.reconcileGraceMs ?? DEFAULT_RECONCILE_GRACE_MS;
  const reapTiming = options.reap?.timing ?? hostReapTiming;
  const callLocks = createCallLocks({
    dir: options.callLockDir,
    mechanism: options.kernelLock ?? hostKernelLock(),
    timing: reapTiming,
    waitMs: heldCallWaitMs(options.heartbeatMs),
  });
  const releaseCallLock = (lock: CallLock): void => {
    try {
      lock.release();
    } catch (error) {
      options.onWarning(`a call lock could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const activeKeys = new Map<string, number>();

  const scopedBlobs = (runId: string): BlobPort => ({
    put: (data, putOptions) => blobs.put(data, { ...putOptions, runId }),
    read: ((handle: string, range: never) => blobs.read(handle, range, { runId })) as BlobPort['read'],
  });

  const finalizeResult = (result: ToolResult, tool: AnyTool, limit: number, runId: string): ResultOutcome['result'] => {
    const truncated =
      tool.pagesOutput === true && result.output.length <= limit
        ? { output: result.output }
        : truncateOutput(result.output, limit, scopedBlobs(runId));
    return {
      status: result.status,
      output: truncated.output,
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.plan === undefined ? {} : { plan: result.plan }),
      ...(result.skill === undefined ? {} : { skill: result.skill }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...('truncated' in truncated ? { truncated: truncated.truncated, handle: truncated.handle } : {}),
    };
  };

  const reasonOr = (reason: string | undefined, fallback: string): string => (reason === undefined || reason === '' ? fallback : reason);

  const hookVerdicts = new Map<string, { verdict: PreToolHookVerdict | undefined; expiresAt: number }>();

  const rememberVerdict = (key: string, verdict: PreToolHookVerdict | undefined): void => {
    const now = clock.now();
    for (const [stored, entry] of hookVerdicts) if (entry.expiresAt <= now) hookVerdicts.delete(stored);
    hookVerdicts.set(key, { verdict, expiresAt: now + ttlMs });
  };

  const haltedBatches = new WeakMap<object, string>();

  const haltBatch = (batch: BatchCore, reason: string | undefined, source: 'PreToolUse' | 'PostToolUse'): string => {
    const text = reasonOr(reason, `a ${source} hook stopped the run`);
    if (!haltedBatches.has(batch)) {
      haltedBatches.set(batch, text);
      batch.onHalt?.(text, source);
    }
    return text;
  };

  const globBudget = globBudgetMs({ leaseMs: options.leaseMs, heartbeatMs: options.heartbeatMs });

  const evaluatePolicy = async (
    call: ToolCall,
    tool: AnyTool,
    subject: PermissionSubject,
    access: BatchAccess,
    batch: ExecutionBatchInput,
  ): Promise<{ outcome: CallOutcome } | { decision: Decision }> => {
    const cwd = batch.session.cwd;
    const blockedPath = readDeniedPath(subject, access, cwd);
    if (blockedPath !== undefined) return { outcome: deniedOutcome(call.callId, { source: 'sandbox', reason: `${blockedPath} is blocked by the sandbox policy` }) };
    const writeBlockedPath = access.writeDeniedPath(subject, cwd);
    if (writeBlockedPath !== undefined) {
      return { outcome: deniedOutcome(call.callId, { source: 'sandbox', reason: `${writeBlockedPath} is write-protected by the sandbox policy` }) };
    }
    const blockedByRule = ruleBlock(subject, access, cwd);
    if (blockedByRule !== undefined) {
      return {
        outcome: deniedOutcome(call.callId, { source: 'rule', reason: `${blockedByRule.target} is blocked by ${describeProvenance(blockedByRule.provenance)}` }),
      };
    }
    const globs = await prepareGlobs({
      expand: options.fs.expandGlob,
      platform: options.fs.platform,
      subject,
      cwd,
      home: batch.home,
      deadline: createGlobDeadline(globBudget),
      signal: batch.signal,
    });
    if (batch.signal.aborted) return { outcome: failedOutcome(call.callId, `${tool.name} was cancelled`) };
    const decision = decide({
      tool,
      subject,
      mode: batch.mode,
      rules: batch.rules,
      roots: [...rootsOf(batch)],
      ...(batch.readRoots === undefined ? {} : { readRoots: batch.readRoots }),
      home: batch.home,
      cwd,
      fileRules: batch.sandboxPolicy.fileRules,
      protectedSet: batch.sandboxPolicy.protectedSet,
      fs: settleGlobs(options.fs, globs),
      searchPath: batch.env['PATH'],
      isWritable: access.isWritable,
    });
    if (decision.kind === 'deny') {
      return { outcome: deniedOutcome(call.callId, { source: decision.source === 'mode' ? 'mode' : 'rule', reason: decision.reason }) };
    }
    return { decision };
  };

  const permissionGate = async (
    call: ToolCall,
    tool: AnyTool,
    target: GateTarget,
    access: BatchAccess,
    batch: ExecutionBatchInput,
    stage: GateStage = 'enforce',
  ): Promise<CallOutcome | undefined> => {
    const cwd = batch.session.cwd;
    const policyTool = tool;
    const first = await evaluatePolicy(call, tool, target.subject, access, batch);
    if ('outcome' in first) return first.outcome;
    let decision = first.decision;
    const hooks = batch.hooks !== undefined && batch.hooks.matchesPreToolUse(tool.name) ? batch.hooks : undefined;
    if (stage === 'preview' && (hooks !== undefined || batch.mode === 'auto')) return undefined;

    const key = idempotencyKeyFor(batch.runId, batch.step, call.callId);
    let verdict: PreToolHookVerdict | undefined;
    if (hooks !== undefined) {
      const remembered = call.approval === undefined ? undefined : hookVerdicts.get(key);
      verdict = remembered !== undefined ? remembered.verdict : await hooks.preToolUse({ callId: call.callId, toolName: tool.name, input: target.input });
      hookVerdicts.delete(key);
      if (verdict?.halt !== undefined) {
        const reason = haltBatch(batch, verdict.halt.reason, 'PreToolUse');
        return failedOutcome(call.callId, `${tool.name} was not run: a PreToolUse hook stopped the run: ${reason}`);
      }
      if (verdict?.updatedInput !== undefined) {
        const validation = validateToolInput(tool, verdict.updatedInput);
        if (!validation.ok) return failedOutcome(call.callId, `A PreToolUse hook returned an input that ${tool.name} rejects: ${validation.message}`);
        let subject: PermissionSubject;
        try {
          subject = tool.subject(validation.value, { cwd, home: batch.home, roots: rootsOf(batch) });
        } catch (error) {
          return failedOutcome(call.callId, describeThrown(tool.name, error));
        }
        const second = await evaluatePolicy(call, tool, subject, access, batch);
        if ('outcome' in second) return second.outcome;
        decision = second.decision;
        target.input = validation.value;
        target.subject = subject;
        target.hookInput = validation.value;
      }
      if (verdict?.decision === 'deny') {
        return deniedOutcome(call.callId, { source: 'hook', reason: reasonOr(verdict.reason, `a PreToolUse hook denied ${tool.name}`) });
      }
      if (verdict?.decision === 'ask' && decision.kind === 'allow') {
        decision = { kind: 'ask', source: 'hook', reason: reasonOr(verdict.reason, 'a PreToolUse hook requires approval') };
      }
      if (verdict?.decision === 'allow' && decision.kind === 'ask' && decision.source === 'mode' && decision.humanOnly !== true) {
        decision = { kind: 'allow', source: 'hook', reason: reasonOr(verdict.reason, 'allowed by a PreToolUse hook'), basis: 'hook' };
      }
    }
    const { subject, input } = target;
    const unsandboxedExec = decision.kind === 'allow' && tool.sideEffect === 'exec' && batch.sandbox.kind === 'none';
    const { approval } = call;
    if ((decision.kind === 'ask' || unsandboxedExec)) {
      let subjectDigest: string;
      try {
        subjectDigest = subjectDigestOf(subject, cwd, options.fs.canonicalise);
      } catch (error) {
        return failedOutcome(call.callId, `Permission check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (approval?.subjectDigest !== subjectDigest) {
        const effective: Decision = unsandboxedExec
          ? { kind: 'ask', source: 'mode', reason: 'no sandbox is available: file deny rules are checked on the command text only, so command execution requires approval' }
          : decision;
        if (batch.mode === 'auto' && effective.source === 'mode' && effective.humanOnly !== true) {
          if (batch.classifier === undefined) throw new Error('auto mode needs a classifier');
          const classified = await batch.classifier.classify({
            callId: call.callId,
            toolName: tool.name,
            title: tool.title(input),
            input,
            reason: effective.reason,
            subjectDigest,
          });
          if (classified === 'allow') {
            target.basis = 'classifier';
            return undefined;
          }
        }
        if (hooks !== undefined) rememberVerdict(key, verdict);
        const suggestedRule =
          unsandboxedExec || decision.source === 'protected' || decision.source === 'hook' || decision.rule?.layer === 'governance'
            ? undefined
            : suggestAllowRule(policyTool, subject, cwd, options.fs.canonicalise);
        const locations = tool.locations?.(input);
        return {
          callId: call.callId,
          kind: 'needs_approval',
          decision: effective,
          subjectDigest,
          ...(suggestedRule === undefined ? {} : { suggestedRule }),
          title: tool.title(input),
          toolKind: tool.kind,
          ...(locations === undefined ? {} : { locations }),
        };
      }
      target.basis = 'person';
      return undefined;
    }
    target.basis = allowBasisOf(decision);
    return undefined;
  };

  const hookedInputOf = (tool: AnyTool, lookup: ToolIdempotencyLookup | undefined): { input: unknown } | { failure: string } | undefined => {
    const record = lookup?.s === 'PENDING' || lookup?.s === 'UNKNOWN' ? lookup.rec.meta['hookInput'] : undefined;
    if (record === undefined) return undefined;
    const validation = validateToolInput(tool, record);
    return validation.ok ? { input: validation.value } : { failure: validation.message };
  };

  const admit = async (call: ToolCall, batch: BatchInput, access: BatchAccess | undefined, stage: GateStage = 'enforce'): Promise<Admission> => {
    const outcome = (value: CallOutcome): Admission => ({ kind: 'outcome', outcome: value });
    if (batch.signal.aborted) return outcome(failedOutcome(call.callId, `${call.name} was cancelled`));
    if (haltedBatches.has(batch)) return outcome(failedOutcome(call.callId, `${call.name} was not run: a hook stopped the run`));
    const tool = batch.toolSet.get(call.name);
    if (tool === undefined) {
      const available = batch.toolSet.tools.map((candidate) => candidate.name).join(', ');
      return outcome(failedOutcome(call.callId, `Unknown tool "${call.name}". Available tools: ${available}`));
    }
    const validation = validateToolInput(tool, call.arguments);
    if (!validation.ok) return outcome(failedOutcome(call.callId, validation.message));
    let input = validation.value;
    const cwd = batch.session.cwd;

    const key = idempotencyKeyFor(batch.runId, batch.step, call.callId);
    if (batch.recoverOnly === true) {
      const existing = idempotency.get(key);
      if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));
      if (existing === undefined) return outcome(failedOutcome(call.callId, `${tool.name} was cancelled`));
      if (existing.s === 'UNKNOWN') {
        return outcome({ ...failedOutcome(call.callId, interruptedOutput(tool)), idemKey: key, reconciled: 'unknown' });
      }
      const hooked = hookedInputOf(tool, existing);
      if (hooked !== undefined && 'failure' in hooked) return outcome(failedOutcome(call.callId, hooked.failure));
      return { kind: 'run', plan: { kind: 'recovery', call, tool, input: hooked === undefined ? input : hooked.input, key, batch } };
    }

    if (access === undefined) throw new Error('read access is required for a batch that can execute');
    const existing = idempotency.get(key);
    if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));
    const recovered = existing?.s === 'PENDING' || existing?.s === 'UNKNOWN' ? existing.rec : undefined;
    const hooked = hookedInputOf(tool, existing);
    if (hooked !== undefined && 'failure' in hooked) return outcome(failedOutcome(call.callId, hooked.failure));
    if (hooked !== undefined) input = hooked.input;

    let subject: PermissionSubject;
    try {
      subject = tool.subject(input, { cwd, home: batch.home, roots: rootsOf(batch) });
    } catch (error) {
      return outcome(failedOutcome(call.callId, describeThrown(tool.name, error)));
    }
    const target: GateTarget = { input, subject };

    if (recovered === undefined) {
      const gated = await permissionGate(call, tool, target, access, batch, stage);
      if (gated !== undefined) return outcome(gated);
    }
    return {
      kind: 'run',
      plan: {
        kind: 'execution',
        call,
        tool,
        input: target.input,
        gate: { subject: target.subject, access },
        key,
        batch,
        gateRan: recovered === undefined,
        ...(target.hookInput === undefined ? {} : { hookInput: target.hookInput }),
        ...(target.basis === undefined ? {} : { basis: target.basis }),
        ...(recovered === undefined ? {} : { recovered }),
      },
    };
  };

  type CallScope = {
    controller: AbortController;
    processMarker: string;
    reconcileCtx: ReconcileContext;
    abortReason(): AbortReason | undefined;
    abortWith(reason: AbortReason): void;
    armTimer(ms: number): void;
    timerMs(): number;
    extendTimerToDeadline(): void;
    disarmTimer(): void;
    closeContext(): void;
    ledger: LeasedIdempotencyPort;
    holding(outcome: LeasedOutcome): boolean;
    deferred: CallOutcome;
    holdCall(): Promise<'held' | 'aborted'>;
    trackEffect(running: Promise<unknown>): void;
    checkpoint(state: Record<string, unknown> | undefined): void;
    complete(result: ResultOutcome['result'], reconciled?: ReconcileResult['outcome']): CallOutcome;
    waiting(pending: ToolPending): CallOutcome;
    release(): void;
  };

  const openScope = (batch: BatchCore, call: ToolCall, tool: AnyTool, key: string, inlineLimit: number, deadlineAt: number): CallScope => {
    const { callId } = call;
    const controller = new AbortController();
    let abortReason: AbortReason | undefined;
    let recordCompleted = false;
    let contextClosed = false;
    let timer: NodeJS.Timeout | undefined;
    let timerMs = 0;
    let heldLock: CallLock | undefined;
    let effect: Promise<unknown> | undefined;
    const leaseLost = (): boolean => batch.leaseLost?.() === true;
    const ledger = idempotency.holding(batch.fence);
    const holding = (outcome: LeasedOutcome): boolean => {
      if (outcome.kind === 'ok') return true;
      batch.onLeaseLost?.();
      return false;
    };
    const abortWith = (reason: AbortReason): void => {
      if (abortReason !== undefined) return;
      abortReason = reason;
      controller.abort();
    };
    const processMarker = path.join(options.processMarkerDir, key);
    const onBatchAbort = (): void => abortWith('cancelled');
    batch.signal.addEventListener('abort', onBatchAbort, { once: true });
    activeKeys.set(key, (activeKeys.get(key) ?? 0) + 1);
    const trace = batch.traceparentFor?.(callId);
    const reconcileCtx: ReconcileContext = {
      cwd: batch.session.cwd,
      home: batch.home,
      roots: rootsOf(batch),
      ...(batch.tmpDir === undefined ? {} : { tmpDir: batch.tmpDir }),
      runId: batch.runId,
      step: batch.step,
      callId,
      idemKey: key,
      outputBudgetChars: inlineLimit,
      ...(tool.sideEffect === 'exec' ? { processMarker } : {}),
      ...(trace === undefined ? {} : { traceparent: trace.traceparent }),
      ...(trace?.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
      env: batch.env,
      signal: controller.signal,
      deadlineAt,
      blobs: scopedBlobs(batch.runId),
      clock,
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      session: batch.session,
      attachProcess: (processInfo) => {
        if (!leaseLost() && !contextClosed) holding(ledger.attachProcess(key, processInfo));
      },
      update: (content) => {
        if (!contextClosed) batch.onUpdate?.(callId, content);
      },
    };
    const deferred: DeferredOutcome = { callId, kind: 'deferred' };
    return {
      controller,
      processMarker,
      reconcileCtx,
      abortReason: () => abortReason,
      abortWith,
      armTimer: (ms) => {
        timerMs = ms;
        timer = setTimeout(() => abortWith('timeout'), ms);
      },
      timerMs: () => timerMs,
      extendTimerToDeadline: () => {
        clearTimeout(timer);
        timerMs = Math.max(0, deadlineAt - clock.now());
        timer = setTimeout(() => abortWith('timeout'), timerMs);
      },
      disarmTimer: () => clearTimeout(timer),
      closeContext: () => {
        contextClosed = true;
      },
      ledger,
      holding,
      deferred,
      holdCall: async () => {
        if (tool.sideEffect === 'read_only' || heldLock !== undefined) return 'held';
        const acquired = await callLocks.acquire(key, controller.signal);
        if (acquired === 'aborted') return 'aborted';
        heldLock = acquired;
        return 'held';
      },
      trackEffect: (running) => {
        effect = running;
      },
      checkpoint: (state) => {
        if (!leaseLost() && !contextClosed) holding(ledger.checkpoint(key, state));
      },
      complete: (result, reconciled) => {
        if (leaseLost()) return deferred;
        const outcome: ResultOutcome = { callId, kind: 'result', result, idemKey: key, ...(reconciled === undefined ? {} : { reconciled }) };
        if (!holding(ledger.complete(key, outcome))) return deferred;
        recordCompleted = true;
        return outcome;
      },
      waiting: (pending) => {
        if (leaseLost()) return deferred;
        return { callId, kind: 'waiting', awaits: pending.awaits, ...(pending.wakeAt === undefined ? {} : { wakeAt: pending.wakeAt }) };
      },
      release: () => {
        clearTimeout(timer);
        const lock = heldLock;
        heldLock = undefined;
        if (lock !== undefined) {
          if (effect === undefined) releaseCallLock(lock);
          else void effect.then(
            () => releaseCallLock(lock),
            () => releaseCallLock(lock),
          );
        }
        batch.signal.removeEventListener('abort', onBatchAbort);
        const remaining = (activeKeys.get(key) ?? 0) - 1;
        if (remaining > 0) activeKeys.set(key, remaining);
        else activeKeys.delete(key);
        if (recordCompleted && tool.sideEffect === 'exec') {
          try {
            fs.rmSync(processMarker, { force: true });
          } catch (error) {
            options.onWarning(`the process marker of call ${key} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    };
  };

  const reapEarlierAttempt = async (key: string, pgid: number | undefined): Promise<NonNullable<ReconcileContext['earlierAttempt']>> => {
    const marker = path.join(options.processMarkerDir, key);
    let reaped: ReapReport;
    try {
      reaped = await reapMarkedProcessesWithReport({
        marker,
        pgid,
        killGraceMs: options.reap?.killGraceMs ?? ABANDON_KILL_GRACE_MS,
        label: 'tool',
        onWarning: options.onWarning,
        timing: reapTiming,
        ...(options.reap?.kill === undefined ? {} : { kill: options.reap.kill }),
        ...(options.reap?.inspector === undefined ? {} : { inspector: options.reap.inspector }),
        ...(options.reap?.uninspectable === undefined ? {} : { uninspectable: options.reap.uninspectable }),
      });
    } catch (error) {
      throw new EarlierAttemptNotStoppedError(
        `the earlier attempt of call ${key} could not be verified as stopped: ${error instanceof Error ? error.message : String(error)}`,
        'unverifiable',
        { cause: error },
      );
    }
    if (!reaped.removed) {
      throw new EarlierAttemptNotStoppedError(`a process of the earlier attempt of call ${key} survived the attempt to stop it`, 'survived');
    }
    if (reaped.uninspectable.length > 0) {
      return { stopped: false, uninspectable: reaped.uninspectable.map(({ pid, command }) => ({ pid, command })) };
    }
    return { stopped: reaped.stopped };
  };

  type Resumed = { kind: 'reconciled'; result: ReconcileResult } | { kind: 'outcome'; outcome: CallOutcome };

  const reconcileAsHolder = async (scope: CallScope, callId: string, tool: AnyTool, input: unknown, record: ToolIdempotencyRecord): Promise<Resumed> => {
    if ((await scope.holdCall()) === 'aborted') return { kind: 'outcome', outcome: failedOutcome(callId, `${tool.name} was cancelled`) };
    if (!scope.holding(scope.ledger.authorise(record.key))) return { kind: 'outcome', outcome: scope.deferred };
    const earlierAttempt = await reapEarlierAttempt(record.key, record.pgid);
    try {
      const ctx: ReconcileContext = { ...scope.reconcileCtx, earlierAttempt };
      return { kind: 'reconciled', result: await reconcileWithin(tool, input, record, ctx, () => scope.abortWith('timeout'), scope.closeContext) };
    } catch (error) {
      return { kind: 'outcome', outcome: failedOutcome(callId, describeThrown(tool.name, error)) };
    }
  };

  const reconcileOnly = async (batch: RecoveryBatchInput, plan: RecoveryPlan): Promise<CallOutcome> => {
    const { call, tool, input, key } = plan;
    const { callId } = call;
    const inlineLimit = batch.inlineLimitForReconcile ?? maxInlineOutputChars;
    if (batch.signal.aborted) return failedOutcome(callId, `${tool.name} was cancelled`);
    const scope = openScope(batch, call, tool, key, inlineLimit, clock.now() + reconcileCapMs + reconcileGraceMs);
    try {
      const current = idempotency.get(key);
      if (current?.s === 'COMPLETED') return storedOutcome(current.result);
      const record = current?.rec;
      if (record === undefined) return failedOutcome(callId, `${tool.name} was cancelled`);
      const resumed = await reconcileAsHolder(scope, callId, tool, input, record);
      if (resumed.kind === 'outcome') return resumed.outcome;
      const reconcileOutcome = resumed.result;
      if (reconcileOutcome.outcome === 'not_applied') {
        return scope.complete(finalizeResult({ status: 'failed', output: cancelledOutput(tool) }, tool, inlineLimit, batch.runId), 'not_applied');
      }
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return scope.complete(finalizeResult({ status, output: reconcileOutcome.output }, tool, inlineLimit, batch.runId), reconcileOutcome.outcome);
    } finally {
      scope.release();
    }
  };

  const applyPostToolHooks = async (batch: ExecutionBatchInput, call: ToolCall, tool: AnyTool, input: unknown, result: ToolResult): Promise<ToolResult> => {
    if (batch.hooks === undefined || result.status !== 'completed') return result;
    const hooked = await batch.hooks.postToolUse({ callId: call.callId, toolName: tool.name, input, output: result.output });
    if (hooked === undefined) return result;
    if (hooked.halt !== undefined) haltBatch(batch, hooked.halt.reason, 'PostToolUse');
    return hooked.feedback === undefined ? result : { ...result, output: `${result.output}\n\n[PostToolUse hook]\n${hooked.feedback}` };
  };

  const performExecution = async (batch: ExecutionBatchInput, plan: ExecutionPlan): Promise<CallOutcome> => {
    const { call, tool, gate, key, recovered, gateRan } = plan;
    const target: GateTarget = {
      input: plan.input,
      subject: gate.subject,
      ...(plan.hookInput === undefined ? {} : { hookInput: plan.hookInput }),
      ...(plan.basis === undefined ? {} : { basis: plan.basis }),
    };
    const { callId } = call;
    const inlineLimit = batch.inlineLimitForReconcile ?? maxInlineOutputChars;
    let executionLimit: Promise<number> | undefined;
    const resolveExecutionLimit = (): Promise<number> => {
      executionLimit ??= batch.inlineLimitForExecution === undefined ? Promise.resolve(inlineLimit) : batch.inlineLimitForExecution();
      return executionLimit;
    };
    if (batch.signal.aborted) return failedOutcome(callId, `${tool.name} was cancelled`);
    if (batch.deadlineAt - clock.now() <= 0) return failedOutcome(callId, `Run deadline exceeded before ${tool.name} could start`);

    const scope = openScope(batch, call, tool, key, inlineLimit, batch.deadlineAt);
    const toolContext: ToolContext = { ...scope.reconcileCtx, sandbox: batch.sandbox, sandboxPolicy: batch.sandboxPolicy, checkpoint: scope.checkpoint, extendToRunDeadline: scope.extendTimerToDeadline };
    const contextForBasis = (): ToolContext => (requireBasis(target) === 'read_only' ? readOnlyContextOf(toolContext) : toolContext);

    try {
      let prepared: Record<string, unknown> | undefined;
      let record: ToolIdempotencyRecord | undefined;
      let gateAdmitted = gateRan;
      if (recovered !== undefined) {
        const current = idempotency.get(key);
        if (current?.s === 'COMPLETED') return storedOutcome(current.result);
        record = current?.rec;
        if (record === undefined) {
          const gated = await permissionGate(call, tool, target, gate.access, batch);
          if (gated !== undefined) return gated;
          gateAdmitted = true;
        } else {
          const stored = record.meta['prepared'];
          prepared = isRecord(stored) ? stored : undefined;
        }
      }
      if (record === undefined) {
        await resolveExecutionLimit();
        if (tool.prepare !== undefined) {
          try {
            prepared = await tool.prepare(target.input, contextForBasis());
          } catch (error) {
            return failedOutcome(callId, describeThrown(tool.name, error));
          }
        }
        if (scope.abortReason() !== undefined) return failedOutcome(callId, `${tool.name} was cancelled`);
        const begun = scope.ledger.begin(key, {
          expiresAt: clock.now() + ttlMs,
          meta: {
            tool: tool.name,
            runId: batch.runId,
            ...(prepared === undefined ? {} : { prepared }),
            ...(target.hookInput === undefined ? {} : { hookInput: target.hookInput }),
          },
        });
        if (begun.s === 'LEASE_LOST') {
          scope.holding({ kind: 'lease_lost' });
          return scope.deferred;
        }
        if (begun.s === 'COMPLETED') return storedOutcome(begun.result);
        if (begun.s !== 'NEW') record = begun.rec;
      }

      const execute = async (reconciled?: ReconcileResult['outcome'], resume?: ToolResume): Promise<CallOutcome> => {
        const outputLimit = await resolveExecutionLimit();
        if ((await scope.holdCall()) === 'aborted') return failedOutcome(callId, `${tool.name} was cancelled`);
        if (!scope.holding(scope.ledger.authorise(key))) return scope.deferred;
        const executionCtx: ToolContext = { ...contextForBasis(), outputBudgetChars: outputLimit, ...(resume === undefined ? {} : { resume }) };
        if (tool.sideEffect === 'exec') {
          fs.rmSync(scope.processMarker, { force: true });
          fs.closeSync(fs.openSync(scope.processMarker, 'wx', 0o600));
        }
        const requestedMs = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(target.input) : tool.timeoutMs;
        const timeoutMs = Math.max(0, Math.min(requestedMs, batch.deadlineAt - clock.now()));

        const runTool = async (): Promise<ToolResult | ToolPending | ToolInputRequired> => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await tool.execute(target.input, executionCtx, prepared);
            } catch (error) {
              if (error instanceof ToolInputRequired) return error;
              const retryable =
                error instanceof TransientToolError &&
                tool.sideEffect === 'read_only' &&
                attempt + 1 < retry.attempts &&
                !scope.controller.signal.aborted &&
                batch.deadlineAt - clock.now() > 0;
              if (!retryable) return { status: 'failed', output: describeThrown(tool.name, error) };
              await pause(computeBackoff({ attempt, baseMs: retry.baseMs, maxMs: retry.maxMs, random: Math.random }), scope.controller.signal);
              if (scope.controller.signal.aborted) return { status: 'failed', output: describeThrown(tool.name, error) };
            }
          }
        };

        const aborted = new Promise<void>((resolve) => {
          if (scope.controller.signal.aborted) resolve();
          else scope.controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        scope.armTimer(timeoutMs);
        const running = runTool();
        scope.trackEffect(running);
        const result = await Promise.race([running, aborted.then(() => undefined)]);
        if (scope.abortReason() === undefined && result !== undefined) {
          if (result instanceof ToolInputRequired) {
            scope.checkpoint(result.checkpoint);
            return leaseHeld() ? { callId, kind: 'needs_input', server: result.server, requests: result.requests } : { callId, kind: 'deferred' };
          }
          if (result.status === 'pending') return scope.waiting(result);
          scope.disarmTimer();
          const hooked = await applyPostToolHooks(batch, call, tool, target.input, result);
          return scope.complete(finalizeResult(hooked, tool, outputLimit, batch.runId), reconciled);
        }
        await settleWithin(running, ABORT_SETTLE_LIMIT_MS);
        const output = scope.abortReason() === 'timeout' ? timedOutOutput(tool, scope.timerMs()) : cancelledOutput(tool);
        return scope.complete({ status: 'failed', output }, reconciled);
      };

      const leaseHeld = (): boolean => batch.leaseLost?.() !== true;

      const admitExecution = async (): Promise<CallOutcome | undefined> => {
        if (gateAdmitted) return undefined;
        const gated = await permissionGate(call, tool, target, gate.access, batch);
        if (gated?.kind === 'needs_approval') return gated;
        if (gated?.kind === 'result') return scope.complete(gated.result);
        return undefined;
      };

      if (record === undefined) {
        await batch.onStarted?.(callId, key, requireBasis(target));
        return await execute();
      }

      const checkpoint = record.meta['checkpoint'];
      if (isRecord(checkpoint)) {
        const refused = await admitExecution();
        if (refused !== undefined) return refused;
        return await execute(undefined, { checkpoint, inputResponses: call.inputResponses });
      }

      const resumed = await reconcileAsHolder(scope, callId, tool, target.input, record);
      if (resumed.kind === 'outcome') return resumed.outcome;
      const reconcileOutcome = resumed.result;
      if (reconcileOutcome.outcome === 'not_applied') {
        const refused = await admitExecution();
        if (refused !== undefined) return refused;
        return await execute('not_applied');
      }
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return scope.complete(finalizeResult({ status, output: reconcileOutcome.output }, tool, inlineLimit, batch.runId), reconcileOutcome.outcome);
    } finally {
      scope.release();
    }
  };

  const perform = (plan: RunPlan): Promise<CallOutcome> =>
    plan.kind === 'recovery' ? reconcileOnly(plan.batch, plan) : performExecution(plan.batch, plan);

  const reconcileWithin = async (
    tool: AnyTool,
    input: unknown,
    record: ToolIdempotencyRecord,
    ctx: ReconcileContext,
    abortTool: () => void,
    closeContext: () => void,
  ): Promise<ReconcileResult> => {
    const running = reconcileInterrupted(tool, input, record, ctx);
    const finished = running.then((value) => ({ value }));
    const cap = cancellableTimer(reconcileCapMs);
    let first: { value: ReconcileResult } | void;
    try {
      first = await Promise.race([finished, cap.done]);
    } finally {
      cap.cancel();
    }
    if (first !== undefined) return first.value;
    abortTool();
    const grace = cancellableTimer(reconcileGraceMs);
    try {
      await Promise.race([finished, grace.done]);
    } finally {
      grace.cancel();
    }
    closeContext();
    running.catch(() => undefined);
    return { outcome: 'unknown', output: interruptedOutput(tool) };
  };

  const reconcileInterrupted = async (
    tool: AnyTool,
    input: unknown,
    record: ToolIdempotencyRecord,
    ctx: ReconcileContext,
  ): Promise<ReconcileResult> => {
    if (tool.reconcile !== undefined) return tool.reconcile(input, record, ctx);
    if (tool.sideEffect === 'read_only') return { outcome: 'not_applied', output: '' };
    return { outcome: 'unknown', output: interruptedOutput(tool) };
  };

  const prepareBatch = (given: BatchInput): { batch: BatchInput; access: BatchAccess | undefined } => {
    if (given.recoverOnly === true) return { batch: given, access: undefined };
    const expected = fileRuleFingerprint(fileRuleSpecsOf(given.rules, given.roots), given.roots, given.tmpDir ?? null);
    if (given.sandboxPolicy.fileRules.fingerprint !== expected) {
      throw new SandboxPolicyError('file_rules_stale', 'the sandbox policy was built from different permission rules, roots or session tmp dir than this batch');
    }
    const { writableRoots } = given.sandboxPolicy;
    const isWritable = writableCheckOf(writableAreaOf({ writableRoots, entries: given.sandboxPolicy.fileRules.entries }));
    return { batch: given, access: { ...createReadAccessMatcher(given.sandboxPolicy), writeDeniedPath: createWriteGuard(given), isWritable } };
  };

  const runBatch = async (given: BatchInput): Promise<CallOutcome[]> => {
    const { batch, access } = prepareBatch(given);
    const { calls } = batch;
    const outcomes: Array<CallOutcome | undefined> = new Array<CallOutcome | undefined>(calls.length).fill(undefined);
    const inFlight = new Set<Promise<void>>();
    const limiter = createLimiter(maxParallel);

    let failure: { error: unknown } | undefined;
    const recordFailure = (error: unknown): void => {
      if (failure === undefined) failure = { error };
    };

    const announce = (outcome: CallOutcome): void => {
      if (outcome.kind === 'result' && batch.leaseLost?.() !== true) batch.onOutcome?.(outcome);
    };

    const drain = async (): Promise<void> => {
      await Promise.all(inFlight);
    };

    let approvalAsked = false;

    const surfaceApprovalsFrom = async (start: number): Promise<void> => {
      for (let later = start; later < calls.length; later += 1) {
        const call = calls[later] as ToolCall;
        const admission = await admit(call, batch, access, 'preview');
        outcomes[later] =
          admission.kind === 'outcome' && admission.outcome.kind === 'needs_approval'
            ? admission.outcome
            : { callId: call.callId, kind: 'deferred' };
      }
    };

    const walk = async (): Promise<void> => {
      for (let index = 0; index < calls.length; index += 1) {
        if (failure !== undefined) return;
        const call = calls[index] as ToolCall;
        const concurrent = batch.toolSet.get(call.name)?.sideEffect === 'read_only';
        let release: (() => void) | undefined;
        if (concurrent) release = await limiter.acquire();
        else await drain();
        if (failure !== undefined) {
          release?.();
          return;
        }
        if (approvalAsked) {
          release?.();
          await surfaceApprovalsFrom(index);
          return;
        }

        let admission: Admission;
        try {
          admission = await admit(call, batch, access);
        } catch (error) {
          release?.();
          throw error;
        }

        if (admission.kind === 'outcome') {
          release?.();
          outcomes[index] = admission.outcome;
          announce(admission.outcome);
          if (admission.outcome.kind === 'needs_approval') {
            await drain();
            await surfaceApprovalsFrom(index + 1);
            return;
          }
          continue;
        }

        if (release === undefined) {
          const performed = await perform(admission.plan);
          outcomes[index] = performed;
          announce(performed);
          if (performed.kind === 'needs_approval' || performed.kind === 'needs_input') {
            await surfaceApprovalsFrom(index + 1);
            return;
          }
          continue;
        }
        const releaseSlot = release;
        const running: Promise<void> = perform(admission.plan)
          .then(
            (outcome) => {
              outcomes[index] = outcome;
              if (outcome.kind === 'needs_approval' || outcome.kind === 'needs_input') approvalAsked = true;
              try {
                announce(outcome);
              } catch (error) {
                recordFailure(error);
              }
            },
            (error: unknown) => {
              recordFailure(error);
            },
          )
          .finally(() => {
            releaseSlot();
            inFlight.delete(running);
          });
        inFlight.add(running);
      }
    };

    try {
      await walk();
    } catch (error) {
      recordFailure(error);
    }
    await drain();
    if (failure !== undefined) throw failure.error;

    return outcomes.map((outcome, index) => {
      if (outcome === undefined) throw new Error(`no outcome produced for call ${(calls[index] as ToolCall).callId}`);
      return outcome;
    });
  };

  const stopEarlierAttempt = async (key: string, pgid: number | undefined, signal: AbortSignal): Promise<void> => {
    const lock = await callLocks.acquire(key, signal);
    if (lock === 'aborted') throw signal.reason;
    try {
      await reapEarlierAttempt(key, pgid);
    } finally {
      releaseCallLock(lock);
    }
  };

  const abandonTarget = async (target: AbandonTarget, signal: AbortSignal): Promise<AbandonOutcome> => {
    const lookup = idempotency.get(target.idemKey);
    try {
      if (lookup?.s === 'PENDING') await stopEarlierAttempt(target.idemKey, lookup.rec.pgid, signal);
    } finally {
      idempotency.markUnknownIfPending(target.idemKey);
    }
    return { idemKey: target.idemKey, callId: target.callId, outcome: 'unknown' };
  };

  const abandon = async (targets: readonly AbandonTarget[], { signal }: { signal: AbortSignal }): Promise<AbandonOutcome[]> => {
    signal.throwIfAborted();
    const settled = await Promise.allSettled(targets.map((target) => abandonTarget(target, signal)));
    const outcomes: AbandonOutcome[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      outcomes.push(result.value);
    }
    return outcomes;
  };

  const releaseTarget = async (target: ReleaseTarget, toolSet: () => Promise<ToolSet>, signal: AbortSignal): Promise<void> => {
    const lookup = idempotency.get(target.idemKey);
    if (lookup?.s !== 'PENDING') return;
    const checkpoint = lookup.rec.meta['checkpoint'];
    if (!isRecord(checkpoint)) return;
    await (await toolSet()).get(target.name)?.releaseCheckpoint?.(checkpoint, { signal });
    idempotency.clearCheckpoint(target.idemKey);
    idempotency.markUnknownIfPending(target.idemKey);
  };

  const release = async (
    targets: readonly ReleaseTarget[],
    { toolSet, signal }: { toolSet: () => Promise<ToolSet>; signal: AbortSignal },
  ): Promise<void> => {
    signal.throwIfAborted();
    let loaded: Promise<ToolSet> | undefined;
    const loadOnce = (): Promise<ToolSet> => (loaded ??= toolSet());
    await Promise.all(targets.map((target) => releaseTarget(target, loadOnce, signal)));
  };

  return { runBatch, abandon, release, inFlightKeys: () => new Set(activeKeys.keys()) };
};
