import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { absoluteFrom, canonicalizePath, decide, suggestAllowRule } from '@momonga/policy';
import type { Decision, PermissionRule, PermissionSubject } from '@momonga/policy';
import type { PermissionMode, ToolKind } from '@momonga/protocol';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { createReadDeniedMatcher } from './read-denied.ts';
import type { BlobPort, IdempotencyPort, ToolIdempotencyRecord } from './ports.ts';
import type { ToolSet } from './registry.ts';
import { MINIMUM_INLINE_OUTPUT_CHARS, truncateOutput } from './truncate.ts';
import { ToolExecutionError, ToolInputError, TransientToolError } from './types.ts';
import type { AnyTool, ReconcileResult, ToolContent, ToolContext, ToolResult, ToolSessionState } from './types.ts';
import { validateToolInput } from './validate.ts';

const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 30_000;
const DEFAULT_MAX_PARALLEL = 8;
const DEFAULT_READ_ONLY_RETRY = { attempts: 3, baseMs: 200, maxMs: 2000 } as const;
const ABORT_SETTLE_LIMIT_MS = 2000;
const UNKNOWN_EFFECTS_NOTICE = 'Its side effects are unknown; inspect the current state before retrying.';

export type ToolCall = {
  callId: string;
  name: string;
  arguments: string | unknown;
  approval?: { kind: 'allow_once' | 'allow_always'; subjectDigest: string } | 'allow_once' | 'allow_always';
};

export type BatchInput = {
  calls: readonly ToolCall[];
  toolSet: ToolSet;
  runId: string;
  step: number;
  mode: PermissionMode;
  rules: PermissionRule[];
  home: string;
  roots: readonly string[];
  env: Readonly<Record<string, string>>;
  session: ToolSessionState;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  deadlineAt: number;
  signal: AbortSignal;
  protectedPaths: readonly string[];
  traceparentFor?(callId: string): { traceparent: string; tracestate?: string } | undefined;
  onStarted?(callId: string, idemKey: string): void | Promise<void>;
  onUpdate?(callId: string, content: ToolContent[]): void;
};

export type ResultOutcome = {
  callId: string;
  kind: 'result';
  result: ToolResult & { truncated?: true; handle?: string };
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
};

export type ToolExecutor = { runBatch(input: BatchInput): Promise<CallOutcome[]> };

type RunPlan = { call: ToolCall; tool: AnyTool; input: unknown; key: string; batch: BatchInput; recovered?: ToolIdempotencyRecord };

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

const readDeniedPath = (subject: PermissionSubject, readDenied: readonly string[], cwd: string): string | undefined => {
  if (subject.kind !== 'path' || readDenied.length === 0) return undefined;
  const matcher = createReadDeniedMatcher(readDenied, cwd);
  return subject.paths.find((target) => matcher.blocks(target));
};

const digestSubject = (subject: PermissionSubject, cwd: string): unknown => {
  if (subject.kind === 'path') {
    return {
      ...subject,
      paths: subject.paths.map((target) => {
        const absolute = absoluteFrom(target, cwd);
        return canonicalizePath(absolute) ?? absolute;
      }),
    };
  }
  if (subject.kind === 'command') {
    const canonicalCwd = canonicalizePath(cwd);
    if (canonicalCwd === null) throw new Error(`session cwd ${cwd} cannot be resolved to a real location`);
    return { subject, cwd: canonicalCwd };
  }
  return subject;
};

const failedOutcome = (callId: string, output: string): ResultOutcome => ({
  callId,
  kind: 'result',
  result: { status: 'failed', output },
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

const cancellableTimer = (ms: number): { done: Promise<void>; cancel(): void } => {
  let handle: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
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

export const createToolExecutor = (options: ToolExecutorOptions): ToolExecutor => {
  if (options.maxInlineOutputChars !== undefined && options.maxInlineOutputChars < MINIMUM_INLINE_OUTPUT_CHARS) {
    throw new RangeError(`maxInlineOutputChars must be at least ${MINIMUM_INLINE_OUTPUT_CHARS}`);
  }
  const { idempotency, blobs, clock } = options;
  const ttlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxInlineOutputChars = options.maxInlineOutputChars ?? DEFAULT_MAX_INLINE_OUTPUT_CHARS;
  const retry = options.readOnlyRetry ?? DEFAULT_READ_ONLY_RETRY;
  const maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;

  const finalizeResult = (result: ToolResult, tool: AnyTool): ResultOutcome['result'] => {
    const truncated =
      tool.pagesOutput === true && result.output.length <= maxInlineOutputChars
        ? { output: result.output }
        : truncateOutput(result.output, maxInlineOutputChars, blobs);
    return {
      status: result.status,
      output: truncated.output,
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.plan === undefined ? {} : { plan: result.plan }),
      ...('truncated' in truncated ? { truncated: truncated.truncated, handle: truncated.handle } : {}),
    };
  };

  const admit = (call: ToolCall, batch: BatchInput): Admission => {
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

    let subject;
    try {
      subject = tool.subject(input, { cwd, home: batch.home, roots: batch.roots });
    } catch (error) {
      return outcome(failedOutcome(call.callId, describeThrown(tool.name, error)));
    }

    const key = idempotencyKeyFor(batch.runId, batch.step, call.callId);
    const existing = idempotency.get(key);
    if (existing?.s === 'COMPLETED') return outcome(storedOutcome(existing.result));

    const blockedPath = readDeniedPath(subject, batch.sandboxPolicy.readDenied, cwd);
    if (blockedPath !== undefined) return outcome(failedOutcome(call.callId, `Permission denied: ${blockedPath} is blocked by the sandbox policy`));

    const policyTool = { name: tool.name, kind: tool.kind, sideEffect: tool.sideEffect };
    const decision = decide({
      tool: policyTool,
      subject,
      mode: batch.mode,
      rules: batch.rules,
      roots: [...batch.roots],
      home: batch.home,
      cwd,
      protectedPaths: batch.protectedPaths,
    });
    if (decision.kind === 'deny') return outcome(failedOutcome(call.callId, `Permission denied: ${decision.reason}`));
    const unsandboxedExec = decision.kind === 'allow' && tool.sideEffect === 'exec' && batch.sandbox.kind === 'none';
    const { approval } = call;
    if ((decision.kind === 'ask' || unsandboxedExec) && typeof approval !== 'string') {
      let subjectDigest: string;
      try {
        subjectDigest = sha256Hex(canonicalJson(digestSubject(subject, cwd)));
      } catch (error) {
        return outcome(failedOutcome(call.callId, `Permission check failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (approval?.subjectDigest !== subjectDigest) {
        const effective: Decision = unsandboxedExec
          ? { kind: 'ask', source: 'mode', reason: 'no sandbox is available, so command execution requires approval' }
          : decision;
        const suggestedRule =
          unsandboxedExec || decision.source === 'protected' ? undefined : suggestAllowRule(policyTool, subject, { cwd, home: batch.home });
        const locations = tool.locations?.(input);
        return outcome({
          callId: call.callId,
          kind: 'needs_approval',
          decision: effective,
          subjectDigest,
          ...(suggestedRule === undefined ? {} : { suggestedRule }),
          title: tool.title(input),
          toolKind: tool.kind,
          ...(locations === undefined ? {} : { locations }),
        });
      }
    }
    const recovered = existing?.s === 'PENDING' || existing?.s === 'UNKNOWN' ? existing.rec : undefined;
    return { kind: 'run', plan: { call, tool, input, key, batch, ...(recovered === undefined ? {} : { recovered }) } };
  };

  const perform = async (plan: RunPlan): Promise<CallOutcome> => {
    const { call, tool, input, key, batch, recovered } = plan;
    const { callId } = call;
    if (batch.signal.aborted) return failedOutcome(callId, `${tool.name} was cancelled`);
    if (batch.deadlineAt - clock.now() <= 0) return failedOutcome(callId, `Run deadline exceeded before ${tool.name} could start`);

    const controller = new AbortController();
    let abortReason: AbortReason | undefined;
    const abortWith = (reason: AbortReason): void => {
      if (abortReason !== undefined) return;
      abortReason = reason;
      controller.abort();
    };
    const processMarker = path.join(options.processMarkerDir, key);
    let recordCompleted = false;
    const onBatchAbort = (): void => abortWith('cancelled');
    batch.signal.addEventListener('abort', onBatchAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;

    try {
      const trace = batch.traceparentFor?.(callId);
      const ctx: ToolContext = {
        cwd: batch.session.cwd,
        home: batch.home,
        roots: batch.roots,
        runId: batch.runId,
        step: batch.step,
        callId,
        idemKey: key,
        outputBudgetChars: maxInlineOutputChars,
        ...(tool.sideEffect === 'exec' ? { processMarker } : {}),
        ...(trace === undefined ? {} : { traceparent: trace.traceparent }),
        ...(trace?.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
        env: batch.env,
        signal: controller.signal,
        deadlineAt: batch.deadlineAt,
        sandbox: batch.sandbox,
        sandboxPolicy: batch.sandboxPolicy,
        blobs,
        clock,
        session: batch.session,
        attachProcess: (processInfo) => idempotency.attachProcess(key, processInfo),
        update: (content) => batch.onUpdate?.(callId, content),
      };

      let prepared: Record<string, unknown> | undefined;
      if (recovered !== undefined) {
        const stored = recovered.meta['prepared'];
        prepared = isRecord(stored) ? stored : undefined;
      } else if (tool.prepare !== undefined) {
        try {
          prepared = await tool.prepare(input, ctx);
        } catch (error) {
          return failedOutcome(callId, describeThrown(tool.name, error));
        }
      }
      if (abortReason !== undefined) return failedOutcome(callId, `${tool.name} was cancelled`);

      const begun = idempotency.begin(key, {
        expiresAt: clock.now() + ttlMs,
        meta: { tool: tool.name, ...(prepared === undefined ? {} : { prepared }) },
      });
      if (begun.s === 'COMPLETED') return storedOutcome(begun.result);

      const complete = (result: ResultOutcome['result'], reconciled?: ReconcileResult['outcome']): ResultOutcome => {
        const outcome: ResultOutcome = {
          callId,
          kind: 'result',
          result,
          idemKey: key,
          ...(reconciled === undefined ? {} : { reconciled }),
        };
        idempotency.complete(key, outcome);
        recordCompleted = true;
        return outcome;
      };

      const execute = async (reconciled?: ReconcileResult['outcome']): Promise<ResultOutcome> => {
        if (tool.sideEffect === 'exec') {
          fs.rmSync(processMarker, { force: true });
          fs.closeSync(fs.openSync(processMarker, 'wx', 0o600));
        }
        const requestedMs = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(input) : tool.timeoutMs;
        const timeoutMs = Math.max(0, Math.min(requestedMs, batch.deadlineAt - clock.now()));

        const runTool = async (): Promise<ToolResult> => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await tool.execute(input, ctx, prepared);
            } catch (error) {
              const retryable =
                error instanceof TransientToolError &&
                tool.sideEffect === 'read_only' &&
                attempt + 1 < retry.attempts &&
                !controller.signal.aborted &&
                batch.deadlineAt - clock.now() > 0;
              if (!retryable) return { status: 'failed', output: describeThrown(tool.name, error) };
              await pause(computeBackoff({ attempt, baseMs: retry.baseMs, maxMs: retry.maxMs, random: Math.random }), controller.signal);
              if (controller.signal.aborted) return { status: 'failed', output: describeThrown(tool.name, error) };
            }
          }
        };

        const aborted = new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        timer = setTimeout(() => abortWith('timeout'), timeoutMs);
        const running = runTool();
        const result = await Promise.race([running, aborted.then(() => undefined)]);
        if (abortReason === undefined && result !== undefined) return complete(finalizeResult(result, tool), reconciled);
        await settleWithin(running, ABORT_SETTLE_LIMIT_MS);
        const output = abortReason === 'timeout' ? timedOutOutput(tool, timeoutMs) : cancelledOutput(tool);
        return complete({ status: 'failed', output }, reconciled);
      };

      if (begun.s === 'NEW') {
        await batch.onStarted?.(callId, key);
        return await execute();
      }

      let reconcileOutcome: ReconcileResult;
      try {
        reconcileOutcome = await reconcileInterrupted(tool, input, begun.rec, ctx);
      } catch (error) {
        return failedOutcome(callId, describeThrown(tool.name, error));
      }
      if (reconcileOutcome.outcome === 'not_applied') return await execute('not_applied');
      const status = reconcileOutcome.outcome === 'already_applied' ? 'completed' : 'failed';
      return complete(finalizeResult({ status, output: reconcileOutcome.output }, tool), reconcileOutcome.outcome);
    } finally {
      clearTimeout(timer);
      if (recordCompleted && tool.sideEffect === 'exec') fs.rmSync(processMarker, { force: true });
      batch.signal.removeEventListener('abort', onBatchAbort);
    }
  };

  const reconcileInterrupted = async (
    tool: AnyTool,
    input: unknown,
    record: ToolIdempotencyRecord,
    ctx: ToolContext,
  ): Promise<ReconcileResult> => {
    if (tool.reconcile !== undefined) return tool.reconcile(input, record, ctx);
    if (tool.sideEffect === 'read_only') return { outcome: 'not_applied', output: '' };
    return { outcome: 'unknown', output: interruptedOutput(tool) };
  };

  const runBatch = async (batch: BatchInput): Promise<CallOutcome[]> => {
    const { calls } = batch;
    const outcomes: Array<CallOutcome | undefined> = new Array<CallOutcome | undefined>(calls.length).fill(undefined);
    const inFlight = new Set<Promise<void>>();
    const limiter = createLimiter(maxParallel);

    let failure: { error: unknown } | undefined;
    const recordFailure = (error: unknown): void => {
      if (failure === undefined) failure = { error };
    };

    const drain = async (): Promise<void> => {
      await Promise.all(inFlight);
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

        let admission: Admission;
        try {
          admission = admit(call, batch);
        } catch (error) {
          release?.();
          throw error;
        }

        if (admission.kind === 'outcome') {
          release?.();
          outcomes[index] = admission.outcome;
          if (admission.outcome.kind === 'needs_approval') {
            await drain();
            for (let later = index + 1; later < calls.length; later += 1) {
              outcomes[later] = { callId: (calls[later] as ToolCall).callId, kind: 'deferred' };
            }
            return;
          }
          continue;
        }

        if (release === undefined) {
          outcomes[index] = await perform(admission.plan);
          continue;
        }
        const releaseSlot = release;
        const running: Promise<void> = perform(admission.plan)
          .then(
            (outcome) => {
              outcomes[index] = outcome;
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

  return { runBatch };
};
