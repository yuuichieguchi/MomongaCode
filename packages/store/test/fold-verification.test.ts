import { describe, expect, it } from 'vitest';
import type { RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION, decodeRunState, encodeRunState } from '../src/codec.ts';
import { claimed, foldOf, task } from './inherit-fixtures.ts';
import { TEST_FENCE } from '@momonga/testkit';

type Verification = { round: number; results: Record<string, { seq: number; outcome: string; mutationSeq: number; round?: number }>; lastFailure?: { round: number; mutationSeq: number }; failureBefore?: number };

const completionFields = (state: RunState): { lastMutationSeq: unknown; verification: Verification } =>
  state as unknown as { lastMutationSeq: unknown; verification: Verification };

const call = (callId: string, name: string, kind: string, sideEffect: string, rawInput: unknown = {}): RunEventPayload =>
  ({ type: 'tool.call', callId, providerCallId: callId, name, kind, sideEffect, title: name, rawInput }) as unknown as RunEventPayload;

const started = (callId: string, basis?: string): RunEventPayload =>
  ({ type: 'tool.started', callId, idemKey: `k-${callId}`, ...(basis === undefined ? {} : { basis }) }) as unknown as RunEventPayload;

const completed = (callId: string, extra: Record<string, unknown> = {}): RunEventPayload =>
  ({ type: 'tool.completed', callId, status: 'completed', output: 'ok', ...extra }) as unknown as RunEventPayload;

const verificationStarted = (round: number, conditionId: string, mutationSeq: number, attempt = 1): RunEventPayload =>
  ({ type: 'verification.started', round, conditionId, mutationSeq, attempt }) as unknown as RunEventPayload;

const verificationCompleted = (round: number, conditionId: string, outcome: string, mutationSeq: number, exitCode?: number): RunEventPayload =>
  ({
    type: 'verification.completed',
    round,
    conditionId,
    outcome,
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: 5,
    output: '',
    mutationSeq,
  }) as unknown as RunEventPayload;

const lead = [task('make it pass'), ...claimed()];

describe('the initial run state', () => {
  it('starts with no mutation and no verification round', () => {
    const fields = completionFields(initialRunState({ runId: 'r1', sessionId: 's1', fence: TEST_FENCE }));
    expect(fields.lastMutationSeq).toBe(0);
    expect(fields.verification).toEqual({ round: 0, results: {} });
  });
});

describe('lastMutationSeq', () => {
  it('is the seq of the completion of a call that is not read only', () => {
    const state = foldOf([...lead, call('w1', 'Write', 'edit', 'write', { file_path: '/work/a/x.txt' }), started('w1', 'rule'), completed('w1')]);
    expect(completionFields(state).lastMutationSeq).toBe(6);
  });

  it('ignores a read only call', () => {
    const state = foldOf([...lead, call('r1', 'Read', 'read', 'read_only', { file_path: '/work/a/x.txt' }), started('r1'), completed('r1')]);
    expect(completionFields(state).lastMutationSeq).toBe(0);
  });

  it('ignores an exec call whose start basis is read only', () => {
    const state = foldOf([...lead, call('b1', 'Bash', 'execute', 'exec', { command: 'ls' }), started('b1', 'read_only'), completed('b1', { exitCode: 0 })]);
    expect(completionFields(state).lastMutationSeq).toBe(0);
  });

  it('counts an exec call that is not read only even when its command equals a condition and it exited 0', () => {
    const state = foldOf([...lead, call('b1', 'Bash', 'execute', 'exec', { command: 'npm test' }), started('b1', 'rule'), completed('b1', { exitCode: 0 })]);
    expect(completionFields(state).lastMutationSeq).toBe(6);
  });

  it('ignores a denied call, which did not run', () => {
    const state = foldOf([
      ...lead,
      call('w1', 'Write', 'edit', 'write'),
      completed('w1', { status: 'failed', denial: { source: 'rule', reason: 'denied' } }),
    ]);
    expect(completionFields(state).lastMutationSeq).toBe(0);
  });

  it.each([
    ['already_applied', 6],
    ['unknown', 6],
    ['not_applied', 0],
  ])('treats a reconciled %s call accordingly', (outcome, expected) => {
    const state = foldOf([
      ...lead,
      call('w1', 'Write', 'edit', 'write'),
      started('w1', 'rule'),
      { type: 'tool.reconciled', callId: 'w1', outcome, output: '' } as unknown as RunEventPayload,
    ]);
    expect(completionFields(state).lastMutationSeq).toBe(expected);
  });

  it('moves forward with every later mutation', () => {
    const state = foldOf([
      ...lead,
      call('w1', 'Write', 'edit', 'write'),
      started('w1', 'rule'),
      completed('w1'),
      call('w2', 'Edit', 'edit', 'write'),
      started('w2', 'rule'),
      completed('w2'),
    ]);
    expect(completionFields(state).lastMutationSeq).toBe(9);
  });
});

describe('the verification state', () => {
  it('records a completed check with its seq, outcome and the mutation it saw', () => {
    const state = foldOf([...lead, call('w1', 'Write', 'edit', 'write'), started('w1', 'rule'), completed('w1'), verificationStarted(1, 'c1', 6), verificationCompleted(1, 'c1', 'passed', 6, 0)]);
    expect(completionFields(state).verification).toMatchObject({ round: 1, results: { c1: { seq: 8, outcome: 'passed', mutationSeq: 6 } } });
  });

  it('never treats a started check without its completion as a result', () => {
    const state = foldOf([...lead, verificationStarted(1, 'c1', 0)]);
    expect(completionFields(state).verification.results).toEqual({});
    expect(completionFields(state).verification.round).toBe(1);
  });

  it('keeps only the latest result per condition', () => {
    const state = foldOf([
      ...lead,
      verificationStarted(1, 'c1', 0),
      verificationCompleted(1, 'c1', 'failed', 0, 1),
      call('w1', 'Write', 'edit', 'write'),
      started('w1', 'rule'),
      completed('w1'),
      verificationStarted(2, 'c1', 9),
      verificationCompleted(2, 'c1', 'passed', 9, 0),
    ]);
    expect(completionFields(state).verification.results).toEqual({ c1: { seq: 10, outcome: 'passed', mutationSeq: 9, round: 2 } });
    expect(completionFields(state).verification.round).toBe(2);
  });

  it('remembers the round and the mutation seq of the last failure, and the failure of the round before it', () => {
    const first = foldOf([...lead, verificationStarted(1, 'c1', 0), verificationCompleted(1, 'c1', 'passed', 0, 0), verificationStarted(1, 'c2', 0), verificationCompleted(1, 'c2', 'failed', 0, 2)]);
    expect(completionFields(first).verification).toMatchObject({ lastFailure: { round: 1, mutationSeq: 0 } });
    expect(completionFields(first).verification.failureBefore).toBeUndefined();
    const second = foldOf([
      ...lead,
      verificationStarted(1, 'c1', 0),
      verificationCompleted(1, 'c1', 'failed', 0, 1),
      call('w1', 'Write', 'edit', 'write'),
      started('w1', 'rule'),
      completed('w1'),
      verificationStarted(2, 'c1', 9),
      verificationCompleted(2, 'c1', 'failed', 9, 1),
    ]);
    expect(completionFields(second).verification).toMatchObject({ lastFailure: { round: 2, mutationSeq: 9 }, failureBefore: 0 });
  });

  it('is unchanged by a model-run command, which is never evidence', () => {
    const state = foldOf([...lead, call('b1', 'Bash', 'execute', 'exec', { command: 'npm test' }), started('b1', 'read_only'), completed('b1', { exitCode: 0 })]);
    expect(completionFields(state).verification).toEqual({ round: 0, results: {} });
  });
});

describe('snapshots and the new state fields', () => {
  it('bumps the snapshot state version', () => {
    expect(SNAPSHOT_STATE_VERSION).toBe(26);
  });

  it('discards an old snapshot without the new fields, so the run refolds from the journal', () => {
    const state = foldOf([...lead, call('w1', 'Write', 'edit', 'write'), started('w1', 'rule'), completed('w1')]);
    const { lastMutationSeq: _mutation, verification: _verification, ...old } = encodeRunState(state) as Record<string, unknown>;
    expect(decodeRunState('r1', { ...old, stateVersion: 18 })).toBeUndefined();
  });

  it('round-trips the new fields through a current snapshot', () => {
    const state = foldOf([...lead, verificationStarted(1, 'c1', 0), verificationCompleted(1, 'c1', 'failed', 0, 1)]);
    const decoded = decodeRunState('r1', encodeRunState(state));
    expect(decoded === undefined ? undefined : completionFields(decoded)).toEqual(completionFields(state));
    expect(completionFields(state).verification.results['c1']).toMatchObject({ outcome: 'failed' });
  });

  it('refolds a journal into the same state whether or not it was folded in two parts', () => {
    const payloads = [...lead, call('w1', 'Write', 'edit', 'write'), started('w1', 'rule'), completed('w1'), verificationStarted(1, 'c1', 6), verificationCompleted(1, 'c1', 'passed', 6, 0)];
    const whole = foldOf(payloads);
    expect(completionFields(whole).lastMutationSeq).toBe(6);
    expect(foldRunState).toBeTypeOf('function');
  });
});
