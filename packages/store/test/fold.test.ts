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
  finalAnswerRun,
  materializeEvents,
  toolRoundTripRun,
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

describe('initialRunState', () => {
  it('starts empty and QUEUED', () => {
    expect(start()).toEqual({
      runId: FIXTURE_RUN_ID,
      sessionId: FIXTURE_SESSION_ID,
      status: 'QUEUED',
      step: 0,
      attempt: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      items: [],
      pendingCalls: {},
      notes: [],
      toolCallCounts: {},
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
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      items: [userItem('say hi'), assistantItem('m1', 'hi')],
      lastSeq: 9,
    });
  });

  it('folds a tool round trip', () => {
    expect(foldAll(materializeEvents(toolRoundTripRun.payloads))).toEqual({
      ...start(),
      status: 'COMPLETED',
      step: 2,
      attempt: 1,
      usage: { inputTokens: 50, outputTokens: 9, totalTokens: 59 },
      items: [userItem('read a.txt'), callItem('c1', 'Read', { path: 'a.txt' }), outputItem('c1', 'A'), assistantItem('m2', 'A it is')],
      pendingCalls: { c1: { name: 'Read', providerCallId: 'c1', arguments: { path: 'a.txt' }, status: 'completed', idemKey: 'k1' } },
      toolCallCounts: { [sha256('Read\n{"path":"a.txt"}')]: 1 },
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
    });
    const resolved = foldAll(events.slice(0, 9));
    expect(resolved.pendingCalls['c1']?.status).toBe('requested');
    const final = foldAll(events);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      attempt: 2,
      step: 2,
      usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
      pendingCalls: { c1: { name: 'Bash', arguments: { command: 'rm -r tmp' }, status: 'completed', approvalId: 'a1', idemKey: 'k1' } },
      lastSeq: 18,
    });
    expect(final.items).toEqual([
      userItem('delete tmp'),
      callItem('c1', 'Bash', { command: 'rm -r tmp' }),
      outputItem('c1', ''),
      assistantItem('m2', 'deleted'),
    ]);
  });

  it('folds a cancel with a reconciled tool and a notice', () => {
    expect(foldAll(materializeEvents(cancelRun.payloads))).toMatchObject({
      status: 'CANCELLED',
      pendingCalls: { c1: { status: 'reconciled', idemKey: 'k1' } },
      items: [userItem('build it'), callItem('c1', 'Bash', { command: 'npm run build' }), outputItem('c1', 'cancelled while running')],
      notes: [{ level: 'warning', message: 'run cancelled' }],
      lastSeq: 12,
    });
  });

  it('folds a compaction that replaces items through the given index', () => {
    const final = foldAll(materializeEvents(compactionRun.payloads));
    expect(final.items).toEqual([{ type: 'compaction_summary', summary: 'searched for x' }, assistantItem('m2', 'found x')]);
    expect(final).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps', step: 2, lastSeq: 14 });
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
    expect(state.inFlightModelRequest).toEqual({ step: 1, attempt: 1, digest: 'd1', body: { input: 'say hi' } });
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
      response: { output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
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
      { type: 'tool.permission.requested', approvalId: 'ap2', callId: 'run-call-2', options: [] },
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
    expect(final.items.filter((item) => (item as { type: string }).type === 'function_call_output')).toEqual([
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

  it('rejects a snapshot beyond the last event', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const state = initialRunState({ runId: run.id, sessionId: run.sessionId });
    expect(store.writeSnapshot(claim, 5, state).kind).toBe('conflict');
    expect(store.load(run.id).snapshot).toBeUndefined();
  });
});

describe('load consistency', () => {
  it('rolls back its read transaction when a snapshot row is corrupt', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    rawDb(dbPath)
      .prepare("INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (?, 1, '{\"nope\":1}', 0)")
      .run(run.id);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
    expect(store.append(claim, [{ type: 'notice', level: 'info', message: 'still writable' }]).kind).toBe('ok');
  });
});
