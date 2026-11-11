import { NOT_RUN_REASONS, RESIDUAL_RISK_CODES, completionMutates, conditionOwed, heldEndOf, pinnedCompletionOf, reconciliationMutates } from '@momonga/protocol';
import type {
  BudgetExhausted,
  ConditionResult,
  ConditionState,
  MutationFacts,
  NotRunReason,
  PinnedCompletion,
  ReportAnomalyCause,
  ResidualRiskCode,
  OperationEffectRecord,
  RunBudgetReport,
  RunDeniedCallReport,
  RunFailedCallReport,
  RunOperationReport,
  RunEvent,
  RunEventPayload,
  RunHeldCallReport,
  RunReport,
  RunReportAnomaly,
} from '@momonga/protocol';

type CallRecord = MutationFacts & { name: string; waitsOnRun: boolean; completedStatus: 'completed' | 'failed' | undefined };

type CheckRecord = { rounds: Set<number>; last: Extract<RunEvent, { type: 'verification.completed' }> | undefined };

const isNotRunReason = (value: string): value is NotRunReason => (NOT_RUN_REASONS as readonly string[]).includes(value);

const notRunReasonOf = (status: string, stopReason: string | undefined): NotRunReason => {
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'FAILED') return 'failed';
  if (status === 'STOPPED' && stopReason !== undefined && isNotRunReason(stopReason)) return stopReason;
  return 'unfinished';
};

export const RUN_REPORT_EVENT_TYPES = [
  'run.started',
  'run.status',
  'tool.call',
  'tool.permission.requested',
  'tool.permission.resolved',
  'tool.started',
  'tool.waiting',
  'tool.completed',
  'tool.reconciled',
  'verification.completed',
  'budget.exhausted',
  'tool.held',
  'tool.held.resolved',
  'run.quiescent',
] as const satisfies readonly RunEventPayload['type'][];

export type RunReportSpan = { runId: string; firstCreatedAt: number; lastCreatedAt: number; budget?: RunBudgetReport };

export type RunReportFold = {
  add(event: RunEvent): void;
  finish(span: RunReportSpan): RunReport;
};

export const createRunReportFold = (): RunReportFold => {
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
  const held = new Map<string, RunHeldCallReport>();
  const denied: RunDeniedCallReport[] = [];
  let stoppedBy: BudgetExhausted | undefined;
  let quiescent = false;
  const operations = new Map<string, RunOperationReport>();
  const failedCalls: RunFailedCallReport[] = [];
  const anomalies: RunReportAnomaly[] = [];

  const anomaly = (event: RunEvent, callId: string, cause: ReportAnomalyCause): undefined => {
    anomalies.push({ seq: event.seq, type: event.type, callId, cause });
    return undefined;
  };

  const recordEffect = (callId: string, effect: OperationEffectRecord | undefined): void => {
    if (effect !== undefined) operations.set(callId, { callId, operation: effect.operation, target: effect.target, effect: effect.outcome });
  };

  const recordMutation = (hasKnownPaths: boolean, seq: number): void => {
    lastMutationSeq = seq;
    mutatingCalls += 1;
    if (!hasKnownPaths) unknownPathMutations += 1;
  };
  const knownCall = (event: RunEvent, callId: string): CallRecord | undefined => calls.get(callId) ?? anomaly(event, callId, 'unknown_call');

  const endHold = (event: RunEvent): void => {
    const ended = heldEndOf(event);
    if (ended === undefined) return;
    const open = held.get(ended.callId);
    if (open === undefined) {
      anomaly(event, ended.callId, 'not_held');
      return;
    }
    held.set(ended.callId, { ...open, outcome: ended.outcome, status: ended.status, resolvedSeq: event.seq });
  };

  const add = (event: RunEvent): void => {
    endHold(event);
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
          name: event.name,
          waitsOnRun: false,
          completedStatus: undefined,
        });
        break;
      case 'tool.permission.requested':
        approvals.set(event.approvalId, { callId: event.callId, rejecting: new Set(event.options.filter((option) => option.kind.startsWith('reject')).map((option) => option.optionId)) });
        break;
      case 'tool.permission.resolved': {
        const approval = approvals.get(event.approvalId);
        if (approval === undefined || !approval.rejecting.has(event.optionId)) break;
        const call = knownCall(event, approval.callId);
        if (call !== undefined) call.rejected = true;
        break;
      }
      case 'tool.started': {
        const call = knownCall(event, event.callId);
        if (call !== undefined && event.basis !== undefined) call.basis = event.basis;
        break;
      }
      case 'tool.waiting': {
        if (event.awaits.kind !== 'run') break;
        const call = knownCall(event, event.callId);
        if (call !== undefined) call.waitsOnRun = true;
        break;
      }
      case 'tool.completed': {
        const call = knownCall(event, event.callId);
        if (call === undefined) break;
        call.completedStatus = event.status;
        if (event.status === 'failed' && event.denial === undefined) failedCalls.push({ callId: event.callId, tool: call.name, seq: event.seq });
        if (event.denial !== undefined) denials += 1;
        if (event.denial?.source === 'mandate' || event.denial?.source === 'held') denied.push({ callId: event.callId, tool: call.name, source: event.denial.source, reason: event.denial.reason });
        if (event.truncated === true) truncatedOutputs += 1;
        recordEffect(event.callId, event.effect);
        if (completionMutates(call, event)) {
          const changed = event.files?.filter((file) => file.access !== 'read') ?? [];
          recordMutation(changed.length > 0, event.seq);
          for (const file of changed) written.set(file.path, { ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }), lastSeq: event.seq });
        }
        if (event.command !== undefined && event.status === 'completed' && event.exitCode !== undefined && event.denial === undefined) {
          completedCommands.push({ command: event.command, exitCode: event.exitCode, seq: event.seq });
        }
        break;
      }
      case 'tool.reconciled': {
        const call = knownCall(event, event.callId);
        if (call === undefined) break;
        recordEffect(event.callId, event.effect);
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
      case 'budget.exhausted':
        stoppedBy = { dimension: event.dimension, cause: event.cause, spent: event.spent, limit: event.limit };
        break;
      case 'tool.held': {
        const call = knownCall(event, event.callId);
        if (call !== undefined) held.set(event.callId, { callId: event.callId, tool: call.name, reason: event.reason, heldSeq: event.seq });
        break;
      }
      case 'run.quiescent':
        quiescent = true;
        break;
      default:
        break;
    }
  };

  const finish = (span: RunReportSpan): RunReport => {
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
      runId: span.runId,
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      durationMs: Math.max(0, span.lastCreatedAt - span.firstCreatedAt),
      declaration: completion === undefined ? null : { conditions: completion.conditions, requirements: completion.requirements },
      changes: { files: [...written].map(([path, fact]) => ({ path, ...fact })), mutatingCalls },
      conditions,
      notRun,
      residualRisk: RESIDUAL_RISK_CODES.filter((code) => counts[code] > 0).map((code) => ({ code, count: counts[code] })),
      modelChecks: completedCommands.filter((entry) => declaredCommands.has(entry.command)),
      ...(span.budget === undefined ? {} : { budget: span.budget }),
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
      ...(held.size === 0 && denied.length === 0 && !quiescent ? {} : { delegation: { held: [...held.values()], denied, quiescent } }),
      ...(operations.size === 0 ? {} : { operations: [...operations.values()] }),
      ...(failedCalls.length === 0 ? {} : { failedCalls: [...failedCalls] }),
      ...(anomalies.length === 0 ? {} : { anomalies: [...anomalies] }),
    };
  };

  return { add, finish };
};

export const buildRunReport = (events: readonly RunEvent[]): RunReport => {
  const [first] = events;
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) throw new Error('a run report needs at least one event of the run');
  const fold = createRunReportFold();
  for (const event of events) fold.add(event);
  return fold.finish({ runId: first.runId, firstCreatedAt: first.createdAt, lastCreatedAt: last.createdAt });
};

const conditionStateOf = (when: 'always' | 'after_mutation', lastMutationSeq: number, result: ConditionResult | undefined): ConditionState => {
  if (result === undefined) return conditionOwed({ when }, lastMutationSeq, undefined) ? 'not_run' : 'not_needed';
  if (result.outcome !== 'passed') return result.outcome;
  return result.mutationSeq === lastMutationSeq ? 'passed' : 'stale';
};
