import { completionMutates } from '@momonga/protocol';
import type { ApprovalBasis, MutationFacts, RunEventPayload, ToolFile } from '@momonga/protocol';
import * as runtime from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { mustClaim } from '../../../store/test/helpers.ts';

const RUN_PINS = {
  model: 'fm',
  systemPromptDigest: 'system-prompt-digest',
  toolSetDigest: 'tool-set-digest',
  capabilities: { contextWindow: 100_000, maxOutputTokens: 4096, parallelToolCalls: false, streaming: true, tokenCounting: 'exact', toolCalling: 'native' },
} as const;

export const exported = <T>(name: string): T => {
  const found = (runtime as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`@momonga/runtime does not export ${name}`);
  return found as T;
};

export const bash = (callId: string, command: string, exitCode: number, output = '', basis: ApprovalBasis = 'read_only'): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'other', title: command, rawInput: { command } },
  { type: 'tool.started', callId, idemKey: `key-${callId}`, basis },
  { type: 'tool.completed', callId, status: 'completed', output, exitCode, command },
] as RunEventPayload[];

export const fileTool = (callId: string, name: string, file: ToolFile, output = ''): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: `${name} ${file.path}`, rawInput: { file_path: file.path } },
  { type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'person' },
  { type: 'tool.completed', callId, status: 'completed', output, files: [file] },
] as RunEventPayload[];

export const conditionIdOf = (command: string): string => `condition:${command}`;

export const checked = (command: string, exitCode: number, output = ''): RunEventPayload[] => [
  { type: 'verification.started', round: 1, conditionId: conditionIdOf(command), command, mutationSeq: 0, attempt: 1 },
  { type: 'verification.completed', round: 1, conditionId: conditionIdOf(command), command, outcome: exitCode === 0 ? 'passed' : 'failed', exitCode, durationMs: 1, output, mutationSeq: 0 },
];

const atTheirMutation = (events: readonly RunEventPayload[], firstSeq: number): RunEventPayload[] => {
  const calls = new Map<string, MutationFacts>();
  let lastMutationSeq = 0;
  return events.map((event, index) => {
    if (event.type === 'tool.call') calls.set(event.callId, { rejected: false, ...(event.sideEffect === undefined ? {} : { sideEffect: event.sideEffect }) });
    if (event.type === 'tool.started' && event.basis !== undefined) {
      const call = calls.get(event.callId);
      if (call !== undefined) call.basis = event.basis;
    }
    if (event.type === 'tool.completed') {
      const call = calls.get(event.callId);
      if (call !== undefined && completionMutates(call, event)) lastMutationSeq = firstSeq + index;
    }
    return event.type === 'verification.started' || event.type === 'verification.completed' ? { ...event, mutationSeq: lastMutationSeq } : event;
  });
};

const declaredBy = (events: readonly RunEventPayload[]) => {
  const commands = [...new Set(events.flatMap((event) => (event.type === 'verification.completed' ? [event.command] : [])))];
  if (commands.length === 0) return {};
  return { mandate: { completion: { conditions: commands.map((command) => ({ id: conditionIdOf(command), command, when: 'after_mutation', source: 'settings' })), requirements: [] } } };
};

export const verdictSeqOf = (events: readonly { type: string; seq: number }[], command: string): number => {
  const found = events.filter((event) => event.type === 'verification.completed' && 'command' in event && event.command === command).at(-1);
  if (found === undefined) throw new Error(`no verification.completed event for ${command}`);
  return found.seq;
};

export const finishClaimed = async (
  store: RuntimeStore,
  events: readonly RunEventPayload[],
  outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED',
  pins: Record<string, unknown> = RUN_PINS,
): Promise<void> => {
  const claim = mustClaim(store, 'w1');
  const before = store.getRun(claim.runId);
  if (before === undefined) throw new Error(`run ${claim.runId} does not exist`);
  const appended = store.append(claim, [
    { type: 'run.started', attempt: claim.attempt, now: 0, pins: { ...pins, ...declaredBy(events) } },
    ...atTheirMutation(events, before.lastSeq + 2),
  ]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const patch = outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {};
  const finished = await store.transition(claim, ['RUNNING'], outcome, patch);
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
};
