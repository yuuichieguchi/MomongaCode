import { describe, expect, it } from 'vitest';
import { clipDiff, diffOfStrings, diffOfToolInput } from '../src/tui/diff.ts';

describe('diffOfStrings', () => {
  it('marks a changed line as removed and added', () => {
    expect(diffOfStrings('name = "old"', 'name = "new"')).toEqual([
      { kind: 'removed', text: 'name = "old"' },
      { kind: 'added', text: 'name = "new"' },
    ]);
  });

  it('keeps two lines of context around the change and drops the rest', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n');
    expect(diffOfStrings(before, after)).toEqual([
      { kind: 'context', text: 'b' },
      { kind: 'context', text: 'c' },
      { kind: 'removed', text: 'd' },
      { kind: 'added', text: 'D' },
      { kind: 'context', text: 'e' },
      { kind: 'context', text: 'f' },
    ]);
  });

  it('shows a pure insertion as added lines', () => {
    expect(diffOfStrings('', 'one\ntwo')).toEqual([
      { kind: 'added', text: 'one' },
      { kind: 'added', text: 'two' },
    ]);
  });
});

describe('diffOfToolInput', () => {
  it('builds a diff with the file as header for Edit', () => {
    expect(diffOfToolInput('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' })).toEqual([
      { kind: 'header', text: '/p/a.ts' },
      { kind: 'removed', text: 'x' },
      { kind: 'added', text: 'y' },
    ]);
  });

  it('shows the content of a Write as added lines', () => {
    expect(diffOfToolInput('Write', { file_path: '/p/a.ts', content: 'hi' })).toEqual([
      { kind: 'header', text: '/p/a.ts' },
      { kind: 'added', text: 'hi' },
    ]);
  });

  it.each([
    ['another tool', 'Bash', { command: 'ls' }],
    ['a missing path', 'Edit', { old_string: 'x', new_string: 'y' }],
    ['non-text strings', 'Edit', { file_path: '/p', old_string: 1, new_string: 2 }],
    ['an input that is not an object', 'Edit', 'text'],
  ])('has no diff for %s', (_label, name, input) => {
    expect(diffOfToolInput(name, input)).toBeUndefined();
  });
});

describe('clipDiff', () => {
  it('clips long diffs and reports how many lines were omitted', () => {
    const lines = Array.from({ length: 5 }, (_, index) => ({ kind: 'added' as const, text: String(index) }));
    expect(clipDiff(lines, 3)).toEqual({ lines: lines.slice(0, 3), omitted: 2 });
    expect(clipDiff(lines, 10)).toEqual({ lines, omitted: 0 });
  });
});
