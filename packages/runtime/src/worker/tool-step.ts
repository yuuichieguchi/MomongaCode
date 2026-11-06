import { PinnedOverflowError, formatToolOutput, formattedHeader, readersOffered } from '@momonga/context';
import { canonicalJson, parseJsonOrText } from '@momonga/foundation';
import { termsOf } from '@momonga/protocol';
import type { PermissionOption, RunEventPayload, RunState, ToolAwait } from '@momonga/protocol';
import type { BatchOutputFormatter, CallOutcome, DisplayContext, NeedsApprovalOutcome, NeedsInputOutcome, ResultOutcome, ToolCall, WaitingOutcome } from '@momonga/tools';
import { TOOL_VALIDATOR_FAILED_CODE, toolRefusalKey, validateToolInput } from '@momonga/tools';
import type { RuntimeStore, Session } from '@momonga/store';
import { createToolHooks } from '@momonga/tools';
import { permissionRulesFor } from '../governance/rules.ts';
import { createAutoClassifier } from './auto-classifier.ts';
import { haltRun, hookRunContextFor } from './hook-step.ts';
import type { TraceSpan } from '../ports.ts';
import type { ClaimContext, Flow } from './claim-context.ts';
import { pinnedFailureFor, taskOf } from './context-step.ts';
import { ownEntries } from './own-entries.ts';
import { offeredInBody } from './tool-offer.ts';
import type { OfferedInBody } from './tool-offer.ts';

export const REJECTED_OUTPUT = 'The user rejected this tool call.';

type PendingCall = RunState['pendingCalls'][string];

const toolRefusedInJournal = (ctx: ClaimContext, toolKey: string): boolean =>
  ctx.journal.state.notes.some((note) => note.code === TOOL_VALIDATOR_FAILED_CODE && note.toolKey === toolKey);

const callPayload = (ctx: ClaimContext, display: DisplayContext, item: { call_id: string; name: string; arguments: string }): RunEventPayload => {
  const rawInput = parseJsonOrText(item.arguments);
  const tool = ctx.toolSet.get(item.name);
  const validation = tool === undefined || toolRefusedInJournal(ctx, toolRefusalKey(tool)) ? undefined : validateToolInput(tool, rawInput);
  const input = validation?.ok === true ? validation.value : undefined;
  const locations = tool !== undefined && input !== undefined ? tool.locations?.(input, display) : undefined;
  return {
    type: 'tool.call',
    callId: item.call_id,
    providerCallId: item.call_id,
    name: item.name,
    kind: tool?.kind ?? 'other',
    ...(tool === undefined ? {} : { sideEffect: tool.sideEffect }),
    title: tool !== undefined && input !== undefined ? tool.title(input, display) : item.name,
    rawInput,
    ...(locations === undefined ? {} : { locations }),
  };
};

export const recordCalls = (ctx: ClaimContext, leading: readonly RunEventPayload[] = []): void => {
  const { pendingCalls } = ctx.journal.state;
  const payloads: RunEventPayload[] = [...leading];
  const session = ctx.options.store.getSession(ctx.run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${ctx.run.sessionId}`);
  const display = ctx.options.tools.sessionState(session);
  for (const { item } of ownEntries(ctx.journal.state)) {
    if (item.type === 'function_call' && pendingCalls[item.call_id] === undefined) payloads.push(callPayload(ctx, display, item));
  }
  if (payloads.length > 0) ctx.journal.append(payloads);
};

export const outcomePayloads = (outcome: ResultOutcome): RunEventPayload[] => {
  const { callId, result } = outcome;
  const settled: RunEventPayload =
    outcome.reconciled === undefined || outcome.reconciled === 'not_applied'
      ? {
          type: 'tool.completed',
          callId,
          status: result.status,
          output: result.output,
          ...(result.content === undefined ? {} : { content: result.content }),
          ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
          ...(result.handle === undefined ? {} : { handle: result.handle }),
          ...(result.formatted === undefined ? {} : { formatted: result.formatted }),
          ...(result.denial === undefined ? {} : { denial: result.denial }),
          ...(result.files === undefined ? {} : { files: result.files }),
          ...(result.command === undefined ? {} : { command: result.command }),
          ...(result.windowShared === undefined ? {} : { windowShared: result.windowShared }),
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        }
      : {
          type: 'tool.reconciled',
          callId,
          outcome: outcome.reconciled,
          output: result.output,
          ...(result.files === undefined ? {} : { files: result.files }),
          ...(result.command === undefined ? {} : { command: result.command }),
        };
  return [
    settled,
    ...(result.plan === undefined ? [] : [{ type: 'plan.updated' as const, entries: result.plan }]),
    ...(result.skill === undefined ? [] : [{ type: 'skill.activated' as const, name: result.skill.name, content: result.skill.content }]),
    ...(result.toolsLoaded === undefined ? [] : [{ type: 'tool.loaded' as const, names: result.toolsLoaded }]),
    ...(result.authorizationRequired === undefined
      ? []
      : [{ type: 'mcp.authorization.required' as const, callId, server: result.authorizationRequired.server }]),
  ];
};

const batchFormatterOf = (ctx: ClaimContext): BatchOutputFormatter | undefined => {
  const enabled = ctx.token.outputFormatters;
  if (enabled.length === 0) return undefined;
  const terms = termsOf(taskOf(ctx).text);
  return ({ output, status, tool }) => {
    const reader = readersOffered(ctx.readers(), ctx.functionTools())['output_handle'];
    const formatted = formatToolOutput({ output, status, tool, enabled, terms, reader });
    return formatted === undefined ? undefined : { ...formatted, header: (handle) => formattedHeader(formatted.formatter, handle, reader) };
  };
};

export const offeredOfRequest = (store: Pick<RuntimeStore, 'readLatestRunEventBefore'>, runId: string, lastSeq: number): OfferedInBody => {
  const requested = store.readLatestRunEventBefore(runId, 'model.requested', lastSeq + 1);
  if (requested === undefined || requested.type !== 'model.requested') throw new Error(`run ${runId} has tool calls but no recorded model.requested before seq ${lastSeq}`);
  return offeredInBody(runId, requested.body);
};

const approvalOptions = (suggestedRule: string | undefined): PermissionOption[] => [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  ...(suggestedRule === undefined ? [] : [{ optionId: 'allow_always', name: `Always allow ${suggestedRule}`, kind: 'allow_always' } as const]),
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ...(suggestedRule === undefined ? [] : [{ optionId: 'reject_always', name: `Always reject ${suggestedRule}`, kind: 'reject_always' } as const]),
];

const requireSuggestedRule = (callId: string, call: PendingCall): string => {
  const rule = call.resolution?.suggestedRule;
  if (rule === undefined) throw new Error(`call ${callId} was resolved with an always option but carries no suggested rule`);
  return rule;
};

const requestApproval = (ctx: ClaimContext, outcome: NeedsApprovalOutcome): void => {
  const { options, journal } = ctx;
  const created = options.store.requestApproval(ctx.claim, {
    callId: outcome.callId,
    options: approvalOptions(outcome.suggestedRule),
    expiresAt: Math.min(options.clock.now() + ctx.limits.approvalTtlMs, ctx.run.deadlineAt),
    event: {
      subjectDigest: outcome.subjectDigest,
      reason: outcome.decision.reason,
      ...(outcome.suggestedRule === undefined ? {} : { suggestedRule: outcome.suggestedRule }),
    },
  });
  if (created.kind === 'lease_lost') ctx.control.lost();
  journal.sync();
};

const requestInput = (ctx: ClaimContext, outcome: NeedsInputOutcome): void => {
  const { options, journal } = ctx;
  const created = options.store.requestElicitation(ctx.claim, {
    callId: outcome.callId,
    expiresAt: Math.min(options.clock.now() + ctx.limits.approvalTtlMs, ctx.run.deadlineAt),
    server: outcome.server,
    requests: outcome.requests,
  });
  if (created.kind === 'lease_lost') ctx.control.lost();
  journal.sync();
};

const persistRule = async (
  ctx: ClaimContext,
  session: Session,
  callId: string,
  call: PendingCall,
  effect: 'allow' | 'deny',
): Promise<void> => {
  const { options, journal } = ctx;
  const { approvalId, resolution } = call;
  if (approvalId === undefined || resolution === undefined) throw new Error(`call ${callId} persists a rule without a resolved approval`);
  if (resolution.rulePersisted === true) return;
  const rule = requireSuggestedRule(callId, call);
  journal.verifyLease();
  await options.settings.appendRule(session, { effect, rule });
  const persisted: RunEventPayload = { type: 'approval.rule.persisted', approvalId, effect, rule };
  journal.append(
    effect === 'allow' ? [persisted, { type: 'notice', level: 'info', message: `Saved the allow rule ${rule} to the local settings.`, code: 'allow_rule_saved' }] : [persisted],
  );
};

const recordToolContent = (spans: ReadonlyMap<string, TraceSpan>, calls: readonly ToolCall[], outcome: ResultOutcome): void => {
  const call = calls.find((candidate) => candidate.callId === outcome.callId);
  if (call === undefined) return;
  spans.get(outcome.callId)?.recordToolContent({
    arguments: typeof call.arguments === 'string' ? parseJsonOrText(call.arguments) : call.arguments,
    result: outcome.result.output,
  });
};

export const settleCalls = async (ctx: ClaimContext): Promise<Flow> => {
  const { options, journal, run } = ctx;
  recordCalls(ctx);
  const entries = Object.entries(journal.state.pendingCalls);
  if (entries.some(([, call]) => call.status === 'awaiting_approval' || call.status === 'awaiting_input')) return ctx.terminals.yieldTo('WAITING_HUMAN');
  const runnable = entries.filter(([, call]) => call.status === 'requested' || call.status === 'started');
  if (runnable.length === 0) return 'continue';

  const session = options.store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${run.sessionId}`);

  const calls: ToolCall[] = [];
  const rejected: RunEventPayload[] = [];
  for (const [callId, call] of runnable) {
    const resolution = call.resolution;
    if (resolution?.kind === 'reject_once' || resolution?.kind === 'reject_always') {
      if (resolution.kind === 'reject_always') await persistRule(ctx, session, callId, call, 'deny');
      rejected.push({ type: 'tool.completed', callId, status: 'failed', output: REJECTED_OUTPUT });
      continue;
    }
    if (resolution?.kind === 'allow_always' && call.status === 'requested') await persistRule(ctx, session, callId, call, 'allow');
    const approval =
      resolution?.kind === 'allow_once' || resolution?.kind === 'allow_always'
        ? { approval: { kind: resolution.kind, subjectDigest: resolution.subjectDigest } }
        : {};
    const inputResponses = call.inputResolution === undefined ? {} : { inputResponses: call.inputResolution.responses };
    calls.push({ callId, name: call.name, arguments: call.arguments, ...approval, ...inputResponses });
  }
  if (rejected.length > 0) journal.append(rejected);
  if (calls.length === 0) return 'continue';

  const step = journal.state.step;
  if (ctx.control.yieldRequested()) return ctx.terminals.yieldLease();
  const rules = await permissionRulesFor(options, session);
  const policy = await options.tools.policyFor(session, { env: ctx.env, rules, readableDirectories: ctx.skills.readDirectories });
  const hookSettings = await options.settings.hooks(session);
  const hasToolHooks = hookSettings.PreToolUse !== undefined || hookSettings.PostToolUse !== undefined;
  const toolHooks = hasToolHooks
    ? createToolHooks(
        hookRunContextFor(ctx, session, hookSettings, policy, (execution) => journal.append([{ type: 'hook.completed', ...execution }])),
      )
    : undefined;
  const classifier = session.permissionMode === 'auto' ? createAutoClassifier(ctx, options.tools.sessionState(session).cwd, step) : undefined;
  const spans = new Map<string, TraceSpan>();
  const halt: { reason?: string; hookEvent?: string } = {};
  const formatOutput = batchFormatterOf(ctx);
  const offered = offeredOfRequest(options.store, run.id, journal.state.lastSeq);
  let outcomes: CallOutcome[];
  try {
    outcomes = await options.tools.executor.runBatch({
      calls,
      toolSet: ctx.toolSet,
      offered,
      fence: ctx.claim,
      runId: run.id,
      step,
      mode: session.permissionMode,
      rules,
      home: options.home,
      roots: policy.roots,
      readRoots: ctx.skills.readDirectories,
      tmpDir: policy.tmpDir,
      env: policy.env,
      session: options.tools.sessionState(session),
      sandbox: options.tools.sandbox,
      sandboxPolicy: policy.sandboxPolicy,
      workTreeObserver: options.tools.workTreeObserver(session, options.settings.trusted(session)),
      windowShared: ctx.windowShared,
      deadlineAt: run.deadlineAt,
      signal: ctx.control.signal,
      ...(toolHooks === undefined ? {} : { hooks: toolHooks }),
      ...(classifier === undefined ? {} : { classifier }),
      ...(formatOutput === undefined ? {} : { formatOutput }),
      onHalt: (reason, hookEvent) => {
        halt.reason = reason;
        halt.hookEvent = hookEvent;
      },
      leaseLost: () => ctx.control.leaseLost() || ctx.control.shuttingDown(),
      onLeaseLost: ctx.control.noteLeaseLost,
      outputFit: ctx.outputFit,
      reconcileFit: ctx.reconcileFit,
      traceparentFor: (callId) => {
        const existing = spans.get(callId);
        if (existing !== undefined) return { traceparent: existing.traceparent };
        const toolName = journal.state.pendingCalls[callId]?.name;
        if (toolName === undefined) throw new Error(`unknown tool call ${callId}`);
        const span = options.tracer.startToolSpan(ctx.agentSpan, { runId: run.id, step, callId, toolName, toolType: 'function' });
        spans.set(callId, span);
        return { traceparent: span.traceparent };
      },
      onOutcome: (outcome) => {
        journal.append(outcomePayloads(outcome));
        if (outcome.result.toolsLoaded !== undefined) ctx.toolLoading?.rememberLoaded(outcome.result.toolsLoaded);
        recordToolContent(spans, calls, outcome);
      },
      toolUnavailable: (toolKey) => toolRefusedInJournal(ctx, toolKey),
      onWarning: (message, toolKey) => journal.append([{ type: 'notice', level: 'warning', message, code: TOOL_VALIDATOR_FAILED_CODE, toolKey }]),
      onStarted: (callId, idemKey, basis) => journal.append([{ type: 'tool.started', callId, idemKey, basis }]),
      onUpdate: (callId, content) => journal.append([{ type: 'tool.updated', callId, content }]),
    });
  } catch (error) {
    for (const span of spans.values()) span.end(error);
    if (error instanceof PinnedOverflowError) {
      await ctx.terminals.finish('FAILED', { error: pinnedFailureFor(ctx, error) });
      return 'done';
    }
    throw error;
  }
  for (const span of spans.values()) span.end();
  if (ctx.control.leaseLost()) ctx.control.lost();
  if (ctx.control.shuttingDown()) return ctx.terminals.yieldLease();

  if (halt.hookEvent !== undefined) return haltRun(ctx, halt.hookEvent, halt.reason);

  const asking = outcomes.filter((outcome): outcome is NeedsApprovalOutcome => outcome.kind === 'needs_approval');
  const inputs = outcomes.filter((outcome): outcome is NeedsInputOutcome => outcome.kind === 'needs_input');
  if (asking.length > 0 || inputs.length > 0) {
    for (const outcome of asking) requestApproval(ctx, outcome);
    for (const outcome of inputs) requestInput(ctx, outcome);
    return ctx.terminals.yieldTo('WAITING_HUMAN');
  }
  const waiting = outcomes.filter((outcome): outcome is WaitingOutcome => outcome.kind === 'waiting');
  if (waiting.length === 0) return 'continue';
  return yieldForTools(ctx, waiting);
};

const sameAwait = (left: ToolAwait | undefined, right: ToolAwait): boolean => left !== undefined && canonicalJson(left) === canonicalJson(right);

const yieldForTools = (ctx: ClaimContext, waiting: readonly WaitingOutcome[]): Flow => {
  const fresh = waiting.filter((outcome) => !sameAwait(ctx.journal.state.pendingCalls[outcome.callId]?.awaiting, outcome.awaits));
  if (fresh.length > 0) {
    ctx.journal.append(
      fresh.map((outcome): RunEventPayload => ({
        type: 'tool.waiting',
        callId: outcome.callId,
        awaits: outcome.awaits,
        ...(outcome.wakeAt === undefined ? {} : { wakeAt: outcome.wakeAt }),
      })),
    );
  }
  const wakeAt = Math.min(ctx.run.deadlineAt, ...waiting.map((outcome) => outcome.wakeAt ?? ctx.run.deadlineAt));
  const runIds = waiting.flatMap((outcome) => (outcome.awaits.kind === 'run' ? [outcome.awaits.runId] : []));
  const jobIds = waiting.flatMap((outcome) => (outcome.awaits.kind === 'job' ? [outcome.awaits.jobId] : []));
  return ctx.terminals.yieldTo('WAITING_TOOL', wakeAt, { refundAttempt: true, awaits: { runIds, jobIds } });
};
