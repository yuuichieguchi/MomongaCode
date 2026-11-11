import { describe, expect, it } from 'vitest';
import { ALL_ROWS, commandRow, commandRows, decideRow, kindIn } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';

describe('plan column of every command row equals its default column (1.5 (c))', () => {
  for (const row of commandRows(ALL_ROWS)) {
    it(`${row.id} ${row.command} in plan -> ${row.after[2]}`, async () => {
      expect(row.after[2]).toBe(row.after[0]);
      expect(await kindIn(row, 'plan')).toBe(row.after[2]);
    });
  }
});

describe('plan mode follows the regular flow for commands', () => {
  it.each(['ls', 'git status'])('runs the read-only command %s', async (command) => {
    expect(await kindIn(commandRow(command), 'plan')).toBe('allow');
  });

  it('asks for a rule-allowed command that writes inside the roots', async () => {
    const decision = await decideRow(commandRow('mkdir out', { rules: [['allow', 'Bash(mkdir:*)']] }), 'plan');
    expect((await decision).kind).toBe('ask');
    expect((await decision).reason).toBe('edits require approval');
  });

  it('denies a command by a deny rule', async () => {
    expect(await decideRow(commandRow('rm x', { rules: [['deny', 'Bash(rm:*)']] }), 'plan')).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('does not apply the acceptEdits approval', async () => {
    expect(await kindIn(commandRow('mkdir out'), 'plan')).toBe('ask');
  });

  it.each<[string, Row]>([
    ['Write', { id: 'w', write: (layout) => `${layout.project}/a.txt`, after: ['ask', 'allow', 'deny', 'allow'], pin: true }],
    ['Edit with an allow rule', { id: 'e', write: (layout) => `${layout.project}/a.txt`, rules: [['allow', 'Write']], after: ['allow', 'allow', 'deny', 'allow'], pin: true }],
  ])('keeps denying the %s tool (pin)', async (_label, row) => {
    const decision = await decideRow(row, 'plan');
    expect((await decision).kind).toBe('deny');
    expect((await decision).reason).toMatch(/plan mode/i);
  });
});
