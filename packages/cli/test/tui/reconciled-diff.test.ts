import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { NO_A11Y } from '../../src/tui/screen/a11y.ts';
import { rowsOfEntry } from '../../src/tui/screen/entry-rows.ts';
import { plainOf, storeOf } from './screen-fakes.ts';

const rowsOf = (events: readonly Record<string, unknown>[]): string[] => {
  const [entry] = plainOf(storeOf(events)).entries;
  if (entry === undefined) throw new Error('no entry');
  return rowsOfEntry(entry, 60, { keys: DEFAULT_KEY_TABLE, a11y: NO_A11Y }).map((row) => row.text);
};

const EDIT = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit src/a.ts', rawInput: { file_path: 'src/a.ts', old_string: 'line10', new_string: 'changed10' }, createdAt: 1000 };

const DIFF = { hunks: [{ oldStart: 9, newStart: 9, lines: [' line9', '-line10', '+changed10'] }], added: 1, removed: 1 };

const reconciled = (outcome: string, extra: Record<string, unknown>): Record<string, unknown> => ({ type: 'tool.reconciled', callId: 'c1', outcome, output: 'Edit to src/a.ts had already been applied', createdAt: 9000, ...extra });

describe('an edit that was found already applied after an interruption', () => {
  it('shows the diff its completion would have shown', () => {
    const completed = rowsOf([EDIT, { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'Updated', createdAt: 9000, ...DIFF }]);
    const settled = rowsOf([EDIT, reconciled('already_applied', DIFF)]);
    expect(settled).toEqual(completed);
    expect(settled.slice(1)).toEqual(['• Edited src/a.ts (+1 -1)', '   9  line9', '  10 -line10', '  10 +changed10']);
  });

  it('shows no diff for an edit whose effect is not known', () => {
    expect(rowsOf([EDIT, reconciled('unknown', {})]).some((row) => row.includes('Edited'))).toBe(false);
  });
});
