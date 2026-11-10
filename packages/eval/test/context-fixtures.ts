import { sha256Hex } from '@momonga/foundation';
import type { RunEventPayload, RunStatus, SummaryFidelity, SummarySource } from '@momonga/protocol';
import { fixtureCompactionItem } from '@momonga/testkit';
import type { Transcript } from '@momonga/eval';
import { RECORDED_CODE_DIGEST, RECORDED_IDENTITY, publicEventsOf } from './fixtures.ts';

export const TEST_CODE_DIGEST = RECORDED_CODE_DIGEST;

export const compacted = (replacedThroughSeq: number, source?: SummarySource, fidelity?: SummaryFidelity): RunEventPayload => ({
  type: 'context.compacted',
  item: fixtureCompactionItem(`cmp-${replacedThroughSeq}`, 'summary'),
  summary: 'summary',
  replacedThroughSeq,
  ...(source === undefined ? {} : { source }),
  ...(fidelity === undefined ? {} : { fidelity }),
});

export const summarized = (replacedThroughSeq: number, summary: SummaryFidelity): RunEventPayload =>
  compacted(replacedThroughSeq, summary.fabricated.length === 0 ? 'model' : 'deterministic', summary);

export const answer = (text: string): RunEventPayload => ({
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: {
    status: 'completed',
    output: [{ type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
});

export const padding = (count: number): RunEventPayload[] => Array.from({ length: count }, (_unused, index) => ({ type: 'notice', level: 'info', message: `padding ${index}` }));

export const marked = (payloads: readonly RunEventPayload[], callId: string): { seqFrom: number; seqTo: number } => {
  const events = publicEventsOf(payloads);
  const start = events.find((event) => event.type === 'tool.call' && event.callId === callId);
  const end = events.find((event) => event.type === 'tool.completed' && event.callId === callId);
  if (start === undefined || end === undefined || !('seq' in start) || !('seq' in end)) throw new Error(`no marked call ${callId}`);
  return { seqFrom: start.seq, seqTo: end.seq };
};

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

const started = (callId: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey: `key-${callId}` });

export const ran = (calls: readonly RunEventPayload[]): RunEventPayload[] =>
  calls.flatMap((event) => (event.type === 'tool.call' ? [event, started(event.callId)] : [event]));

export const historyRead = (callId: string, seqFrom: number, seqTo: number): RunEventPayload[] => [
  call(callId, 'HistoryRead', { seqFrom, seqTo }),
  { type: 'tool.completed', callId, status: 'completed', output: '' },
];

export const failedHistoryRead = (callId: string, seqFrom: number, seqTo: number): RunEventPayload[] => [
  call(callId, 'HistoryRead', { seqFrom, seqTo }),
  { type: 'tool.completed', callId, status: 'failed', output: 'no such range' },
];

export const deniedHistoryRead = (callId: string, seqFrom: number, seqTo: number): RunEventPayload[] => [
  call(callId, 'HistoryRead', { seqFrom, seqTo }),
  { type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source: 'rule', reason: 'denied' } },
];

export const denied = (callId: string, command: string): RunEventPayload[] => [
  call(callId, 'Bash', { command }),
  { type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source: 'rule', reason: 'denied' } },
];

export const recorded = (
  caseId: string,
  runIndex: number,
  payloads: readonly RunEventPayload[],
  options: { status?: RunStatus; totalTokens?: number; children?: Transcript['children']; modelAlias?: string; reflection?: Transcript['reflection'] } = {},
): Transcript => {
  const totalTokens = options.totalTokens ?? 100;
  return {
    caseId,
    runIndex,
    run: { id: `run-${caseId}-${runIndex}`, status: options.status ?? 'COMPLETED', step: 1, usage: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens }, ...(options.modelAlias === undefined ? {} : { modelAlias: options.modelAlias }) },
    events: publicEventsOf(payloads),
    children: options.children ?? [],
    ...RECORDED_IDENTITY,
    reflection: options.reflection ?? { state: 'none' },
  };
};

export const contextCase = (id: string, scenario: string, compaction: 'on' | 'off') => ({
  id,
  scenario,
  compaction,
  input: `work on ${scenario}`,
  permissionMode: 'manual',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  rules: [],
  revisionDepth: 0,
  noise: { level: 0, topics: ['testing'] },
  graders: [{ kind: 'status', equals: 'COMPLETED' }],
});
