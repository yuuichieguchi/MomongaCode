import path from 'node:path';
import { isRecord, jsonValueOrText } from '@momonga/foundation';
import { callInputTracker, completionMutates, conditionOwed, pinnedMandateOf, reconciliationMutates } from '@momonga/protocol';
import type { ConditionResult, MutationFacts, PinnedCompletion, RunEvent, ToolFile } from '@momonga/protocol';

export type VerifiedSuccessInput = {
  status: string;
  events: readonly RunEvent[];
  commands: readonly string[];
  manifests: readonly string[];
};

type CallEvent = Extract<RunEvent, { type: 'tool.call' }>;

type CallFacts = MutationFacts & { kind: string; paths: string[] };

const WRITING_KINDS: readonly string[] = ['edit', 'delete', 'move'];

const runsCommands = (call: CallFacts): boolean => call.sideEffect === 'exec' || call.kind === 'execute';

const pathsNamedBy = (call: CallEvent, input: unknown): string[] => {
  const located = (call.locations ?? []).map((location) => location.path);
  const given = isRecord(input) ? input['file_path'] : undefined;
  return typeof given === 'string' ? [...located, given] : located;
};

const factsOfCall = (call: CallEvent, input: unknown): CallFacts => ({
  kind: call.kind,
  paths: pathsNamedBy(call, input),
  rejected: false,
  ...(call.sideEffect === undefined ? {} : { sideEffect: call.sideEffect }),
});

const declaredPathsOf = (call: CallFacts): string[] | undefined => (WRITING_KINDS.includes(call.kind) ? call.paths : undefined);

const changedPathsOf = (files: readonly ToolFile[]): string[] => files.filter((file) => file.access !== 'read').map((file) => file.path);

const observedPathsOf = (call: CallFacts, event: { files?: ToolFile[]; filesComplete?: boolean }): string[] | undefined => {
  if (event.files === undefined || event.filesComplete === false) return undefined;
  if (event.filesComplete === undefined && runsCommands(call)) return undefined;
  return changedPathsOf(event.files);
};

export type PassingCheck = { command: string; conditionId: string; seq: number };

export type VerifiedSuccessAnalysis = { verified: boolean; passingChecks: PassingCheck[] };

export const VERIFIED_SUCCESS_EVENT_TYPES = [
  'run.started',
  'tool.call',
  'tool.permission.requested',
  'tool.permission.resolved',
  'tool.started',
  'tool.completed',
  'tool.reconciled',
  'verification.completed',
] as const satisfies readonly RunEvent['type'][];

export type VerifiedSuccessFold = {
  add(event: RunEvent): void;
  finish(status: string): VerifiedSuccessAnalysis;
};

export const createVerifiedSuccessFold = (input: Pick<VerifiedSuccessInput, 'commands' | 'manifests'>): VerifiedSuccessFold => {
  const calls = new Map<string, CallFacts>();
  const approvals = new Map<string, { callId: string; rejecting: Set<string> }>();
  const manifests = new Set(input.manifests);
  const results = new Map<string, ConditionResult>();
  let completion: PinnedCompletion | undefined;
  let lastMutationSeq = 0;
  let manifestWritten = false;
  const namesManifest = (paths: readonly string[]): boolean => paths.some((changed) => manifests.has(path.basename(changed)));
  const mutated = (seq: number, call: CallFacts, command: string | undefined, observed: string[] | undefined): void => {
    lastMutationSeq = seq;
    if (observed !== undefined) {
      if (namesManifest(observed)) manifestWritten = true;
      return;
    }
    if (command !== undefined) {
      if (!input.commands.includes(command)) manifestWritten = true;
      return;
    }
    const declared = declaredPathsOf(call);
    if (declared === undefined) {
      if (runsCommands(call)) manifestWritten = true;
      return;
    }
    if (namesManifest(declared)) manifestWritten = true;
  };
  const inputs = callInputTracker(jsonValueOrText);
  const add = (event: RunEvent): void => {
    inputs.observe(event);
    switch (event.type) {
      case 'run.started':
        completion ??= pinnedMandateOf(event.pins)?.completion;
        return;
      case 'tool.call':
        calls.set(event.callId, factsOfCall(event, inputs.inputOf(event)));
        return;
      case 'tool.permission.requested':
        approvals.set(event.approvalId, {
          callId: event.callId,
          rejecting: new Set(event.options.filter((option) => option.kind.startsWith('reject')).map((option) => option.optionId)),
        });
        return;
      case 'tool.permission.resolved': {
        const approval = approvals.get(event.approvalId);
        const call = approval === undefined ? undefined : calls.get(approval.callId);
        if (approval !== undefined && call !== undefined && approval.rejecting.has(event.optionId)) call.rejected = true;
        return;
      }
      case 'tool.started': {
        const call = calls.get(event.callId);
        if (call !== undefined && event.basis !== undefined) call.basis = event.basis;
        return;
      }
      case 'tool.reconciled': {
        const call = calls.get(event.callId);
        if (call !== undefined && reconciliationMutates(call, event.outcome)) mutated(event.seq, call, event.command, observedPathsOf(call, event));
        return;
      }
      case 'tool.completed': {
        const call = calls.get(event.callId);
        if (call !== undefined && completionMutates(call, event)) mutated(event.seq, call, event.command, observedPathsOf(call, event));
        return;
      }
      case 'verification.completed':
        results.set(event.conditionId, { seq: event.seq, outcome: event.outcome, mutationSeq: event.mutationSeq });
        return;
      default:
        return;
    }
  };
  const finish = (status: string): VerifiedSuccessAnalysis => {
    const declared = completion?.conditions ?? [];
    const passes = declared.flatMap((condition) => {
      const result = results.get(condition.id);
      return result?.outcome === 'passed' && result.mutationSeq === lastMutationSeq ? [{ command: condition.command, conditionId: condition.id, seq: result.seq }] : [];
    });
    const noneOwed = declared.every((condition) => !conditionOwed(condition, lastMutationSeq, results.get(condition.id)));
    const verified = status === 'COMPLETED' && !manifestWritten && noneOwed && passes.length > 0;
    const passingChecks = verified ? passes.filter((check) => input.commands.includes(check.command)).sort((left, right) => left.seq - right.seq) : [];
    return { verified, passingChecks };
  };
  return { add, finish };
};

export const analyseVerifiedSuccess = (input: VerifiedSuccessInput): VerifiedSuccessAnalysis => {
  const fold = createVerifiedSuccessFold(input);
  for (const event of input.events) fold.add(event);
  return fold.finish(input.status);
};

export const isVerifiedSuccess = (input: VerifiedSuccessInput): boolean => analyseVerifiedSuccess(input).verified;
