import { describe, expect, it } from 'vitest';
import { approvalWording } from '../../src/tui/screen/prompt-panel.tsx';
import type { PendingApproval, ToolEntry } from '../../src/tui/transcript.ts';

const OPTIONS: PendingApproval['options'] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

const bash = (rawInput: unknown): ToolEntry => ({ kind: 'tool', callId: 'c1', name: 'Bash', title: 'npm install', toolKind: 'execute', rawInput, status: 'awaiting_approval', calledAt: 0, shownAt: 0 }) as ToolEntry;

describe('the approval panel of a command that requests the network', () => {
  it('shows the request for unrestricted network access under the command', () => {
    const approval: PendingApproval = { approvalId: 'a1', callId: 'c1', options: OPTIONS, reason: 'the command requests unrestricted network access' };
    expect(approvalWording(approval, () => bash({ command: 'npm install', network: 'open' }))).toEqual({ title: 'npm install', lines: ['the command requests unrestricted network access'] });
  });

  it('shows the hosts of a request for named hosts', () => {
    const approval: PendingApproval = { approvalId: 'a1', callId: 'c1', options: OPTIONS, reason: 'the command requests network access to registry.example.org only' };
    expect(approvalWording(approval, () => bash({ command: 'npm install', network: { hosts: ['registry.example.org'] } })).lines).toEqual(['the command requests network access to registry.example.org only']);
  });
});
