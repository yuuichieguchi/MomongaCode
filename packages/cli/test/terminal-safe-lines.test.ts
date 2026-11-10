import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView, JobView, PermissionOption } from '@momonga/protocol';
import { approvalLine, pendingLines } from '../src/commands/runs.ts';
import type { ApprovalView } from '../src/client/views.ts';
import { jobLine } from '../src/commands/jobs.ts';
import { describeElicitation } from '../src/elicit/describe.ts';
import { terminalSink } from '../src/terminal-writer.ts';

const HOSTILE = 'x\u001b]0;pwn\u0007\u009b2J‮y';
const ESCAPED = 'x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey';
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u;

describe('lines that show text a person did not write', () => {
  it('escapes the title, the reason and the option names of a pending approval', () => {
    const options: PermissionOption[] = [{ optionId: 'o1', name: HOSTILE, kind: 'allow_once' }];
    const approval: ApprovalView = {
      id: 'ap1',
      kind: 'permission',
      runId: 'run-1',
      callId: 'c1',
      status: 'pending',
      options,
      createdAt: 1,
      reason: HOSTILE,
      toolCall: { callId: 'c1', name: 'Write', title: HOSTILE, kind: 'edit' },
    };
    const printed = pendingLines(approval);
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(3);
  });

  it('escapes the title of a pending approval in the status tree', () => {
    const printed = approvalLine(1, 'ap1', HOSTILE);
    expect(printed).not.toMatch(UNSAFE);
    expect(printed).toContain(ESCAPED);
  });

  it('escapes the command of a background job', () => {
    const job: JobView = { id: 'j1', sessionId: 's', runId: 'r', callId: 'c', command: HOSTILE, status: 'running', startedAt: 0 };
    const printed = jobLine(job);
    expect(printed).not.toMatch(UNSAFE);
    expect(printed).toContain(ESCAPED);
  });

  it('escapes the server, the title, the message, the URL and the field text of an elicitation, keeping its lines', () => {
    const requests: ElicitationRequestView[] = [{ mode: 'url', key: 'k', message: HOSTILE, url: `https://example.test/${HOSTILE}` }];
    const written: string[] = [];
    terminalSink(() => ({ write: (chunk) => void written.push(chunk) })).write(describeElicitation('in1', HOSTILE, HOSTILE, requests).join('\n'));
    const printed = written.join('');
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(4);
    expect(printed.split('\n').length).toBeGreaterThan(4);
  });
});
