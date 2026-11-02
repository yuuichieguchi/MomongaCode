import { describe, expect, it } from 'vitest';
import { ALL_ROWS, commandRow, commandRows, decideRow, kindIn } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';

describe('plan column of every command row equals its default column (1.5 (c))', () => {
  for (const row of commandRows(ALL_ROWS)) {
    it(`${row.id} ${row.command} in plan -> ${row.after[2]}`, () => {
      expect(row.after[2]).toBe(row.after[0]);
      expect(kindIn(row, 'plan')).toBe(row.after[2]);
    });
  }
});

describe('plan mode follows the regular flow for commands', () => {
  it.each(['ls', 'git status'])('runs the read-only command %s', (command) => {
    expect(kindIn(commandRow(command), 'plan')).toBe('allow');
  });

  it('asks for a rule-allowed command that writes inside the roots', () => {
    const decision = decideRow(commandRow('mkdir out', { rules: [['allow', 'Bash(mkdir:*)']] }), 'plan');
    expect(decision.kind).toBe('ask');
    expect(decision.reason).toBe('edits require approval');
  });

  it('denies a command by a deny rule', () => {
    expect(decideRow(commandRow('rm x', { rules: [['deny', 'Bash(rm:*)']] }), 'plan')).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('does not apply the acceptEdits approval', () => {
    expect(kindIn(commandRow('mkdir out'), 'plan')).toBe('ask');
  });

  it.each<[string, Row]>([
    ['Write', { id: 'w', write: (layout) => `${layout.project}/a.txt`, after: ['ask', 'allow', 'deny', 'allow'], pin: true }],
    ['Edit with an allow rule', { id: 'e', write: (layout) => `${layout.project}/a.txt`, rules: [['allow', 'Write']], after: ['allow', 'allow', 'deny', 'allow'], pin: true }],
  ])('keeps denying the %s tool (pin)', (_label, row) => {
    const decision = decideRow(row, 'plan');
    expect(decision.kind).toBe('deny');
    expect(decision.reason).toMatch(/plan mode/i);
  });
});
