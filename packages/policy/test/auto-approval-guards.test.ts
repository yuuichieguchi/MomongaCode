import { describe, expect, it } from 'vitest';
import { GUARD_ROWS, cellAt, columnModes, kindIn, rowById } from './decision-rows.ts';

describe('4.3 review-2 guard rows', () => {
  for (const row of GUARD_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, async () => {
        expect(await kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('substitution bodies are analysed with the approval rules', () => {
  it.each(['S1', 'S2', 'S3'])('%s asks in default, plan and acceptEdits', async (id) => {
    for (const mode of ['manual', 'plan', 'acceptEdits'] as const) expect(await kindIn(rowById(id), mode)).toBe('ask');
  });
});
