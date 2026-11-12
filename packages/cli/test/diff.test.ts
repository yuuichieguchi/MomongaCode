import { describe, expect, it } from 'vitest';
import { diffLines, diffRowCount } from '../src/tui/screen/diff.ts';

describe('the one diff renderer', () => {
  it('shows a change to an existing file as removed and added lines with their line numbers', () => {
    const hunks = [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }];
    expect([...diffLines(hunks)]).toEqual([
      { prefix: '  1 -', text: 'a', token: 'diff.removed' },
      { prefix: '  1 +', text: 'b', token: 'diff.added' },
    ]);
  });

  it('counts the rows it draws, separators included', () => {
    const hunks = [
      { oldStart: 1, newStart: 1, lines: ['+a'] },
      { oldStart: 9, newStart: 10, lines: [' b'] },
    ];
    expect(diffRowCount(hunks)).toBe([...diffLines(hunks)].length);
  });
});
