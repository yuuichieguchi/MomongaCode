import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, fixtureSubjectDigest, materializeEvents } from '@momonga/testkit';

const start = () => initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID });
const foldAll = (events: readonly RunEvent[], from: RunState = start()) => events.reduce(foldRunState, from);

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
] as const;

const asked = (approvalId: string): RunEventPayload[] => [
  { type: 'user.message', text: 'write it' },
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write a.txt', rawInput: { file_path: '/w/a.txt' } },
  {
    type: 'tool.permission.requested',
    approvalId,
    callId: 'c1',
    options: [...OPTIONS],
    subjectDigest: fixtureSubjectDigest('a.txt'),
    reason: 'edits require approval',
    suggestedRule: 'Write(/w/a.txt)',
    shown: { title: 'approval', input: {} },
  },
];

const REQUESTED_CALL = { name: 'Write', providerCallId: 'c1', arguments: { file_path: '/w/a.txt' }, status: 'requested' };

describe('tool.permission.cancelled fold', () => {
  it.each(['expired', 'withdrawn', 'superseded'] as const)('returns the call to requested without its approval for %s', (reason) => {
    const events = materializeEvents([...asked('a1'), { type: 'tool.permission.cancelled', approvalId: 'a1', reason }]);

    expect(foldAll(events).pendingCalls['c1']).toEqual(REQUESTED_CALL);
  });

  it('follows a superseding request after the cancelled one', () => {
    const events = materializeEvents([
      ...asked('a1'),
      { type: 'tool.permission.cancelled', approvalId: 'a1', reason: 'superseded' },
      { type: 'tool.permission.requested', approvalId: 'a2', callId: 'c1', options: [...OPTIONS], subjectDigest: fixtureSubjectDigest('b.txt'), reason: 'edits require approval', shown: { title: 'approval', input: {} } },
    ]);

    expect(foldAll(events).pendingCalls['c1']).toEqual({
      ...REQUESTED_CALL,
      status: 'awaiting_approval',
      approvalId: 'a2',
      options: [...OPTIONS],
      subjectDigest: fixtureSubjectDigest('b.txt'),
    });
  });

  it('throws for an unknown approval id', () => {
    const events = materializeEvents([...asked('a1'), { type: 'tool.permission.cancelled', approvalId: 'ghost', reason: 'withdrawn' }]);
    expect(() => foldAll(events)).toThrow(/ghost/);
  });

  it('folds a snapshot at every point plus the tail to the same state as the full fold', () => {
    const events = materializeEvents([
      ...asked('a1'),
      { type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' },
      { type: 'tool.permission.cancelled', approvalId: 'a1', reason: 'expired' },
      { type: 'notice', level: 'warning', message: 'The approval for c1 expired.' },
      { type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'approval_timeout' },
    ]);
    const expected = foldAll(events);
    expect(expected.pendingCalls['c1']).toEqual(REQUESTED_CALL);
    for (let k = 0; k <= events.length; k += 1) {
      const snapshot = JSON.parse(JSON.stringify(foldAll(events.slice(0, k)))) as RunState;
      expect(foldAll(events.slice(k), snapshot)).toEqual(expected);
    }
  });
});
