import { createTokenMeter } from '@momonga/context';
import { computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Claim } from '@momonga/store';
import type { ClaimContext, Flow, RunMemory, Terminals } from './claim-context.ts';
import { reconcileStartedCalls } from './cancel-recovery.ts';
import { startClaimControl } from './claim-control.ts';
import type { ClaimControl } from './claim-control.ts';
import { dispositionOf } from './gateway-policy.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import { inlineOutputLimitFor } from './inline-limit.ts';
import { openJournal } from './journal.ts';
import type { Journal } from './journal.ts';
import { readRunLimits } from './limits.ts';
import { decideAfterResponse, modelKey, responsePending, resumeInFlight, runModelStep } from './model-step.ts';
import { readPins } from './pins.ts';
import type { RunPins } from './pins.ts';
import { createTerminals } from './terminals.ts';
import { settleCalls } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';
import type { TraceSpan } from '../ports.ts';
import { buildSystemPrompt } from '../system-prompt.ts';

const DEFAULT_HEARTBEAT_DIVISOR = 3;
const DEFAULT_CANCEL_POLL_MS = 250;
const REQUEUE_BASE_MS = 1000;
const REQUEUE_MAX_MS = 60_000;
const TOOLS_CHANGED_NOTICE = 'The available tools changed since this run started; the run continues with the current tool set.';

export type ClaimHost = {
  attach(control: ClaimControl): () => void;
  memoryOf(runId: string): RunMemory;
  forget(runId: string): void;
};

const CANCEL_UPSTREAM_TIMEOUT_MS = 1000;

const cancelUpstream = async (options: WorkerOptions, control: ClaimControl, keys: readonly string[]): Promise<string[]> => {
  const failures: string[] = [];
  const settled = Promise.all(
    keys.map(async (key) => {
      try {
        await options.gateway.cancel(key, { signal: AbortSignal.timeout(CANCEL_UPSTREAM_TIMEOUT_MS) });
      } catch (error) {
        failures.push(describeError(error));
      }
    }),
  );
  await Promise.race([settled, control.shutdownRequested]);
  return failures;
};

const recordUpstreamFailures = (journal: Journal, failures: readonly string[]): void => {
  if (failures.length === 0) return;
  journal.append(failures.map((message) => ({ type: 'notice', level: 'warning', message: `Cancelling the upstream model request failed: ${message}` })));
};

export const runClaim = async (options: WorkerOptions, claim: Claim, host: ClaimHost): Promise<void> => {
  const { store, tracer } = options;
  const control = startClaimControl({
    store,
    claim,
    heartbeatMs: options.heartbeatMs ?? options.leaseMs / DEFAULT_HEARTBEAT_DIVISOR,
    cancelPollMs: options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  });
  const detach = host.attach(control);
  const memory = host.memoryOf(claim.runId);
  let journal: Journal | undefined;
  let terminals: Terminals | undefined;
  let agentSpan: TraceSpan | undefined;
  try {
    journal = openJournal({ store, claim, lost: control.lost });
    terminals = createTerminals({ store, claim, journal, control, clock: options.clock });
    agentSpan = tracer.startAgentSpan({ runId: claim.runId, sessionId: claim.sessionId, attempt: claim.attempt });
    await drive(options, claim, journal, control, terminals, agentSpan, memory);
    agentSpan.end();
  } catch (error) {
    const cause = control.failure() ?? error;
    agentSpan?.end(cause);
    if (control.leaseLost() || cause instanceof LeaseLostError) return;
    if (journal === undefined || terminals === undefined) throw cause;
    try {
      if (control.shuttingDown()) {
        terminals.yieldLease();
        return;
      }
      if (control.cancelRequested() && control.failure() === undefined) {
        if (!control.raisedDuringCancel(cause)) {
          journal.append([{ type: 'notice', level: 'error', message: `The run was cancelled after an error: ${describeError(cause)}` }]);
        }
        const keys = [control.inFlight.modelKey, control.inFlight.compactionKey].filter((key): key is string => key !== undefined);
        const failures = await cancelUpstream(options, control, keys);
        if (control.shuttingDown()) {
          terminals.yieldLease();
          return;
        }
        recordUpstreamFailures(journal, failures);
        terminals.cancel();
        return;
      }
      requeueOrStop(options, claim, journal, terminals, memory, cause);
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }
  } finally {
    control.stop();
    detach();
    if (memory.streak === 0 || store.getRun(claim.runId)?.status !== 'QUEUED') host.forget(claim.runId);
  }
};

const requeueOrStop = (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  terminals: Terminals,
  memory: RunMemory,
  cause: unknown,
): void => {
  const disposition = dispositionOf(cause, memory.interruptions);
  if (disposition.kind === 'fail') {
    terminals.finish('FAILED', { error: { code: disposition.code, message: disposition.message } });
    return;
  }
  if (disposition.kind === 'timeout') {
    terminals.finish('STOPPED', { stopReason: 'timeout' });
    return;
  }
  const now = options.clock.now();
  const backoff = computeBackoff({ attempt: memory.streak, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: options.random ?? Math.random });
  const availableAt = now + Math.max(backoff, disposition.retryAfterMs);
  const deadlineAt = options.store.getRun(claim.runId)?.deadlineAt;
  if (deadlineAt !== undefined && availableAt >= deadlineAt) {
    terminals.finish('STOPPED', { stopReason: 'timeout' });
    return;
  }
  if (deadlineAt !== undefined) memory.deadlineAt = deadlineAt;
  if (memory.streak === 0) {
    journal.append([{ type: 'notice', level: 'error', message: `The attempt failed and will be retried: ${describeError(cause)}` }]);
  }
  memory.streak += 1;
  if (disposition.interrupted) memory.interruptions += 1;
  terminals.yieldTo('QUEUED', availableAt, disposition.refund ? { refundAttempt: true } : undefined);
};

const drive = async (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  control: ClaimContext['control'],
  terminals: ClaimContext['terminals'],
  agentSpan: ClaimContext['agentSpan'],
  memory: RunMemory,
): Promise<void> => {
  const { store, gateway, tools, clock } = options;
  const run = store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const session = store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${run.sessionId}`);
  if (claim.status === 'CANCELLING' || run.cancelRequested) {
    if (control.shuttingDown()) {
      terminals.yieldLease();
      return;
    }
    if (control.leaseLost()) control.lost();
    const inFlight = journal.state.inFlightModelRequest;
    const keys = inFlight === undefined ? [] : [modelKey(run.id, inFlight.step, inFlight.attempt)];
    const reconciling = reconcileStartedCalls({ options, run, session, journal, control });
    const upstream = cancelUpstream(options, control, keys);
    const settled = Promise.all([upstream, reconciling]);
    await Promise.race([settled, control.shutdownRequested]);
    if (control.shuttingDown()) {
      settled.catch((error: unknown) => {
        if (error instanceof LeaseLostError || error instanceof ShutdownError) return;
        options.onError?.(error, { workerId: options.workerId, runId: run.id });
      });
      terminals.yieldLease();
      return;
    }
    recordUpstreamFailures(journal, await upstream);
    terminals.cancel();
    return;
  }
  if (clock.now() >= run.deadlineAt) {
    terminals.finish('STOPPED', { stopReason: 'timeout' });
    return;
  }

  const systemPrompt = (options.systemPrompt ?? buildSystemPrompt)({ cwd: session.cwd, platform: process.platform });
  const systemPromptDigest = sha256Hex(systemPrompt);
  const toolSet = await tools.toolSet(run.id);
  const recorded = journal.state.pins;
  const pins: RunPins =
    recorded === undefined
      ? {
          modelAlias: session.modelAlias,
          systemPromptDigest,
          toolSetDigest: toolSet.digest,
          capabilities: await gateway.capabilities(session.modelAlias, { signal: control.signal }),
        }
      : readPins(recorded);
  journal.append([{ type: 'run.started', attempt: claim.attempt, now: clock.now(), pins: { ...pins } }]);
  const knownNotes = new Set(journal.state.notes.map((note) => note.message));
  const toolNotices = toolSet.notices.filter((message) => !knownNotes.has(message));
  if (toolNotices.length > 0) journal.append([...new Set(toolNotices)].map((message) => ({ type: 'notice', level: 'warning', message })));

  if (recorded !== undefined) {
    if (pins.modelAlias !== session.modelAlias || pins.systemPromptDigest !== systemPromptDigest) {
      const drift = pins.modelAlias !== session.modelAlias ? 'the model alias' : 'the system prompt';
      terminals.finish('FAILED', {
        error: { code: 'pins_mismatch', message: `${drift} changed since this run started, so it cannot be resumed` },
      });
      return;
    }
    if (pins.toolSetDigest !== toolSet.digest && !journal.state.notes.some((note) => note.message === TOOLS_CHANGED_NOTICE)) {
      journal.append([{ type: 'notice', level: 'warning', message: TOOLS_CHANGED_NOTICE }]);
    }
  }

  const limits = readRunLimits(run.limits, options.defaults);
  const rules = await options.settings.rules(session);
  const ctx: ClaimContext = {
    options,
    claim,
    run,
    alias: pins.modelAlias,
    capabilities: pins.capabilities,
    limits,
    toolSet,
    functionTools: toolSet.forModel({ mode: session.permissionMode, rules }),
    systemPrompt,
    inlineLimit: inlineOutputLimitFor(pins.capabilities),
    journal,
    control,
    terminals,
    agentSpan,
    meter: createTokenMeter({ counter: { count: (request) => control.recordingRaised(gateway.countTokens(request, { signal: control.signal })) }, model: pins.modelAlias, capabilities: pins.capabilities }),
    pinnedDigest: { value: undefined },
    memory,
  };

  if (responsePending(journal.state)) {
    if ((await decideAfterResponse(ctx)) === 'done') return;
  } else if ((await settleCalls(ctx)) === 'done') {
    return;
  }
  if ((await resumeInFlight(ctx)) === 'done') return;
  for (let flow: Flow = 'continue'; flow === 'continue'; ) {
    if (control.shuttingDown()) {
      terminals.yieldLease();
      return;
    }
    if (control.cancelRequested()) {
      terminals.cancel();
      return;
    }
    flow = await runModelStep(ctx);
  }
};
