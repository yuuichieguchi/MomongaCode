import { NOT_RUN_REASONS, RESIDUAL_RISK_CODES, completionMutates, conditionOwed, pinnedCompletionOf, reconciliationMutates } from '@momonga/protocol';
import type { ConditionResult, ConditionState, MutationFacts, NotRunReason, PinnedCompletion, ResidualRiskCode, RunEvent, RunReport } from '@momonga/protocol';

type CallRecord = MutationFacts & { command: string | undefined; waitsOnRun: boolean; completedStatus: 'completed' | 'failed' | undefined };

type CheckRecord = { rounds: Set<number>; last: Extract<RunEvent, { type: 'verification.completed' }> | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const commandOf = (call: Extract<RunEvent, { type: 'tool.call' }>): string | undefined => {
  if (call.kind !== 'execute' || !isRecord(call.rawInput)) return undefined;
  const { command } = call.rawInput;
  return typeof command === 'string' ? command : undefined;
};

const isNotRunReason = (value: string): value is NotRunReason => (NOT_RUN_REASONS as readonly string[]).includes(value);

const notRunReasonOf = (status: string, stopReason: string | undefined): NotRunReason => {
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'FAILED') return 'failed';
  if (status === 'STOPPED' && stopReason !== undefined && isNotRunReason(stopReason)) return stopReason;
  return 'unfinished';
};

export const buildRunReport = (events: readonly RunEvent[]): RunReport => {
  const [first] = events;
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) throw new Error('a run report needs at least one event of the run');
  let status = 'QUEUED';
  let stopReason: string | undefined;
  let pins: Record<string, unknown> | undefined;
  let lastMutationSeq = 0;
  let mutatingCalls = 0;
  let unknownPathMutations = 0;
  let unknownEffectCalls = 0;
  let denials = 0;
  let truncatedOutputs = 0;
  const calls = new Map<string, CallRecord>();
  const approvals = new Map<string, { callId: string; rejecting: Set<string> }>();
  const written = new Map<string, { sha256?: string; lastSeq: number }>();
  const checks = new Map<string, CheckRecord>();
  const completedCommands: { command: string; exitCode: number; seq: number }[] = [];

  const recordMutation = (hasKnownPaths: boolean, seq: number): void => {
    lastMutationSeq = seq;
    mutatingCalls += 1;
    if (!hasKnownPaths) unknownPathMutations += 1;
  };
  const requireCall = (callId: string, type: string): CallRecord => {
    const call = calls.get(callId);
    if (call === undefined) throw new Error(`${type} refers to unknown tool call ${callId}`);
    return call;
  };

  for (const event of events) {
    switch (event.type) {
      case 'run.started':
        pins ??= event.pins;
        break;
      case 'run.status':
        status = event.to;
        stopReason = event.to === 'STOPPED' ? event.reason : undefined;
        break;
      case 'tool.call':
        calls.set(event.callId, {
          ...(event.sideEffect === undefined ? {} : { sideEffect: event.sideEffect }),
          rejected: false,
          command: commandOf(event),
          waitsOnRun: false,
          completedStatus: undefined,
        });
        break;
      case 'tool.permission.requested':
        approvals.set(event.approvalId, { callId: event.callId, rejecting: new Set(event.options.filter((option) => option.kind.startsWith('reject')).map((option) => option.optionId)) });
        break;
      case 'tool.permission.resolved': {
        const approval = approvals.get(event.approvalId);
        if (approval !== undefined && approval.rejecting.has(event.optionId)) requireCall(approval.callId, event.type).rejected = true;
        break;
      }
      case 'tool.started': {
        const call = requireCall(event.callId, event.type);
        if (event.basis !== undefined) call.basis = event.basis;
        break;
      }
      case 'tool.waiting':
        if (event.awaits.kind === 'run') requireCall(event.callId, event.type).waitsOnRun = true;
        break;
      case 'tool.completed': {
        const call = requireCall(event.callId, event.type);
        call.completedStatus = event.status;
        if (event.denial !== undefined) denials += 1;
        if (event.truncated === true) truncatedOutputs += 1;
        if (completionMutates(call, event)) {
          const changed = event.files?.filter((file) => file.access !== 'read') ?? [];
          recordMutation(changed.length > 0, event.seq);
          for (const file of changed) written.set(file.path, { ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }), lastSeq: event.seq });
        }
        if (call.command !== undefined && event.status === 'completed' && event.exitCode !== undefined && event.denial === undefined) {
          completedCommands.push({ command: call.command, exitCode: event.exitCode, seq: event.seq });
        }
        break;
      }
      case 'tool.reconciled': {
        const call = requireCall(event.callId, event.type);
        if (event.outcome === 'unknown') unknownEffectCalls += 1;
        if (reconciliationMutates(call, event.outcome)) recordMutation(false, event.seq);
        break;
      }
      case 'verification.completed': {
        const record = checks.get(event.conditionId) ?? { rounds: new Set<number>(), last: undefined };
        record.rounds.add(event.round);
        record.last = event;
        checks.set(event.conditionId, record);
        if (event.truncated === true) truncatedOutputs += 1;
        break;
      }
      default:
        break;
    }
  }

  const completion: PinnedCompletion | undefined = pinnedCompletionOf(pins);
  const declared = completion?.conditions ?? [];
  const requirements = completion?.requirements ?? [];
  const notRun: RunReport['notRun'] = [];
  const conditions: RunReport['conditions'] = declared.map((condition) => {
    const record = checks.get(condition.id);
    const lastCheck = record?.last;
    const result: ConditionResult | undefined =
      lastCheck === undefined ? undefined : { seq: lastCheck.seq, outcome: lastCheck.outcome, mutationSeq: lastCheck.mutationSeq };
    const state = conditionStateOf(condition.when, lastMutationSeq, result);
    if (state === 'not_needed') notRun.push({ what: condition.id, reason: 'not_needed' });
    if (state === 'not_run' || state === 'stale') notRun.push({ what: condition.id, reason: notRunReasonOf(status, stopReason) });
    return {
      id: condition.id,
      command: condition.command,
      state,
      rounds: record?.rounds.size ?? 0,
      ...(lastCheck === undefined
        ? {}
        : {
            last: {
              seq: lastCheck.seq,
              ...(lastCheck.exitCode === undefined ? {} : { exitCode: lastCheck.exitCode }),
              durationMs: lastCheck.durationMs,
              mutationSeq: lastCheck.mutationSeq,
              ...(lastCheck.handle === undefined ? {} : { handle: lastCheck.handle }),
            },
          }),
    };
  });
  for (const requirement of requirements) notRun.push({ what: requirement, reason: 'no_mechanical_check' });

  const declaredCommands = new Set(declared.map((condition) => condition.command));
  const childRunsNotCompleted = [...calls.values()].filter((call) => call.waitsOnRun && call.completedStatus !== 'completed').length;
  const counts: Record<ResidualRiskCode, number> = {
    no_condition_declared_after_mutation: declared.length === 0 ? mutatingCalls : 0,
    mutation_without_known_paths: unknownPathMutations,
    unknown_effect_calls: unknownEffectCalls,
    permission_denials: denials,
    child_runs_not_completed: childRunsNotCompleted,
    output_truncated: truncatedOutputs,
    requirements_unchecked: requirements.length,
  };

  return {
    runId: first.runId,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    durationMs: Math.max(0, last.createdAt - first.createdAt),
    declaration: completion === undefined ? null : { conditions: completion.conditions, requirements: completion.requirements },
    changes: { files: [...written].map(([path, fact]) => ({ path, ...fact })), mutatingCalls },
    conditions,
    notRun,
    residualRisk: RESIDUAL_RISK_CODES.filter((code) => counts[code] > 0).map((code) => ({ code, count: counts[code] })),
    modelChecks: completedCommands.filter((entry) => declaredCommands.has(entry.command)),
  };
};

const conditionStateOf = (when: 'always' | 'after_mutation', lastMutationSeq: number, result: ConditionResult | undefined): ConditionState => {
  if (result === undefined) return conditionOwed({ when }, lastMutationSeq, undefined) ? 'not_run' : 'not_needed';
  if (result.outcome !== 'passed') return result.outcome;
  return result.mutationSeq === lastMutationSeq ? 'passed' : 'stale';
};
