import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, fixtureCompactionItem, materializeEvents } from '@momonga/testkit';

const start = (): RunState => initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID });
const foldPayloads = (payloads: readonly RunEventPayload[]): RunState =>
  materializeEvents(payloads).reduce((state: RunState, event: RunEvent) => foldRunState(state, event), start());

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const PLAIN = { type: 'message' as const, role: 'user' as const, content: '<conversation_summary>\nwhat happened\n</conversation_summary>' };

const compacted: RunEventPayload[] = [
  { type: 'user.message', text: 'go' },
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { tool_choice: 'auto' } },
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: USAGE },
  },
  { type: 'user.message', text: 'next' },
  { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'what happened'), summary: 'what happened', replacedThroughSeq: 2 },
];

const requestedStep2: RunEventPayload = { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { tool_choice: 'auto' } };

const rejectionMessageOf = (fold: () => unknown): string => {
  try {
    fold();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the fold did not throw');
};

describe('context.compaction_rejected fold', () => {
  it('replaces the summary item and keeps the text and the boundary', () => {
    const state = foldPayloads([...compacted, { type: 'context.compaction_rejected', item: PLAIN }]);
    expect(state.summary).toEqual({ item: PLAIN, summary: 'what happened', replacedThroughSeq: 2 });
    expect(state.history.map((entry) => entry.seq)).toEqual([3]);
  });

  it('clears the in-flight request and its step entry when step and attempt are present', () => {
    const before = foldPayloads([...compacted, requestedStep2]);
    expect(before.inFlightModelRequest?.step).toBe(2);
    expect(before.steps[2]).toEqual({ toolChoice: 'auto', summary: false });
    const state = foldPayloads([...compacted, requestedStep2, { type: 'context.compaction_rejected', step: 2, attempt: 1, item: PLAIN }]);
    expect(state.inFlightModelRequest).toBeUndefined();
    expect(state.steps[2]).toBeUndefined();
    expect(state.steps[1]).toEqual({ toolChoice: 'auto', summary: false });
    expect(state.step).toBe(before.step);
    expect(state.summary?.item).toEqual(PLAIN);
  });

  it('leaves an existing in-flight request untouched when step and attempt are absent', () => {
    const before = foldPayloads([...compacted, requestedStep2]);
    const state = foldPayloads([...compacted, requestedStep2, { type: 'context.compaction_rejected', item: PLAIN }]);
    expect(state.inFlightModelRequest).toEqual(before.inFlightModelRequest);
    expect(state.steps).toEqual(before.steps);
    expect(state.summary?.item).toEqual(PLAIN);
  });

  it('throws when there is no summary', () => {
    const message = rejectionMessageOf(() => foldPayloads([{ type: 'user.message', text: 'go' }, { type: 'context.compaction_rejected', item: PLAIN }]));
    expect(message).toContain(FIXTURE_RUN_ID);
    expect(message).not.toMatch(/unhandled event/);
  });

  it('throws when the summary is already a plain message', () => {
    const message = rejectionMessageOf(() =>
      foldPayloads([...compacted, { type: 'context.compaction_rejected', item: PLAIN }, { type: 'context.compaction_rejected', item: PLAIN }]),
    );
    expect(message).toContain(FIXTURE_RUN_ID);
    expect(message).not.toMatch(/unhandled event/);
  });

  it('lets a later compaction replace the plain summary with a new compaction item', () => {
    const state = foldPayloads([
      ...compacted,
      { type: 'context.compaction_rejected', item: PLAIN },
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-2', 'newer'), summary: 'newer', replacedThroughSeq: 3 },
    ]);
    expect(state.summary).toEqual({ item: fixtureCompactionItem('cmp-2', 'newer'), summary: 'newer', replacedThroughSeq: 3 });
  });
});

describe('run.started mode fold', () => {
  const started = (attempt: number, mode: 'default' | 'plan' | 'acceptEdits' | undefined, pins: Record<string, unknown>): RunEventPayload => ({
    type: 'run.started',
    attempt,
    now: attempt,
    pins,
    ...(mode === undefined ? {} : { mode }),
  });

  it('sets the mode from the claim and lets the latest claim win while pins stay first-wins', () => {
    const state = foldPayloads([{ type: 'user.message', text: 'go' }, started(1, 'default', { model: 'a' }), started(2, 'plan', { model: 'b' })]);
    expect(state.mode).toBe('plan');
    expect(state.pins).toEqual({ model: 'a' });
    expect(state.attempt).toBe(2);
  });

  it('leaves the mode undefined for a run.started without a mode', () => {
    expect(foldPayloads([{ type: 'user.message', text: 'go' }, started(1, undefined, {})]).mode).toBeUndefined();
  });

});
