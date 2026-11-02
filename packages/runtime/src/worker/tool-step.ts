import { PinnedOverflowError } from '@momonga/context';
import { parseJsonOrText } from '@momonga/foundation';
import type { PermissionOption, RunEventPayload, RunState } from '@momonga/protocol';
import type { CallOutcome, NeedsApprovalOutcome, ResultOutcome, ToolCall } from '@momonga/tools';
import { validateToolInput } from '@momonga/tools';
import type { Session } from '@momonga/store';
import type { TraceSpan } from '../ports.ts';
import type { ClaimContext, Flow } from './claim-context.ts';
import { pinnedOverflowFailure } from './context-step.ts';
import { ownEntries } from './own-entries.ts';

export const REJECTED_OUTPUT = 'The user rejected this tool call.';

type PendingCall = RunState['pendingCalls'][string];

const callPayload = (ctx: ClaimContext, item: { call_id: string; name: string; arguments: string }): RunEventPayload => {
  const rawInput = parseJsonOrText(item.arguments);
  const tool = ctx.toolSet.get(item.name);
  const validation = tool === undefined ? undefined : validateToolInput(tool, rawInput);
  const input = validation?.ok === true ? validation.value : undefined;
  const locations = tool !== undefined && input !== undefined ? tool.locations?.(input) : undefined;
  return {
    type: 'tool.call',
    callId: item.call_id,
    providerCallId: item.call_id,
    name: item.name,
    kind: tool?.kind ?? 'other',
    title: tool !== undefined && input !== undefined ? tool.title(input) : item.name,
    rawInput,
    ...(locations === undefined ? {} : { locations }),
  };
};

export const recordCalls = (ctx: ClaimContext): void => {
  const { pendingCalls } = ctx.journal.state;
  const payloads: RunEventPayload[] = [];
  for (const { item } of ownEntries(ctx.journal.state)) {
    if (item.type === 'function_call' && pendingCalls[item.call_id] === undefined) payloads.push(callPayload(ctx, item));
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
        }
      : { type: 'tool.reconciled', callId, outcome: outcome.reconciled, output: result.output };
  return [
    settled,
    ...(result.plan === undefined ? [] : [{ type: 'plan.updated' as const, entries: result.plan }]),
    ...(result.skill === undefined ? [] : [{ type: 'skill.activated' as const, name: result.skill.name, content: result.skill.content }]),
  ];
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
      ...(outcome.suggestedRule === undefined ? {} : { suggestedRule: outcome.suggestedRule }),
    },
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
    effect === 'allow' ? [persisted, { type: 'notice', level: 'info', message: `Saved the allow rule ${rule} to the local settings.` }] : [persisted],
  );
};

export const settleCalls = async (ctx: ClaimContext): Promise<Flow> => {
  const { options, journal, run } = ctx;
  recordCalls(ctx);
  const entries = Object.entries(journal.state.pendingCalls);
  if (entries.some(([, call]) => call.status === 'awaiting_approval')) return ctx.terminals.yieldTo('WAITING_HUMAN');
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
    calls.push({ callId, name: call.name, arguments: call.arguments, ...approval });
  }
  if (rejected.length > 0) journal.append(rejected);
  if (calls.length === 0) return 'continue';

  const step = journal.state.step;
  if (ctx.control.yieldRequested()) return ctx.terminals.yieldLease();
  const rules = await options.settings.rules(session);
  const policy = await options.tools.policyFor(session, { env: ctx.env, rules, readableDirectories: ctx.skills.readDirectories });
  const spans = new Map<string, TraceSpan>();
  let outcomes: CallOutcome[];
  try {
    outcomes = await options.tools.executor.runBatch({
      calls,
      toolSet: ctx.toolSet,
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
      deadlineAt: run.deadlineAt,
      signal: ctx.control.signal,
      leaseLost: () => ctx.control.leaseLost() || ctx.control.shuttingDown(),
      inlineLimitForReconcile: ctx.inlineLimitForReconcile,
      inlineLimitForExecution: ctx.inlineLimitForExecution,
      traceparentFor: (callId) => {
        const existing = spans.get(callId);
        if (existing !== undefined) return { traceparent: existing.traceparent };
        const toolName = journal.state.pendingCalls[callId]?.name;
        if (toolName === undefined) throw new Error(`unknown tool call ${callId}`);
        const span = options.tracer.startToolSpan(ctx.agentSpan, { runId: run.id, step, callId, toolName, toolType: 'function' });
        spans.set(callId, span);
        return { traceparent: span.traceparent };
      },
      onOutcome: (outcome) => journal.append(outcomePayloads(outcome)),
      onStarted: (callId, idemKey) => journal.append([{ type: 'tool.started', callId, idemKey }]),
      onUpdate: (callId, content) => journal.append([{ type: 'tool.updated', callId, content }]),
    });
  } catch (error) {
    for (const span of spans.values()) span.end(error);
    if (error instanceof PinnedOverflowError) {
      ctx.terminals.finish('FAILED', { error: pinnedOverflowFailure(ctx, error) });
      return 'done';
    }
    throw error;
  }
  for (const span of spans.values()) span.end();
  if (ctx.control.leaseLost()) ctx.control.lost();
  if (ctx.control.shuttingDown()) return ctx.terminals.yieldLease();

  const asking = outcomes.filter((outcome): outcome is NeedsApprovalOutcome => outcome.kind === 'needs_approval');
  if (asking.length === 0) return 'continue';
  for (const outcome of asking) requestApproval(ctx, outcome);
  return ctx.terminals.yieldTo('WAITING_HUMAN');
};
