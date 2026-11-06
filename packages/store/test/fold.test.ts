import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import {
  FIXTURE_RUN_ID,
  FIXTURE_SESSION_ID,
  RECORDED_RUNS,
  approvalWaitResumeRun,
  cancelRun,
  compactionRun,
  evictionAndRejectionRun,
  finalAnswerRun,
  fixtureCompactionItem,
  fixtureSubjectDigest,
  materializeEvents,
  toolRoundTripRun,
  usageChargedRun,
} from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const start = () => initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID });
const foldAll = (events: readonly RunEvent[], from: RunState = start()) => events.reduce(foldRunState, from);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const userItem = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistantItem = (id: string, text: string) => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] });
const callItem = (callId: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `fc-${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const outputItem = (callId: string, output: string) => ({ type: 'function_call_output', call_id: callId, output });
const callIdOf = (item: unknown): string | undefined => {
  const record = item as { type?: unknown; call_id?: unknown };
  return record.type === 'function_call_output' && typeof record.call_id === 'string' ? record.call_id : undefined;
};
const entry = (seq: number, item: unknown, handle?: string, callId: string | undefined = callIdOf(item)) => ({
  seq,
  item,
  ...(callId === undefined ? {} : { callId }),
  ...(handle === undefined ? {} : { handle }),
});
const itemsOf = (state: RunState): unknown[] => state.history.map((historyEntry) => historyEntry.item);

describe('initialRunState', () => {
  it('starts empty and QUEUED', () => {
    expect(start()).toEqual({
      runId: FIXTURE_RUN_ID,
      sessionId: FIXTURE_SESSION_ID,
      status: 'QUEUED',
      step: 0,
      attempt: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      history: [],
      nextItemSeq: 1,
      taskSeq: 1,
      workingFacts: { written: [], touched: [], commands: [], messages: [], itemEvents: [] },
      evicted: [],
      pendingCalls: {},
      notes: [],
      toolCallCounts: {},
      steps: {},
      loadedInstructions: [],
      hookCompletions: {},
      stopHookRanSinceResponse: false,
      stopHookContinuations: 0,
      compactions: 0,
      lastCompactionSeq: 0,
      callResults: {},
      formsSinceCompaction: {},
      activatedSkills: [],
      loadedTools: [],
      loopGroups: [],
      lastSeq: 0,
    });
  });
});

describe('foldRunState on recorded runs', () => {
  it('folds a final answer', () => {
    expect(foldAll(materializeEvents(finalAnswerRun.payloads))).toEqual({
      ...start(),
      status: 'COMPLETED',
      step: 1,
      attempt: 1,
      pins: { model: 'fm' },
      lastResponse: { step: 1, incomplete: false, refusal: false, callIds: [] },
      steps: {},
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      history: [entry(1, userItem('say hi')), entry(2, assistantItem('m1', 'hi'))],
      nextItemSeq: 3,
      workingFacts: {
        written: [],
        touched: [],
        commands: [],
        messages: [],
        taskText: 'say hi',
        itemEvents: [
          { itemSeq: 1, eventSeq: 1 },
          { itemSeq: 2, eventSeq: 7 },
        ],
      },
      lastSeq: 9,
    });
  });

  it('adds the usage charged outside the main model calls to the run total', () => {
    const state = foldAll(materializeEvents(usageChargedRun.payloads));
    expect(state.usage).toEqual({ inputTokens: 10 + 7 + 5, outputTokens: 2 + 3 + 1, totalTokens: 12 + 10 + 6 });
  });

  it('folds a tool round trip', () => {
    expect(foldAll(materializeEvents(toolRoundTripRun.payloads))).toEqual({
      ...start(),
      status: 'COMPLETED',
      step: 2,
      attempt: 1,
      pins: { model: 'fm' },
      lastResponse: { step: 2, incomplete: false, refusal: false, callIds: [] },
      steps: {},
      loadedInstructions: [{ path: '/w/AGENTS.md', textSha256: 'b0d336336bae9756708102764ccc977778d8c408df38d7050d69f9e4d22c9a43', seq: 4, content: 'be brief' }],
      callResults: { c1: 'completed' },
      usage: { inputTokens: 50, outputTokens: 9, totalTokens: 59 },
      history: [
        entry(1, userItem('read a.txt')),
        entry(2, callItem('c1', 'Read', { path: 'a.txt' })),
        entry(3, outputItem('c1', 'A')),
        entry(4, assistantItem('m2', 'A it is')),
      ],
      nextItemSeq: 5,
      workingFacts: {
        written: [],
        touched: [{ kind: 'file', path: '/w/a.txt' }],
        commands: [],
        messages: [],
        taskText: 'read a.txt',
        itemEvents: [
          { itemSeq: 1, eventSeq: 1 },
          { itemSeq: 2, eventSeq: 6 },
          { itemSeq: 3, eventSeq: 10 },
          { itemSeq: 4, eventSeq: 12 },
        ],
      },
      pendingCalls: { c1: { name: 'Read', providerCallId: 'c1', arguments: { path: 'a.txt' }, status: 'completed', idemKey: 'k1' } },
      toolCallCounts: { [sha256('Read\n{"path":"a.txt"}')]: 1 },
      loopOpen: { calls: [['Read', { path: 'a.txt' }]], callIds: ['c1'], outputs: { c1: sha256('"A"') } },
      lastSeq: 13,
    });
  });

  it('folds an approval wait and resume', () => {
    const events = materializeEvents(approvalWaitResumeRun.payloads);
    const waiting = foldAll(events.slice(0, 8));
    expect(waiting.status).toBe('WAITING_HUMAN');
    expect(waiting.pendingCalls['c1']).toEqual({
      name: 'Bash',
      providerCallId: 'c1',
      arguments: { command: 'rm -r tmp' },
      status: 'awaiting_approval',
      approvalId: 'a1',
      subjectDigest: fixtureSubjectDigest('rm -r tmp'),
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const resolved = foldAll(events.slice(0, 9));
    expect(resolved.pendingCalls['c1']).toEqual({
      name: 'Bash',
      providerCallId: 'c1',
      arguments: { command: 'rm -r tmp' },
      status: 'requested',
      approvalId: 'a1',
      subjectDigest: fixtureSubjectDigest('rm -r tmp'),
      resolution: { optionId: 'allow_once', kind: 'allow_once', subjectDigest: fixtureSubjectDigest('rm -r tmp') },
    });
    const final = foldAll(events);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      attempt: 2,
      step: 2,
      usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
      pendingCalls: { c1: { name: 'Bash', arguments: { command: 'rm -r tmp' }, status: 'completed', approvalId: 'a1', idemKey: 'k1' } },
      lastSeq: 18,
    });
    expect(final.history).toEqual([
      entry(1, userItem('delete tmp')),
      entry(2, callItem('c1', 'Bash', { command: 'rm -r tmp' })),
      entry(3, outputItem('c1', '')),
      entry(4, assistantItem('m2', 'deleted')),
    ]);
    expect(final.nextItemSeq).toBe(5);
  });

  it('folds a cancel with a reconciled tool and a notice', () => {
    expect(foldAll(materializeEvents(cancelRun.payloads))).toMatchObject({
      status: 'CANCELLED',
      pendingCalls: { c1: { status: 'reconciled', idemKey: 'k1' } },
      history: [
        entry(1, userItem('build it')),
        entry(2, callItem('c1', 'Bash', { command: 'npm run build' })),
        entry(3, outputItem('c1', 'cancelled while running')),
      ],
      nextItemSeq: 4,
      notes: [{ level: 'warning', message: 'run cancelled' }],
      lastSeq: 12,
    });
  });

  it('folds a compaction that drops history through the given seq and keeps the compaction item as the summary', () => {
    const events = materializeEvents(compactionRun.payloads);
    const compactionIndex = events.findIndex((event) => event.type === 'context.compacted');
    expect(compactionIndex).toBeGreaterThan(0);
    const beforeCompaction = foldAll(events.slice(0, compactionIndex));
    expect(beforeCompaction.history).toEqual([
      entry(1, userItem('grep everything')),
      entry(2, callItem('c1', 'Grep', { pattern: 'x' })),
      entry(3, outputItem('c1', 'head...tail'), 'blob-1'),
    ]);
    expect(beforeCompaction.evicted).toEqual([]);
    const final = foldAll(events);
    expect(final.history).toEqual([entry(4, assistantItem('m2', 'found x'))]);
    expect(final.summary).toEqual({ item: fixtureCompactionItem('cmp-1', 'searched for x'), summary: 'searched for x', replacedThroughSeq: 3 });
    expect(final.nextItemSeq).toBe(5);
    expect(final).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps', step: 2, lastSeq: 14 });
  });

  it('folds evictions, output handles and a reject_always resolution', () => {
    const final = foldAll(materializeEvents(evictionAndRejectionRun.payloads));
    expect(final.history).toEqual([
      entry(1, userItem('inspect logs')),
      entry(2, callItem('c2', 'Read', { path: 'b.log' })),
      entry(3, callItem('c1', 'Read', { path: 'a.log' })),
      entry(4, outputItem('c2', 'B head...'), 'blob-b'),
      entry(5, outputItem('c1', 'A'), 'blob-a'),
      entry(6, callItem('c3', 'Bash', { command: 'rm b.log' })),
    ]);
    expect(final.evicted).toEqual(['c1', 'c2']);
    expect(final.pendingCalls['c3']).toEqual({
      name: 'Bash',
      providerCallId: 'c3',
      arguments: { command: 'rm b.log' },
      status: 'requested',
      approvalId: 'a3',
      subjectDigest: fixtureSubjectDigest('rm b.log'),
      resolution: { optionId: 'never', kind: 'reject_always', subjectDigest: fixtureSubjectDigest('rm b.log') },
    });
    expect(final).toMatchObject({ status: 'QUEUED', nextItemSeq: 7, lastSeq: 21 });
  });

  it.each(RECORDED_RUNS.map((run) => [run.name, run] as const))(
    '%s: folding a snapshot at every k plus the tail equals folding everything',
    (_name, run) => {
      const events = materializeEvents(run.payloads);
      const expected = foldAll(events);
      for (let k = 0; k <= events.length; k += 1) {
        const snapshot = JSON.parse(JSON.stringify(foldAll(events.slice(0, k)))) as RunState;
        expect(foldAll(events.slice(k), snapshot)).toEqual(expected);
      }
    },
  );

  it.each(RECORDED_RUNS.map((run) => [run.name, run] as const))('%s: never mutates the previous state', (_name, run) => {
    let state = deepFreeze(start());
    for (const event of materializeEvents(run.payloads)) {
      const before = JSON.stringify(state);
      const next = foldRunState(state, event);
      expect(JSON.stringify(state)).toBe(before);
      state = deepFreeze(next);
    }
  });
});

describe('foldRunState details', () => {
  const events = materializeEvents(finalAnswerRun.payloads);

  it('keeps the exact in-flight model request when no response was recorded', () => {
    const state = foldAll(events.slice(0, 4));
    expect(state.inFlightModelRequest).toEqual({ step: 1, attempt: 1, digest: 'd1', body: { input: 'say hi' }, requestedSeq: 4 });
    expect(state.step).toBe(1);
  });

  it('clears the in-flight request only on the matching response', () => {
    const requested = foldAll(events.slice(0, 4));
    const stray = foldRunState(requested, {
      id: 99,
      runId: FIXTURE_RUN_ID,
      sessionId: FIXTURE_SESSION_ID,
      seq: 5,
      leaseToken: 1,
      createdAt: 0,
      type: 'model.responded',
      step: 1,
      attempt: 2,
      response: { status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    });
    expect(stray.inFlightModelRequest).toEqual(requested.inFlightModelRequest);
    expect(foldAll(events.slice(4, 7), requested).inFlightModelRequest).toBeUndefined();
  });

  it('counts identical tool calls under the same key regardless of argument key order', () => {
    const base = materializeEvents([
      { type: 'tool.call', callId: 'x1', providerCallId: 'x1', name: 'Grep', kind: 'search', title: 'g', rawInput: { pattern: 'a', path: '.' } },
      { type: 'tool.call', callId: 'x2', providerCallId: 'x2', name: 'Grep', kind: 'search', title: 'g', rawInput: { path: '.', pattern: 'a' } },
      { type: 'tool.call', callId: 'x3', providerCallId: 'x3', name: 'Glob', kind: 'search', title: 'g', rawInput: { path: '.', pattern: 'a' } },
    ]);
    expect(foldAll(base).toolCallCounts).toEqual({
      [sha256('Grep\n{"path":".","pattern":"a"}')]: 2,
      [sha256('Glob\n{"path":".","pattern":"a"}')]: 1,
    });
  });

  const reusedProviderIdPayloads = (): RunEventPayload[] => {
    const response = (callId: string) => ({
      status: 'completed' as const,
      output: [callItem('call_0', 'Read', { path: callId })],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    return [
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: {} },
      { type: 'model.responded', step: 1, attempt: 1, response: response('a') },
      { type: 'tool.call', callId: 'run-call-1', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'a', rawInput: { path: 'a' } },
      { type: 'tool.started', callId: 'run-call-1', idemKey: 'k1' },
      { type: 'tool.completed', callId: 'run-call-1', status: 'completed', output: 'A' },
      { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: {} },
      { type: 'model.responded', step: 2, attempt: 1, response: response('b') },
      { type: 'tool.call', callId: 'run-call-2', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'b', rawInput: { path: 'b' } },
      {
        type: 'tool.permission.requested',
        approvalId: 'ap2',
        callId: 'run-call-2',
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        subjectDigest: fixtureSubjectDigest('read b'),
        reason: 'edits require approval',
      },
      { type: 'tool.permission.resolved', approvalId: 'ap2', optionId: 'allow_once' },
      { type: 'tool.started', callId: 'run-call-2', idemKey: 'k2' },
      { type: 'tool.completed', callId: 'run-call-2', status: 'completed', output: 'B' },
    ];
  };

  it('keeps two steps that reuse the same provider call id apart and returns the provider id to the model', () => {
    const final = foldAll(materializeEvents(reusedProviderIdPayloads()));
    expect(Object.keys(final.pendingCalls)).toEqual(['run-call-1', 'run-call-2']);
    expect(final.pendingCalls['run-call-1']).toMatchObject({ providerCallId: 'call_0', arguments: { path: 'a' }, status: 'completed', idemKey: 'k1' });
    expect(final.pendingCalls['run-call-2']).toMatchObject({ providerCallId: 'call_0', arguments: { path: 'b' }, status: 'completed', idemKey: 'k2', approvalId: 'ap2' });
    expect(itemsOf(final).filter((item) => (item as { type: string }).type === 'function_call_output')).toEqual([
      outputItem('call_0', 'A'),
      outputItem('call_0', 'B'),
    ]);
  });

  it('replays reused provider call ids identically from every snapshot point', () => {
    const events = materializeEvents(reusedProviderIdPayloads());
    const expected = foldAll(events);
    for (let k = 0; k <= events.length; k += 1) {
      const snapshot = JSON.parse(JSON.stringify(foldAll(events.slice(0, k)))) as RunState;
      expect(foldAll(events.slice(k), snapshot)).toEqual(expected);
    }
  });

  it('still rejects a duplicate run-unique call id', () => {
    const [call] = materializeEvents([
      { type: 'tool.call', callId: 'dup', providerCallId: 'p', name: 'Read', kind: 'read', title: 't', rawInput: {} },
    ]);
    const once = foldRunState(start(), call!);
    expect(() => foldRunState(once, { ...call!, seq: 2 })).toThrow(/duplicate tool.call.*dup/);
  });

  it('tracks lastSeq from every event', () => {
    expect(foldAll(events.slice(0, 5)).lastSeq).toBe(5);
  });
});

const toolPrelude = (callId: string): RunEventPayload[] => [
  { type: 'user.message', text: 'go' },
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: {} },
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [callItem(callId, 'Read', { path: 'a' })], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  },
  { type: 'tool.call', callId, providerCallId: callId, name: 'Read', kind: 'read', title: 'Read a', rawInput: { path: 'a' } },
  { type: 'tool.started', callId, idemKey: `k-${callId}` },
];

const responded = (step: number, output: unknown[]): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: {} },
  { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];

describe('history seqs', () => {
  it('gives every appended item the next seq, one per model output item', () => {
    const state = foldAll(
      materializeEvents([
        { type: 'user.message', text: 'one' },
        ...responded(1, [assistantItem('m1', 'a'), callItem('c1', 'Read', { path: 'a' }), callItem('c2', 'Read', { path: 'b' })]),
        { type: 'user.message', text: 'two' },
      ]),
    );
    expect(state.history.map((historyEntry) => historyEntry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state.nextItemSeq).toBe(6);
  });

  it('keeps seqs of retained items and continues numbering after a compaction', () => {
    const payloads: RunEventPayload[] = [
      ...toolPrelude('c1'),
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
      ...responded(2, [assistantItem('m2', 'done')]),
      { type: 'user.message', text: 'next' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'first'), summary: 'first', replacedThroughSeq: 3 },
      { type: 'user.message', text: 'after' },
    ];
    const state = foldAll(materializeEvents(payloads));
    expect(state.history).toEqual([entry(4, assistantItem('m2', 'done')), entry(5, userItem('next')), entry(6, userItem('after'))]);
    expect(state.nextItemSeq).toBe(7);
    expect(state.summary).toEqual({ item: fixtureCompactionItem('cmp-1', 'first'), summary: 'first', replacedThroughSeq: 3 });
  });

  it('accumulates what the calls declared they touch in the working facts and keeps it when a compaction replaces the calls', () => {
    const declared = (callId: string, name: string, kind: 'read' | 'edit' | 'search' | 'execute' | 'other', rawInput: unknown, locations?: { path: string }[]): RunEventPayload => ({
      type: 'tool.call',
      callId,
      providerCallId: callId,
      name,
      kind,
      title: name,
      rawInput,
      ...(locations === undefined ? {} : { locations }),
    });
    const payloads: RunEventPayload[] = [
      { type: 'user.message', text: 'go' },
      ...responded(1, [
        callItem('c1', 'Reader', { file: 'legacy/a.ts' }),
        callItem('c2', 'Finder', { in: 'lib' }),
        callItem('c3', 'Finder', {}),
        callItem('c4', 'Runner', { cmd: 'ls' }),
        callItem('c5', 'Changer', { file: 'legacy/a.ts' }),
        callItem('c6', 'Thinker', { path: 'ignored' }),
      ]),
      declared('c1', 'Reader', 'read', { file: 'legacy/a.ts' }, [{ path: '/p/legacy/a.ts' }]),
      declared('c2', 'Finder', 'search', { in: 'lib' }, [{ path: '/p/lib' }]),
      declared('c3', 'Finder', 'search', {}),
      declared('c4', 'Runner', 'execute', { cmd: 'ls' }),
      declared('c5', 'Changer', 'edit', { file: 'legacy/a.ts' }, [{ path: '/p/legacy/a.ts' }]),
      declared('c6', 'Thinker', 'other', { path: 'ignored' }, [{ path: '/p/ignored' }]),
      { type: 'user.message', text: 'next' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'first'), summary: 'first', replacedThroughSeq: 7 },
    ];
    const before = foldAll(materializeEvents(payloads.slice(0, 9)));
    const expected = [
      { kind: 'file', path: '/p/legacy/a.ts' },
      { kind: 'directory', path: '/p/lib' },
      { kind: 'directory' },
    ];
    expect(before.workingFacts.touched).toEqual(expected);
    const after = foldAll(materializeEvents(payloads));
    expect(after.history.map((historyEntry) => historyEntry.seq)).toEqual([8]);
    expect(after.workingFacts.touched).toEqual(expected);
  });

  it('replaces the summary on a later compaction and keeps numbering', () => {
    const payloads: RunEventPayload[] = [
      { type: 'user.message', text: 'a' },
      { type: 'user.message', text: 'b' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'first'), summary: 'first', replacedThroughSeq: 1 },
      { type: 'user.message', text: 'c' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-2', 'second'), summary: 'second', replacedThroughSeq: 2 },
      { type: 'user.message', text: 'd' },
    ];
    const state = foldAll(materializeEvents(payloads));
    expect(state.history).toEqual([entry(3, userItem('c')), entry(4, userItem('d'))]);
    expect(state.summary).toEqual({ item: fixtureCompactionItem('cmp-2', 'second'), summary: 'second', replacedThroughSeq: 2 });
    expect(state.nextItemSeq).toBe(5);
  });

  it('pairs positionally so a reused provider id cannot cover an output whose own call was dropped', () => {
    const payloads: RunEventPayload[] = [
      ...responded(1, [callItem('call_0', 'Read', { path: 'a' })]),
      { type: 'tool.call', callId: 'rc1', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'a', rawInput: { path: 'a' } },
      { type: 'tool.completed', callId: 'rc1', status: 'completed', output: 'A' },
      ...responded(2, [callItem('call_0', 'Read', { path: 'b' })]),
      { type: 'tool.call', callId: 'rc2', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'b', rawInput: { path: 'b' } },
      { type: 'tool.completed', callId: 'rc2', status: 'completed', output: 'B' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'x'), summary: 'x', replacedThroughSeq: 1 },
    ];
    const events = materializeEvents(payloads);
    expect(() => foldAll(events)).toThrow(RangeError);
    expect(() => foldAll(events)).toThrow(/call_0/);
  });

  it('rejects a compaction boundary that keeps an output whose call was dropped', () => {
    const payloads: RunEventPayload[] = [
      ...toolPrelude('c1'),
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'bad'), summary: 'bad', replacedThroughSeq: 2 },
    ];
    expect(() => foldAll(materializeEvents(payloads))).toThrow(/c1/);
  });

  it('gives a reconciled output a fresh seq', () => {
    const state = foldAll(
      materializeEvents([...toolPrelude('c1'), { type: 'tool.reconciled', callId: 'c1', outcome: 'not_applied', output: 'not run' }]),
    );
    expect(state.history).toEqual([entry(1, userItem('go')), entry(2, callItem('c1', 'Read', { path: 'a' })), entry(3, outputItem('c1', 'not run'))]);
    expect(state.nextItemSeq).toBe(4);
  });
});

describe('output handles and evictions', () => {
  it('attaches a context.truncated handle by run-unique callId when two calls share a provider id and complete out of order', () => {
    const payloads: RunEventPayload[] = [
      { type: 'user.message', text: 'go' },
      ...responded(1, [callItem('call_0', 'Read', { path: 'a' }), callItem('call_0', 'Read', { path: 'b' })]),
      { type: 'tool.call', callId: 'run-call-1', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'a', rawInput: { path: 'a' } },
      { type: 'tool.call', callId: 'run-call-2', providerCallId: 'call_0', name: 'Read', kind: 'read', title: 'b', rawInput: { path: 'b' } },
      { type: 'tool.started', callId: 'run-call-2', idemKey: 'k2' },
      { type: 'tool.completed', callId: 'run-call-2', status: 'completed', output: 'B' },
      { type: 'tool.started', callId: 'run-call-1', idemKey: 'k1' },
      { type: 'tool.completed', callId: 'run-call-1', status: 'completed', output: 'A' },
      { type: 'context.truncated', callId: 'run-call-1', handle: 'blob-a', kind: 'omitted' },
    ];
    const state = foldAll(materializeEvents(payloads));
    expect(state.history).toEqual([
      entry(1, userItem('go')),
      entry(2, callItem('call_0', 'Read', { path: 'a' })),
      entry(3, callItem('call_0', 'Read', { path: 'b' })),
      entry(4, outputItem('call_0', 'B'), undefined, 'run-call-2'),
      entry(5, outputItem('call_0', 'A'), 'blob-a', 'run-call-1'),
    ]);
    expect(state.evicted).toEqual(['run-call-1']);
  });

  it.each([
    ['requested', [] as RunEventPayload[]],
    ['started', [{ type: 'tool.started', callId: 'c9', idemKey: 'k9' }] as RunEventPayload[]],
    [
      'awaiting_approval',
      [
        {
          type: 'tool.permission.requested',
          approvalId: 'ap9',
          callId: 'c9',
          options: [{ optionId: 'ok', name: 'Allow once', kind: 'allow_once' }],
          subjectDigest: fixtureSubjectDigest('c9'),
          reason: 'edits require approval',
        },
      ] as RunEventPayload[],
    ],
  ])('rejects a context.truncated for a %s call that has not finished', (_status, progress) => {
    const payloads: RunEventPayload[] = [
      { type: 'tool.call', callId: 'c9', providerCallId: 'c9', name: 'Read', kind: 'read', title: 'r', rawInput: {} },
      ...progress,
      { type: 'context.truncated', callId: 'c9', handle: 'h9', kind: 'omitted' },
    ];
    expect(() => foldAll(materializeEvents(payloads))).toThrow(/c9/);
  });

  it('records the handle carried by tool.completed on the output entry', () => {
    const state = foldAll(
      materializeEvents([
        ...toolPrelude('c1'),
        { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'head', truncated: true, handle: 'blob-x' },
      ]),
    );
    expect(state.history[2]).toEqual(entry(3, outputItem('c1', 'head'), 'blob-x'));
    expect(state.evicted).toEqual([]);
  });

  it('leaves the output entry without a handle when tool.completed has none', () => {
    const state = foldAll(materializeEvents([...toolPrelude('c1'), { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' }]));
    expect(state.history[2]).toEqual(entry(3, outputItem('c1', 'A')));
  });

  it('records the handle from a later truncated context.truncated without evicting', () => {
    const state = foldAll(
      materializeEvents([
        ...toolPrelude('c1'),
        { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
        { type: 'context.truncated', callId: 'c1', handle: 'blob-t', kind: 'truncated' },
      ]),
    );
    expect(state.history[2]).toEqual(entry(3, outputItem('c1', 'A'), 'blob-t'));
    expect(state.evicted).toEqual([]);
  });

  it('records the handle and evicts on an omitted context.truncated', () => {
    const state = foldAll(
      materializeEvents([
        ...toolPrelude('c1'),
        { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
        { type: 'context.truncated', callId: 'c1', handle: 'blob-o', kind: 'omitted' },
      ]),
    );
    expect(state.history[2]).toEqual(entry(3, outputItem('c1', 'A'), 'blob-o'));
    expect(state.evicted).toEqual(['c1']);
  });

  it('is idempotent for a repeated context.truncated', () => {
    const payloads: RunEventPayload[] = [
      ...toolPrelude('c1'),
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
      { type: 'context.truncated', callId: 'c1', handle: 'blob-o', kind: 'omitted' },
    ];
    const once = foldAll(materializeEvents(payloads));
    const twice = foldAll(materializeEvents([...payloads, payloads[payloads.length - 1]!]));
    expect({ ...twice, lastSeq: once.lastSeq }).toEqual(once);
  });

  it('rejects a context.truncated for a callId that has no output and no pending call', () => {
    const payloads: RunEventPayload[] = [
      ...toolPrelude('c1'),
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
      { type: 'context.truncated', callId: 'ghost', handle: 'h-ghost', kind: 'omitted' },
    ];
    expect(() => foldAll(materializeEvents(payloads))).toThrow(/ghost/);
  });

  it('ignores a context.truncated for an output that was already compacted away', () => {
    const payloads: RunEventPayload[] = [
      ...toolPrelude('c1'),
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'A' },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'done'), summary: 'done', replacedThroughSeq: 3 },
    ];
    const compacted = foldAll(materializeEvents(payloads));
    const after = foldAll(
      materializeEvents([...payloads, { type: 'context.truncated', callId: 'c1', handle: 'h-late', kind: 'omitted' }]),
    );
    expect(after).toEqual({ ...compacted, lastSeq: compacted.lastSeq + 1 });
  });

  it('keeps evicted sorted and unique across calls', () => {
    const payloads: RunEventPayload[] = [
      { type: 'user.message', text: 'go' },
      ...responded(1, [callItem('cb', 'Read', { path: 'b' }), callItem('ca', 'Read', { path: 'a' }), callItem('cc', 'Read', { path: 'c' })]),
      ...(['cb', 'ca', 'cc'] as const).flatMap((callId): RunEventPayload[] => [
        { type: 'tool.call', callId, providerCallId: callId, name: 'Read', kind: 'read', title: callId, rawInput: { path: callId } },
        { type: 'tool.started', callId, idemKey: `k-${callId}` },
        { type: 'tool.completed', callId, status: 'completed', output: callId },
      ]),
      { type: 'context.truncated', callId: 'cc', handle: 'h-cc', kind: 'omitted' },
      { type: 'context.truncated', callId: 'ca', handle: 'h-ca', kind: 'omitted' },
      { type: 'context.truncated', callId: 'cb', handle: 'h-cb', kind: 'truncated' },
      { type: 'context.truncated', callId: 'cc', handle: 'h-cc', kind: 'omitted' },
    ];
    expect(foldAll(materializeEvents(payloads)).evicted).toEqual(['ca', 'cc']);
  });
});

describe('approval resolution', () => {
  const OPTIONS = [
    { optionId: 'opt-ao', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'opt-aa', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'opt-ro', name: 'Reject once', kind: 'reject_once' },
    { optionId: 'opt-ra', name: 'Reject always', kind: 'reject_always' },
  ] as const;
  const digest = fixtureSubjectDigest('approval subject');

  const requested = (): RunEventPayload[] => [
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'run', rawInput: { command: 'run' } },
    { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', options: OPTIONS.map((option) => ({ ...option })), subjectDigest: digest, reason: 'edits require approval' },
  ];

  it('stores the subject digest on the pending call when approval is requested', () => {
    const state = foldAll(materializeEvents(requested()));
    expect(state.pendingCalls['c1']).toEqual({
      name: 'Bash',
      providerCallId: 'c1',
      arguments: { command: 'run' },
      status: 'awaiting_approval',
      approvalId: 'ap1',
      subjectDigest: digest,
      options: OPTIONS.map((option) => ({ ...option })),
    });
  });

  it.each(OPTIONS.map((option) => [option.kind, option.optionId] as const))(
    'derives %s from the requested options and returns the call to requested',
    (kind, optionId) => {
      const state = foldAll(materializeEvents([...requested(), { type: 'tool.permission.resolved', approvalId: 'ap1', optionId }]));
      expect(state.pendingCalls['c1']?.status).toBe('requested');
      expect(state.pendingCalls['c1']).not.toHaveProperty('options');
      expect(state.pendingCalls['c1']?.resolution).toEqual({ optionId, kind, subjectDigest: digest });
    },
  );

  it('rejects a resolution whose optionId is not among the requested options', () => {
    const payloads: RunEventPayload[] = [...requested(), { type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'opt-missing' }];
    expect(() => foldAll(materializeEvents(payloads))).toThrow(/(ap1[\s\S]*opt-missing|opt-missing[\s\S]*ap1)/);
  });
});

describe('store snapshots', () => {
  it('loads the latest snapshot and the tail after it', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'read a.txt');
    const claim = mustClaim(store, 'w1');
    const payloads = toolRoundTripRun.payloads.filter((payload) => payload.type !== 'user.message' && payload.type !== 'run.status');
    expect(store.append(claim, payloads).kind).toBe('ok');
    const all = store.readRunEvents(run.id, 0, 1000);
    const fresh = initialRunState({ runId: run.id, sessionId: run.sessionId });
    const full = foldAll(all, fresh);

    expect(store.load(run.id)).toEqual({ tail: all });

    expect(store.writeSnapshot(claim, 3, foldAll(all.slice(0, 3), fresh))).toEqual({ kind: 'ok' });
    expect(store.writeSnapshot(claim, 6, foldAll(all.slice(0, 6), fresh))).toEqual({ kind: 'ok' });
    const loaded = store.load(run.id);
    expect(loaded.snapshot?.seq).toBe(6);
    expect(loaded.tail.map((event) => event.seq)).toEqual(all.slice(6).map((event) => event.seq));
    expect(foldAll(loaded.tail, loaded.snapshot!.state)).toEqual(full);
  });

  it('treats a snapshot written by the previous fold as absent and refolds from all events', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id, 'read a.txt');
    const claim = mustClaim(store, 'w1');
    const payloads = toolRoundTripRun.payloads.filter((payload) => payload.type !== 'user.message' && payload.type !== 'run.status');
    expect(store.append(claim, payloads).kind).toBe('ok');
    const all = store.readRunEvents(run.id, 0, 1000);
    const previousFoldState = {
      runId: run.id,
      sessionId: run.sessionId,
      status: 'RUNNING',
      step: 1,
      attempt: 1,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      items: [userItem('read a.txt'), callItem('c1', 'Read', { path: 'a.txt' })],
      pendingCalls: { c1: { name: 'Read', providerCallId: 'c1', arguments: { path: 'a.txt' }, status: 'requested' } },
      notes: [],
      toolCallCounts: { [sha256('Read\n{"path":"a.txt"}')]: 1 },
      lastSeq: 6,
    };
    rawDb(dbPath)
      .prepare('INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (?, 6, ?, 0)')
      .run(run.id, JSON.stringify(previousFoldState));
    const loaded = store.load(run.id);
    expect(loaded).toEqual({ tail: all });
    const fresh = initialRunState({ runId: run.id, sessionId: run.sessionId });
    expect(foldAll(loaded.tail, fresh)).toEqual(foldAll(all, fresh));
  });

  it('reports a current-version snapshot whose history is malformed as corrupt', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const all = store.readRunEvents(run.id, 0, 1000);
    const state = foldAll(all, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    expect(store.writeSnapshot(claim, state.lastSeq, state)).toEqual({ kind: 'ok' });
    expect(store.load(run.id).snapshot?.state).toEqual(state);
    rawDb(dbPath).prepare("UPDATE snapshots SET state_json = json_set(state_json, '$.history', 'oops') WHERE run_id = ?").run(run.id);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });

  it('rejects a snapshot beyond the last event', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const state = initialRunState({ runId: run.id, sessionId: run.sessionId });
    expect(store.writeSnapshot(claim, 5, state).kind).toBe('conflict');
    expect(store.load(run.id).snapshot).toBeUndefined();
  });
});

describe('snapshot validation', () => {
  const richPayloads = (): RunEventPayload[] => [
    { type: 'user.message', text: 'go' },
    ...responded(1, [callItem('cA', 'Read', { path: 'a' })]),
    { type: 'tool.call', callId: 'cA', providerCallId: 'cA', name: 'Read', kind: 'read', title: 'a', rawInput: { path: 'a' } },
    { type: 'tool.started', callId: 'cA', idemKey: 'kA' },
    { type: 'tool.completed', callId: 'cA', status: 'completed', output: 'A' },
    { type: 'user.message', text: 'more' },
    { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'started'), summary: 'started', replacedThroughSeq: 1 },
    ...responded(2, [callItem('cB', 'Bash', { command: 'b' }), callItem('cC', 'Bash', { command: 'c' })]),
    { type: 'tool.call', callId: 'cB', providerCallId: 'cB', name: 'Bash', kind: 'execute', title: 'b', rawInput: { command: 'b' } },
    {
      type: 'tool.permission.requested',
      approvalId: 'apB',
      callId: 'cB',
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
      ],
      subjectDigest: fixtureSubjectDigest('b'),
      reason: 'edits require approval',
    },
    { type: 'tool.call', callId: 'cC', providerCallId: 'cC', name: 'Bash', kind: 'execute', title: 'c', rawInput: { command: 'c' } },
    {
      type: 'tool.permission.requested',
      approvalId: 'apC',
      callId: 'cC',
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
      subjectDigest: fixtureSubjectDigest('c'),
      reason: 'edits require approval',
    },
    { type: 'tool.permission.resolved', approvalId: 'apC', optionId: 'yes' },
  ];

  const storedRichSnapshot = () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const events = store.readRunEvents(run.id, 0, 1000);
    const lastEventSeq = events[events.length - 1]!.seq;
    const state = foldAll(materializeEvents(richPayloads(), { runId: run.id, sessionId: run.sessionId }), initialRunState({ runId: run.id, sessionId: run.sessionId }));
    expect(store.writeSnapshot(claim, lastEventSeq, state)).toEqual({ kind: 'ok' });
    const mutate = (expression: string): void => {
      rawDb(dbPath).prepare(`UPDATE snapshots SET state_json = ${expression} WHERE run_id = ?`).run(run.id);
    };
    return { store, run, state, mutate };
  };

  it('loads the unmodified rich snapshot', () => {
    const { store, run, state } = storedRichSnapshot();
    expect(state.history.map((historyEntry) => historyEntry.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(state.summary?.replacedThroughSeq).toBe(1);
    expect(state.pendingCalls['cB']?.options).toHaveLength(2);
    expect(state.pendingCalls['cC']?.resolution?.kind).toBe('allow_once');
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it.each([
    ['a non-integer history seq', "json_set(state_json, '$.history[0].seq', 2.5)"],
    ['non-increasing history seqs', "json_set(state_json, '$.history[1].seq', 2)"],
    ['nextItemSeq not beyond the last history seq', "json_set(state_json, '$.nextItemSeq', 6)"],
    ['a non-integer nextItemSeq', "json_set(state_json, '$.nextItemSeq', 7.5)"],
    ['replacedThroughSeq at or beyond the first retained seq', "json_set(state_json, '$.summary.replacedThroughSeq', 2)"],
    ['a summary item without string encrypted_content', "json_remove(state_json, '$.summary.item.encrypted_content')"],
    ['a summary item that is not a compaction', "json_set(state_json, '$.summary.item.type', 'message')"],
    ['a function_call item without call_id', "json_remove(state_json, '$.history[0].item.call_id')"],
    ['a function_call_output item without call_id', "json_remove(state_json, '$.history[1].item.call_id')"],
    ['a pending call without name', "json_remove(state_json, '$.pendingCalls.cB.name')"],
    ['a pending call without providerCallId', "json_remove(state_json, '$.pendingCalls.cB.providerCallId')"],
    ['a pending call with an unknown status', "json_set(state_json, '$.pendingCalls.cB.status', 'bogus')"],
    ['a permission option with an unknown kind', "json_set(state_json, '$.pendingCalls.cB.options[0].kind', 'maybe')"],
    ['a resolution with an unknown kind', "json_set(state_json, '$.pendingCalls.cC.resolution.kind', 'maybe')"],
  ])('reports a snapshot with %s as corrupt', (_label, expression) => {
    const { store, run, mutate } = storedRichSnapshot();
    mutate(expression);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });
});

describe('load consistency', () => {
  it('rolls back its read transaction when a snapshot row is corrupt', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    rawDb(dbPath)
      .prepare("INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (?, 1, 'not json', 0)")
      .run(run.id);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
    expect(store.append(claim, [{ type: 'notice', level: 'info', message: 'still writable' }]).kind).toBe('ok');
  });
});
