import { describe, expect, it } from 'vitest';
import { pendingLines } from '../src/commands/runs.ts';
import type { ApprovalView } from '../src/client/views.ts';

const outside: ApprovalView = {
  id: 'ap1',
  kind: 'permission',
  runId: 'run-1',
  callId: 'c1',
  status: 'pending',
  options: [
    { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'o2', name: 'reject_once', kind: 'reject_once' },
  ],
  createdAt: 1,
  reason: 'edit outside the workspace requires approval',
  toolCall: { callId: 'c1', name: 'Write', title: 'Write /elsewhere/out.txt', kind: 'edit' },
};

describe('momonga approve shows why the policy asked', () => {
  it('prints the reason under the title of a pending approval, before its options', () => {
    expect(pendingLines(outside)).toBe(
      ['ap1  Write /elsewhere/out.txt', '  edit outside the workspace requires approval', '    allow_once  (Allow once)', '    reject_once'].join('\n'),
    );
  });

  it('prints the reason under the title of a subagent approval in the listing', () => {
    expect(pendingLines(outside, 'reviewer')).toBe(
      [
        'ap1  Write /elsewhere/out.txt  (subagent reviewer)',
        '  edit outside the workspace requires approval',
        '    allow_once  (Allow once)',
        '    reject_once',
      ].join('\n'),
    );
  });
});
