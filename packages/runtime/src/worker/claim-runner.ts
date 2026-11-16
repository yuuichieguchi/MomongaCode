import { agentSystemPrompt, readAgentPin } from '@momonga/agents';
import { permissionRulesComposerFor, permissionRulesFor } from '../governance/rules.ts';
import { signalUntil } from '../memory/deadline-signal.ts';
import { reapTimingOf } from '../process/reap-timing.ts';
import { createTokenMeter, inheritanceWindowFor, readerNamesOf, withCalibration } from '@momonga/context';
import type { TokenMeter } from '@momonga/context';
import { computeBackoff, sha256Hex, sleep } from '@momonga/foundation';
import { REFERENCE_KINDS, measuringLineOf, measuringSkipOf, measuringStepOf, sessionFenceOf, RUN_STATUSES, TARGET_NOT_READY, TERMINAL_STATUSES, agentReadiness, displayMapOf, readinessText } from '@momonga/protocol';
import type { Capabilities, FunctionTool, Measuring } from '@momonga/protocol';
import { JournalThreadError, UnknownValueError, isFatalStoreError } from '@momonga/store';
import type { Claim, Session } from '@momonga/store';
import type { ClaimContext, Flow, RunMemory, Terminals } from './claim-context.ts';
import { reconcileStartedCalls, releaseWaitingOnCancel } from './cancel-recovery.ts';
import { startClaimControl } from './claim-control.ts';
import type { ClaimControl } from './claim-control.ts';
import { MEASURING_SAME_STATE_WAITS, dispositionOf, observedCodeOf, retireDecisionOf, terminalOf } from './gateway-policy.ts';
import { heartbeatMsFor } from './heartbeat.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import { meteredOutputFit, reconcileOutputFit } from './output-fit.ts';
import { compactOnly, governingFailureAtStart, measurePinnedFor } from './context-step.ts';
import { readCompactPin } from './compact-pin.ts';
import { runStartHooks } from './hook-step.ts';
import { openJournal } from './journal.ts';
import type { Journal } from './journal.ts';
import { readRunLimits } from './limits.ts';
import { delegationOf } from './held-calls.ts';
import { decideAfterResponse, responsePending, resumeInFlight, runModelStep } from './model-step.ts';
import { guidelineOf, guidelineVersionFor } from './guideline-pin.ts';
import { memoryShareFor } from './memory-share.ts';
import { watchMode } from './mode-watch.ts';
import { foldMeterFor } from './meter-journal.ts';
import { modelChainReaches } from './model-switch.ts';
import { roleModelNotConfiguredText, sessionModelNotConfiguredText } from './model-texts.ts';
import { EXACT_MODEL } from './exact-model.ts';
import { readPins } from './pins.ts';
import { rolesFor } from './role-pin.ts';
import { deferredPinFor, tokenPinFor, tokenPolicyOf } from './token-pin.ts';
import { COMPLETION_CONDITION_DENIED_CODE, completionPinFor, deniedConditionText } from './completion-pin.ts';
import type { RunPins } from './pins.ts';
import { createSkillAdmission } from './skill-admission.ts';
import { createTerminals, releaseClaimLease } from './terminals.ts';
import { extendToolSet, harnessOutputToolsOf, operationCatalogueFacts } from '@momonga/tools';
import { createLoadToolsTool } from './load-tools-tool.ts';
import { createToolLoading } from './tool-admission.ts';
import { offerFor, offeredRecordFor } from './tool-offer.ts';
import type { ToolOffer } from './tool-offer.ts';
import { settleCalls, settleHeld } from './tool-step.ts';
import { unknownGate } from './unknown-gate.ts';
import { laterVerdictNotice, mandateRefusal, policyRefusal, ruleVerdictAtStart } from './rule-verdict.ts';
import type { WorkerOptions } from './types.ts';
import type { TracerPort, TraceSpan } from '../ports.ts';
import { MODEL_ROLES } from '@momonga/config';
import type { Lease } from '@momonga/config';
import { modelKey } from '../model-key.ts';
import { MEMORY_PAGE_ROWS, REQUEUE_BASE_MS, REQUEUE_MAX_MS } from '../process/constants.ts';
import { createGoverningActivation, createInstructionProbes } from './touched-paths.ts';
import type { ClaimTouched } from './touched-paths.ts';
import { buildSystemPrompt } from '../system-prompt.ts';
import { summaryStopReason } from './wrap-up.ts';
import { reportError } from './report.ts';
import { GatewayRequestError, MODEL_NOT_FOUND_CODE, isModelNotFound } from '../gateway-client.ts';
import type { GatewayModel } from '../gateway-client.ts';
import { heldSessionOf } from './known.ts';

const LIVE_RUN_STATUSES = RUN_STATUSES.filter((status) => !TERMINAL_STATUSES.some((terminal) => terminal === status));
const DEFAULT_CANCEL_POLL_MS = 250;
const TOOLS_CHANGED_NOTICE = 'The available tools changed since this run started; the run continues with the current tool set.';

export type ClaimHost = {
  attach(control: ClaimControl): () => void;
  memoryOf(runId: string): RunMemory;
  forget(runId: string): void;
};

const listedOrUndefined = async (control: ClaimControl, gateway: WorkerOptions['gateway'], model: string): Promise<GatewayModel | undefined> => {
  try {
    return await control.recordingRaised(gateway.model(model, { signal: control.signal }));
  } catch (error) {
    if (isModelNotFound(error)) return undefined;
    throw error;
  }
};

const capabilitiesOrReason = async (
  gateway: WorkerOptions['gateway'],
  model: string,
  signal: AbortSignal,
  interruptions: number,
): Promise<{ capabilities: Capabilities } | { unavailable: string } | { notConfigured: true }> => {
  try {
    return { capabilities: await gateway.capabilities(model, { signal }) };
  } catch (error) {
    if (isModelNotFound(error)) return { notConfigured: true };
    if (!(error instanceof GatewayRequestError)) throw error;
    const disposition = dispositionOf(error, interruptions);
    if (disposition.kind === 'fail') return { unavailable: disposition.message };
    throw error;
  }
};

const cancelUpstream = async (options: WorkerOptions, control: ClaimControl, keys: readonly string[]): Promise<string[]> => {
  const failures: string[] = [];
  const settled = Promise.all(
    keys.map(async (key) => {
      try {
        await options.gateway.cancel(key, { signal: control.recoverySignal });
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
  journal.append(failures.map((message) => ({ type: 'notice', level: 'warning', message: `Cancelling the upstream model request failed: ${message}`, code: 'upstream_cancel_failed' })));
};

const touchedOf = (session: Session, options: WorkerOptions, signal: AbortSignal): ClaimTouched => {
  const source = (after: { eventId: number; path: string } | null, limit: number) =>
    after === null ? options.store.sessionTouched.after(session.id, 0, limit) : options.store.sessionTouched.after(session.id, after.eventId, limit, after.path);
  const nextTurn = (): Promise<unknown> => sleep(options.timers, 0, signal);
  return {
    governing: createGoverningActivation({ project: session.cwd, source, pageRows: MEMORY_PAGE_ROWS, nextTurn }),
    probes: createInstructionProbes({ reader: options.instructionReaderFor(signal), projectRoot: session.cwd, source, pageRows: MEMORY_PAGE_ROWS, nextTurn }),
  };
};

export const runClaim = async (options: WorkerOptions, claim: Claim, host: ClaimHost): Promise<void> => {
  const { store } = options;
  const control = startClaimControl({
    store,
    timers: options.timers,
    claim,
    role: options.role,
    heartbeatMs: options.heartbeatMs ?? heartbeatMsFor(options.leaseMs),
    cancelPollMs: options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  });
  const detach = host.attach(control);
  const memory = host.memoryOf(claim.runId);
  let journal: Journal | undefined;
  let terminals: Terminals | undefined;
  let agentSpan: TraceSpan | undefined;
  let tracerLease: Lease<TracerPort> | undefined;
  let escaping = false;
  let fatal = false;
  let leftToRecovery = false;
  try {
    journal = await openJournal({ store, claim, signal: control.recoverySignal, lost: control.lost });
    terminals = createTerminals({ store, claim, journal, control, clock: options.clock });
    tracerLease = await options.tracers.acquire(control.signal);
    agentSpan = tracerLease.value.startAgentSpan({ runId: claim.runId, sessionId: claim.sessionId, attempt: claim.attempt });
    await drive(options, claim, journal, control, terminals, agentSpan, tracerLease.value, memory);
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
    if (journal === undefined && cause instanceof ShutdownError) {
      await releaseClaimLease(store, claim, options.clock);
      return;
    }
    if (control.shuttingDown() && cause instanceof JournalThreadError) {
      leftToRecovery = true;
      return;
    }
    if (journal === undefined || terminals === undefined) {
      escaping = true;
      throw cause;
    }
    try {
      if (control.shuttingDown() || cause instanceof UnknownValueError) {
        await terminals.yieldLease();
        return;
      }
      if ((await retireDecisionOf(cause, options.role)) === 'retire-yield') {
        await terminals.yieldLease();
        return;
      }
      if (control.cancelRequested() && control.failure() === undefined) {
        if (!control.raisedDuringCancel(cause)) {
          journal.append([{ type: 'notice', level: 'error', message: `The run was cancelled after an error: ${describeError(cause)}`, code: 'cancelled_after_error' }]);
        }
        const keys = [control.inFlight.modelKey, control.inFlight.compactionKey].filter((key): key is string => key !== undefined);
        const failures = await cancelUpstream(options, control, keys);
        if (control.shuttingDown()) {
          await terminals.yieldLease();
          return;
        }
        recordUpstreamFailures(journal, failures);
        await terminals.cancel();
        return;
      }
      await requeueOrStop(options, claim, journal, terminals, memory, cause);
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) {
        escaping = true;
        fatal = isFatalStoreError(recoveryError);
        throw recoveryError;
      }
    }
  } finally {
    tracerLease?.release();
    control.stop();
    detach();
    if (!fatal && !leftToRecovery) {
      try {
        if ((memory.streak === 0 && memory.measuring === undefined) || store.getRun(claim.runId)?.status !== 'QUEUED') host.forget(claim.runId);
      } catch (lookupError) {
        if (!escaping) throw lookupError;
      }
    }
  }
};

const stopRejectedWrapUp = async (options: WorkerOptions, claim: Claim, journal: Journal, terminals: Terminals, cause: unknown): Promise<boolean> => {
  const inFlight = journal.state.inFlightModelRequest;
  if (inFlight === undefined || journal.state.steps[inFlight.step]?.summary !== true) return false;
  if (!(cause instanceof GatewayRequestError)) return false;
  if (cause.status < 400 || cause.status >= 500 || cause.type === 'too_many_requests' || dispositionOf(cause, 0).kind !== 'fail') return false;
  const run = options.store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const { maxSteps } = readRunLimits(run.limits, options.defaults);
  journal.append([
    { type: 'notice', level: 'error', message: `The model refused the final summary request (${cause.code}): ${cause.message}. The work of the run is kept; ask for a summary in a new prompt.`, code: 'final_summary_rejected' },
  ]);
  await terminals.finish('STOPPED', { stopReason: summaryStopReason(inFlight.step, maxSteps) });
  return true;
};

const measuringStateOf = (measuring: Measuring): string => JSON.stringify([measuring.fields, measuring.step]);

const measuringStalledText = (measuring: Measuring): string =>
  `${measuringStepOf(measuring)}, and it did not move on in ${MEASURING_SAME_STATE_WAITS} waits of its own bound; ${measuringSkipOf(measuring)}`;

const requeueOrStop = async (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  terminals: Terminals,
  memory: RunMemory,
  cause: unknown,
): Promise<void> => {
  if (await stopRejectedWrapUp(options, claim, journal, terminals, cause)) return;
  const disposition = dispositionOf(cause, memory.interruptions);
  if (disposition.kind === 'fail' || disposition.kind === 'stop') {
    const terminal = terminalOf(disposition);
    await terminals.finish(terminal.to, terminal.patch);
    return;
  }
  if (disposition.kind === 'timeout') {
    await terminals.finish('STOPPED', { stopReason: 'timeout' });
    return;
  }
  if (disposition.kind === 'wait') {
    const state = measuringStateOf(disposition.measuring);
    const elapsedSeconds = disposition.measuring.elapsedSeconds;
    const previous = memory.measuring;
    const shown = previous?.state === state;
    const stalls = shown && elapsedSeconds <= previous.elapsedSeconds ? previous.stalls + 1 : 0;
    if (stalls >= MEASURING_SAME_STATE_WAITS) {
      await terminals.finish('FAILED', { error: { code: disposition.code, message: measuringStalledText(disposition.measuring) } });
      return;
    }
    const availableAt = options.clock.now() + disposition.retryAfterMs;
    const deadlineAt = options.store.getRun(claim.runId)?.deadlineAt;
    if (deadlineAt !== undefined && availableAt >= deadlineAt) {
      await terminals.finish('STOPPED', { stopReason: 'timeout' });
      return;
    }
    if (!shown) journal.append([{ type: 'notice', level: 'info', message: measuringLineOf(disposition.measuring), code: disposition.code }]);
    memory.measuring = { state, elapsedSeconds, stalls };
    await terminals.yieldTo('QUEUED', availableAt, { refundAttempt: true });
    return;
  }
  const refund = disposition.kind === 'requeue' && disposition.refund;
  const unhonoured = async (otherwise: () => Promise<void>): Promise<void> => {
    if (disposition.kind === 'defer') await terminals.finish('FAILED', { error: { code: disposition.code, message: disposition.message } });
    else await otherwise();
  };
  const attempts = (options.store.getRun(claim.runId)?.attempts ?? 0) - (refund ? 1 : 0);
  if (attempts >= options.store.maxTotalAttempts) {
    await unhonoured(async () => {
      await terminals.finish('FAILED', {
        error: {
          code: 'max_total_attempts',
          message: `run ${claim.runId} exceeded ${options.store.maxTotalAttempts} total attempts; the last attempt failed with: ${describeError(cause)}`,
        },
      });
    });
    return;
  }
  const now = options.clock.now();
  const backoff = computeBackoff({ attempt: memory.streak, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: { float: options.random } });
  const availableAt = now + (disposition.kind === 'defer' ? disposition.retryAfterMs : Math.max(backoff, disposition.retryAfterMs));
  const deadlineAt = options.store.getRun(claim.runId)?.deadlineAt;
  if (deadlineAt !== undefined && availableAt >= deadlineAt) {
    await unhonoured(async () => {
      await terminals.finish('STOPPED', { stopReason: 'timeout' });
    });
    return;
  }
  if (deadlineAt !== undefined) memory.deadlineAt = deadlineAt;
  if (memory.streak === 0) {
    journal.append([{ type: 'notice', level: 'error', message: `The attempt failed and will be retried: ${describeError(cause)}`, code: 'attempt_retried' }]);
  }
  memory.streak += 1;
  if (disposition.kind === 'requeue' && disposition.interrupted) memory.interruptions += 1;
  journal.append([{ type: 'attempt.failed', attempt: claim.leaseToken, code: observedCodeOf(cause), retryAt: availableAt, limit: options.store.maxTotalAttempts }]);
  await terminals.yieldTo('QUEUED', availableAt, refund ? { refundAttempt: true } : undefined);
};

const drive = async (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  control: ClaimContext['control'],
  terminals: ClaimContext['terminals'],
  agentSpan: ClaimContext['agentSpan'],
  tracer: TracerPort,
  memory: RunMemory,
): Promise<void> => {
  const { store, gateway, tools, clock } = options;
  const run = store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const session = heldSessionOf(store, run.sessionId);
  if (journal.state.inherited === undefined) {
    const inherited = await store.inheritContext(claim, { mode: session.permissionMode, facts: store.journalFacts });
    if (inherited.kind === 'lease_lost') control.lost();
    if (inherited.kind === 'conflict') throw new Error(`the context of run ${run.id} could not be inherited: ${inherited.reason ?? 'conflict'}`);
    if (inherited.kind !== 'none') journal.sync();
  }
  if (claim.status === 'CANCELLING' || run.cancelRequested) {
    if (control.shuttingDown()) {
      await terminals.yieldLease();
      return;
    }
    if (control.leaseLost()) control.lost();
    const inFlight = journal.state.inFlightModelRequest;
    const keys = inFlight === undefined ? [] : [modelKey(run.id, inFlight.step, inFlight.attempt)];
    const recovering = releaseWaitingOnCancel({ options, claim, run, session, journal, control }).then(() =>
      reconcileStartedCalls({ options, claim, run, session, journal, control }),
    );
    const upstream = cancelUpstream(options, control, keys);
    const settled = Promise.all([upstream, recovering]);
    await Promise.race([settled, control.shutdownRequested]);
    if (control.shuttingDown()) {
      settled.catch((error: unknown) => {
        if (error instanceof LeaseLostError || error instanceof ShutdownError) return;
        reportError(options, error, { workerId: options.workerId, runId: run.id });
      });
      await terminals.yieldLease();
      return;
    }
    recordUpstreamFailures(journal, await upstream);
    await terminals.cancel();
    return;
  }
  if (clock.now() >= run.deadlineAt) {
    await terminals.finish('STOPPED', { stopReason: 'timeout' });
    return;
  }

  const recorded = journal.state.pins;
  const pinned = recorded === undefined ? undefined : readPins(recorded);
  const read = pinned === undefined ? await capabilitiesOrReason(gateway, session.model, control.signal, memory.interruptions) : { capabilities: pinned.capabilities };
  if ('notConfigured' in read) {
    await terminals.finish('FAILED', { error: { code: MODEL_NOT_FOUND_CODE, message: sessionModelNotConfiguredText(session.model) } });
    return;
  }
  if ('unavailable' in read) {
    await terminals.finish('FAILED', { error: { code: TARGET_NOT_READY, message: readinessText(agentReadiness({ unavailable: read.unavailable })) } });
    return;
  }
  const { capabilities } = read;
  const readiness = agentReadiness(capabilities);
  if (readiness.state !== 'ready' && readiness.state !== 'no_tools') {
    await terminals.finish('FAILED', { error: { code: TARGET_NOT_READY, message: readinessText(readiness) } });
    return;
  }
  const toolLess = readiness.state === 'no_tools';
  const agentPin = readAgentPin(run.pins);
  const basePrompt = (options.systemPrompt ?? buildSystemPrompt)({ cwd: session.cwd, platform: options.platform, fence: sessionFenceOf(session), ...(toolLess ? { tools: 'none' as const } : {}) });
  const systemPrompt = agentPin === undefined ? basePrompt : agentSystemPrompt(basePrompt, agentPin);
  const systemPromptDigest = sha256Hex(systemPrompt);
  const env = await tools.envFor(session, control.signal);
  const skills = await options.skills.load(session, control.signal);
  const admit = createSkillAdmission(() => ctx);
  const activationTool = skills.activationTool({ isActive: (name) => journal.state.activatedSkills.some((skill) => skill.name === name), admit });
  const recallDeadline = signalUntil(reapTimingOf(clock, options.timers), run.deadlineAt, control.signal);
  const recalled = await options.memories.load(session, recallDeadline.signal).finally(() => recallDeadline.dispose());
  const agentSet = run.parentRunId === null && options.agents !== undefined ? await options.agents.load(session, control.signal) : undefined;
  const agentTool = options.agents === undefined ? undefined : agentSet?.tool(options.agents.runs);
  const toolSet = await tools.toolSet(run.id, {
    signal: control.signal,
    env,
    additionalTools: [activationTool, agentTool, ...recalled.tools, ...(await options.history.load(session, control.signal)).tools, ...(await options.governance.load(session, control.signal)).tools].filter(
      (tool) => tool !== undefined,
    ),
    ...(agentPin?.tools === undefined ? {} : { only: agentPin.tools }),
  });
  if (agentPin?.tools !== undefined && toolSet.tools.length === 0) {
    await terminals.finish('FAILED', {
      error: { code: 'agent_without_tools', message: `none of the tools ${agentPin.tools.map((name) => JSON.stringify(name)).join(', ')} of subagent ${agentPin.name} exists` },
    });
    return;
  }
  const listing = await listedOrUndefined(control, gateway, pinned?.model ?? session.model);
  if (listing === undefined) {
    await terminals.finish('FAILED', { error: { code: MODEL_NOT_FOUND_CODE, message: sessionModelNotConfiguredText(pinned?.model ?? session.model) } });
    return;
  }
  const newRoles = pinned === undefined ? rolesFor({ store: options.store, listed: listing.roles, run }) : undefined;
  const lostRole = newRoles === undefined ? undefined : MODEL_ROLES.find((role) => newRoles[role] !== undefined && !listing.views.some((view) => view.canon === newRoles[role]));
  if (newRoles !== undefined && lostRole !== undefined) {
    await terminals.finish('FAILED', { error: { code: MODEL_NOT_FOUND_CODE, message: roleModelNotConfiguredText(lostRole, newRoles[lostRole] ?? '') } });
    return;
  }
  const pinning =
    pinned === undefined
      ? await completionPinFor({ run, session, settings: options.settings, rules: () => permissionRulesFor(options, session, control.signal), mode: session.permissionMode, signal: control.signal })
      : undefined;
  if (pinning?.kind === 'denied') {
    await terminals.finish('FAILED', { error: { code: COMPLETION_CONDITION_DENIED_CODE, message: deniedConditionText(pinning.denied) } });
    return;
  }
  const completionPin = pinning?.pin;
  const { delegation } = delegationOf(pinned ?? completionPin ?? {}, { home: options.home, cwd: session.cwd }, operationCatalogueFacts());
  const startVerdict = await ruleVerdictAtStart({ options, control, env, readableDirectories: skills.readDirectories, delegation }, session);
  const startRefusal = policyRefusal(startVerdict) ?? (await mandateRefusal(options, session, delegation, control.signal));
  if (startRefusal !== undefined) {
    await terminals.finish('FAILED', { error: startRefusal });
    return;
  }
  const newMemoryShare = recorded === undefined ? await memoryShareFor({ store: options.store, settings: options.settings, session, run, signal: control.signal }) : undefined;
  const newGuidelineVersion = recorded === undefined ? guidelineVersionFor(options.store, run) : undefined;
  const pins: RunPins =
    pinned === undefined
      ? {
          model: session.model,
          systemPromptDigest,
          toolSetDigest: toolSet.digest,
          capabilities,
          policyVerdict: startVerdict,
          roles: newRoles ?? {},
          targets: { ...listing.targets },
          ...(newMemoryShare === undefined ? {} : { memoryShare: newMemoryShare }),
          ...(newGuidelineVersion === undefined ? {} : { guidelineVersion: newGuidelineVersion }),
          token: {
            ...(await tokenPinFor({ store: options.store, settings: options.settings, session, run, signal: control.signal })),
            ...(await deferredPinFor({ store: options.store, settings: options.settings, session, run, signal: control.signal })),
          },
          ...completionPin,
        }
      : pinned;
  const startOffered = offeredRecordFor(journal.state.offeredTools, pins.token?.deferred ?? []);
  journal.append([
    { type: 'run.started', attempt: claim.attempt, now: clock.now(), pins: { ...pins }, mode: session.permissionMode },
    ...(startOffered === undefined ? [] : [startOffered]),
  ]);
  const [startedEvent] = store.readRunEvents(run.id, journal.state.lastSeq - (startOffered === undefined ? 1 : 2), 1);
  if (startedEvent === undefined) throw new Error(`run ${run.id} has no event at seq ${journal.state.lastSeq} after its run.started`);
  const laterVerdict = laterVerdictNotice(journal.state, pins.policyVerdict?.fingerprint, startVerdict);
  if (laterVerdict.length > 0) journal.append(laterVerdict);
  const modeWatch = watchMode(store, session.id, startedEvent.id);
  const knownNotes = new Set(journal.state.notes.map((note) => note.message));
  const toolNotices = [...skills.warnings, ...(agentSet?.warnings ?? []), ...toolSet.notices].filter((message) => !knownNotes.has(message));
  if (toolNotices.length > 0) journal.append([...new Set(toolNotices)].map((message) => ({ type: 'notice', level: 'warning', message })));
  for (const server of toolSet.authorizationRequired) {
    const message = `MCP server "${server}" requires authorization before its tools can be listed`;
    if (journal.state.notes.some((note) => note.code === 'mcp_authorization_required' && note.message === message)) continue;
    journal.append([{ type: 'notice', level: 'warning', message, code: 'mcp_authorization_required' }, { type: 'mcp.authorization.required', server }]);
  }

  if (recorded !== undefined) {
    if (!modelChainReaches(options.store, { runId: run.id, sessionId: session.id, pinned: pins.model, current: session.model })) {
      await terminals.finish('FAILED', {
        error: { code: 'pins_mismatch', message: 'the model changed without a recorded model switch since this run started, so it cannot be resumed' },
      });
      return;
    }
    if (pins.systemPromptDigest !== systemPromptDigest) {
      await terminals.finish('FAILED', {
        error: { code: 'pins_mismatch', message: 'the system prompt changed since this run started, so it cannot be resumed' },
      });
      return;
    }
    if (pins.toolSetDigest !== toolSet.digest && !journal.state.notes.some((note) => note.code === 'tools_changed')) {
      journal.append([{ type: 'notice', level: 'warning', message: TOOLS_CHANGED_NOTICE, code: 'tools_changed' }]);
    }
  }

  const pinnedGuideline = guidelineOf(options.store, pins.guidelineVersion);
  const limits = readRunLimits(run.limits, options.defaults);
  const composeRules = await permissionRulesComposerFor(options, session, control.signal);
  const targetFacts = new Map<string, { meter: TokenMeter; capabilities: Capabilities; counter: string }>();
  const counterOf = (target: string): string => {
    const counter = listing.chain.find((member) => member.model === target)?.counter;
    if (counter === undefined) throw new Error(`the gateway lists no counter for the model ${target} that the model ${pins.model} falls back to`);
    return counter;
  };
  const [first, ...fallbackMembers] = listing.chain;
  if (first === undefined) throw new Error(`the gateway lists no chain for the model ${pins.model}`);
  const chainCounter = first.counter;
  const chainMeterCapabilities = withCalibration(pins.capabilities, first.capabilities);
  if (journal.needsWindow()) {
    const windowTargets = [chainMeterCapabilities, ...fallbackMembers.map((member) => member.capabilities)];
    journal.installWindow(await store.journalFacts.inheritedWindow({ runId: run.id, ...inheritanceWindowFor(windowTargets) }, control.signal));
  }
  const displays = displayMapOf(listing.views);
  const token = tokenPolicyOf(pins.token);
  const chainMeter = createTokenMeter({
    counter: { count: (request) => control.recordingRaised(gateway.countTokens({ ...request, momonga: { ...request.momonga, ...EXACT_MODEL } }, { signal: control.signal })) },
    model: pins.model,
    capabilities: chainMeterCapabilities,
    observedCapacity: token.observedCapacity,
  });
  chainMeter.restore(await foldMeterFor(options.store, session.id, chainMeterCapabilities, chainCounter));
  const factsOf = async (target: string): Promise<{ meter: TokenMeter; capabilities: Capabilities; counter: string }> => {
    const known = targetFacts.get(target);
    if (known !== undefined) return known;
    const capabilities = await control.recordingRaised(gateway.capabilities(pins.model, { signal: control.signal, target }));
    const meter = createTokenMeter({
      counter: { count: (request) => control.recordingRaised(gateway.countTokens({ ...request, momonga: { ...request.momonga, target, ...EXACT_MODEL } }, { signal: control.signal })) },
      model: pins.model,
      capabilities,
      observedCapacity: token.observedCapacity,
    });
    const counter = counterOf(target);
    meter.restore(await foldMeterFor(options.store, session.id, capabilities, counter));
    const created = { capabilities, meter, counter };
    targetFacts.set(target, created);
    return created;
  };
  const fallbackMeters = token.observedCapacity
    ? (await Promise.all(fallbackMembers.map((member) => factsOf(member.model)))).map((facts) => facts.meter)
    : [];
  const loading = token.deferred === undefined ? undefined : createToolLoading(() => ctx);
  const offeredSet = loading === undefined ? toolSet : extendToolSet(toolSet, createLoadToolsTool(loading));
  const visibleNow = (): FunctionTool[] =>
    toolLess ? [] : offeredSet.forModel({ mode: session.permissionMode, rules: composeRules(), conciseDescriptions: token.conciseDescriptions });
  const claimVisible = token.cachePrefix ? visibleNow() : undefined;
  const jobRunningNow = (): boolean => options.store.jobs.listForSession(session.id).some((job) => job.status === 'running');
  const childRunLive = (): boolean => options.store.listRuns(session.id, LIVE_RUN_STATUSES).some((live) => live.parentRunId !== null && live.id !== run.id);
  const claimKeepsCompanions = token.cachePrefix ? jobRunningNow() : undefined;
  const keepCompanionsWithoutHost = (): boolean => claimKeepsCompanions ?? jobRunningNow();
  const readersNow = (): Readonly<Record<string, string>> =>
    Object.fromEntries(REFERENCE_KINDS.flatMap((kind) => {
      const name = toolSet.readerOf(kind);
      return name === undefined ? [] : [[kind, name] as const];
    }));
  const offerNow = (loaded: readonly string[] = journal.state.loadedTools): ToolOffer =>
    offerFor({
      toolSet: offeredSet,
      visible: claimVisible === undefined ? visibleNow() : [...claimVisible],
      deferred: token.deferred,
      loaded,
      keepCompanionsWithoutHost: keepCompanionsWithoutHost(),
      required: new Set(readerNamesOf(readersNow(), journal.state)),
    });
  const ctx: ClaimContext = {
    options,
    claim,
    run,
    model: pins.model,
    display: (model) => displays.get(model) ?? model,
    capabilities: pins.capabilities,
    toolLess,
    roles: pins.roles,
    ...(pins.memoryShare === undefined ? {} : { memoryShare: pins.memoryShare }),
    ...(pinnedGuideline === undefined ? {} : { guideline: pinnedGuideline }),
    limits,
    budget: {
      limits: { maxTotalTokens: limits.maxTotalTokens, ...(limits.maxCostNano === undefined ? {} : { maxCostNano: limits.maxCostNano }) },
      quote: (model) => control.recordingRaised(gateway.quote(model, { signal: control.signal })),
      spend: () => options.store.treeSpend(run.id),
      ledger: { admitModelRequest: (ask) => options.store.admitModelRequest(claim, ask) },
      tail: Promise.resolve(),
    },
    ...(delegation === undefined ? {} : { delegation }),
    toolSet: offeredSet,
    ...(loading === undefined ? {} : { toolLoading: loading }),
    skills,
    recalled,
    touched: touchedOf(session, options, control.signal),
    env,
    functionTools: () => offerNow().tools,
    toolOffer: offerNow,
    readers: readersNow,
    windowShared: () => jobRunningNow() || childRunLive(),
    companions: () => ({ hostOf: Object.fromEntries(toolSet.companions), keepWithoutHost: keepCompanionsWithoutHost() }),
    systemPrompt,
    outputFit: meteredOutputFit({ meter: chainMeter, itemCap: async () => (await measurePinnedFor(ctx)).itemCap, harnessTools: new Set(harnessOutputToolsOf(offeredSet.tools)), fence: sessionFenceOf(session) }),
    reconcileFit: reconcileOutputFit(pins.capabilities),
    journal,
    control,
    terminals,
    agentSpan,
    tracer,
    meter: chainMeter,
    fallbackMeters,
    counter: chainCounter,
    calibration: listing.capabilities,
    targetFacts: factsOf,
    pinnedDigest: { value: undefined },
    memory,
    completion: {
      conditions: pins.mandate?.completion.conditions ?? [],
      required: pins.verificationRequired === true,
    },
    verificationCommands: (await options.settings.verification(session, control.signal)).conditions,
    autoCompact: (await options.settings.context(session, control.signal)).autoCompact,
    token,
    policyFingerprint: pins.policyVerdict?.fingerprint,
  };

  const governingFailure = await governingFailureAtStart(ctx);
  if (governingFailure !== undefined) {
    await terminals.finish('FAILED', { error: governingFailure });
    return;
  }
  const compactPin = readCompactPin(run.pins);
  if (compactPin !== undefined) {
    await compactOnly(ctx, compactPin.instructions);
    return;
  }
  if ((await runStartHooks(ctx)) === 'done') return;
  if (responsePending(journal.state)) {
    if ((await decideAfterResponse(ctx)) === 'done') return;
  } else if ((await settleCalls(ctx)) === 'done') {
    return;
  }
  if ((await unknownGate(ctx)) === 'done') return;
  if ((await resumeInFlight(ctx)) === 'done') return;
  for (let flow: Flow = 'continue'; flow === 'continue'; ) {
    if (control.shuttingDown()) {
      await terminals.yieldLease();
      return;
    }
    if (control.cancelRequested()) {
      await terminals.cancel();
      return;
    }
    if (modeWatch.changed()) {
      await terminals.yieldTo('QUEUED', clock.now(), { refundAttempt: true });
      return;
    }
    if ((await unknownGate(ctx)) === 'done') return;
    if ((await settleHeld(ctx)) === 'done') return;
    journal.deliverSteering();
    flow = await runModelStep(ctx);
  }
};
