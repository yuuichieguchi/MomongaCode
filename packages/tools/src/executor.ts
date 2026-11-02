import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, canonicalPath, comparableContains, comparablePath, computeBackoff, fileRuleFingerprint, momongaLayout, reapMarkedProcesses, sha256Hex, volumeIsCaseInsensitive, writableAreaOf, writableCheckOf } from '@momonga/foundation';
import type { Clock, FileRuleProvenance, PathResolution, ReapTiming, SignalSender } from '@momonga/foundation';
import { absoluteFrom, decide, fileRuleSpecsOf, suggestAllowRule } from '@momonga/policy';
import type { Decision, PermissionRule, PermissionSubject, PolicyFilesystem } from '@momonga/policy';
import { permissionDeniedOutput } from '@momonga/protocol';
import type { PermissionDenial, PermissionMode, ToolKind } from '@momonga/protocol';
import { SandboxPolicyError, canonicalParentForm } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { createReadAccessMatcher } from './read-access.ts';
import type { ReadFamilyTool } from './read-access.ts';
import type { ReadAccessMatcher } from './read-access.ts';
import type { ToolHooks } from './hooks/events.ts';
import type { AutoClassifier, BlobPort, IdempotencyPort, ToolIdempotencyRecord } from './ports.ts';
import type { ToolSet } from './registry.ts';
import { cancellableTimer } from './timers.ts';
import { MINIMUM_INLINE_OUTPUT_CHARS, truncateOutput } from './truncate.ts';
import { ToolExecutionError, ToolInputError, TransientToolError } from './types.ts';
import type { AnyTool, ReconcileContext, ReconcileResult, ToolContent, ToolContext, ToolResult, ToolSessionState } from './types.ts';
import { validateToolInput } from './validate.ts';

const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 30_000;
const DEFAULT_MAX_PARALLEL = 8;
const DEFAULT_READ_ONLY_RETRY = { attempts: 3, baseMs: 200, maxMs: 2000 } as const;
const ABORT_SETTLE_LIMIT_MS = 2000;
const DEFAULT_RECONCILE_GRACE_MS = 2000;
const DEFAULT_RECONCILE_CAP_MS = 30_000;
const ABANDON_KILL_GRACE_MS = 2000;
const UNKNOWN_EFFECTS_NOTICE = 'Its side effects are unknown; inspect the current state before retrying.';

export type ToolCall = {
  callId: string;
  name: string;
  arguments: string | unknown;
  approval?: { kind: 'allow_once' | 'allow_always'; subjectDigest: string };
};

type BatchCallbacks = {
  leaseLost?(): boolean;
  onOutcome?(outcome: ResultOutcome): void;
  traceparentFor?(callId: string): { traceparent: string; tracestate?: string } | undefined;
  onStarted?(callId: string, idemKey: string): void | Promise<void>;
  onUpdate?(callId: string, content: ToolContent[]): void;
};

type BatchCore = BatchCallbacks & {
  calls: readonly ToolCall[];
  toolSet: ToolSet;
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

export type DeferredOutcome = { callId: string; kind: 'deferred' };

export type CallOutcome = ResultOutcome | NeedsApprovalOutcome | DeferredOutcome;

export type ToolExecutorOptions = {
  idempotency: IdempotencyPort;
  blobs: BlobPort;
  clock: Clock;
  idempotencyTtlMs?: number;
  maxInlineOutputChars?: number;
  readOnlyRetry?: { attempts: number; baseMs: number; maxMs: number };
  maxParallel?: number;
  processMarkerDir: string;
  fs: PolicyFilesystem;
  reconcileCapMs?: number;
  reconcileGraceMs?: number;
  onWarning(message: string): void;
  reap?: { kill?: SignalSender; timing?: ReapTiming };
};

export type AbandonTarget = { callId: string; idemKey: string };

export type AbandonOutcome = { idemKey: string; callId: string; outcome: 'unknown' };

export type ToolExecutor = {
  runBatch(input: BatchInput): Promise<CallOutcome[]>;
  abandon(targets: readonly AbandonTarget[], options: { signal: AbortSignal }): Promise<AbandonOutcome[]>;
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
  return path.join(comparablePath(directory), volumeIsCaseInsensitive(directory) ? name.toLowerCase() : name);
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

const createWriteGuard = (batch: ExecutionBatchInput): ((subject: PermissionSubject, cwd: string) => string | undefined) => {
  batch.sandboxPolicy.writableRoots.forEach(canonicalPath);
  const layout = momongaLayout(batch.home);
  const homeGuards = new Set([layout.root, layout.keychains]);
  const approvalGated = new Set(batch.sandboxPolicy.protectedSet.paths);
  const guards = batch.sandboxPolicy.writeDenied.filter((entry) => homeGuards.has(entry) || !approvalGated.has(entry)).map(canonicalPath);
  const launcherKeys = launcherGuardKeys(batch.sandboxPolicy.writeDeniedLiterals);
  const blocksLauncher = (resolved: string): boolean => launcherKeys.has(parentCanonicalKey(resolved));
  const exempt = batch.tmpDir === undefined ? undefined : canonicalPath(batch.tmpDir);
  const blocksResolved = (resolved: string): boolean =>
    guards.some((guard) => comparableContains(guard, resolved)) && !(exempt !== undefined && comparableContains(exempt, resolved));
  return (subject, cwd) => {
    if (subject.kind !== 'path' || subject.access !== 'write') return undefined;
    return subject.paths.find(
      (target) =>
        blocksResolved(canonicalPath(absoluteFrom(target, cwd))) ||
        blocksResolved(path.resolve(cwd, target)) ||
        blocksLauncher(path.resolve(cwd, target)),
    );
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
  const activeKeys = new Map<string, number>();

  const finalizeResult = (result: ToolResult, tool: AnyTool, limit: number): ResultOutcome['result'] => {
    const truncated =
      tool.pagesOutput === true && result.output.length <= limit
        ? { output: result.output }
        : truncateOutput(result.output, limit, blobs);
    return {
      status: result.status,
      output: truncated.output,
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.plan === undefined ? {} : { plan: result.plan }),
      ...(result.skill === undefined ? {} : { skill: result.skill }),
      ...('truncated' in truncated ? { truncated: truncated.truncated, handle: truncated.handle } : {}),
    };
  };

  const reasonOr = (reason: string | undefined, fallback: string): string => (reason === undefined || reason === '' ? fallback : reason);

  const permissionGate = async (
    call: ToolCall,
    tool: AnyTool,
    input: unknown,
    gate: Gate,
    batch: ExecutionBatchInput,
    stage: GateStage = 'enforce',
  ): Promise<CallOutcome | undefined> => {
    const { subject, access } = gate;
    const cwd = batch.session.cwd;
    const blockedPath = readDeniedPath(subject, access, cwd);
    if (blockedPath !== undefined) return deniedOutcome(call.callId, { source: 'sandbox', reason: `${blockedPath} is blocked by the sandbox policy` });
    const writeBlockedPath = access.writeDeniedPath(subject, cwd);
    if (writeBlockedPath !== undefined) return deniedOutcome(call.callId, { source: 'sandbox', reason: `${writeBlockedPath} is write-protected by the sandbox policy` });
    const blockedByRule = ruleBlock(subject, access, cwd);
    if (blockedByRule !== undefined) {
      return deniedOutcome(call.callId, { source: 'rule', reason: `${blockedByRule.target} is blocked by ${describeProvenance(blockedByRule.provenance)}` });
    }

    const policyTool = { name: tool.name, kind: tool.kind, sideEffect: tool.sideEffect };
    const policyDecision = decide({
      tool: policyTool,
      subject,
      mode: batch.mode,
      rules: batch.rules,
      roots: [...rootsOf(batch)],
      ...(batch.readRoots === undefined ? {} : { readRoots: batch.readRoots }),
      home: batch.home,
      cwd,
      fileRules: batch.sandboxPolicy.fileRules,
      protectedSet: batch.sandboxPolicy.protectedSet,
      fs: options.fs,
      searchPath: batch.env['PATH'],
      isWritable: access.isWritable,
    });
    if (policyDecision.kind === 'deny') {
      return deniedOutcome(call.callId, { source: policyDecision.source === 'mode' ? 'mode' : 'rule', reason: policyDecision.reason });
    }
    const hooks = batch.hooks !== undefined && batch.hooks.matchesPreToolUse(tool.name) ? batch.hooks : undefined;
    if (stage === 'preview' && (hooks !== undefined || batch.mode === 'auto')) return undefined;

    let decision = policyDecision;
    if (hooks !== undefined) {
      const verdict = await hooks.preToolUse({ callId: call.callId, toolName: tool.name, input });
      if (verdict?.decision === 'deny') {
        return deniedOutcome(call.callId, { source: 'hook', reason: reasonOr(verdict.reason, `a PreToolUse hook denied ${tool.name}`) });
      }
      if (verdict?.decision === 'ask' && decision.kind === 'allow') {
        decision = { kind: 'ask', source: 'hook', reason: reasonOr(verdict.reason, 'a PreToolUse hook requires approval') };
      }
      if (verdict?.decision === 'allow' && decision.kind === 'ask' && decision.source === 'mode') {
        decision = { kind: 'allow', source: 'hook', reason: reasonOr(verdict.reason, 'allowed by a PreToolUse hook') };
      }
    }
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
        if (batch.mode === 'auto' && (effective.source === 'mode' || effective.source === 'protected')) {
          if (batch.classifier === undefined) throw new Error('auto mode needs a classifier');
          const verdict = await batch.classifier.classify({
            callId: call.callId,
            toolName: tool.name,
            title: tool.title(input),
            input,
            reason: effective.reason,
            subjectDigest,
          });
          if (verdict === 'allow') return undefined;
        }
        const suggestedRule =
          unsandboxedExec || decision.source === 'protected' || decision.source === 'hook'
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
    }
    return undefined;
  };

  const admit = async (call: ToolCall, batch: BatchInput, access: BatchAccess | undefined, stage: GateStage = 'enforce'): Promise<Admission> => {
    const outcome = (value: CallOutcome): Admission => ({ kind: 'outcome', outcome: value });
    if (batch.signal.aborted) return outcome(failedOutcome(call.callId, `${call.name} was cancelled`));
    const tool = batch.toolSet.get(call.name);
    if (tool === undefined) {
      const available = batch.toolSet.tools.map((candidate) => candidate.name).join(', ');
      return outcome(failedOutcome(call.callId, `Unknown tool "${call.name}". Available tools: ${available}`));
    }
    const validation = validateToolInput(tool, call.arguments);
    if (!validation.ok) return outcome(failedOutcome(call.callId, validation.message));
    const input = validation.value;
    const cwd = batch.session.cwd;

    const key = idempotencyKeyFor(batch.runId, batch.step, call.callId);
    if (batch.recoverOnly === true) {
      const existing = idempotency.get(key);
      if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));
      if (existing === undefined) return outcome(failedOutcome(call.callId, `${tool.name} was cancelled`));
      if (existing.s === 'UNKNOWN') {
        return outcome({ ...failedOutcome(call.callId, interruptedOutput(tool)), idemKey: key, reconciled: 'unknown' });
      }
      return { kind: 'run', plan: { kind: 'recovery', call, tool, input, key, batch } };
    }

    if (access === undefined) throw new Error('read access is required for a batch that can execute');
    let subject;
    try {
      subject = tool.subject(input, { cwd, home: batch.home, roots: rootsOf(batch) });
    } catch (error) {
      return outcome(failedOutcome(call.callId, describeThrown(tool.name, error)));
    }
    const gate: Gate = { subject, access };

    const existing = idempotency.get(key);
    if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));
    const recovered = existing?.s === 'PENDING' || existing?.s === 'UNKNOWN' ? existing.rec : undefined;

    if (recovered === undefined) {
      const gated = await permissionGate(call, tool, input, gate, batch, stage);
      if (gated !== undefined) return outcome(gated);
    }
    return { kind: 'run', plan: { kind: 'execution', call, tool, input, gate, key, batch, gateRan: recovered === undefined, ...(recovered === undefined ? {} : { recovered }) } };
  };

  type CallScope = {
    controller: AbortController;
    processMarker: string;
    reconcileCtx: ReconcileContext;
    abortReason(): AbortReason | undefined;
    abortWith(reason: AbortReason): void;
    armTimer(ms: number): void;
    disarmTimer(): void;
    closeContext(): void;
    complete(result: ResultOutcome['result'], reconciled?: ReconcileResult['outcome']): CallOutcome;
    release(): void;
  };

  const openScope = (batch: BatchCore, call: ToolCall, tool: AnyTool, key: string, inlineLimit: number, deadlineAt: number): CallScope => {
    const { callId } = call;
    const controller = new AbortController();
    let abortReason: AbortReason | undefined;
    let recordCompleted = false;
    let contextClosed = false;
    let timer: NodeJS.Timeout | undefined;
    const leaseLost = (): boolean => batch.leaseLost?.() === true;
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
      blobs,
      clock,
      session: batch.session,
      attachProcess: (processInfo) => {
        if (!leaseLost() && !contextClosed) idempotency.attachProcess(key, processInfo);
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
        timer = setTimeout(() => abortWith('timeout'), ms);
      },
      disarmTimer: () => clearTimeout(timer),
      closeContext: () => {
        contextClosed = true;
      },
      complete: (result, reconciled) => {
        if (leaseLost()) return deferred;
        const outcome: ResultOutcome = { callId, kind: 'result', result, idemKey: key, ...(reconciled === undefined ? {} : { reconciled }) };
        idempotency.complete(key, outcome);
        recordCompleted = true;
        return outcome;
      },
      release: () => {
        clearTimeout(timer);
        if (recordCompleted && tool.sideEffect === 'exec') fs.rmSync(processMarker, { force: true });
        batch.signal.removeEventListener('abort', onBatchAbort);
        const remaining = (activeKeys.get(key) ?? 0) - 1;
        if (remaining > 0) activeKeys.set(key, remaining);
        else activeKeys.delete(key);
      },
    };
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
      let reconcileOutcome: ReconcileResult;
      try {
        reconcileOutcome = await reconcileWithin(tool, input, record, scope.reconcileCtx, () => scope.abortWith('timeout'), scope.closeContext);
      } catch (error) {
        return failedOutcome(callId, describeThrown(tool.name, error));
      }
      if (reconcileOutcome.outcome === 'not_applied') {
        return scope.complete(finalizeResult({ status: 'failed', output: cancelledOutput(tool) }, tool, inlineLimit), 'not_applied');
      }
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return scope.complete(finalizeResult({ status, output: reconcileOutcome.output }, tool, inlineLimit), reconcileOutcome.outcome);
    } finally {
      scope.release();
    }
  };

  const applyPostToolHooks = async (batch: ExecutionBatchInput, call: ToolCall, tool: AnyTool, input: unknown, result: ToolResult): Promise<ToolResult> => {
    if (batch.hooks === undefined || result.status !== 'completed') return result;
    const feedback = await batch.hooks.postToolUse({ callId: call.callId, toolName: tool.name, input, output: result.output });
    return feedback === undefined ? result : { ...result, output: `${result.output}\n\n[PostToolUse hook]\n${feedback}` };
  };

  const performExecution = async (batch: ExecutionBatchInput, plan: ExecutionPlan): Promise<CallOutcome> => {
    const { call, tool, input, gate, key, recovered, gateRan } = plan;
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
    const toolContext: ToolContext = { ...scope.reconcileCtx, sandbox: batch.sandbox, sandboxPolicy: batch.sandboxPolicy };

    try {
      let prepared: Record<string, unknown> | undefined;
      let record: ToolIdempotencyRecord | undefined;
      let gateAdmitted = gateRan;
      if (recovered !== undefined) {
        const current = idempotency.get(key);
        if (current?.s === 'COMPLETED') return storedOutcome(current.result);
        record = current?.rec;
        if (record === undefined) {
          const gated = await permissionGate(call, tool, input, gate, batch);
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
            prepared = await tool.prepare(input, toolContext);
          } catch (error) {
            return failedOutcome(callId, describeThrown(tool.name, error));
          }
        }
        if (scope.abortReason() !== undefined) return failedOutcome(callId, `${tool.name} was cancelled`);
        const begun = idempotency.begin(key, {
          expiresAt: clock.now() + ttlMs,
          meta: { tool: tool.name, runId: batch.runId, ...(prepared === undefined ? {} : { prepared }) },
        });
        if (begun.s === 'COMPLETED') return storedOutcome(begun.result);
        if (begun.s !== 'NEW') record = begun.rec;
      }

      const execute = async (reconciled?: ReconcileResult['outcome']): Promise<CallOutcome> => {
        const outputLimit = await resolveExecutionLimit();
        const executionCtx: ToolContext = { ...toolContext, outputBudgetChars: outputLimit };
        if (tool.sideEffect === 'exec') {
          fs.rmSync(scope.processMarker, { force: true });
          fs.closeSync(fs.openSync(scope.processMarker, 'wx', 0o600));
        }
        const requestedMs = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(input) : tool.timeoutMs;
        const timeoutMs = Math.max(0, Math.min(requestedMs, batch.deadlineAt - clock.now()));

        const runTool = async (): Promise<ToolResult> => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await tool.execute(input, executionCtx, prepared);
            } catch (error) {
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
        const result = await Promise.race([running, aborted.then(() => undefined)]);
        if (scope.abortReason() === undefined && result !== undefined) {
          scope.disarmTimer();
          const hooked = await applyPostToolHooks(batch, call, tool, input, result);
          return scope.complete(finalizeResult(hooked, tool, outputLimit), reconciled);
        }
        await settleWithin(running, ABORT_SETTLE_LIMIT_MS);
        const output = scope.abortReason() === 'timeout' ? timedOutOutput(tool, timeoutMs) : cancelledOutput(tool);
        return scope.complete({ status: 'failed', output }, reconciled);
      };

      const admitExecution = async (): Promise<CallOutcome | undefined> => {
        if (gateAdmitted) return undefined;
        const gated = await permissionGate(call, tool, input, gate, batch);
        if (gated?.kind === 'needs_approval') return gated;
        if (gated?.kind === 'result') return scope.complete(gated.result);
        return undefined;
      };

      if (record === undefined) {
        await batch.onStarted?.(callId, key);
        return await execute();
      }

      let reconcileOutcome: ReconcileResult;
      try {
        reconcileOutcome = await reconcileWithin(tool, input, record, scope.reconcileCtx, () => scope.abortWith('timeout'), scope.closeContext);
      } catch (error) {
        return failedOutcome(callId, describeThrown(tool.name, error));
      }
      if (reconcileOutcome.outcome === 'not_applied') {
        const refused = await admitExecution();
        if (refused !== undefined) return refused;
        return await execute('not_applied');
      }
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return scope.complete(finalizeResult({ status, output: reconcileOutcome.output }, tool, inlineLimit), reconcileOutcome.outcome);
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
          if (performed.kind === 'needs_approval') {
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
              if (outcome.kind === 'needs_approval') approvalAsked = true;
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

  const abandonTarget = async (target: AbandonTarget): Promise<AbandonOutcome> => {
    const lookup = idempotency.get(target.idemKey);
    if (lookup?.s === 'PENDING') {
      const marker = path.join(options.processMarkerDir, target.idemKey);
      try {
        await reapMarkedProcesses({
          marker,
          pgid: lookup.rec.pgid,
          killGraceMs: ABANDON_KILL_GRACE_MS,
          label: 'tool',
          onWarning: options.onWarning,
          ...(options.reap?.kill === undefined ? {} : { kill: options.reap.kill }),
          ...(options.reap?.timing === undefined ? {} : { timing: options.reap.timing }),
        });
      } catch (error) {
        options.onWarning(`tool marker ${marker} could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    idempotency.markUnknownIfPending(target.idemKey);
    return { idemKey: target.idemKey, callId: target.callId, outcome: 'unknown' };
  };

  const abandon = async (targets: readonly AbandonTarget[], { signal }: { signal: AbortSignal }): Promise<AbandonOutcome[]> => {
    signal.throwIfAborted();
    const settled = await Promise.allSettled(targets.map((target) => abandonTarget(target)));
    const outcomes: AbandonOutcome[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      outcomes.push(result.value);
    }
    return outcomes;
  };

  return { runBatch, abandon, inFlightKeys: () => new Set(activeKeys.keys()) };
};
