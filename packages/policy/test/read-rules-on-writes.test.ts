import { describe, expect, it } from 'vitest';
import { READ_RULE_ROWS, cellAt, columnModes, kindIn, rowById } from './decision-rows.ts';
import { decideRow } from './decision-rows.ts';

describe('4.4 Read rules on every write path subject', () => {
  for (const row of READ_RULE_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command ?? 'Write tool .env'} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, async () => {
        expect(await kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('one code path for Read deny and ask rules on writes', () => {
  it.each(['RW1', 'RW3', 'RW4', 'RW6', 'RW8'])('%s is denied by the Read(.env) rule', async (id) => {
    const decision = await decideRow(rowById(id), 'manual');
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
    expect((await decision).rule?.text).toBe('Read(.env)');
  });

  it.each(['RW2', 'RW5'])('%s asks by the Read(.env) ask rule', async (id) => {
    const decision = await decideRow(rowById(id), 'acceptEdits');
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
    expect((await decision).rule?.text).toBe('Read(.env)');
  });

  it('RW10: a Read allow rule grants no write (pin)', async () => {
    const decision = await decideRow(rowById('RW10'), 'manual');
    expect((await decision).kind).toBe('ask');
    expect((await decision).rule?.text).not.toBe('Read(.env)');
  });
});
