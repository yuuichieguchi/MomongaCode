import { sha256Hex } from '@momonga/foundation';
import type { RunEventPayload, RunStatus, SummaryFidelity, SummarySource } from '@momonga/protocol';
import { fixtureCompactionItem } from '@momonga/testkit';
import type { Transcript } from '@momonga/eval';
import { publicEventsOf } from './fixtures.ts';

export const compacted = (replacedThroughSeq: number, source?: SummarySource, fidelity?: SummaryFidelity): RunEventPayload => ({
  type: 'context.compacted',
  item: fixtureCompactionItem(`cmp-${replacedThroughSeq}`, 'summary'),
  summary: 'summary',
  replacedThroughSeq,
  ...(source === undefined ? {} : { source }),
  ...(fidelity === undefined ? {} : { fidelity }),
});

export const fidelity = (fabricated: string[], identifiers: number, retained: number): SummaryFidelity => ({ fabricated, identifiers, retained, sections: 'complete' });

export const governing = (...ids: string[]): RunEventPayload => ({
  type: 'context.governing_loaded',
  active: ids.map((id) => ({ id, textSha256: `sha-${id}` })),
  conflicts: [],
});

export const memories = (...statuses: ('verified' | 'unbound' | 'unverifiable' | 'stale')[]): RunEventPayload => ({
  type: 'context.memories_loaded',
  memories: statuses.map((status, index) => ({ id: `m${index}`, status })),
});

const call = (callId: string, name: string, rawInput: Record<string, unknown>): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name,
  kind: 'other',
  title: name,
  rawInput,
});

export const read = (callId: string, path: string, output: string): RunEventPayload[] => [
  call(callId, 'Read', { file_path: path }),
  { type: 'tool.completed', callId, status: 'completed', output, files: [{ path, sha256: sha256Hex(output), access: 'read' }] },
];

export const bash = (callId: string, command: string, status: 'completed' | 'failed'): RunEventPayload[] => [
  call(callId, 'Bash', { command }),
  { type: 'tool.completed', callId, status, output: '' },
];

export const historyRead = (callId: string, seqFrom: number, seqTo: number): RunEventPayload[] => [
  call(callId, 'HistoryRead', { seqFrom, seqTo }),
  { type: 'tool.completed', callId, status: 'completed', output: '' },
];

export const denied = (callId: string, command: string): RunEventPayload[] => [
  call(callId, 'Bash', { command }),
  { type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source: 'rule', reason: 'denied' } },
];

export const recorded = (caseId: string, runIndex: number, payloads: readonly RunEventPayload[], options: { status?: RunStatus; totalTokens?: number } = {}): Transcript => {
  const totalTokens = options.totalTokens ?? 100;
  return {
    caseId,
    runIndex,
    run: { id: `run-${caseId}-${runIndex}`, status: options.status ?? 'COMPLETED', step: 1, usage: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens } },
    events: publicEventsOf(payloads),
    children: [],
  };
};

export const contextCase = (id: string, scenario: string, compaction: 'on' | 'off') => ({
  id,
  scenario,
  compaction,
  input: `work on ${scenario}`,
  permissionMode: 'default',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 0,
  rules: [],
  revisionDepth: 0,
  noise: { level: 0, topics: ['testing'] },
  graders: [{ kind: 'status', equals: 'COMPLETED' }],
});
