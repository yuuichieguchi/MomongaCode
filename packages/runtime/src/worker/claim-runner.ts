import { agentSystemPrompt, readAgentPin } from '@momonga/agents';
import { permissionRulesComposerFor } from '../governance/rules.ts';
import { signalUntil } from '../memory/deadline-signal.ts';
import { createTokenMeter, inheritanceWindowFor, withCalibration } from '@momonga/context';
import type { TokenMeter } from '@momonga/context';
import { computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Capabilities, FunctionTool } from '@momonga/protocol';
import { isFatalStoreError } from '@momonga/store';
import type { Claim } from '@momonga/store';
import type { ClaimContext, Flow, RunMemory, Terminals } from './claim-context.ts';
import { reconcileStartedCalls, releaseWaitingOnCancel } from './cancel-recovery.ts';
import { startClaimControl } from './claim-control.ts';
import type { ClaimControl } from './claim-control.ts';
import { dispositionOf } from './gateway-policy.ts';
import { heartbeatMsFor } from './heartbeat.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import { inlineLimitForItemCap, inlineOutputLimitFor } from './inline-limit.ts';
import { governingFailureAtStart, measurePinnedFor } from './context-step.ts';
import { runStartHooks } from './hook-step.ts';
import { openJournal } from './journal.ts';
import type { Journal } from './journal.ts';
import { readRunLimits } from './limits.ts';
import { decideAfterResponse, responsePending, resumeInFlight, runModelStep } from './model-step.ts';
import { guidelineOf, guidelineVersionFor } from './guideline-pin.ts';
import { memoryShareFor } from './memory-share.ts';
import { watchMode } from './mode-watch.ts';
import { foldMeterFor } from './meter-journal.ts';
import { aliasChainReaches } from './model-switch.ts';
import { readPins } from './pins.ts';
import { rolesFor } from './role-pin.ts';
import { deferredPinFor, tokenPinFor, tokenPolicyOf } from './token-pin.ts';
import type { RunPins } from './pins.ts';
import { createSkillAdmission } from './skill-admission.ts';
import { createTerminals } from './terminals.ts';
import { extendToolSet } from '@momonga/tools';
import { createLoadToolsTool } from './load-tools-tool.ts';
import { createToolLoading } from './tool-admission.ts';
import { offerFor, offeredRecordFor } from './tool-offer.ts';
import type { ToolOffer } from './tool-offer.ts';
import { settleCalls } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';
import type { TraceSpan } from '../ports.ts';
import { modelKey } from '../model-key.ts';
import { REQUEUE_BASE_MS, REQUEUE_MAX_MS } from '../process/constants.ts';
import { buildSystemPrompt } from '../system-prompt.ts';
import { summaryStopReason } from './wrap-up.ts';
import { reportError } from './report.ts';
import { GatewayRequestError } from '../gateway-client.ts';

const DEFAULT_CANCEL_POLL_MS = 250;
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
  journal.append(failures.map((message) => ({ type: 'notice', level: 'warning', message: `Cancelling the upstream model request failed: ${message}`, code: 'upstream_cancel_failed' })));
};

export const runClaim = async (options: WorkerOptions, claim: Claim, host: ClaimHost): Promise<void> => {
  const { store, tracer } = options;
  const control = startClaimControl({
    store,
    timers: options.timers,
    claim,
    heartbeatMs: options.heartbeatMs ?? heartbeatMsFor(options.leaseMs),
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
          journal.append([{ type: 'notice', level: 'error', message: `The run was cancelled after an error: ${describeError(cause)}`, code: 'cancelled_after_error' }]);
        }
        const keys = [control.inFlight.modelKey, control.inFlight.compactionKey].filter((key): key is string => key !== undefined);
        const failures = await cancelUpstream(options, control, keys);
        if (control.shuttingDown()) {
          terminals.yieldLease();
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

const stopRejectedWrapUp = async (options: WorkerOptions, claim: Claim, journal: Journal, terminals: Terminals, cause: unknown): Promise<boolean> => {
  const inFlight = journal.state.inFlightModelRequest;
  if (inFlight === undefined || journal.state.steps[inFlight.step]?.summary !== true) return false;
  if (!(cause instanceof GatewayRequestError)) return false;
  if (cause.status < 400 || cause.status >= 500 || cause.type === 'too_many_requests' || dispositionOf(cause, 0).kind !== 'fail') return false;
  const run = options.store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const { maxSteps } = readRunLimits(run.limits, options.defaults);
  journal.append([
    { type: 'notice', level: 'error', message: `The gateway rejected the final summary request (${cause.code}): ${cause.message}`, code: 'final_summary_rejected' },
  ]);
  await terminals.finish('STOPPED', { stopReason: summaryStopReason(inFlight.step, maxSteps) });
  return true;
};

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
  if (disposition.kind === 'fail') {
    await terminals.finish('FAILED', { error: { code: disposition.code, message: disposition.message } });
    return;
  }
  if (disposition.kind === 'timeout') {
    await terminals.finish('STOPPED', { stopReason: 'timeout' });
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
  const backoff = computeBackoff({ attempt: memory.streak, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: options.random });
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
  terminals.yieldTo('QUEUED', availableAt, refund ? { refundAttempt: true } : undefined);
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
    const inherited = await store.inheritContext(claim, { mode: session.permissionMode, facts: store.journalFacts });
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
      terminals.yieldLease();
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

  const agentPin = readAgentPin(run.pins);
  const basePrompt = (options.systemPrompt ?? buildSystemPrompt)({ cwd: session.cwd, platform: options.platform });
  const systemPrompt = agentPin === undefined ? basePrompt : agentSystemPrompt(basePrompt, agentPin);
  const systemPromptDigest = sha256Hex(systemPrompt);
  const env = tools.envFor(session);
  const skills = await options.skills.load(session);
  const admit = createSkillAdmission(() => ctx);
  const activationTool = skills.activationTool({ isActive: (name) => journal.state.activatedSkills.some((skill) => skill.name === name), admit });
  const recalled = await options.memories.load(session, signalUntil(run.deadlineAt, clock.now(), control.signal));
  const agentSet = run.parentRunId === null && options.agents !== undefined ? await options.agents.load(session) : undefined;
  const agentTool = options.agents === undefined ? undefined : agentSet?.tool(options.agents.runs);
  const toolSet = await tools.toolSet(run.id, {
    signal: control.signal,
    env,
    additionalTools: [activationTool, agentTool, ...recalled.tools, ...options.history.load(session).tools, ...options.governance.load(session).tools].filter(
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
  const recorded = journal.state.pins;
  const newMemoryShare = recorded === undefined ? await memoryShareFor({ store: options.store, settings: options.settings, session, run }) : undefined;
  const newGuidelineVersion = recorded === undefined ? guidelineVersionFor(options.store, run) : undefined;
  const pins: RunPins =
    recorded === undefined
      ? {
          modelAlias: session.modelAlias,
          systemPromptDigest,
          toolSetDigest: toolSet.digest,
          capabilities: await gateway.capabilities(session.modelAlias, { signal: control.signal }),
          roles: rolesFor({ store: options.store, settings: options.settings, run }),
          ...(newMemoryShare === undefined ? {} : { memoryShare: newMemoryShare }),
          ...(newGuidelineVersion === undefined ? {} : { guidelineVersion: newGuidelineVersion }),
          token: {
            ...(await tokenPinFor({ store: options.store, settings: options.settings, session, run })),
            ...(await deferredPinFor({ store: options.store, settings: options.settings, session, run })),
          },
        }
      : readPins(recorded);
  const startOffered = offeredRecordFor(journal.state.offeredTools, pins.token?.deferred ?? []);
  journal.append([
    { type: 'run.started', attempt: claim.attempt, now: clock.now(), pins: { ...pins }, mode: session.permissionMode },
    ...(startOffered === undefined ? [] : [startOffered]),
  ]);
  const [startedEvent] = store.readRunEvents(run.id, journal.state.lastSeq - (startOffered === undefined ? 1 : 2), 1);
  if (startedEvent === undefined) throw new Error(`run ${run.id} has no event at seq ${journal.state.lastSeq} after its run.started`);
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
    if (!aliasChainReaches(options.store, { runId: run.id, sessionId: session.id, pinned: pins.modelAlias, current: session.modelAlias })) {
      await terminals.finish('FAILED', {
        error: { code: 'pins_mismatch', message: 'the model alias changed without a recorded model switch since this run started, so it cannot be resumed' },
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
  const composeRules = await permissionRulesComposerFor(options, session);
  let measuredInlineLimit: Promise<number> | undefined;
  const targetFacts = new Map<string, { meter: TokenMeter; capabilities: Capabilities; counter: string }>();
  const listing = await control.recordingRaised(gateway.model(pins.modelAlias, { signal: control.signal }));
  const counterOf = (target: string): string => {
    const counter = listing.targetCounters[target];
    if (counter === undefined) throw new Error(`the gateway lists no counter for the target ${target} of the model ${pins.modelAlias}`);
    return counter;
  };
  const [firstTarget] = listing.targets;
  const firstCapabilities = firstTarget === undefined ? undefined : listing.targetCapabilities[firstTarget];
  if (firstTarget === undefined || firstCapabilities === undefined) throw new Error(`the gateway lists no target for the model ${pins.modelAlias}`);
  const aliasCounter = counterOf(firstTarget);
  const aliasMeterCapabilities = withCalibration(pins.capabilities, firstCapabilities);
  if (journal.needsWindow()) {
    const targetCapabilitiesOf = (target: string): Capabilities => {
      const capabilities = listing.targetCapabilities[target];
      if (capabilities === undefined) throw new Error(`the gateway lists no capabilities for the target ${target} of the model ${pins.modelAlias}`);
      return capabilities;
    };
    const windowTargets = [aliasMeterCapabilities, ...listing.targets.slice(1).map(targetCapabilitiesOf)];
    journal.installWindow(await store.journalFacts.inheritedWindow({ runId: run.id, ...inheritanceWindowFor(windowTargets) }, control.signal));
  }
  const token = tokenPolicyOf(pins.token);
  const aliasMeter = createTokenMeter({
    counter: { count: (request) => control.recordingRaised(gateway.countTokens(request, { signal: control.signal })) },
    model: pins.modelAlias,
    capabilities: aliasMeterCapabilities,
    observedCapacity: token.observedCapacity,
  });
  aliasMeter.restore(foldMeterFor(options.store, session.id, aliasMeterCapabilities, aliasCounter));
  const factsOf = async (target: string): Promise<{ meter: TokenMeter; capabilities: Capabilities; counter: string }> => {
    const known = targetFacts.get(target);
    if (known !== undefined) return known;
    const capabilities = await control.recordingRaised(gateway.capabilities(pins.modelAlias, { signal: control.signal, target }));
    const meter = createTokenMeter({
      counter: { count: (request) => control.recordingRaised(gateway.countTokens({ ...request, momonga: { ...request.momonga, target } }, { signal: control.signal })) },
      model: pins.modelAlias,
      capabilities,
      observedCapacity: token.observedCapacity,
    });
    const counter = counterOf(target);
    meter.restore(foldMeterFor(options.store, session.id, capabilities, counter));
    const created = { capabilities, meter, counter };
    targetFacts.set(target, created);
    return created;
  };
  const fallbackMeters = token.observedCapacity
    ? (await Promise.all(listing.targets.filter((target) => target !== firstTarget).map(factsOf))).map((facts) => facts.meter)
    : [];
  const visibleNow = (): FunctionTool[] =>
    toolSet.forModel({ mode: session.permissionMode, rules: composeRules(), conciseDescriptions: token.conciseDescriptions });
  const claimVisible = token.cachePrefix ? visibleNow() : undefined;
  const jobRunningNow = (): boolean => options.store.jobs.listForSession(session.id).some((job) => job.status === 'running');
  const claimKeepsCompanions = token.cachePrefix ? jobRunningNow() : undefined;
  const keepCompanionsWithoutHost = (): boolean => claimKeepsCompanions ?? jobRunningNow();
  const loading = token.deferred === undefined ? undefined : createToolLoading(() => ctx);
  const offerNow = (loaded: readonly string[] = journal.state.loadedTools): ToolOffer =>
    offerFor({
      toolSet,
      visible: claimVisible === undefined ? visibleNow() : [...claimVisible],
      deferred: token.deferred,
      loaded,
      keepCompanionsWithoutHost: keepCompanionsWithoutHost(),
    });
  const ctx: ClaimContext = {
    options,
    claim,
    run,
    alias: pins.modelAlias,
    capabilities: pins.capabilities,
    roles: pins.roles,
    ...(pins.memoryShare === undefined ? {} : { memoryShare: pins.memoryShare }),
    ...(pinnedGuideline === undefined ? {} : { guideline: pinnedGuideline }),
    limits,
    toolSet: loading === undefined ? toolSet : extendToolSet(toolSet, createLoadToolsTool(loading)),
    ...(loading === undefined ? {} : { toolLoading: loading }),
    skills,
    recalled,
    usedMemoryIds: new Set<string>(),
    env,
    functionTools: () => offerNow().tools,
    toolOffer: offerNow,
    companions: () => ({ hostOf: Object.fromEntries(toolSet.companions), keepWithoutHost: keepCompanionsWithoutHost() }),
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
    meter: aliasMeter,
    fallbackMeters,
    counter: aliasCounter,
    calibration: listing.capabilities,
    targetFacts: factsOf,
    pinnedDigest: { value: undefined },
    memory,
    verificationCommands: (await options.settings.verification(session)).commands,
    autoCompact: (await options.settings.context(session)).autoCompact,
    token,
  };

  const governingFailure = await governingFailureAtStart(ctx);
  if (governingFailure !== undefined) {
    await terminals.finish('FAILED', { error: governingFailure });
    return;
  }
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
      await terminals.cancel();
      return;
    }
    if (modeWatch.changed()) {
      terminals.yieldTo('QUEUED', clock.now(), { refundAttempt: true });
      return;
    }
    flow = await runModelStep(ctx);
  }
};
