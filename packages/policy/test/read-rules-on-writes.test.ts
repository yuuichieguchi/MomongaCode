import { describe, expect, it } from 'vitest';
import { READ_RULE_ROWS, cellAt, columnModes, kindIn, rowById } from './decision-rows.ts';
import { decideRow } from './decision-rows.ts';

describe('4.4 Read rules on every write path subject', () => {
  for (const row of READ_RULE_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command ?? 'Write tool .env'} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, () => {
        expect(kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('one code path for Read deny and ask rules on writes', () => {
  it.each(['RW1', 'RW3', 'RW4', 'RW6', 'RW8'])('%s is denied by the Read(.env) rule', (id) => {
    const decision = decideRow(rowById(id), 'default');
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
    expect(decision.rule?.text).toBe('Read(.env)');
  });

  it.each(['RW2', 'RW5'])('%s asks by the Read(.env) ask rule', (id) => {
    const decision = decideRow(rowById(id), 'acceptEdits');
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(decision.rule?.text).toBe('Read(.env)');
  });

  it('RW10: a Read allow rule grants no write (pin)', () => {
    const decision = decideRow(rowById('RW10'), 'default');
    expect(decision.kind).toBe('ask');
    expect(decision.rule?.text).not.toBe('Read(.env)');
  });
});
