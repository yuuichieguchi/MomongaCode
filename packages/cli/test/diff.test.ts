import { describe, expect, it } from 'vitest';
import { clipDiff, maxDiffLines } from '../src/tui/diff.ts';

describe('clipDiff', () => {
  it('clips long diffs and reports how many lines were omitted', () => {
    const lines = Array.from({ length: 5 }, (_, index) => ({ kind: 'added' as const, text: String(index) }));
    expect(clipDiff(lines, 3)).toEqual({ lines: lines.slice(0, 3), omitted: 2 });
    expect(clipDiff(lines, 10)).toEqual({ lines, omitted: 0 });
  });
});

describe('maxDiffLines', () => {
  it('leaves the terminal rows that the approval prompt, its options and the status line do not use', () => {
    expect(maxDiffLines(40, 4)).toBe(40 - 2 - 1 - 4 - 1 - 1 - 1);
    expect(maxDiffLines(24, 2)).toBe(24 - 2 - 1 - 2 - 1 - 1 - 1);
  });

  it('never goes negative on a terminal shorter than the prompt', () => {
    expect(maxDiffLines(5, 4)).toBe(0);
  });
});
