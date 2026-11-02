import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { PERMISSION_MODES, STOP_REASONS } from '@momonga/protocol';
import type { PermissionMode, RunEventPayload, RunState } from '@momonga/protocol';
import { applyInheritance, projectInheritance } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import {
  CLOSURE_TEXT,
  MARKER_TEXT,
  NEXT_RUN,
  SOURCE_RUN,
  assistantItem,
  callItem,
  claimed,
  closureEntry,
  ended,
  foldOf,
  hasAdjacentAssistants,
  hasConsistentSeqs,
  inheritedDigest,
  inheritedEvent,
  markerEntry,
  modeChangedText,
  pairsEveryCall,
  partialEntry,
  requested,
  responded,
  startedClosureText,
  task,
  taskItem,
  toolCall,
  toolDone,
} from './inherit-fixtures.ts';
import type { InheritedEvent, Outcome } from './inherit-fixtures.ts';

const FINAL_DEFAULT = { kind: 'final', currentMode: 'default' } as const;
const CANCELLED: Outcome = { status: 'CANCELLED' };

const project = (state: RunState, outcome: Outcome, kind: Parameters<typeof projectInheritance>[2] = FINAL_DEFAULT): InheritedEvent =>
  projectInheritance(state, outcome, kind) as InheritedEvent;

const expectWellFormed = (payload: InheritedEvent): void => {
  expect(payload.digest).toBe(inheritedDigest(payload));
  expect(hasConsistentSeqs(payload)).toBe(true);
  expect(pairsEveryCall(payload.history)).toBe(true);
  expect(hasAdjacentAssistants(payload.history)).toBe(false);
};

const answered = (mode: PermissionMode | undefined): RunState =>
  foldOf([task('Say hello'), ...claimed(mode), requested(1), responded(1, [assistantItem('m1', 'hello')]), ended('COMPLETED')]);

const danglingSource = (extra: readonly RunEventPayload[], end: RunEventPayload): RunState =>
  foldOf([task('Write both'), ...claimed('default'), requested(1), responded(1, [callItem('c1'), callItem('c2')]), ...extra, end]);

const withdrawn = (reason: 'withdrawn' | 'expired'): RunEventPayload[] => [
  toolCall('c1'),
  toolCall('c2'),
  {
    type: 'tool.permission.requested',
    approvalId: 'appr-1',
    callId: 'c1',
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    subjectDigest: 'a'.repeat(64),
  },
  { type: 'tool.permission.cancelled', approvalId: 'appr-1', reason },
];

describe('projectInheritance: a completed conversation', () => {
  it('carries the history, the seqs, the source mode and no synthetic entry', () => {
    const state = answered('default');
    const payload = project(state, { status: 'COMPLETED' });
    expect(payload).toEqual({
      type: 'context.inherited',
      fromRunId: SOURCE_RUN,
      fromLastSeq: state.lastSeq,
      history: [
        { seq: 1, item: taskItem('Say hello') },
        { seq: 2, item: assistantItem('m1', 'hello') },
      ],
      nextItemSeq: 3,
      evicted: [],
      closures: [],
      markers: [],
      fromMode: 'default',
      mode: 'default',
      digest: inheritedDigest({ history: state.history, nextItemSeq: 3, evicted: [], mode: 'default' }),
    });
    expectWellFormed(payload);
  });

  it('carries the summary, the evicted ids and the output handles', () => {
    const state = foldOf([
      task('Read it'),
      ...claimed('default'),
      requested(1),
      responded(1, [assistantItem('m0', 'earlier')]),
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'the summary'), summary: 'the summary', replacedThroughSeq: 2 },
      requested(2),
      responded(2, [callItem('c1')]),
      toolCall('c1'),
      ...toolDone('c1', 'big output'),
      { type: 'context.truncated', callId: 'c1', handle: 'blob-c1', kind: 'omitted' },
      requested(3),
      responded(3, [assistantItem('m1', 'done')]),
      ended('COMPLETED'),
    ]);
    const payload = project(state, { status: 'COMPLETED' });
    expect(payload.summary).toEqual({ item: fixtureCompactionItem('cmp-1', 'the summary'), summary: 'the summary', replacedThroughSeq: 2 });
    expect(payload.evicted).toEqual(['c1']);
    expect(payload.history).toEqual(state.history);
    expect(payload.history.find((entry) => entry.item.type === 'function_call_output')?.handle).toBe('blob-c1');
    expect(payload.nextItemSeq).toBe(6);
    expectWellFormed(payload);
  });
});

describe('projectInheritance: closures for dangling calls', () => {
  it.each<[string, readonly RunEventPayload[], RunEventPayload, Outcome, string, boolean]>([
    ['cancelled before recordCalls', [], ended('CANCELLED'), CANCELLED, CLOSURE_TEXT.cancelled, false],
    ['cancelled with an approval wait withdrawn', withdrawn('withdrawn'), ended('CANCELLED'), CANCELLED, CLOSURE_TEXT.cancelled, true],
    ['cancelled with an approval that was never announced', [toolCall('c1'), toolCall('c2')], ended('CANCELLED'), CANCELLED, CLOSURE_TEXT.cancelled, true],
    ['stopped by the loop check', [], ended('STOPPED', 'loop'), { status: 'STOPPED', stopReason: 'loop' }, CLOSURE_TEXT.loop, false],
    ['stopped by the run timeout', [toolCall('c1'), toolCall('c2')], ended('STOPPED', 'timeout'), { status: 'STOPPED', stopReason: 'timeout' }, CLOSURE_TEXT.timeout, true],
    ['failed', [], ended('FAILED', 'server_error'), { status: 'FAILED', errorCode: 'server_error' }, CLOSURE_TEXT.failed, false],
    ['stopped at max_steps', [], ended('STOPPED', 'max_steps'), { status: 'STOPPED', stopReason: 'max_steps' }, CLOSURE_TEXT.other, false],
    ['stopped at the budget', [], ended('STOPPED', 'budget'), { status: 'STOPPED', stopReason: 'budget' }, CLOSURE_TEXT.other, false],
    ['stopped at max_tokens', [], ended('STOPPED', 'max_tokens'), { status: 'STOPPED', stopReason: 'max_tokens' }, CLOSURE_TEXT.other, false],
    ['stopped by a refusal', [], ended('STOPPED', 'refusal'), { status: 'STOPPED', stopReason: 'refusal' }, CLOSURE_TEXT.other, false],
    ['completed', [], ended('COMPLETED'), { status: 'COMPLETED' }, CLOSURE_TEXT.other, false],
  ])('closes both calls of a run %s, in call order, after the source items', (_label, extra, end, outcome, text, announced) => {
    const state = danglingSource(extra, end);
    expect(state.nextItemSeq).toBe(4);
    const payload = project(state, outcome);
    expect(payload.history).toEqual([...state.history, closureEntry(4, 'c1', text), closureEntry(5, 'c2', text)]);
    expect(payload.closures).toEqual([
      { callId: 'c1', seq: 4, effect: 'not_executed', announced },
      { callId: 'c2', seq: 5, effect: 'not_executed', announced },
    ]);
    expect(payload.markers).toEqual([]);
    expect(payload.partial).toBeUndefined();
    expect(payload.nextItemSeq).toBe(6);
    expectWellFormed(payload);
  });

  it('closes only the call still dangling after an approval timeout, keeping its completed sibling', () => {
    const state = danglingSource([...withdrawn('expired'), ...toolDone('c2', 'wrote c2')], ended('STOPPED', 'approval_timeout'));
    const payload = project(state, { status: 'STOPPED', stopReason: 'approval_timeout' });
    expect(state.history.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(payload.history).toEqual([...state.history, closureEntry(5, 'c1', CLOSURE_TEXT.approvalTimeout)]);
    expect(payload.closures).toEqual([{ callId: 'c1', seq: 5, effect: 'not_executed', announced: true }]);
    expect(payload.nextItemSeq).toBe(6);
    expectWellFormed(payload);
  });

  it.each<[string, RunEventPayload, Outcome, string]>([
    ['failed', ended('FAILED', 'server_error'), { status: 'FAILED', errorCode: 'server_error' }, 'ended with an error'],
    ['cancelled', ended('CANCELLED'), CANCELLED, 'was interrupted by the user'],
    ['timed out', ended('STOPPED', 'timeout'), { status: 'STOPPED', stopReason: 'timeout' }, 'ran out of time'],
    ['stopped by the loop check', ended('STOPPED', 'loop'), { status: 'STOPPED', stopReason: 'loop' }, 'was stopped'],
    ['stopped at max_steps', ended('STOPPED', 'max_steps'), { status: 'STOPPED', stopReason: 'max_steps' }, 'was stopped'],
  ])('marks a started call of a run that %s as unknown', (_label, end, outcome, phrase) => {
    const state = danglingSource([toolCall('c1'), toolCall('c2'), { type: 'tool.started', callId: 'c1', idemKey: 'k-c1' }], end);
    const payload = project(state, outcome);
    expect(payload.history.slice(-2)).toEqual([closureEntry(4, 'c1', startedClosureText(phrase)), closureEntry(5, 'c2', closureTextFor(outcome))]);
    expect(payload.closures).toEqual([
      { callId: 'c1', seq: 4, effect: 'unknown', announced: true },
      { callId: 'c2', seq: 5, effect: 'not_executed', announced: true },
    ]);
    expectWellFormed(payload);
  });

  it('throws InheritanceError previous_run_inconsistent when an output has no call', () => {
    const state = answered('default');
    const broken: RunState = { ...state, history: [...state.history, { seq: 3, item: { type: 'function_call_output', call_id: 'ghost', output: 'x' }, callId: 'ghost' }], nextItemSeq: 4 };
    expect(() => project(broken, { status: 'COMPLETED' })).toThrow(expect.objectContaining({ name: 'InheritanceError', code: 'previous_run_inconsistent' }));
  });
});

const closureTextFor = (outcome: Outcome): string => {
  if (outcome.status === 'CANCELLED') return CLOSURE_TEXT.cancelled;
  if (outcome.status === 'FAILED') return CLOSURE_TEXT.failed;
  if (outcome.stopReason === 'timeout') return CLOSURE_TEXT.timeout;
  if (outcome.stopReason === 'loop') return CLOSURE_TEXT.loop;
  if (outcome.stopReason === 'approval_timeout') return CLOSURE_TEXT.approvalTimeout;
  return CLOSURE_TEXT.other;
};

describe('projectInheritance: the partial assistant message', () => {
  const streamed = (end: RunEventPayload): RunState =>
    foldOf([
      task('Explain'),
      ...claimed('default'),
      requested(1),
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text: 'Hel' },
      { type: 'agent.thought.delta', step: 1, attempt: 1, itemId: 'r1', text: 'thinking' },
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text: 'lo' },
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm2', text: 'More' },
      end,
    ]);

  it('rebuilds the streamed text as an incomplete assistant item followed by the interrupted marker', () => {
    const payload = project(streamed(ended('CANCELLED')), CANCELLED);
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Explain') }, partialEntry(2, 'Hello\n\nMore'), markerEntry(3, MARKER_TEXT.userInterrupted)]);
    expect(payload.partial).toEqual({ seq: 2 });
    expect(payload.markers).toEqual([{ seq: 3, kind: 'interrupted' }]);
    expect(payload.closures).toEqual([]);
    expect(payload.nextItemSeq).toBe(4);
    expectWellFormed(payload);
  });

  it('uses the ended-before-finished marker after a failed stream', () => {
    const payload = project(streamed(ended('FAILED', 'stream_interrupted')), { status: 'FAILED', errorCode: 'stream_interrupted' });
    expect(payload.history.slice(1)).toEqual([partialEntry(2, 'Hello\n\nMore'), markerEntry(3, MARKER_TEXT.ended)]);
    expectWellFormed(payload);
  });

  it('projects no partial message for a thought-only stream, and marks the unanswered task', () => {
    const state = foldOf([task('Explain'), ...claimed('default'), requested(1), { type: 'agent.thought.delta', step: 1, attempt: 1, itemId: 'r1', text: 'thinking' }, ended('CANCELLED')]);
    expect(state.streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [] });
    const payload = project(state, CANCELLED);
    expect(payload.partial).toBeUndefined();
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Explain') }, markerEntry(2, MARKER_TEXT.userInterrupted)]);
    expectWellFormed(payload);
  });

  it('projects no partial message after model.stream.restarted discarded the text', () => {
    const state = foldOf([
      task('Explain'),
      ...claimed('default'),
      requested(1),
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text: 'stale' },
      { type: 'model.stream.restarted', step: 1, attempt: 1 },
      ended('FAILED', 'call_id_reused'),
    ]);
    const payload = project(state, { status: 'FAILED', errorCode: 'call_id_reused' });
    expect(payload.partial).toBeUndefined();
    expect(JSON.stringify(payload.history)).not.toContain('stale');
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Explain') }, markerEntry(2, MARKER_TEXT.ended)]);
  });

  it('places a partial message after a tool output without an adjacent assistant item', () => {
    const state = foldOf([
      task('Explain'),
      ...claimed('default'),
      requested(1),
      responded(1, [callItem('c1')]),
      toolCall('c1'),
      ...toolDone('c1', 'contents'),
      requested(2),
      { type: 'agent.message.delta', step: 2, attempt: 1, itemId: 'm2', text: 'The file says' },
      ended('CANCELLED'),
    ]);
    const payload = project(state, CANCELLED);
    expect(payload.history.slice(-2)).toEqual([partialEntry(4, 'The file says'), markerEntry(5, MARKER_TEXT.userInterrupted)]);
    expect(payload.closures).toEqual([]);
    expectWellFormed(payload);
  });
});

describe('projectInheritance: interruption markers', () => {
  it('marks a claimed run cancelled before its first response', () => {
    const state = foldOf([task('Do it'), ...claimed('default'), ended('CANCELLED')]);
    const payload = project(state, CANCELLED);
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Do it') }, markerEntry(2, MARKER_TEXT.userInterrupted)]);
    expect(payload.markers).toEqual([{ seq: 2, kind: 'interrupted' }]);
    expect(payload.nextItemSeq).toBe(3);
    expectWellFormed(payload);
  });

  it('contributes nothing for a run cancelled before run.started, with no marker', () => {
    const state = foldOf([task('Do it'), { type: 'run.status', from: 'QUEUED', to: 'CANCELLING' }, { type: 'run.status', from: 'CANCELLING', to: 'CANCELLED' }]);
    const payload = project(state, CANCELLED);
    expect(payload.history).toEqual([]);
    expect(payload.markers).toEqual([]);
    expectWellFormed(payload);
  });

  it('keeps the inherited part and drops only the own task of a cancelled run that never started', () => {
    const inherited = inheritedEvent({
      fromRunId: 'run-older',
      fromLastSeq: 5,
      history: [
        { seq: 1, item: taskItem('first') },
        { seq: 2, item: assistantItem('m1', 'answer') },
      ],
      nextItemSeq: 3,
      mode: 'default',
    });
    const state = foldOf([task('Cancelled early'), inherited, { type: 'run.status', from: 'QUEUED', to: 'CANCELLING' }, { type: 'run.status', from: 'CANCELLING', to: 'CANCELLED' }]);
    const payload = project(state, CANCELLED);
    expect(payload.history).toEqual(inherited.history);
    expect(payload.markers).toEqual([]);
    expectWellFormed(payload);
  });

  it('marks a never-claimed run that timed out in the queue as unprocessed', () => {
    const state = foldOf([task('Queued'), { type: 'run.status', from: 'QUEUED', to: 'STOPPED', reason: 'timeout' }]);
    const payload = project(state, { status: 'STOPPED', stopReason: 'timeout' });
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Queued') }, markerEntry(2, MARKER_TEXT.unprocessed)]);
    expect(payload.markers).toEqual([{ seq: 2, kind: 'unprocessed' }]);
    expectWellFormed(payload);
  });

  it('marks a dead-lettered run that never got a response with the ended marker', () => {
    const state = foldOf([task('Queued'), { type: 'run.status', from: 'RUNNING', to: 'FAILED', reason: 'max_attempts' }]);
    const payload = project(state, { status: 'FAILED', errorCode: 'max_attempts' });
    expect(payload.history).toEqual([{ seq: 1, item: taskItem('Queued') }, markerEntry(2, MARKER_TEXT.ended)]);
    expect(payload.markers).toEqual([{ seq: 2, kind: 'interrupted' }]);
  });

  it.each<[string, RunEventPayload, Outcome]>([
    ['completed', ended('COMPLETED'), { status: 'COMPLETED' }],
    ['stopped at max_steps after its summary', ended('STOPPED', 'max_steps'), { status: 'STOPPED', stopReason: 'max_steps' }],
    ['cancelled after a complete answer', ended('CANCELLED'), CANCELLED],
  ])('adds no marker after a complete assistant message of a run %s', (_label, end, outcome) => {
    const state = foldOf([task('Say hello'), ...claimed('default'), requested(1), responded(1, [assistantItem('m1', 'hello')]), end]);
    const payload = project(state, outcome);
    expect(payload.history).toEqual(state.history);
    expect(payload.markers).toEqual([]);
  });

  it('adds no interruption marker for a summary-only source', () => {
    const state = foldOf([
      task('Say hello'),
      ...claimed('default'),
      requested(1),
      responded(1, [assistantItem('m1', 'hello')]),
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'all of it'), summary: 'all of it', replacedThroughSeq: 2 },
      ended('CANCELLED'),
    ]);
    expect(state.history).toEqual([]);
    const payload = project(state, CANCELLED);
    expect(payload.history).toEqual([]);
    expect(payload.markers).toEqual([]);
    expect(payload.summary?.replacedThroughSeq).toBe(2);
    expect(payload.nextItemSeq).toBe(3);
    expectWellFormed(payload);
  });
});

describe('projectInheritance: pinned_overflow', () => {
  it('replaces the task of a step-0 pinned_overflow run in place by the dropped marker, with no other marker', () => {
    const state = foldOf([task('x'.repeat(50)), ...claimed('default'), ended('FAILED', 'pinned_overflow')]);
    expect(state.step).toBe(0);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: [] });
    expect(payload.history).toEqual([markerEntry(1, MARKER_TEXT.dropped)]);
    expect(payload.markers).toEqual([{ seq: 1, kind: 'dropped' }]);
    expect(payload.nextItemSeq).toBe(2);
    expectWellFormed(payload);
  });

  it('replaces the rebased task of an inheriting run, keeping the inherited entries and seqs', () => {
    const inherited = inheritedEvent({
      fromRunId: 'run-older',
      fromLastSeq: 5,
      history: [
        { seq: 1, item: taskItem('first') },
        { seq: 2, item: assistantItem('m1', 'answer') },
      ],
      nextItemSeq: 3,
      mode: 'default',
    });
    const state = foldOf([task('x'.repeat(50)), inherited, ...claimed('default'), ended('FAILED', 'pinned_overflow')]);
    expect(state.taskSeq).toBe(3);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: [] });
    expect(payload.history).toEqual([...inherited.history, markerEntry(3, MARKER_TEXT.dropped)]);
    expect(payload.markers).toEqual([{ seq: 3, kind: 'dropped' }]);
    expect(payload.nextItemSeq).toBe(4);
  });

  it('keeps the task and every item when pinned_overflow happened after the first model request', () => {
    const state = foldOf([
      task('Write'),
      ...claimed('default'),
      requested(1),
      responded(1, [callItem('c1')]),
      toolCall('c1'),
      ...toolDone('c1', 'written'),
      ended('FAILED', 'pinned_overflow'),
    ]);
    expect(state.step).toBe(1);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: [] });
    expect(payload.history).toEqual(state.history);
    expect(payload.history[0]).toEqual({ seq: 1, item: taskItem('Write') });
    expect(payload.markers).toEqual([]);
    expect(payload.closures).toEqual([]);
    expect(payload.nextItemSeq).toBe(state.nextItemSeq);
  });
});

describe('projectInheritance: skills of a pinned_overflow run', () => {
  const skill = (name: string): RunEventPayload => ({ type: 'skill.activated', name, content: `${name} body` });
  const carriedPdf = inheritedEvent({
    fromRunId: 'run-older',
    fromLastSeq: 5,
    history: [{ seq: 1, item: taskItem('first') }],
    nextItemSeq: 2,
    mode: 'default',
    activatedSkills: [{ name: 'pdf', content: 'pdf body' }],
  });

  it('drops the skills a step-0 pinned_overflow run brought itself and keeps the ones it inherited', () => {
    const state = foldOf([task('x'), carriedPdf, skill('huge'), ...claimed('default'), ended('FAILED', 'pinned_overflow')]);
    expect(state.activatedSkills.map((entry) => entry.name)).toEqual(['pdf', 'huge']);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: ['pdf'] });
    expect(payload.activatedSkills).toEqual([{ name: 'pdf', content: 'pdf body' }]);
    expectWellFormed(payload);
  });

  it('carries no skill forward when a first run brought the only one', () => {
    const state = foldOf([task('x'), skill('huge'), ...claimed('default'), ended('FAILED', 'pinned_overflow')]);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: [] });
    expect(payload.activatedSkills).toBeUndefined();
    expectWellFormed(payload);
  });

  it('keeps every skill when pinned_overflow happened after the first model request', () => {
    const state = foldOf([task('x'), skill('big'), ...claimed('default'), requested(1), responded(1, [assistantItem('m1', 'hi')]), ended('FAILED', 'pinned_overflow')]);
    const payload = project(state, { status: 'FAILED', errorCode: 'pinned_overflow', carriedSkills: [] });
    expect(payload.activatedSkills).toEqual([{ name: 'big', content: 'big body' }]);
  });

  it('refuses to project a step-0 pinned_overflow run whose carried skills are unknown', () => {
    const state = foldOf([task('x'), skill('huge'), ...claimed('default'), ended('FAILED', 'pinned_overflow')]);
    expect(() => project(state, { status: 'FAILED', errorCode: 'pinned_overflow' })).toThrow('the skills carried into a step-0 pinned_overflow run are not known');
  });
});

describe('projectInheritance: the mode', () => {
  it('appends the mode_changed marker last, after the interruption marker, when the final mode differs', () => {
    const state = foldOf([task('Do it'), ...claimed('default'), ended('CANCELLED')]);
    const payload = project(state, CANCELLED, { kind: 'final', currentMode: 'plan' });
    expect(payload.history).toEqual([
      { seq: 1, item: taskItem('Do it') },
      markerEntry(2, MARKER_TEXT.userInterrupted),
      markerEntry(3, modeChangedText('default', 'plan')),
    ]);
    expect(payload.markers).toEqual([
      { seq: 2, kind: 'interrupted' },
      { seq: 3, kind: 'mode_changed' },
    ]);
    expect(payload.fromMode).toBe('default');
    expect(payload.mode).toBe('plan');
    expect(payload.nextItemSeq).toBe(4);
    expectWellFormed(payload);
  });

  const pairs = PERMISSION_MODES.flatMap((from) => PERMISSION_MODES.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)('announces a change from %s to %s with the label and rule of the new mode', (from, to) => {
    const payload = project(answered(from), { status: 'COMPLETED' }, { kind: 'final', currentMode: to });
    expect(payload.history.at(-1)).toEqual(markerEntry(3, modeChangedText(from, to)));
    expect(payload.markers).toEqual([{ seq: 3, kind: 'mode_changed' }]);
    expect(payload.fromMode).toBe(from);
    expect(payload.mode).toBe(to);
  });

  it('adds no marker when the mode is unchanged and records the current mode', () => {
    const payload = project(answered('plan'), { status: 'COMPLETED' }, { kind: 'final', currentMode: 'plan' });
    expect(payload.markers).toEqual([]);
    expect(payload.history).toHaveLength(2);
    expect(payload.mode).toBe('plan');
  });

  it('adds no marker when the source mode is unknown and still records the current mode', () => {
    const state = answered(undefined);
    expect(state.mode).toBeUndefined();
    const payload = project(state, { status: 'COMPLETED' }, { kind: 'final', currentMode: 'acceptEdits' });
    expect(payload.markers).toEqual([]);
    expect(payload.fromMode).toBeUndefined();
    expect(payload.mode).toBe('acceptEdits');
    expectWellFormed(payload);
  });

  it('never emits mode_changed in an intermediate projection and carries the source mode', () => {
    const known = project(answered('default'), { status: 'COMPLETED' }, { kind: 'intermediate' });
    expect(known.markers).toEqual([]);
    expect(known.mode).toBe('default');
    const unknown = project(answered(undefined), { status: 'COMPLETED' }, { kind: 'intermediate' });
    expect(unknown.mode).toBeUndefined();
    expect(unknown.digest).toBe(inheritedDigest(unknown));
  });

  it('changes the digest when only the mode differs', () => {
    const state = answered(undefined);
    const asDefault = project(state, { status: 'COMPLETED' }, { kind: 'final', currentMode: 'default' });
    const asPlan = project(state, { status: 'COMPLETED' }, { kind: 'final', currentMode: 'plan' });
    expect(asPlan.history).toEqual(asDefault.history);
    expect(asPlan.digest).not.toBe(asDefault.digest);
  });
});

describe('projectInheritance: determinism and wording', () => {
  it('gives byte-identical canonical JSON for the same input', () => {
    const state = danglingSource([toolCall('c1'), toolCall('c2'), { type: 'tool.started', callId: 'c1', idemKey: 'k-c1' }], ended('CANCELLED'));
    expect(canonicalJson(project(state, CANCELLED, { kind: 'final', currentMode: 'plan' }))).toBe(canonicalJson(project(state, CANCELLED, { kind: 'final', currentMode: 'plan' })));
  });

  it('never puts a stop reason, a status or an error code into a model-facing text', () => {
    const outcomes: Outcome[] = [
      CANCELLED,
      { status: 'FAILED', errorCode: 'server_error' },
      { status: 'COMPLETED' },
      ...STOP_REASONS.map((stopReason): Outcome => ({ status: 'STOPPED', stopReason })),
    ];
    const texts = new Set<string>();
    for (const outcome of outcomes) {
      for (const state of [
        danglingSource([toolCall('c1'), toolCall('c2'), { type: 'tool.started', callId: 'c1', idemKey: 'k-c1' }], ended('CANCELLED')),
        foldOf([task('Do it'), ...claimed('default'), ended('CANCELLED')]),
      ]) {
        const payload = project(state, outcome, { kind: 'final', currentMode: 'plan' });
        for (const entry of payload.history.filter((candidate) => candidate.seq >= state.nextItemSeq)) {
          const item = entry.item as { output?: unknown; content?: unknown };
          texts.add(String(item.output ?? item.content));
        }
      }
    }
    const queued = project(foldOf([task('Queued'), { type: 'run.status', from: 'QUEUED', to: 'STOPPED', reason: 'timeout' }]), { status: 'STOPPED', stopReason: 'timeout' });
    texts.add(String(queued.history.at(-1)?.item.type === 'message' ? (queued.history.at(-1)?.item as { content: unknown }).content : ''));
    expect(texts.size).toBeGreaterThan(8);
    const tokens = [...STOP_REASONS, 'pinned_overflow', 'server_error', 'COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'];
    for (const text of texts) for (const token of tokens) expect(text, text).not.toMatch(new RegExp(`\\b${token}\\b`));
  });
});

describe('applyInheritance', () => {
  it('rebases the task after the inherited entries and records the inheritance', () => {
    const payload = project(answered('default'), { status: 'COMPLETED' }, { kind: 'final', currentMode: 'plan' });
    const fresh = foldOf([task('And again')], NEXT_RUN);
    const next = applyInheritance(fresh, payload as never);
    expect(next.history).toEqual([...payload.history, { seq: payload.nextItemSeq, item: taskItem('And again') }]);
    expect(next.nextItemSeq).toBe(payload.nextItemSeq + 1);
    expect(next.taskSeq).toBe(payload.nextItemSeq);
    expect(next.inherited).toEqual({ fromRunId: SOURCE_RUN, fromLastSeq: payload.fromLastSeq, digest: payload.digest });
    expect(next.mode).toBe('plan');
    expect(next.evicted).toEqual([]);
    expect(next.summary).toBeUndefined();
    expect(next.runId).toBe(NEXT_RUN);
    expect(next.step).toBe(0);
    expect(next.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(next.pendingCalls).toEqual({});
    expect(next.notes).toEqual([]);
  });
});
