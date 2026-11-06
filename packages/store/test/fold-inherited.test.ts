import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';
import {
  NEXT_RUN,
  assistantItem,
  callItem,
  claimed,
  closureEntry,
  foldOf,
  inheritedDigest,
  inheritedEvent,
  requested,
  responded,
  task,
  taskItem,
  toolCall,
  toolDone,
} from './inherit-fixtures.ts';

const INHERITED = inheritedEvent({
  fromRunId: 'run-prev',
  fromLastSeq: 9,
  history: [
    { seq: 3, item: taskItem('first') },
    { seq: 4, item: callItem('c_old') },
    { seq: 5, item: { type: 'function_call_output', call_id: 'c_old', output: 'old output' }, callId: 'c_old', handle: 'blob-old' },
    { seq: 6, item: assistantItem('m1', 'answer') },
  ],
  nextItemSeq: 7,
  summary: { item: fixtureCompactionItem('cmp-1', 'before'), summary: 'before', replacedThroughSeq: 2 },
  evicted: ['c_older'],
  mode: 'plan',
  fromMode: 'default',
  markers: [],
  closures: [],
});

const nextRun = (payloads: readonly RunEventPayload[]): RunState => foldOf(payloads, NEXT_RUN);

describe('fold of context.inherited', () => {
  it('prepends the inherited history, rebases the task and records the inheritance', () => {
    const state = nextRun([task('And again'), INHERITED]);
    expect(state.history).toEqual([...INHERITED.history, { seq: 7, item: taskItem('And again') }]);
    expect(state.nextItemSeq).toBe(8);
    expect(state.taskSeq).toBe(7);
    expect(state.summary).toEqual(INHERITED.summary);
    expect(state.evicted).toEqual(['c_older']);
    expect(state.inherited).toEqual({ fromRunId: 'run-prev', fromLastSeq: 9, digest: INHERITED.digest });
    expect(state.mode).toBe('plan');
    expect(state.step).toBe(0);
    expect(state.pendingCalls).toEqual({});
    expect(state.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(state.lastSeq).toBe(2);
  });

  it('carries the working facts of the source run into the child and maps the rebased task to its own event', () => {
    const facts = {
      written: [{ path: '/p/a.ts', sha256: 'a'.repeat(64), seq: 0 }],
      touched: [{ kind: 'file' as const, path: '/p/a.ts' }],
      commands: [{ command: 'make lint', failed: true, seq: 0 }],
      messages: [{ text: 'use two spaces', seq: 0 }],
      itemEvents: [],
    };
    const state = nextRun([task('And again'), inheritedEvent({ fromRunId: 'run-prev', fromLastSeq: 4, history: [], nextItemSeq: 3, workingFacts: facts })]);
    expect(state.workingFacts).toEqual({ ...facts, taskText: 'And again', itemEvents: [{ itemSeq: 3, eventSeq: 1 }] });
  });

  it('records the task of every run as its task text, apart from the messages', () => {
    const state = nextRun([task('And again'), INHERITED]);
    expect(state.workingFacts.taskText).toBe('And again');
    expect(state.workingFacts.messages).toEqual([]);
  });

  it('gives a child of a payload without working facts none, so an older event still folds', () => {
    const state = nextRun([task('And again'), INHERITED]);
    expect(state.workingFacts).toEqual({ written: [], commands: [], messages: [], taskText: 'And again', itemEvents: [{ itemSeq: 7, eventSeq: 1 }] });
  });

  it('starts every run with taskSeq 1', () => {
    expect(initialRunState({ runId: 'r', sessionId: 's' }).taskSeq).toBe(1);
    expect(nextRun([task('alone')]).taskSeq).toBe(1);
  });

  it('sorts the inherited evicted ids', () => {
    const unsorted = inheritedEvent({ fromRunId: 'run-prev', fromLastSeq: 2, history: [], nextItemSeq: 3, evicted: ['c_b', 'c_a'] });
    expect(nextRun([task('x'), unsorted]).evicted).toEqual(['c_a', 'c_b']);
  });

  it('leaves the mode undefined when the payload carries none, and run.started overwrites it later', () => {
    const modeless = inheritedEvent({ fromRunId: 'run-prev', fromLastSeq: 2, history: [{ seq: 1, item: taskItem('first') }], nextItemSeq: 2 });
    const state = nextRun([task('x'), modeless]);
    expect(state.mode).toBeUndefined();
    expect(nextRun([task('x'), INHERITED, ...claimed('acceptEdits')]).mode).toBe('acceptEdits');
  });

  it.each<[string, RunEventPayload[]]>([
    ['a second context.inherited', [task('x'), INHERITED, INHERITED]],
    ['an own model response before it', [task('x'), requested(1), responded(1, [assistantItem('m9', 'early')]), INHERITED]],
    ['a model request (step > 0) before it', [task('x'), requested(1), INHERITED]],
    ['no task before it', [INHERITED]],
  ])('throws on %s, while the same event folds right after the task', (_label, payloads) => {
    expect(() => nextRun([task('x'), INHERITED])).not.toThrow();
    expect(() => nextRun(payloads)).toThrow();
  });

  it('accepts notices and claim events between the task and the event', () => {
    const state = nextRun([task('x'), { type: 'notice', level: 'error', message: 'The attempt failed and will be retried: x' }, { type: 'run.status', from: 'QUEUED', to: 'RUNNING' }, INHERITED]);
    expect(state.taskSeq).toBe(7);
  });

  it('throws when the digest does not match the payload', () => {
    expect(() => nextRun([task('x'), INHERITED])).not.toThrow();
    expect(() => nextRun([task('x'), { ...INHERITED, digest: 'f'.repeat(64) }])).toThrow(/digest/);
    expect(() => nextRun([task('x'), { ...INHERITED, nextItemSeq: 8 }])).toThrow(/digest/);
    expect(() => nextRun([task('x'), { ...INHERITED, mode: 'default' }])).toThrow(/digest/);
  });

  it('throws when the payload seqs are not strictly increasing below nextItemSeq', () => {
    const badNext = inheritedEvent({ fromRunId: 'run-prev', fromLastSeq: 2, history: [{ seq: 1, item: taskItem('first') }, { seq: 2, item: assistantItem('m1', 'a') }], nextItemSeq: 2 });
    expect(() => nextRun([task('x'), badNext])).toThrow(/seqs/);
    const unordered = inheritedEvent({ fromRunId: 'run-prev', fromLastSeq: 2, history: [{ seq: 2, item: taskItem('first') }, { seq: 1, item: assistantItem('m1', 'a') }], nextItemSeq: 3 });
    expect(() => nextRun([task('x'), unordered])).toThrow(/seqs/);
  });

  it('keeps the history seqs consistent so a compaction through a seq >= taskSeq folds', () => {
    const state = nextRun([
      task('x'),
      INHERITED,
      ...claimed('plan'),
      requested(1),
      responded(1, [assistantItem('m2', 'own answer')]),
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-2', 'everything'), summary: 'everything', replacedThroughSeq: 7 },
    ]);
    expect(state.history).toEqual([{ seq: 8, item: assistantItem('m2', 'own answer') }]);
    expect(state.summary?.replacedThroughSeq).toBe(7);
    expect(state.taskSeq).toBe(7);
  });
});

describe('fold of context.truncated on an inherited output', () => {
  it('sets the handle and evicts an inherited output that has no pending call', () => {
    const state = nextRun([task('x'), INHERITED, { type: 'context.truncated', callId: 'c_old', handle: 'blob-new', kind: 'omitted' }]);
    expect(state.history.find((entry) => entry.callId === 'c_old')).toEqual({ ...INHERITED.history[2], handle: 'blob-new' });
    expect(state.evicted).toEqual(['c_old', 'c_older']);
  });

  it('accepts a truncated kind without evicting', () => {
    const state = nextRun([task('x'), INHERITED, { type: 'context.truncated', callId: 'c_old', handle: 'blob-cut', kind: 'truncated' }]);
    expect(state.evicted).toEqual(['c_older']);
    expect(state.history.find((entry) => entry.callId === 'c_old')?.handle).toBe('blob-cut');
  });

  it('still throws for an unknown call id', () => {
    expect(() => nextRun([task('x'), INHERITED, { type: 'context.truncated', callId: 'c_none', handle: 'h', kind: 'omitted' }])).toThrow(/unknown tool call/);
  });

  it('still throws for an own call that has not finished', () => {
    expect(() =>
      nextRun([task('x'), INHERITED, requested(1), responded(1, [callItem('c_new')]), toolCall('c_new'), { type: 'context.truncated', callId: 'c_new', handle: 'h', kind: 'omitted' }]),
    ).toThrow(/not finished/);
  });

  it('keeps the existing rule for a finished own call', () => {
    const state = nextRun([
      task('x'),
      INHERITED,
      requested(1),
      responded(1, [callItem('c_new')]),
      toolCall('c_new'),
      ...toolDone('c_new', 'fresh'),
      { type: 'context.truncated', callId: 'c_new', handle: 'h-new', kind: 'omitted' },
    ]);
    expect(state.evicted).toEqual(['c_new', 'c_older']);
  });
});

describe('a closure entry from the projection folds like any output', () => {
  it('lets a following own response reuse nothing and keeps pairs intact', () => {
    const closed = inheritedEvent({
      fromRunId: 'run-prev',
      fromLastSeq: 4,
      history: [{ seq: 1, item: taskItem('first') }, { seq: 2, item: callItem('c_d') }, closureEntry(3, 'c_d', 'Not run: the user interrupted the previous request before this tool call ran.')],
      nextItemSeq: 4,
      closures: [{ callId: 'c_d', seq: 3, effect: 'not_executed', announced: false }],
      mode: 'default',
    });
    const state = nextRun([task('x'), closed]);
    expect(state.history.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(inheritedDigest(closed)).toBe(closed.digest);
  });
});

describe('snapshot plus tail equals the full fold for an inheriting run', () => {
  it('holds at every seq over a journal with the event, modes, deltas, a compaction through the task, a truncation and a rejection', () => {
    const { store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id, 'continue');
    const claim = mustClaim(store, 'w1');
    const journal: RunEventPayload[] = [
      INHERITED,
      ...claimed('plan').slice(1),
      { type: 'context.truncated', callId: 'c_old', handle: 'blob-evict', kind: 'omitted' },
      requested(1),
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'mx', text: 'discarded' },
      { type: 'model.stream.restarted', step: 1, attempt: 1 },
      { type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'my', text: 'kept' },
      responded(1, [assistantItem('m2', 'kept')]),
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-2', 'through the task'), summary: 'through the task', replacedThroughSeq: 7 },
      { type: 'context.compaction_rejected', item: { type: 'message', role: 'user', content: '<conversation_summary>\nthrough the task\n</conversation_summary>' } },
      requested(2),
      { type: 'agent.message.delta', step: 2, attempt: 1, itemId: 'mz', text: 'partial' },
    ];
    expect(store.append(claim, journal).kind).toBe('ok');
    const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
    const initial = initialRunState({ runId: run.id, sessionId: run.sessionId });
    const full = events.reduce(foldRunState, initial);
    expect(full.taskSeq).toBe(7);
    expect(full.inherited?.digest).toBe(INHERITED.digest);
    expect(full.mode).toBe('plan');
    for (let k = 1; k <= events.length; k += 1) {
      const prefix = events.slice(0, k).reduce(foldRunState, initial);
      expect(store.writeSnapshot(claim, events[k - 1]!.seq, prefix)).toEqual({ kind: 'ok' });
      const loaded = store.load(run.id);
      expect(loaded.snapshot?.seq).toBe(events[k - 1]!.seq);
      expect(loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initial)).toEqual(full);
    }
  });
});
