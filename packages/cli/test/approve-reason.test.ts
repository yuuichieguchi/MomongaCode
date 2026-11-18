import { describe, expect, it } from 'vitest';
import { pendingLines, settledApprovalText } from '../src/commands/runs.ts';
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

  it('prints what will run in full, the claim of the model labelled, and the change to the current file', () => {
    const command = `rm -rf build ${'x'.repeat(300)}`;
    const view: ApprovalView = { ...outside, shown: { title: command, input: { command }, effect: command, claim: 'Clean the build' } };
    expect(pendingLines(view)).toBe(
      ['ap1  Write /elsewhere/out.txt', '  edit outside the workspace requires approval', `  ${command}`, '  The model describes it as: Clean the build', '    allow_once  (Allow once)', '    reject_once'].join('\n'),
    );
    const edit: ApprovalView = { ...outside, shown: { title: 'Write out.txt', input: {}, diff: { hunks: [{ oldStart: 2, newStart: 2, lines: ['-old', '+new'] }] } } };
    expect(pendingLines(edit)).toBe(
      ['ap1  Write /elsewhere/out.txt', '  edit outside the workspace requires approval', '  @@ -2 +2 @@', '  -old', '  +new', '    allow_once  (Allow once)', '    reject_once'].join('\n'),
    );
  });
});

describe('momonga approve of an approval that is no longer pending', () => {
  it('says what ended it and with which answer, and changes nothing', () => {
    expect(settledApprovalText({ ...outside, status: 'resolved', optionId: 'o2', resolvedAt: 5 })).toBe('approval ap1 is already resolved: reject_once; nothing was changed');
    expect(settledApprovalText({ ...outside, status: 'expired' })).toBe('approval ap1 is already expired; nothing was changed');
    expect(settledApprovalText(outside)).toBeUndefined();
  });
});
