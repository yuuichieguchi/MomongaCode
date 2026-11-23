import { describe, expect, it } from 'vitest';
import { approvalHeading, approvalSpec, approvalWording, elicitationHeading, elicitationSpec, trustHeading, trustSpec } from '../../src/tui/screen/prompt-panel.tsx';
import { fold } from './screen-fakes.ts';

const OPTIONS = [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }];

const editCall = { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Edit', kind: 'edit', title: 'Edit src/app.ts', rawInput: { file_path: 'src/app.ts' } };
const bashCall = { type: 'tool.call', callId: 'c2', providerCallId: 'c2', name: 'Bash', kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } };
const asked = (approvalId: string, callId: string) => ({ type: 'tool.permission.requested', approvalId, callId, subjectDigest: 'd', reason: 'asks', options: OPTIONS, shown: { title: 'approval', input: {} } });

const unknownCall = { type: 'tool.call', callId: 'u1', providerCallId: 'u1', name: 'Write', kind: 'edit', title: 'Write /a.txt', rawInput: { file_path: '/a.txt' } };
const unknownEvents = [unknownCall, { type: 'tool.started', callId: 'u1', idemKey: 'k1' }, { type: 'tool.reconciled', callId: 'u1', outcome: 'unknown', output: 'found' }, { type: 'tool.unknown.requested', approvalId: 'ap9', callIds: ['u1'], options: [{ optionId: 'allow_once', name: 'Continue', kind: 'allow_once' }], subjectDigest: 'd' }];

const askCall = { type: 'tool.call', callId: 'm1', providerCallId: 'm1', name: 'mcp__github__ask', kind: 'other', title: 'mcp__github__ask {}', rawInput: {} };
const twoQuestions = {
  type: 'tool.elicitation.requested',
  inputId: 'in1',
  callId: 'm1',
  server: 'github',
  requests: [
    { key: 'k1', mode: 'form', message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } },
    { key: 'k2', mode: 'form', message: 'Which tag?', requestedSchema: { type: 'object', properties: { tag: { type: 'string' } } } },
  ],
};

const approvalOf = (events: readonly Record<string, unknown>[]) => {
  const state = fold(events);
  if (state.approval === undefined) throw new Error('expected a pending approval');
  return state.approval;
};

const elicitationOf = (events: readonly Record<string, unknown>[]) => {
  const state = fold(events);
  if (state.elicitation === undefined) throw new Error('expected a pending question');
  return state.elicitation;
};

describe('the heading of the trust screen', () => {
  it('asks whether the person trusts the files in the folder', () => {
    expect(trustHeading('/tmp/work/myproject')).toBe('Do you trust the files in /tmp/work/myproject?');
  });

  it('is the title of the trust panel', () => {
    expect(trustSpec('/tmp/work/myproject').title).toBe('Do you trust the files in /tmp/work/myproject?');
    expect(trustSpec('/tmp/work/myproject').title).toBe(trustHeading('/tmp/work/myproject'));
  });
});

describe('the heading of an approval', () => {
  it('says permission requested with the tool title for a file edit and for a command', () => {
    expect(approvalHeading(approvalOf([editCall, asked('ap1', 'c1')]), 'Edit src/app.ts')).toBe('Permission requested: Edit src/app.ts');
    expect(approvalHeading(approvalOf([bashCall, asked('ap2', 'c2')]), 'npm test')).toBe('Permission requested: npm test');
  });

  it('is the title alone for calls with an unknown effect', () => {
    expect(approvalHeading(approvalOf(unknownEvents), 'Effect unknown: Write /a.txt')).toBe('Effect unknown: Write /a.txt');
  });

  it('leaves the panel title as it was: the heading, then the counter when more than one waits', () => {
    const approval = approvalOf([editCall, asked('ap1', 'c1')]);
    expect(approvalSpec(approval, 'Edit src/app.ts', [], 1).title).toBe('Permission requested: Edit src/app.ts');
    expect(approvalSpec(approval, 'Edit src/app.ts', [], 2).title).toBe('Permission requested: Edit src/app.ts (1 of 2)');
  });

  it('leaves the title of the unknown-effect panel as it was', () => {
    const approval = approvalOf(unknownEvents);
    const tools = new Map(fold(unknownEvents).entries.flatMap((entry) => (entry.kind === 'tool' ? [[entry.callId, entry] as const] : [])));
    const text = approvalWording(approval, (callId) => tools.get(callId));
    expect(text.title).toBe('Effect unknown: Write /a.txt');
    expect(approvalSpec(approval, text.title, text.lines, 1).title).toBe('Effect unknown: Write /a.txt');
    expect(approvalSpec(approval, text.title, text.lines, 2).title).toBe('Effect unknown: Write /a.txt (1 of 2)');
  });
});

describe('the heading of a question from an MCP server', () => {
  it('names the server and the tool title, without the position in the flow', () => {
    expect(elicitationHeading({ server: 'github' }, 'mcp__github__ask {}')).toBe('MCP server github asks for input (mcp__github__ask {})');
  });

  it('leaves the panel title as it was: the heading, the position in the flow, then the counter', () => {
    const elicitation = elicitationOf([askCall, twoQuestions]);
    expect(elicitationSpec(elicitation, 'mcp__github__ask {}', 1).title).toBe('MCP server github asks for input (mcp__github__ask {}) 1/2');
    expect(elicitationSpec(elicitation, 'mcp__github__ask {}', 2).title).toBe('MCP server github asks for input (mcp__github__ask {}) 1/2 (1 of 2)');
  });
});
