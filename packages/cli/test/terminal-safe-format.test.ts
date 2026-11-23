import { describe, expect, it } from 'vitest';
import type { GoverningFactView, MemoryView, ReflectionJobView } from '@momonga/protocol';
import { terminalSink } from '../src/terminal-writer.ts';
import { formatMemory, formatMemoryHistory, formatMemoryList, formatReflection } from '../src/memory/format.ts';
import { formatGovernanceVerification, formatRuleAdded, formatRuleHistory, formatRuleList } from '../src/rule/format.ts';

const HOSTILE = 'x\u001b]0;pwn\u0007\u009b2J‮y';
const ESCAPED ='x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey';

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;

const expectSafe = (printed: string, escaped = ESCAPED): void => {
  expect(printed).not.toMatch(UNSAFE);
  expect(printed).toContain(escaped);
};

const memory = (overrides: Partial<MemoryView> = {}): MemoryView => ({
  id: 'm1',
  scope: 'project',
  origin: 'trusted',
  project: '/p',
  text: 'note',
  source: { kind: 'reflection', sessionId: 's', runId: 'r', ordinal: 0 },
  createdAt: 0,
  keptAt: 0,
  kind: 'procedure',
  state: 'candidate',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  keptByClassifier: null,
  status: 'unbound',
  ...overrides,
});

const fact = (overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id: 'g1',
  kind: 'constraint',
  target: 'pandas',
  text: 'text',
  scope: { level: 'user' },
  validFrom: 0,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 0 },
  ...overrides,
});

const job = (overrides: Partial<ReflectionJobView> = {}): ReflectionJobView => ({
  runId: 'run-9',
  state: 'done',
  attempts: 1,
  reason: null,
  dropped: [],
  updatedAt: 0,
  ...overrides,
});

describe('memory text that a person did not write is printed escaped', () => {
  it('escapes the text of a memory in the list and in the history', () => {
    expectSafe(formatMemoryList([memory({ text: HOSTILE })]));
    expectSafe(formatMemoryHistory([memory({ text: HOSTILE })]));
  });

  it('escapes the project of a memory in the list', () => {
    expectSafe(formatMemoryList([memory({ project: HOSTILE })]));
  });

  it('escapes the whole text of a memory in show and review, keeping its line breaks and indenting each line', () => {
    const written: string[] = [];
    terminalSink(() => ({ write: (chunk) => void written.push(chunk) })).write(formatMemory(memory({ text: `first\n${HOSTILE}` })));
    const printed = written.join('');
    expectSafe(printed);
    expect(printed).toContain(`\n  first\n  ${ESCAPED}`);
  });

  it('escapes the project, the evidence path and the check command of a memory in show and review', () => {
    const printed = formatMemory(
      memory({
        project: HOSTILE,
        evidence: [
          { kind: 'file', project: '/p', path: HOSTILE, sha256: 'a'.repeat(64) },
          { kind: 'check', command: HOSTILE, exitCode: 0, runId: 'r', conditionId: 'c', seq: 1 },
        ],
      }),
    );
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(3);
  });

  it('escapes the reason of the job and the reason and the text of each dropped candidate of a reflection', () => {
    const printed = formatReflection(
      job({
        reason: HOSTILE,
        dropped: [
          { ordinal: 0, text: HOSTILE, cause: 'evidence', reason: `${HOSTILE} was not read` },
          { ordinal: 1, text: null, cause: 'text_rule', reason: HOSTILE },
        ],
      }),
    );
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(4);
  });

  it('keeps one dropped candidate on its own lines when its reason or text holds a line break', () => {
    const printed = formatReflection(job({ dropped: [{ ordinal: 0, text: 'a\nb', cause: 'evidence', reason: 'one\ntwo' }] }));
    expect(printed.split('\n')).toHaveLength(3);
  });
});

describe('rule text that a person did not write is printed escaped', () => {
  it('escapes the text, the target, the paths and the enforced rule of a rule in the list', () => {
    const printed = formatRuleList([fact({ text: HOSTILE, target: HOSTILE, scope: { level: 'project', project: HOSTILE, paths: [HOSTILE] }, enforcement: { behavior: 'deny', rule: HOSTILE } })]);
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(5);
  });

  it('escapes the text and the target of a rule in the history, including a line break in the text', () => {
    const printed = formatRuleHistory([fact({ text: `a\n${HOSTILE}`, target: HOSTILE })]);
    expectSafe(printed);
    expect(printed.split('\n')).toHaveLength(1);
  });

  it('escapes the warnings of an added rule and its enforced rule', () => {
    const printed = formatRuleAdded({ fact: fact({ enforcement: { behavior: 'deny', rule: HOSTILE } }), size: [{ target: HOSTILE, contextWindow: 1000, tokens: 1, percent: 1 }], warnings: [HOSTILE] });
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(3);
  });

  it('escapes the enforced rules and the targets in a verification', () => {
    const printed = formatGovernanceVerification({ rules: [{ id: 'g1', behavior: 'deny', rule: HOSTILE }], textOnly: [fact({ target: HOSTILE })] }, true);
    expect(printed).not.toMatch(UNSAFE);
    expect(printed.split(ESCAPED).length - 1).toBe(2);
  });
});
