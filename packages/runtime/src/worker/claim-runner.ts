import { agentSystemPrompt, readAgentPin } from '@momonga/agents';
import { createTokenMeter } from '@momonga/context';
import { computeBackoff, sha256Hex } from '@momonga/foundation';
import { isFatalStoreError } from '@momonga/store';
import type { Claim } from '@momonga/store';
import type { ClaimContext, Flow, RunMemory, Terminals } from './claim-context.ts';
import { reconcileStartedCalls, releaseWaitingOnCancel } from './cancel-recovery.ts';
import { startClaimControl } from './claim-control.ts';
import type { ClaimControl } from './claim-control.ts';
import { dispositionOf } from './gateway-policy.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import { inlineLimitForItemCap, inlineOutputLimitFor } from './inline-limit.ts';
import { measurePinnedFor } from './context-step.ts';
import { runStartHooks } from './hook-step.ts';
import { openJournal } from './journal.ts';
import type { Journal } from './journal.ts';
import { readRunLimits } from './limits.ts';
import { decideAfterResponse, responsePending, resumeInFlight, runModelStep } from './model-step.ts';
import { readPins } from './pins.ts';
import type { RunPins } from './pins.ts';
import { createSkillAdmission } from './skill-admission.ts';
import { createTerminals } from './terminals.ts';
import { settleCalls } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';
import type { TraceSpan } from '../ports.ts';
import { modelKey } from '../model-key.ts';
import { buildSystemPrompt } from '../system-prompt.ts';
import { summaryStopReason } from './wrap-up.ts';
import { reportError } from './report.ts';
import { GatewayRequestError } from '../gateway-client.ts';

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
      const timeout = new AbortController();
      const timer = options.timers.setTimeout(() => timeout.abort(new Error(`the upstream cancel exceeded ${CANCEL_UPSTREAM_TIMEOUT_MS} ms`)), CANCEL_UPSTREAM_TIMEOUT_MS);
      try {
        await options.gateway.cancel(key, { signal: timeout.signal });
      } catch (error) {
        failures.push(describeError(error));
      } finally {
        options.timers.clearTimeout(timer);
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
    timers: options.timers,
    claim,
    heartbeatMs: options.heartbeatMs ?? options.leaseMs / DEFAULT_HEARTBEAT_DIVISOR,
    cancelPollMs: options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  });
  const detach = host.attach(control);
  const memory = host.memoryOf(claim.runId);
  let journal: Journal | undefined;
  let terminals: Terminals | undefined;
  let agentSpan: TraceSpan | undefined;
  let escaping = false;
  let fatal = false;
  try {
    journal = openJournal({ store, claim, lost: control.lost });
    terminals = createTerminals({ store, claim, journal, control, clock: options.clock });
    agentSpan = tracer.startAgentSpan({ runId: claim.runId, sessionId: claim.sessionId, attempt: claim.attempt });
    await drive(options, claim, journal, control, terminals, agentSpan, memory);
    agentSpan.end();
  } catch (error) {
    const cause = control.failure() ?? error;
    agentSpan?.end(cause);
    if (isFatalStoreError(cause)) {
      fatal = true;
      escaping = true;
      throw cause;
    }
    if (control.leaseLost() || cause instanceof LeaseLostError) return;
    if (journal === undefined || terminals === undefined) {
      escaping = true;
      throw cause;
    }
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
      if (!(recoveryError instanceof LeaseLostError)) {
        escaping = true;
        fatal = isFatalStoreError(recoveryError);
        throw recoveryError;
      }
    }
  } finally {
    control.stop();
    detach();
    if (!fatal) {
      try {
        if (memory.streak === 0 || store.getRun(claim.runId)?.status !== 'QUEUED') host.forget(claim.runId);
      } catch (lookupError) {
        if (!escaping) throw lookupError;
      }
    }
  }
};

const REQUEUEABLE_4XX: readonly number[] = [408, 409, 429];

const stopRejectedWrapUp = (options: WorkerOptions, claim: Claim, journal: Journal, terminals: Terminals, cause: unknown): boolean => {
  const inFlight = journal.state.inFlightModelRequest;
  if (inFlight === undefined || journal.state.steps[inFlight.step]?.summary !== true) return false;
  if (!(cause instanceof GatewayRequestError)) return false;
  if (cause.status < 400 || cause.status >= 500 || REQUEUEABLE_4XX.includes(cause.status)) return false;
  const run = options.store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const { maxSteps } = readRunLimits(run.limits, options.defaults);
  journal.append([
    { type: 'notice', level: 'error', message: `The gateway rejected the final summary request (${cause.code}): ${cause.message}` },
  ]);
  terminals.finish('STOPPED', { stopReason: summaryStopReason(inFlight.step, maxSteps) });
  return true;
};

const requeueOrStop = (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  terminals: Terminals,
  memory: RunMemory,
  cause: unknown,
): void => {
  if (stopRejectedWrapUp(options, claim, journal, terminals, cause)) return;
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
  const backoff = computeBackoff({ attempt: memory.streak, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: options.random });
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
  if (journal.state.inherited === undefined) {
    const inherited = store.inheritContext(claim, { mode: session.permissionMode });
    if (inherited.kind === 'lease_lost') control.lost();
    if (inherited.kind === 'conflict') throw new Error(`the context of run ${run.id} could not be inherited: ${inherited.reason ?? 'conflict'}`);
    if (inherited.kind !== 'none') journal.sync();
  }
  if (claim.status === 'CANCELLING' || run.cancelRequested) {
    if (control.shuttingDown()) {
      terminals.yieldLease();
      return;
    }
    if (control.leaseLost()) control.lost();
    const inFlight = journal.state.inFlightModelRequest;
    const keys = inFlight === undefined ? [] : [modelKey(run.id, inFlight.step, inFlight.attempt)];
    const recovering = releaseWaitingOnCancel({ options, run, session, journal, control }).then(() =>
      reconcileStartedCalls({ options, run, session, journal, control }),
    );
    const upstream = cancelUpstream(options, control, keys);
    const settled = Promise.all([upstream, recovering]);
    await Promise.race([settled, control.shutdownRequested]);
    if (control.shuttingDown()) {
      settled.catch((error: unknown) => {
        if (error instanceof LeaseLostError || error instanceof ShutdownError) return;
        reportError(options, error, { workerId: options.workerId, runId: run.id });
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

  const agentPin = readAgentPin(run.pins);
  const basePrompt = (options.systemPrompt ?? buildSystemPrompt)({ cwd: session.cwd, platform: options.platform });
  const systemPrompt = agentPin === undefined ? basePrompt : agentSystemPrompt(basePrompt, agentPin);
  const systemPromptDigest = sha256Hex(systemPrompt);
  const env = tools.envFor(session);
  const skills = await options.skills.load(session);
  const admit = createSkillAdmission(() => ctx);
  const activationTool = skills.activationTool({ isActive: (name) => journal.state.activatedSkills.some((skill) => skill.name === name), admit });
  const recalled = options.memories.load(session);
  const agentSet = run.parentRunId === null && options.agents !== undefined ? await options.agents.load(session) : undefined;
  const agentTool = options.agents === undefined ? undefined : agentSet?.tool(options.agents.runs);
  const toolSet = await tools.toolSet(run.id, {
    signal: control.signal,
    env,
    additionalTools: [activationTool, agentTool, ...recalled.tools].filter((tool) => tool !== undefined),
    ...(agentPin?.tools === undefined ? {} : { only: agentPin.tools }),
  });
  if (agentPin?.tools !== undefined && toolSet.tools.length === 0) {
    terminals.finish('FAILED', {
      error: { code: 'agent_without_tools', message: `none of the tools ${agentPin.tools.map((name) => JSON.stringify(name)).join(', ')} of subagent ${agentPin.name} exists` },
    });
    return;
  }
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
  journal.append([{ type: 'run.started', attempt: claim.attempt, now: clock.now(), pins: { ...pins }, mode: session.permissionMode }]);
  const knownNotes = new Set(journal.state.notes.map((note) => note.message));
  const toolNotices = [...skills.warnings, ...(agentSet?.warnings ?? []), ...toolSet.notices].filter((message) => !knownNotes.has(message));
  if (toolNotices.length > 0) journal.append([...new Set(toolNotices)].map((message) => ({ type: 'notice', level: 'warning', message })));
  for (const server of toolSet.authorizationRequired) {
    const message = `MCP server "${server}" requires authorization before its tools can be listed`;
    if (journal.state.notes.some((note) => note.message === message)) continue;
    journal.append([{ type: 'notice', level: 'warning', message }, { type: 'mcp.authorization.required', server }]);
  }

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
  let measuredInlineLimit: Promise<number> | undefined;
  const ctx: ClaimContext = {
    options,
    claim,
    run,
    alias: pins.modelAlias,
    capabilities: pins.capabilities,
    limits,
    toolSet,
    skills,
    recalled,
    usedMemoryIds: new Set<string>(),
    env,
    functionTools: () => toolSet.forModel({ mode: session.permissionMode, rules }),
    systemPrompt,
    inlineLimitForReconcile: inlineOutputLimitFor(pins.capabilities),
    inlineLimitForExecution: () => {
      measuredInlineLimit ??= measurePinnedFor(ctx).then((measured) => inlineLimitForItemCap(measured.itemCap));
      return measuredInlineLimit;
    },
    journal,
    control,
    terminals,
    agentSpan,
    meter: createTokenMeter({ counter: { count: (request) => control.recordingRaised(gateway.countTokens(request, { signal: control.signal })) }, model: pins.modelAlias, capabilities: pins.capabilities }),
    pinnedDigest: { value: undefined },
    memory,
    compaction: { suppressedUntilStep: 0 },
  };

  if ((await runStartHooks(ctx)) === 'done') return;
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
