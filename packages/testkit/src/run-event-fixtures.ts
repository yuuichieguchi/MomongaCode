import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { compactionSummaryMessage } from '@momonga/protocol';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';

export type RecordedRun = {
  name: string;
  payloads: RunEventPayload[];
};

export const FIXTURE_RUN_ID = 'run-fixture';
export const FIXTURE_SESSION_ID = 'session-fixture';

const payloadStep = (payload: RunEventPayload): number | undefined =>
  'step' in payload && typeof payload.step === 'number' ? payload.step : undefined;

export const materializeEvents = (
  payloads: readonly RunEventPayload[],
  options: { runId?: string; sessionId?: string; startMs?: number } = {},
): RunEvent[] => {
  let step = 0;
  return payloads.map((payload, index) => {
    step = Math.max(step, payloadStep(payload) ?? step);
    return {
      ...payload,
      id: index + 1,
      runId: options.runId ?? FIXTURE_RUN_ID,
      sessionId: options.sessionId ?? FIXTURE_SESSION_ID,
      seq: index + 1,
      step,
      leaseToken: 1,
      createdAt: (options.startMs ?? 1_700_000_000_000) + index,
    };
  });
};

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
});

const assistantText = (id: string, text: string) => ({
  type: 'message',
  id,
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

const functionCall = (callId: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `fc-${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});

export const fixtureSubjectDigest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

export const fixtureCompactionContent = (summary: string): string =>
  `${Buffer.from(JSON.stringify({ v: 1, summary }), 'utf8').toString('base64url')}.${Buffer.from('fixture-mac', 'utf8').toString('base64url')}`;

export const fixtureCompactionItem = (id: string, summary: string) => ({ type: 'compaction' as const, id, encrypted_content: fixtureCompactionContent(summary) });

const started = (attempt: number): RunEventPayload[] => [
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  { type: 'run.started', attempt, now: 1_700_000_000_000 + attempt, pins: { model: 'fm' } },
];

export const finalAnswerRun: RecordedRun = {
  name: 'final answer',
  payloads: [
    { type: 'user.message', text: 'say hi' },
    ...started(1),
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'say hi' } },
    { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text: 'h' },
    { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text: 'i' },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantText('m1', 'hi')], usage: usage(10, 2) } },
    { type: 'usage.updated', inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const toolRoundTripRun: RecordedRun = {
  name: 'tool round trip',
  payloads: [
    { type: 'user.message', text: 'read a.txt' },
    ...started(1),
    { type: 'instructions.loaded', path: '/w/AGENTS.md', content: 'be brief' },
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'read a.txt' } },
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: [functionCall('c1', 'Read', { path: 'a.txt' })], usage: usage(20, 5) },
    },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'read', title: 'Read a.txt', rawInput: { path: 'a.txt' }, locations: [{ path: '/w/a.txt' }] },
    { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
    { type: 'tool.updated', callId: 'c1', content: [{ type: 'text', text: 'partial' }] },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'read a.txt + A' } },
    { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [assistantText('m2', 'A it is')], usage: usage(30, 4) } },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const approvalWaitResumeRun: RecordedRun = {
  name: 'approval wait and resume',
  payloads: [
    { type: 'user.message', text: 'delete tmp' },
    ...started(1),
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'delete tmp' } },
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: [functionCall('c1', 'Bash', { command: 'rm -r tmp' })], usage: usage(15, 6) },
    },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'rm -r tmp', rawInput: { command: 'rm -r tmp' } },
    {
      type: 'tool.permission.requested',
      approvalId: 'a1',
      callId: 'c1',
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
      subjectDigest: fixtureSubjectDigest('rm -r tmp'),
      reason: 'shell commands require approval',
    },
    { type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' },
    { type: 'tool.permission.resolved', approvalId: 'a1', optionId: 'allow_once' },
    { type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' },
    { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
    { type: 'run.started', attempt: 2, now: 1_700_000_000_100, pins: { model: 'fm' } },
    { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: '' },
    { type: 'plan.updated', entries: [{ content: 'delete tmp', priority: 'medium', status: 'completed' }] },
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'delete tmp + done' } },
    { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [assistantText('m2', 'deleted')], usage: usage(25, 2) } },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const cancelRun: RecordedRun = {
  name: 'cancel',
  payloads: [
    { type: 'user.message', text: 'build it' },
    ...started(1),
    { type: 'plan.updated', entries: [{ content: 'build', priority: 'high', status: 'in_progress' }] },
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'build it' } },
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: [functionCall('c1', 'Bash', { command: 'npm run build' })], usage: usage(12, 3) },
    },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'npm run build', rawInput: { command: 'npm run build' } },
    { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
    { type: 'run.status', from: 'RUNNING', to: 'CANCELLING' },
    { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'cancelled while running' },
    { type: 'notice', level: 'warning', message: 'run cancelled' },
    { type: 'run.status', from: 'CANCELLING', to: 'CANCELLED' },
  ],
};

export const compactionRun: RecordedRun = {
  name: 'compaction',
  payloads: [
    { type: 'user.message', text: 'grep everything' },
    ...started(1),
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'grep everything' } },
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: [functionCall('c1', 'Grep', { pattern: 'x' })], usage: usage(40, 5) },
    },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Grep', kind: 'search', title: 'Grep x', rawInput: { pattern: 'x' } },
    { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'head...tail', truncated: true },
    { type: 'context.truncated', callId: 'c1', handle: 'blob-1', kind: 'truncated' },
    { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'searched for x'), summary: 'searched for x', replacedThroughSeq: 3 },
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'summary' } },
    { type: 'agent.thought.delta', step: 2, attempt: 1, itemId: 'r2', text: 'thinking' },
    { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [assistantText('m2', 'found x')], usage: usage(20, 3) } },
    { type: 'run.status', from: 'RUNNING', to: 'STOPPED', reason: 'max_steps' },
  ],
};

const compactedPrefix: RunEventPayload[] = [
  { type: 'user.message', text: 'grep everything' },
  ...started(1),
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'grep everything' } },
  { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantText('m1', 'searched')], usage: usage(10, 2) } },
  { type: 'user.message', text: 'and again' },
  { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'searched for x'), summary: 'searched for x', replacedThroughSeq: 2 },
];

const plainSummary = compactionSummaryMessage('searched for x', 'model');

export const compactionRejectedAtBuildRun: RecordedRun = {
  name: 'compaction rejected at build',
  payloads: [
    ...compactedPrefix,
    { type: 'context.compaction_rejected', item: plainSummary },
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'summary' } },
    { type: 'model.responded', step: 2, attempt: 1, response: { status: 'completed', output: [assistantText('m2', 'found x')], usage: usage(20, 3) } },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const compactionRejectedAtStreamRun: RecordedRun = {
  name: 'compaction rejected at stream',
  payloads: [
    ...compactedPrefix,
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'summary' } },
    { type: 'context.compaction_rejected', step: 2, attempt: 1, item: plainSummary },
    { type: 'model.requested', step: 3, attempt: 1, digest: 'd3', body: { input: 'plain summary' } },
    { type: 'model.responded', step: 3, attempt: 1, response: { status: 'completed', output: [assistantText('m3', 'found x')], usage: usage(20, 3) } },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const evictionAndRejectionRun: RecordedRun = {
  name: 'eviction and rejection',
  payloads: [
    { type: 'user.message', text: 'inspect logs' },
    ...started(1),
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'inspect logs' } },
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: {
        status: 'completed',
        output: [functionCall('c2', 'Read', { path: 'b.log' }), functionCall('c1', 'Read', { path: 'a.log' })],
        usage: usage(30, 6),
      },
    },
    { type: 'tool.call', callId: 'c2', providerCallId: 'c2', name: 'Read', kind: 'read', title: 'Read b.log', rawInput: { path: 'b.log' } },
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'read', title: 'Read a.log', rawInput: { path: 'a.log' } },
    { type: 'tool.started', callId: 'c2', idemKey: 'k2' },
    { type: 'tool.completed', callId: 'c2', status: 'completed', output: 'B head...', truncated: true, handle: 'blob-b' },
    { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
    { type: 'context.truncated', callId: 'c2', handle: 'blob-b', kind: 'omitted' },
    { type: 'context.truncated', callId: 'c1', handle: 'blob-a', kind: 'omitted' },
    { type: 'context.truncated', callId: 'c2', handle: 'blob-b', kind: 'omitted' },
    { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { input: 'logs read' } },
    {
      type: 'model.responded',
      step: 2,
      attempt: 1,
      response: { status: 'completed', output: [functionCall('c3', 'Bash', { command: 'rm b.log' })], usage: usage(20, 4) },
    },
    { type: 'tool.call', callId: 'c3', providerCallId: 'c3', name: 'Bash', kind: 'execute', title: 'rm b.log', rawInput: { command: 'rm b.log' } },
    {
      type: 'tool.permission.requested',
      approvalId: 'a3',
      callId: 'c3',
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'never', name: 'Reject always', kind: 'reject_always' },
      ],
      subjectDigest: fixtureSubjectDigest('rm b.log'),
      reason: 'shell commands require approval',
    },
    { type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' },
    { type: 'tool.permission.resolved', approvalId: 'a3', optionId: 'never', rulePersisted: true },
    { type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' },
  ],
};

type InheritedPayload = Extract<RunEventPayload, { type: 'context.inherited' }>;

const inheritedHistory: InheritedPayload['history'] = [
  { seq: 1, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] } },
  { seq: 2, item: { type: 'function_call', call_id: 'c0', name: 'Read', arguments: '{"path":"a.txt"}' } },
  {
    seq: 3,
    item: { type: 'function_call_output', call_id: 'c0', output: 'Not run: the user interrupted the previous request before this tool call ran.' },
    callId: 'c0',
  },
  { seq: 4, item: { type: 'message', role: 'user', content: '[The user interrupted the previous request before it was finished.]' } },
];

const inheritedDigest = (history: InheritedPayload['history'], nextItemSeq: number): string =>
  sha256Hex(canonicalJson({ history, nextItemSeq, summary: null, evicted: [], mode: 'default' }));

export const inheritedRun: RecordedRun = {
  name: 'inherited context',
  payloads: [
    { type: 'user.message', text: 'now read b.txt' },
    { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
    {
      type: 'context.inherited',
      fromRunId: 'run-previous',
      fromLastSeq: 9,
      history: inheritedHistory,
      nextItemSeq: 5,
      evicted: [],
      closures: [{ callId: 'c0', seq: 3, effect: 'not_executed', announced: true }],
      markers: [{ seq: 4, kind: 'interrupted' }],
      fromMode: 'default',
      mode: 'default',
      digest: inheritedDigest(inheritedHistory, 5),
    },
    { type: 'run.started', attempt: 1, now: 1_700_000_000_001, pins: { model: 'fm' }, mode: 'default' },
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'inherited + now read b.txt' } },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantText('m1', 'b says hi')], usage: usage(40, 4) } },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const usageChargedRun: RecordedRun = {
  name: 'usage charged outside the main model calls',
  payloads: [
    { type: 'user.message', text: 'say hi' },
    ...started(1),
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: 'say hi' } },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantText('m1', 'hi')], usage: usage(10, 2) } },
    { type: 'usage.charged', purpose: 'permission_classifier', inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    { type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
  ],
};

export const RECORDED_RUNS: readonly RecordedRun[] = [
  finalAnswerRun,
  toolRoundTripRun,
  approvalWaitResumeRun,
  cancelRun,
  compactionRun,
  compactionRejectedAtBuildRun,
  compactionRejectedAtStreamRun,
  evictionAndRejectionRun,
  inheritedRun,
  usageChargedRun,
];
