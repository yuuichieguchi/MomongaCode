import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, newSession } from './helpers.ts';

const IDS = { runId: 'run-1', sessionId: 'sess-1' };

const foldAll = (payloads: readonly unknown[]): RunState =>
  payloads.reduce<RunState>((state, payload, index) => {
    const step = typeof (payload as { step?: unknown }).step === 'number' ? (payload as { step: number }).step : 0;
    const event = { ...(payload as RunEventPayload), id: index + 1, ...IDS, seq: index + 1, step, leaseToken: 1, createdAt: START_MS } as RunEvent;
    return foldRunState(state, event);
  }, initialRunState(IDS));

const requested = (step: number, toolChoice: string): RunEventPayload => ({
  type: 'model.requested',
  step,
  attempt: 1,
  digest: `digest-${step}`,
  body: { model: 'fm', input: [], tool_choice: toolChoice, stream: true },
});

describe('fold: per-step request facts', () => {
  it('starts with no steps and no loaded instructions', () => {
    const state = initialRunState(IDS);
    expect(state.steps).toEqual({});
    expect(state.loadedInstructions).toEqual([]);
  });

  it('records the tool choice of every model.requested and marks a tool_choice none request as the summary', () => {
    const state = foldAll([requested(1, 'auto'), requested(2, 'none')]);
    expect(state.steps).toEqual({
      1: { toolChoice: 'auto', summary: false },
      2: { toolChoice: 'none', summary: true },
    });
  });
});

describe('fold: loaded instructions', () => {
  it('keeps the latest digest per path at the position of its first load', () => {
    const state = foldAll([
      { type: 'instructions.loaded', path: '/proj/AGENTS.md', content: 'v1' },
      { type: 'instructions.loaded', path: '/proj/sub/AGENTS.md', content: 'nested' },
      { type: 'instructions.loaded', path: '/proj/AGENTS.md', content: 'v2' },
    ]);
    expect(state.loadedInstructions).toEqual([
      { path: '/proj/AGENTS.md', textSha256: sha256Hex('v2'), seq: 1 },
      { path: '/proj/sub/AGENTS.md', textSha256: sha256Hex('nested'), seq: 2 },
    ]);
  });
});

describe('fold: approval.rule.persisted', () => {
  it('marks the resolution of the approved call as persisted', () => {
    const state = foldAll([
      { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} },
      {
        type: 'tool.permission.requested',
        approvalId: 'appr-1',
        callId: 'call_1',
        options: [{ optionId: 'aa', name: 'Always allow', kind: 'allow_always' }],
        subjectDigest: 'd'.repeat(64),
        suggestedRule: 'Write(/x)',
      },
      { type: 'tool.permission.resolved', approvalId: 'appr-1', optionId: 'aa' },
      { type: 'approval.rule.persisted', approvalId: 'appr-1', effect: 'allow', rule: 'Write(/x)' },
    ]);
    expect(state.pendingCalls['call_1']?.resolution).toEqual({
      optionId: 'aa',
      kind: 'allow_always',
      subjectDigest: 'd'.repeat(64),
      suggestedRule: 'Write(/x)',
      rulePersisted: true,
    });
  });
});

describe('snapshot codec: steps and loadedInstructions', () => {
  const snapshotWith = (patch: Record<string, unknown>) => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');
    const appended = store.append(claim, [requested(1, 'auto'), { type: 'instructions.loaded', path: '/proj/AGENTS.md', content: 'v1' }]);
    if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
    const state = store.readRunEvents(run.id, 0, 100).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    const written = store.writeSnapshot(claim, state.lastSeq, { ...state, ...patch } as RunState);
    if (written.kind !== 'ok') throw new Error('expected the snapshot to be written');
    return { store, runId: run.id, state };
  };

  it('round-trips the folded steps and loaded instructions', () => {
    const { store, runId, state } = snapshotWith({});
    const loaded = store.load(runId).snapshot?.state;
    expect(loaded?.steps).toEqual({ 1: { toolChoice: 'auto', summary: false } });
    expect(loaded?.loadedInstructions).toEqual([{ path: '/proj/AGENTS.md', textSha256: sha256Hex('v1'), seq: 3 }]);
    expect(loaded).toEqual(state);
  });

  it.each([
    ['steps that is not a record', { steps: [] }],
    ['a step without a boolean summary', { steps: { 1: { toolChoice: 'auto', summary: 'no' } } }],
    ['a step without a string tool choice', { steps: { 1: { toolChoice: 7, summary: false } } }],
    ['loadedInstructions that is not an array', { loadedInstructions: {} }],
    ['a loaded instruction without a path', { loadedInstructions: [{ textSha256: sha256Hex('v1') }] }],
    ['a loaded instruction without a digest', { loadedInstructions: [{ path: '/proj/AGENTS.md' }] }],
  ])('rejects a snapshot holding %s', (_label, patch) => {
    const { store, runId } = snapshotWith(patch);
    expect(() => store.load(runId)).toThrow(/does not hold a RunState/);
  });
});
