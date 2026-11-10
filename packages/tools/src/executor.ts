import fs from 'node:fs';
import path from 'node:path';
import { UNMEASURED_CAPABILITY, canonicalJson, canonicalPath, comparableFromParts, containsByComponents, computeBackoff, createMarker, defaultProcessInspector, displayToolPath, fileRuleFingerprint, hostKernelLock, hostReapTiming, lexicallyWithin, locateThroughFiles, momongaLayout, reapMarkedProcessesWithReport, recordMarkerGroup, resolveCanonicalPath, sha256Hex, writableAreaOf, writableCheckOf } from '@momonga/foundation';
import { createMarkerGuard } from './marker-guard.ts';
import { createMarkerOwners } from './marker-owners.ts';
import type { MarkerOwners } from './marker-owners.ts';
import { createMarkerSettle } from './marker-settle.ts';
import type { MarkerSettle } from './marker-settle.ts';
import type { Clock, FileRuleProvenance, KernelLockMechanism, MarkerHandle, PathResolution, ProcessGroupPort, ProcessInspector, ReapReport, ReapTiming, SignalSender, UninspectableRegistry } from '@momonga/foundation';
import { absoluteFrom, createGlobDeadline, decide, fileRuleSpecsOf, globBudgetMs, prepareGlobs, settleGlobs, suggestAllowRule } from '@momonga/policy';
import type { Decision, PermissionRule, PermissionSubject, PolicyHostFilesystem } from '@momonga/policy';
import { permissionDeniedOutput } from '@momonga/protocol';
import type { ApprovalBasis, ElicitationRequestView, PermissionDenial, PermissionMode, ToolAwait, ToolFile, ToolKind } from '@momonga/protocol';
import { SANDBOX_STOP_BOUND_MS, SandboxPolicyError, canonicalParentForm } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { RipgrepLocator } from './ripgrep-locator.ts';
import { EarlierAttemptNotStoppedError, createCallLocks } from './call-lock.ts';
import type { CallLock } from './call-lock.ts';
import { readOnlyContextOf } from './read-only-call.ts';
import { createReadAccessMatcher } from './read-access.ts';
import type { ReadFamilyTool } from './read-access.ts';
import type { ReadAccessMatcher } from './read-access.ts';
import type { PreToolHookVerdict, ToolHooks } from './hooks/events.ts';
import type { AutoClassifier, BackgroundJobs, BlobPort, IdempotencyPort, LeaseFence, LeasedIdempotencyPort, LeasedOutcome, ToolIdempotencyLookup, ToolIdempotencyRecord } from './ports.ts';
import type { ToolSet } from './registry.ts';
import { callStopOf } from './call-stop.ts';
import type { CallStop } from './call-stop.ts';
import { cancellableTimer } from './timers.ts';
import { observedToolFiles } from './work-tree-observer.ts';
import type { WorkTreeMark, WorkTreeObserver } from './work-tree-observer.ts';
import { startsProcesses, ToolExecutionError, ToolInputError, ToolInputRequired, TransientToolError } from './types.ts';
import type { AnyTool, CallOutputFit, OutputFit, SpawnMarker, ReconcileContext, ReconcileResult, ToolContent, ToolContext, ToolPending, ToolResult, ToolResume, ToolSessionState, SubjectContext } from './types.ts';
import { cleanFailureMessage } from '@momonga/foundation';
import { toolRefusalKey, unavailable, validateToolInput } from './validate.ts';
import type { ValidationResult } from './validate.ts';

const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLE_LENGTH = 64;
const HANDLE_PATTERN = new RegExp(`^[0-9a-f]{${HANDLE_LENGTH}}$`);
const OUTPUT_MEDIA_TYPE = 'text/plain; charset=utf-8';
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
  onWarning?(message: string, toolKey: string): void;
  toolUnavailable?(toolKey: string): boolean;
  traceparentFor?(callId: string): { traceparent: string; tracestate?: string } | undefined;
  onStarted?(callId: string, idemKey: string, basis: ApprovalBasis): void | Promise<void>;
  onUpdate?(callId: string, content: ToolContent[]): void;
};

export type BatchOutputFormatter = (input: {
  output: string;
  status: 'completed' | 'failed';
  tool: { name: string; kind: ToolKind };
}) => { output: string; formatter: string; version: number; header: (handle: string) => string } | undefined;

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
  outputFit: OutputFit;
  reconcileFit: OutputFit;
  hooks?: ToolHooks;
  classifier?: AutoClassifier;
  onHalt?(reason: string, hookEvent: 'PreToolUse' | 'PostToolUse'): void;
  formatOutput?: BatchOutputFormatter;
  workTreeObserver?: WorkTreeObserver;
  windowShared?(): boolean;
  offered?: { tools: readonly string[]; catalog: readonly string[] };
};

export type ExecutionBatchInput = BatchCore & {
  rules: PermissionRule[];
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  ripgrep: RipgrepLocator;
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
  result: ToolResult & { truncated?: boolean; handle?: string; denial?: PermissionDenial; formatted?: { formatter: string; version: number } };
  idemKey?: string;
  reconciled?: ReconcileResult['outcome'];
  interrupted?: 'timeout' | 'cancelled';
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
  readOnlyRetry?: { attempts: number; baseMs: number; maxMs: number };
  maxParallel?: number;
  jobs?: BackgroundJobs;
  processMarkerDir: string;
  owners?: MarkerOwners;
  callLockDir: string;
  kernelLock?: KernelLockMechanism;
  fs: PolicyHostFilesystem;
  leaseMs: number;
  heartbeatMs: number;
  reconcileCapMs?: number;
  reconcileGraceMs?: number;
  onWarning(message: string): void;
  reap?: { kill?: SignalSender; groupPort?: ProcessGroupPort; timing?: ReapTiming; killGraceMs?: number; inspector?: ProcessInspector; uninspectable?: UninspectableRegistry };
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
  const target = subject.paths.find((candidate) => access.blocks(candidate, cwd));
  if (target === undefined) return undefined;
  const matched = access.blockedForm(target, cwd);
  if (matched === undefined) throw new Error(`${target} is read-denied but no matching form was found`);
  return matched;
};

const readRuleToolOf = (subjectTool: string): ReadFamilyTool => (subjectTool === 'Grep' || subjectTool === 'Glob' ? subjectTool : 'Read');

const ruleBlock = (subject: PermissionSubject, access: BatchAccess, cwd: string): { target: string; provenance: FileRuleProvenance } | undefined => {
  if (subject.kind !== 'path') return undefined;
  const tool = readRuleToolOf(subject.tool);
  for (const target of subject.paths) {
    const block = access.blockedMatch(target, cwd, tool) ?? (subject.access === 'write' ? access.writeBlockedMatch(target, cwd) : undefined);
    if (block !== undefined) return { target: block.matched, provenance: block.provenance };
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
    for (const target of subject.paths) {
      const requested = path.resolve(cwd, target);
      const resolvedInput = absoluteFrom(target, cwd);
      if (!(blocks(resolvedInput) || blocks(requested) || blocksLauncher(requested))) continue;
      if (blocksLauncher(requested) || entries.some((entry) => lexicallyWithin(requested, entry))) return requested;
      const resolution = resolveCanonicalPath(resolvedInput);
      return resolution.ok ? resolution.path : requested;
    }
    return undefined;
  };
};

type BatchAccess = ReadAccessMatcher & {
  writeDeniedPath: (subject: PermissionSubject, cwd: string) => string | undefined;
  isWritable: (absolute: string) => boolean;
};

const rootsOf = (batch: BatchCore): readonly string[] => (batch.tmpDir === undefined ? batch.roots : [...batch.roots, batch.tmpDir]);

const subjectContextOf = (batch: BatchCore): SubjectContext => ({
  cwd: batch.session.cwd,
  workingDirectory: batch.session.workingDirectory,
  home: batch.home,
  roots: rootsOf(batch),
});

type SubjectFacts = { command?: string; files?: ToolFile[] };

const subjectFactsOf = (subject: PermissionSubject): SubjectFacts => {
  if (subject.kind === 'command') return { command: subject.command };
  if (subject.kind === 'path' && subject.access === 'write') return { files: subject.paths.map((target): ToolFile => ({ path: target, access: 'write' })) };
  return {};
};

type ObservationState = { ran: number; closed?: { mark: WorkTreeMark; ran: number } };

type OpenWindow = { mark: WorkTreeMark; sharedAtStart: boolean };

const recordedFactsOf = (record: ToolIdempotencyRecord): SubjectFacts => {
  const stored = record.meta['facts'];
  return isRecord(stored) ? (stored as SubjectFacts) : {};
};

const observesCall = (batch: BatchCore, tool: AnyTool): boolean =>
  batch.workTreeObserver !== undefined && tool.sideEffect !== 'read_only' && tool.subjectKind !== 'path';

const digestSubject = (subject: PermissionSubject, cwd: string, canonicalise: (absolute: string) => PathResolution, show: (absolute: string) => string): unknown => {
  if (subject.kind === 'path') {
    return {
      ...subject,
      paths: subject.paths.map((target) => {
        const absolute = absoluteFrom(target, cwd);
        const real = canonicalise(absolute);
        if (!real.ok) throw new Error(`${show(absolute)} cannot be resolved to a real location`);
        return real.path;
      }),
    };
  }
  if (subject.kind === 'command') {
    const canonicalCwd = canonicalise(cwd);
    if (!canonicalCwd.ok) throw new Error(`session cwd ${show(cwd)} cannot be resolved to a real location`);
    return { subject, cwd: canonicalCwd.path };
  }
  return subject;
};

export const subjectDigestOf = (
  subject: PermissionSubject,
  cwd: string,
  canonicalise: (absolute: string) => PathResolution,
  show: (absolute: string) => string = (absolute) => absolute,
): string => sha256Hex(canonicalJson(digestSubject(subject, cwd, canonicalise, show)));

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
  const { idempotency, blobs, clock } = options;
  const ttlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
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
  const owners = options.owners ?? createMarkerOwners();
  const guard = createMarkerGuard({
    markerDir: options.processMarkerDir,
    owners,
    ledgerRow: (name) => ({ settled: idempotency.get(name)?.s === 'COMPLETED' }),
    onWarning: options.onWarning,
    killGraceMs: options.reap?.killGraceMs ?? ABANDON_KILL_GRACE_MS,
    timing: reapTiming,
    ...(options.reap?.kill === undefined ? {} : { kill: options.reap.kill }),
    ...(options.reap?.groupPort === undefined ? {} : { groupPort: options.reap.groupPort }),
    ...(options.reap?.inspector === undefined ? {} : { inspector: options.reap.inspector }),
    ...(options.reap?.uninspectable === undefined ? {} : { uninspectable: options.reap.uninspectable }),
  });

  const isRefused = (batch: BatchCore, tool: AnyTool): boolean => batch.toolUnavailable?.(toolRefusalKey(tool)) === true;

  const announceValidatorFailure = (batch: BatchCore, tool: AnyTool, detail: string): void => {
    const toolKey = toolRefusalKey(tool);
    if (batch.toolUnavailable?.(toolKey) === true) return;
    const origin = tool.server === undefined ? '' : ` of MCP server ${JSON.stringify(cleanFailureMessage(tool.server))}`;
    const message = `Tool ${cleanFailureMessage(tool.name)}${origin} is unavailable for the rest of this run: its schema validator failed: ${detail}`;
    options.onWarning(message);
    batch.onWarning?.(message, toolKey);
  };

  const validateFor = async (batch: BatchCore, tool: AnyTool, raw: unknown): Promise<ValidationResult> =>
    isRefused(batch, tool) ? unavailable(tool, undefined) : validateToolInput(tool, raw, { signal: batch.signal });

  const rejectionOf = (batch: BatchCore, tool: AnyTool, validation: Extract<ValidationResult, { ok: false }>): string => {
    if (validation.reason === 'validator-failed' && validation.detail !== undefined) announceValidatorFailure(batch, tool, validation.detail);
    return validation.message;
  };

  const scopedBlobs = (runId: string): BlobPort => ({
    put: (data, putOptions) => blobs.put(data, { ...putOptions, runId }),
    read: ((handle: string, range: never) => blobs.read(handle, range, { runId })) as BlobPort['read'],
  });

  const storedHandle = (text: string, runId: string): string => {
    const stored = scopedBlobs(runId).put(text, { mediaType: OUTPUT_MEDIA_TYPE });
    if (!HANDLE_PATTERN.test(stored.handle)) {
      throw new TypeError(`blob handle must be ${HANDLE_LENGTH} lowercase hex characters, got ${JSON.stringify(stored.handle)}`);
    }
    return stored.handle;
  };

  const fitOfCall = (fit: OutputFit, call: ToolCall): CallOutputFit => {
    const identity = { callId: call.callId, tool: call.name };
    return { fits: (text) => fit.fits(text, identity), fit: (text, handle) => fit.fit(text, handle, identity) };
  };

  type FittedOutput = { output: string } | { output: string; truncated: boolean; handle: string };

  const formattedResult = async (result: ToolResult, tool: AnyTool, fit: CallOutputFit, runId: string, formatOutput: BatchOutputFormatter | undefined) => {
    if (formatOutput === undefined || tool.pagesOutput === true) return undefined;
    let formatted: ReturnType<BatchOutputFormatter>;
    try {
      formatted = formatOutput({ output: result.output, status: result.status, tool: { name: tool.name, kind: tool.kind } });
    } catch (error) {
      options.onWarning(`the output formatter failed for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (formatted === undefined) return undefined;
    const handle = storedHandle(result.output, runId);
    const text = `${formatted.header(handle)}\n${formatted.output}`;
    const fitsInline = await fit.fits(text);
    return {
      output: fitsInline ? text : await fit.fit(text, handle),
      truncated: !fitsInline,
      handle,
      formatted: { formatter: formatted.formatter, version: formatted.version },
    };
  };

  const fittedOutput = async (result: ToolResult, fit: CallOutputFit, runId: string): Promise<FittedOutput> => {
    if (await fit.fits(result.output)) return { output: result.output };
    const handle = storedHandle(result.output, runId);
    return { output: await fit.fit(result.output, handle), truncated: true, handle };
  };

  const finalizeResult = async (
    result: ToolResult,
    tool: AnyTool,
    fit: CallOutputFit,
    runId: string,
    formatOutput?: BatchOutputFormatter,
  ): Promise<ResultOutcome['result']> => {
    const formatted = await formattedResult(result, tool, fit, runId, formatOutput);
    const truncated: FittedOutput = formatted ?? (await fittedOutput(result, fit, runId));
    return {
      status: result.status,
      output: truncated.output,
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.plan === undefined ? {} : { plan: result.plan }),
      ...(result.skill === undefined ? {} : { skill: result.skill }),
      ...(result.toolsLoaded === undefined ? {} : { toolsLoaded: result.toolsLoaded }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.command === undefined ? {} : { command: result.command }),
      ...(result.windowShared === undefined ? {} : { windowShared: result.windowShared }),
      ...(result.memories === undefined ? {} : { memories: result.memories }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.backend === undefined ? {} : { backend: result.backend }),
      ...(result.hunks === undefined ? {} : { hunks: result.hunks }),
      ...(result.added === undefined ? {} : { added: result.added }),
      ...(result.removed === undefined ? {} : { removed: result.removed }),
      ...(result.diffOmitted === undefined ? {} : { diffOmitted: result.diffOmitted }),
      ...('truncated' in truncated ? { truncated: truncated.truncated, handle: truncated.handle } : {}),
      ...(formatted === undefined ? {} : { formatted: formatted.formatted }),
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
    const shown = (absolute: string): string => displayToolPath(batch.session.workingDirectory, absolute);
    const blockedPath = readDeniedPath(subject, access, cwd);
    if (blockedPath !== undefined) return { outcome: deniedOutcome(call.callId, { source: 'sandbox', reason: `${shown(blockedPath)} is blocked by the sandbox policy` }) };
    const writeBlockedPath = access.writeDeniedPath(subject, cwd);
    if (writeBlockedPath !== undefined) {
      return { outcome: deniedOutcome(call.callId, { source: 'sandbox', reason: `${shown(writeBlockedPath)} is write-protected by the sandbox policy` }) };
    }
    const blockedByRule = ruleBlock(subject, access, cwd);
    if (blockedByRule !== undefined) {
      return {
        outcome: deniedOutcome(call.callId, { source: 'rule', reason: `${shown(blockedByRule.target)} is blocked by ${describeProvenance(blockedByRule.provenance)}` }),
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
        const validation = await validateFor(batch, tool, verdict.updatedInput);
        if (!validation.ok) return failedOutcome(call.callId, `A PreToolUse hook returned an input that ${tool.name} rejects: ${rejectionOf(batch, tool, validation)}`);
        let subject: PermissionSubject;
        try {
          subject = tool.subject(validation.value, subjectContextOf(batch));
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
        subjectDigest = subjectDigestOf(subject, cwd, options.fs.canonicalise, (absolute) => displayToolPath(batch.session.workingDirectory, absolute));
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
            title: tool.title(input, batch.session),
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
        const locations = tool.locations?.(input, batch.session);
        return {
          callId: call.callId,
          kind: 'needs_approval',
          decision: effective,
          subjectDigest,
          ...(suggestedRule === undefined ? {} : { suggestedRule }),
          title: tool.title(input, batch.session),
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

  const hookedInputOf = async (batch: BatchCore, tool: AnyTool, lookup: ToolIdempotencyLookup | undefined): Promise<{ input: unknown } | { failure: string } | undefined> => {
    const record = lookup?.s === 'PENDING' || lookup?.s === 'UNKNOWN' ? lookup.rec.meta['hookInput'] : undefined;
    if (record === undefined) return undefined;
    const validation = await validateFor(batch, tool, record);
    return validation.ok ? { input: validation.value } : { failure: rejectionOf(batch, tool, validation) };
  };

  const admit = async (call: ToolCall, batch: BatchInput, access: BatchAccess | undefined, stage: GateStage = 'enforce'): Promise<Admission> => {
    const outcome = (value: CallOutcome): Admission => ({ kind: 'outcome', outcome: value });
    if (batch.signal.aborted) return outcome(failedOutcome(call.callId, `${call.name} was cancelled`));
    if (haltedBatches.has(batch)) return outcome(failedOutcome(call.callId, `${call.name} was not run: a hook stopped the run`));
    const { offered } = batch;
    if (offered !== undefined && !offered.tools.includes(call.name)) {
      return outcome(
        failedOutcome(
          call.callId,
          offered.catalog.includes(call.name)
            ? `Tool "${call.name}" is not loaded: load it with LoadTools first`
            : `Tool "${call.name}" was not offered in the request that produced this call, so it cannot run. Available tools: ${offered.tools.join(', ')}`,
        ),
      );
    }
    const tool = batch.toolSet.get(call.name);
    if (tool === undefined) {
      const available = (offered === undefined ? batch.toolSet.tools.map((candidate) => candidate.name) : offered.tools).join(', ');
      return outcome(failedOutcome(call.callId, `Unknown tool "${call.name}". Available tools: ${available}`));
    }
    const validation = await validateFor(batch, tool, call.arguments);
    if (!validation.ok) return outcome(failedOutcome(call.callId, rejectionOf(batch, tool, validation)));
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
      const hooked = await hookedInputOf(batch, tool, existing);
      if (hooked !== undefined && 'failure' in hooked) return outcome(failedOutcome(call.callId, hooked.failure));
      return { kind: 'run', plan: { kind: 'recovery', call, tool, input: hooked === undefined ? input : hooked.input, key, batch } };
    }

    if (access === undefined) throw new Error('read access is required for a batch that can execute');
    const existing = idempotency.get(key);
    if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));
    const recovered = existing?.s === 'PENDING' || existing?.s === 'UNKNOWN' ? existing.rec : undefined;
    const hooked = await hookedInputOf(batch, tool, existing);
    if (hooked !== undefined && 'failure' in hooked) return outcome(failedOutcome(call.callId, hooked.failure));
    if (hooked !== undefined) input = hooked.input;

    let subject: PermissionSubject;
    try {
      subject = tool.subject(input, subjectContextOf(batch));
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
    armTimer(bounds: { totalMs: number; idleMs: number | undefined }): void;
    stop(): { bound: CallStop['bound']; ms: number };
    reportProgress(): void;
    disarmTimer(): void;
    closeContext(): void;
    openMarker(): Promise<{ handle: MarkerHandle; settle: MarkerSettle }>;
    spawnMarker(): Promise<SpawnMarker>;
    settleMarker(): Promise<void>;
    ledger: LeasedIdempotencyPort;
    holding(outcome: LeasedOutcome): boolean;
    deferred: CallOutcome;
    holdCall(): Promise<'held' | 'aborted'>;
    trackEffect(running: Promise<unknown>): void;
    checkpoint(state: Record<string, unknown> | undefined): void;
    complete(result: ResultOutcome['result'], reconciled?: ReconcileResult['outcome'], interrupted?: AbortReason): CallOutcome;
    noteAfterOutput(text: string): void;
    waiting(pending: ToolPending): CallOutcome;
    release(): void;
  };

  const openScope = (batch: BatchCore, call: ToolCall, tool: AnyTool, key: string, fit: OutputFit, deadlineAt: number, factsOf: () => SubjectFacts): CallScope => {
    const { callId } = call;
    const controller = new AbortController();
    let abortReason: AbortReason | undefined;
    let recordCompleted = false;
    let contextClosed = false;
    let markerSettle: MarkerSettle | undefined;
    let callMarker: { handle: MarkerHandle; settle: MarkerSettle } | undefined;
    let callMarkerSpawned = false;
    const spawnMarkers: Array<{ handle: MarkerHandle; settle: MarkerSettle }> = [];
    const groupRecords: Promise<void>[] = [];
    let markerOwned = false;
    let processAttached = false;
    let noteAfterOutput: string | undefined;
    let fixedTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let bounds: { startedAt: number; totalMs: number; idleMs: number | undefined } | undefined;
    let fired: CallStop['bound'] = 'total';
    const expire = (bound: CallStop['bound']): void => {
      if (abortReason !== undefined) return;
      fired = bound;
      abortWith('timeout');
    };
    const armIdle = (): void => {
      if (bounds === undefined || abortReason !== undefined) return;
      clearTimeout(idleTimer);
      const now = clock.now();
      const stop = callStopOf({ startedAt: bounds.startedAt, lastProgressAt: now, idleMs: bounds.idleMs, totalMs: bounds.totalMs, deadlineAt });
      if (stop.bound === 'idle') idleTimer = setTimeout(() => expire('idle'), Math.max(0, stop.at - now));
    };
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
    const openMarkerAt = async (file: string, name: string): Promise<{ handle: MarkerHandle; settle: MarkerSettle }> => {
      const inspector = options.reap?.inspector ?? defaultProcessInspector();
      owners.register(name, { alive: () => markerOwned });
      const handle = await createMarker(file, { capability: inspector.capability ?? UNMEASURED_CAPABILITY });
      const settle = createMarkerSettle({
        marker: file,
        mode: handle.mode,
        inspector,
        onWarning: options.onWarning,
        ...(options.reap?.killGraceMs === undefined ? {} : { killGraceMs: options.reap.killGraceMs }),
        ...(options.reap?.kill === undefined ? {} : { kill: options.reap.kill }),
        ...(options.reap?.groupPort === undefined ? {} : { groupPort: options.reap.groupPort }),
        timing: reapTiming,
      });
      owners.remember(name, handle.mode);
      return { handle, settle };
    };
    const processMarker = path.join(options.processMarkerDir, key);
    let attachingMarker = processMarker;
    const onBatchAbort = (): void => abortWith('cancelled');
    batch.signal.addEventListener('abort', onBatchAbort, { once: true });
    activeKeys.set(key, (activeKeys.get(key) ?? 0) + 1);
    const trace = batch.traceparentFor?.(callId);
    const reconcileCtx: ReconcileContext = {
      ...subjectContextOf(batch),
      ...(batch.tmpDir === undefined ? {} : { tmpDir: batch.tmpDir }),
      runId: batch.runId,
      step: batch.step,
      callId,
      idemKey: key,
      outputFit: fitOfCall(fit, call),
      ...(startsProcesses(tool) ? { processMarker } : {}),
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
        processAttached = true;
        if (!leaseLost() && !contextClosed) holding(ledger.attachProcess(key, processInfo));
        if (callMarker === undefined) return Promise.resolve();
        const recorded = recordMarkerGroup(attachingMarker, processInfo.pgid);
        groupRecords.push(
          recorded.then(
            () => undefined,
            () => undefined,
          ),
        );
        return recorded;
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
      armTimer: ({ totalMs, idleMs }) => {
        const now = clock.now();
        bounds = { startedAt: now, totalMs, idleMs };
        armIdle();
        const fixed = callStopOf({ startedAt: now, lastProgressAt: now, idleMs: undefined, totalMs, deadlineAt });
        fixedTimer = setTimeout(() => expire(fixed.bound), Math.max(0, fixed.at - now));
      },
      stop: () => {
        const startedAt = bounds?.startedAt ?? clock.now();
        const ms = fired === 'idle' ? (bounds?.idleMs ?? 0) : fired === 'total' ? (bounds?.totalMs ?? 0) : deadlineAt - startedAt;
        return { bound: fired, ms: Math.max(0, ms) };
      },
      reportProgress: armIdle,
      disarmTimer: () => {
        bounds = undefined;
        clearTimeout(idleTimer);
        clearTimeout(fixedTimer);
      },
      closeContext: () => {
        contextClosed = true;
      },
      openMarker: async () => {
        markerOwned = true;
        callMarker = await openMarkerAt(processMarker, key);
        markerSettle = callMarker.settle;
        return callMarker;
      },
      spawnMarker: async () => {
        if (callMarker !== undefined && !callMarkerSpawned) {
          callMarkerSpawned = true;
          attachingMarker = processMarker;
          return { file: processMarker, fd: callMarker.handle.fd, settle: callMarker.settle };
        }
        const name = `${key}-${spawnMarkers.length + 1}`;
        const file = path.join(options.processMarkerDir, name);
        const opened = await openMarkerAt(file, name);
        spawnMarkers.push(opened);
        attachingMarker = file;
        return { file, fd: opened.handle.fd, settle: opened.settle };
      },
      settleMarker: async () => {
        try {
          await Promise.all(groupRecords.splice(0));
          for (const { handle, settle } of spawnMarkers.splice(0)) {
            handle.close();
            await settle.state(controller.signal);
            await settle.remove();
          }
          if (markerSettle === undefined || !recordCompleted) return;
          if (!processAttached) {
            await markerSettle.discard();
            return;
          }
          await markerSettle.state(controller.signal);
          await markerSettle.remove();
        } finally {
          markerOwned = false;
        }
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
      noteAfterOutput: (text) => {
        noteAfterOutput = text;
      },
      complete: (completed, reconciled, interrupted) => {
        if (leaseLost()) return deferred;
        const result = noteAfterOutput === undefined ? completed : { ...completed, output: `${completed.output}\n${noteAfterOutput}` };
        const reconstructed = reconciled === 'already_applied' || reconciled === 'unknown' ? { ...result, ...factsOf() } : result;
        const outcome: ResultOutcome = {
          callId,
          kind: 'result',
          result: reconstructed,
          idemKey: key,
          ...(reconciled === undefined ? {} : { reconciled }),
          ...(interrupted === undefined ? {} : { interrupted }),
        };
        const markerState = markerSettle?.cached();
        const meta = markerSettle === undefined || markerState === undefined ? undefined : { markerState, markerMode: markerSettle.mode };
        if (!holding(ledger.complete(key, outcome, meta))) return deferred;
        recordCompleted = true;
        return outcome;
      },
      waiting: (pending) => {
        if (leaseLost()) return deferred;
        return { callId, kind: 'waiting', awaits: pending.awaits, ...(pending.wakeAt === undefined ? {} : { wakeAt: pending.wakeAt }) };
      },
      release: () => {
        clearTimeout(idleTimer);
        clearTimeout(fixedTimer);
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
      },
    };
  };

  const reapEarlierAttempt = async (key: string, pgid: number | undefined, signal: AbortSignal): Promise<NonNullable<ReconcileContext['earlierAttempt']>> => {
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
        signal,
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
      if (reaped.uninspectable.length > 0 || signal.aborted) {
        throw new EarlierAttemptNotStoppedError(
          `a process holding the marker of the earlier attempt of call ${key} could not be inspected, so it could not be verified as stopped: ${reaped.uninspectable.map(({ pid, command }) => `${pid} (${command})`).join(', ')}`,
          'unverifiable',
        );
      }
      throw new EarlierAttemptNotStoppedError(`a process of the earlier attempt of call ${key} survived the attempt to stop it`, 'survived');
    }
    return { stopped: reaped.stopped };
  };

  type Resumed = { kind: 'reconciled'; result: ReconcileResult } | { kind: 'outcome'; outcome: CallOutcome };

  const reconcileAsHolder = async (scope: CallScope, callId: string, tool: AnyTool, input: unknown, record: ToolIdempotencyRecord): Promise<Resumed> => {
    if ((await scope.holdCall()) === 'aborted') return { kind: 'outcome', outcome: failedOutcome(callId, `${tool.name} was cancelled`) };
    if (!scope.holding(scope.ledger.authorise(record.key))) return { kind: 'outcome', outcome: scope.deferred };
    const earlierAttempt = await reapEarlierAttempt(record.key, record.pgid, scope.controller.signal);
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
    const fit = batch.reconcileFit;
    if (batch.signal.aborted) return failedOutcome(callId, `${tool.name} was cancelled`);
    const recordedFacts: { current: SubjectFacts } = { current: {} };
    const scope = openScope(batch, call, tool, key, fit, clock.now() + reconcileCapMs + reconcileGraceMs, () => recordedFacts.current);
    try {
      const current = idempotency.get(key);
      if (current?.s === 'COMPLETED') return storedOutcome(current.result);
      const record = current?.rec;
      if (record === undefined) return failedOutcome(callId, `${tool.name} was cancelled`);
      recordedFacts.current = recordedFactsOf(record);
      const resumed = await reconcileAsHolder(scope, callId, tool, input, record);
      if (resumed.kind === 'outcome') return resumed.outcome;
      const reconcileOutcome = resumed.result;
      if (reconcileOutcome.outcome === 'not_applied') {
        return scope.complete(await finalizeResult({ status: 'failed', output: cancelledOutput(tool) }, tool, fitOfCall(fit, call), batch.runId), 'not_applied');
      }
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return scope.complete(await finalizeResult({ status, output: reconcileOutcome.output }, tool, fitOfCall(fit, call), batch.runId), reconcileOutcome.outcome);
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

  const observations = new WeakMap<object, ObservationState>();

  const observationOf = (batch: BatchCore): ObservationState => {
    const known = observations.get(batch);
    if (known !== undefined) return known;
    const created: ObservationState = { ran: 0 };
    observations.set(batch, created);
    return created;
  };

  const openWindow = async (batch: ExecutionBatchInput, state: ObservationState): Promise<OpenWindow | undefined> => {
    const { workTreeObserver } = batch;
    if (workTreeObserver === undefined) return undefined;
    const sharedAtStart = batch.windowShared?.() === true;
    const reusable = state.closed !== undefined && state.closed.ran === state.ran;
    const mark = reusable ? (state.closed as { mark: WorkTreeMark }).mark : await workTreeObserver.mark(batch.signal);
    delete state.closed;
    return mark === undefined ? undefined : { mark, sharedAtStart };
  };

  const closeWindow = async (batch: ExecutionBatchInput, state: ObservationState, window: OpenWindow | undefined): Promise<Pick<ToolResult, 'files' | 'windowShared'>> => {
    const { workTreeObserver } = batch;
    if (workTreeObserver === undefined || window === undefined) return {};
    const closed = await workTreeObserver.changedSince(window.mark, batch.signal);
    const sharedAtEnd = batch.windowShared?.() === true;
    if (closed === undefined) return {};
    state.closed = { mark: closed.mark, ran: state.ran };
    return { files: await observedToolFiles(closed.files, batch.signal), ...(window.sharedAtStart || sharedAtEnd ? { windowShared: true as const } : {}) };
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
    const fit = batch.reconcileFit;
    if (batch.signal.aborted) return failedOutcome(callId, `${tool.name} was cancelled`);
    if (batch.deadlineAt - clock.now() <= 0) return failedOutcome(callId, `Run deadline exceeded before ${tool.name} could start`);

    const facts = subjectFactsOf(gate.subject);
    const performedFacts: { current: SubjectFacts } = { current: facts };
    const scope = openScope(batch, call, tool, key, fit, batch.deadlineAt, () => performedFacts.current);
    const toolContext: ToolContext = { ...scope.reconcileCtx, sandbox: batch.sandbox, sandboxPolicy: batch.sandboxPolicy, ripgrep: batch.ripgrep, checkpoint: scope.checkpoint, reportProgress: scope.reportProgress };
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
        await batch.outputFit.ready?.();
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
            ...(facts.command === undefined && facts.files === undefined ? {} : { facts }),
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
        await batch.outputFit.ready?.();
        if ((await scope.holdCall()) === 'aborted') return failedOutcome(callId, `${tool.name} was cancelled`);
        if (!scope.holding(scope.ledger.authorise(key))) return scope.deferred;
        if (tool.sideEffect !== 'read_only' || startsProcesses(tool)) {
          const verdict = await guard.check(scope.controller.signal, key);
          if (scope.abortReason() !== undefined) return failedOutcome(callId, `${tool.name} was cancelled`);
          if (verdict.kind === 'refuse') return scope.complete({ status: 'failed', output: verdict.text });
          if (verdict.kind === 'note') scope.noteAfterOutput(verdict.text);
        }
        const marker = startsProcesses(tool) ? await scope.openMarker() : undefined;
        try {
          return await executeWithMarker(marker, reconciled, resume);
        } finally {
          marker?.handle.close();
          await scope.settleMarker();
        }
      };

      const executeWithMarker = async (marker: { handle: MarkerHandle; settle: MarkerSettle } | undefined, reconciled: ReconcileResult['outcome'] | undefined, resume: ToolResume | undefined): Promise<CallOutcome> => {
        const executionCtx: ToolContext = {
          ...contextForBasis(),
          outputFit: fitOfCall(batch.outputFit, call),
          ...(resume === undefined ? {} : { resume }),
          ...(marker === undefined ? {} : { markerFd: marker.handle.fd, markerSettle: marker.settle, spawnMarker: scope.spawnMarker }),
        };
        const requestedMs = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(target.input) : tool.timeoutMs;

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
        scope.armTimer({ totalMs: requestedMs, idleMs: tool.idleTimeoutMs });
        const observation = observesCall(batch, tool) ? observationOf(batch) : undefined;
        const window = observation === undefined ? undefined : await openWindow(batch, observation);
        const running = runTool();
        scope.trackEffect(running);
        const result = await Promise.race([running, aborted.then(() => undefined)]);
        if (tool.sideEffect !== 'read_only') observationOf(batch).ran += 1;
        if (scope.abortReason() === undefined && result !== undefined) {
          if (result instanceof ToolInputRequired) {
            scope.checkpoint(result.checkpoint);
            return leaseHeld() ? { callId, kind: 'needs_input', server: result.server, requests: result.requests } : { callId, kind: 'deferred' };
          }
          if (result.status === 'pending') return scope.waiting(result);
          scope.disarmTimer();
          const { validatorFailure, ...settled } = result;
          if (validatorFailure !== undefined) announceValidatorFailure(batch, tool, validatorFailure);
          const hooked = await applyPostToolHooks(batch, call, tool, target.input, settled);
          const effects = observation === undefined || settled.detached === true ? {} : await closeWindow(batch, observation, window);
          const { detached, ...reported } = hooked;
          return scope.complete(await finalizeResult({ ...reported, ...(detached === true ? {} : facts.command === undefined ? {} : { command: facts.command }), ...effects }, tool, fitOfCall(batch.outputFit, call), batch.runId, batch.formatOutput), reconciled);
        }
        await settleWithin(running, ABORT_SETTLE_LIMIT_MS);
        return settleInterrupted(scope, tool, target.input, key, scope.abortReason() === 'timeout' ? 'timeout' : 'cancelled', {
          fit: fitOfCall(batch.reconcileFit, call),
          runId: batch.runId,
          leaseLost: () => batch.leaseLost?.() === true,
          ...(batch.formatOutput === undefined ? {} : { formatOutput: batch.formatOutput }),
        });
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
      return scope.complete(await finalizeResult({ status, output: reconcileOutcome.output }, tool, fitOfCall(fit, call), batch.runId), reconcileOutcome.outcome);
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

  const interruptedText = async (tool: AnyTool, reason: AbortReason, stop: { bound: CallStop['bound']; ms: number }, record: ToolIdempotencyRecord, settled: ReconcileResult): Promise<string> => {
    const { stopText } = tool;
    if (reason === 'timeout' && stopText !== undefined) {
      const checkpoint = record.meta['checkpoint'];
      return stopText.call(tool, { bound: stop.bound, ms: stop.ms, checkpoint: isRecord(checkpoint) ? checkpoint : undefined });
    }
    const sentence = reason === 'timeout' ? `${tool.name} timed out after ${stop.ms} ms` : `${tool.name} was cancelled`;
    if (settled.outcome === 'unknown') return hasUnknownEffects(tool) ? `${sentence}. ${UNKNOWN_EFFECTS_NOTICE}` : sentence;
    return settled.output === '' ? sentence : `${sentence}. ${settled.output}`;
  };

  const settleInterrupted = async (
    scope: CallScope,
    tool: AnyTool,
    input: unknown,
    key: string,
    reason: AbortReason,
    limits: { fit: CallOutputFit; runId: string; formatOutput?: BatchOutputFormatter; leaseLost: () => boolean },
  ): Promise<CallOutcome> => {
    if (limits.leaseLost()) return scope.deferred;
    const current = idempotency.get(key);
    if (current === undefined || current.s === 'COMPLETED') throw new Error(`the interrupted call ${key} has no open idempotency record to reconcile`);
    const { rec: record } = current;
    const reconciling = new AbortController();
    const ctx: ReconcileContext = { ...scope.reconcileCtx, signal: reconciling.signal, deadlineAt: clock.now() + reconcileCapMs + reconcileGraceMs };
    const settled = await reconcileWithin(tool, input, record, ctx, () => reconciling.abort(), scope.closeContext);
    const status = settled.outcome === 'already_applied' ? 'completed' : 'failed';
    const output = await interruptedText(tool, reason, scope.stop(), record, settled);
    return scope.complete(await finalizeResult({ status, output }, tool, limits.fit, limits.runId, limits.formatOutput), settled.outcome, reason);
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
    if ((given.outputFit as OutputFit | undefined) === undefined || (given.reconcileFit as OutputFit | undefined) === undefined) {
      throw new TypeError('a tool batch needs outputFit and reconcileFit: the ports that decide how much of an output the model sees');
    }
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
      await reapEarlierAttempt(key, pgid, signal);
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
