import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { initialTranscript, nextMode, reduceEvent, settledCount } from '../src/tui/transcript.ts';
import type { Transcript } from '../src/tui/transcript.ts';

const envelope = { id: 1, runId: 'r', sessionId: 's', seq: 1, step: 1, createdAt: 1 } as const;

const apply = (events: readonly Record<string, unknown>[]): Transcript =>
  events.reduce<Transcript>((state, event) => reduceEvent(state, { ...envelope, ...event } as PublicRunEvent), initialTranscript);

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Read', kind: 'read', title: 'Read /a', rawInput: {} };

describe('reduceEvent', () => {
  it('appends message deltas of one item and starts a new entry for the next item', () => {
    const state = apply([
      { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'Hel' },
      { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'lo' },
      { type: 'agent.message.delta', attempt: 0, itemId: 'b', text: 'again' },
    ]);
    expect(state.entries).toEqual([
      { kind: 'assistant', itemId: 'a', text: 'Hello', open: false },
      { kind: 'assistant', itemId: 'b', text: 'again', open: true },
    ]);
  });

  it('follows a tool call from requested to running to completed', () => {
    const states = [call, { type: 'tool.started', callId: 'c1', idemKey: 'k' }, { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok' }].map((_, index, all) => apply(all.slice(0, index + 1)));
    expect(states.map((state) => state.entries[0])).toMatchObject([{ status: 'requested' }, { status: 'running' }, { status: 'completed', output: 'ok' }]);
  });

  it('holds a pending approval until it is resolved or cancelled', () => {
    const requested = { type: 'tool.permission.requested', approvalId: 'ap', callId: 'c1', subjectDigest: 'd', options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }] };
    const pending = apply([call, requested]);
    expect(pending.approval).toMatchObject({ approvalId: 'ap', callId: 'c1' });
    expect(pending.entries[0]).toMatchObject({ status: 'awaiting_approval' });
    expect(apply([call, requested, { type: 'tool.permission.resolved', approvalId: 'ap', optionId: 'o' }]).approval).toBeUndefined();
    expect(apply([call, requested, { type: 'tool.permission.cancelled', approvalId: 'ap', reason: 'withdrawn' }]).approval).toBeUndefined();
    expect(apply([call, requested, { type: 'tool.permission.resolved', approvalId: 'other', optionId: 'o' }]).approval).toBeDefined();
  });

  it('marks an interrupted tool as unknown with the reconciliation text', () => {
    const state = apply([call, { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'effect unknown' }]);
    expect(state.entries[0]).toMatchObject({ status: 'unknown', output: 'effect unknown' });
  });

  it('keeps usage and the context size of the last model response', () => {
    const state = apply([
      { type: 'usage.updated', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { type: 'model.responded', attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(state.contextTokens).toBe(15);
  });

  it('records notices and compaction, and clears the approval when the run ends', () => {
    const state = apply([
      { type: 'notice', level: 'warning', message: 'careful' },
      { type: 'context.compacted', summary: 's', replacedThroughSeq: 3 },
      { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
    ]);
    expect(state.entries).toEqual([
      { kind: 'notice', level: 'warning', text: 'careful' },
      { kind: 'notice', level: 'info', text: 'context compacted' },
    ]);
    expect(state.runStatus).toBe('COMPLETED');
  });

  it('shows the plan live and folds it into the transcript when the run ends', () => {
    const plan = { type: 'plan.updated', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] };
    const live = apply([plan]);
    expect(live.entries[0]).toMatchObject({ kind: 'plan' });
    expect(settledCount(live.entries)).toBe(0);
    const ended = apply([plan, { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }]);
    expect(ended.entries).toEqual([{ kind: 'info', text: '[x] step one' }]);
  });

  it('ignores events it has no view for', () => {
    expect(apply([{ type: 'instructions.loaded', path: '/a' }])).toEqual(initialTranscript);
  });
});

describe('settledCount', () => {
  it('counts the leading entries that can no longer change', () => {
    const state = apply([call, { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'x' }]);
    expect(settledCount(state.entries)).toBe(0);
    const done = apply([call, { type: 'tool.completed', callId: 'c1', status: 'completed', output: '' }, { type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'x' }]);
    expect(settledCount(done.entries)).toBe(1);
  });
});

describe('nextMode', () => {
  it('cycles default, acceptEdits, plan and back, skipping bypassPermissions unless the session may use it', () => {
    expect(nextMode({ current: 'default', bypassAllowed: false })).toBe('acceptEdits');
    expect(nextMode({ current: 'acceptEdits', bypassAllowed: false })).toBe('plan');
    expect(nextMode({ current: 'plan', bypassAllowed: false })).toBe('default');
    expect(nextMode({ current: 'plan', bypassAllowed: true })).toBe('bypassPermissions');
    expect(nextMode({ current: 'bypassPermissions', bypassAllowed: true })).toBe('default');
  });

  it('leaves the unavailable auto mode for the first mode', () => {
    expect(nextMode({ current: 'auto', bypassAllowed: false })).toBe('default');
  });
});
