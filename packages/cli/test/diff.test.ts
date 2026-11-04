import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTEXT_LINES, clipDiff, diffOfStrings, diffOfToolInput, maxDiffLines } from '../src/tui/diff.ts';

describe('diffOfStrings', () => {
  it('marks a changed line as removed and added', () => {
    expect(diffOfStrings('name = "old"', 'name = "new"')).toEqual([
      { kind: 'removed', text: 'name = "old"' },
      { kind: 'added', text: 'name = "new"' },
    ]);
  });

  it('keeps the unified-diff default of three lines of context around the change and drops the rest', () => {
    expect(CONTEXT_LINES).toBe(3);
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n');
    expect(diffOfStrings(before, after)).toEqual([
      { kind: 'context', text: 'b' },
      { kind: 'context', text: 'c' },
      { kind: 'context', text: 'd' },
      { kind: 'removed', text: 'e' },
      { kind: 'added', text: 'E' },
      { kind: 'context', text: 'f' },
      { kind: 'context', text: 'g' },
      { kind: 'context', text: 'h' },
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
  it('builds a diff with the file as header for Edit, relative to the working directory', () => {
    expect(diffOfToolInput('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }, '/p')).toEqual([
      { kind: 'header', text: 'a.ts' },
      { kind: 'removed', text: 'x' },
      { kind: 'added', text: 'y' },
    ]);
  });

  it('shows the content of a Write as added lines', () => {
    expect(diffOfToolInput('Write', { file_path: '/p/a.ts', content: 'hi' }, '/p')).toEqual([
      { kind: 'header', text: 'a.ts' },
      { kind: 'added', text: 'hi' },
    ]);
  });

  it('heads a relative path with that path resolved against the working directory', () => {
    expect(diffOfToolInput('Write', { file_path: 'src/a.ts', content: 'hi' }, '/p')?.[0]).toEqual({ kind: 'header', text: 'src/a.ts' });
    expect(diffOfToolInput('Write', { file_path: './src/../src/a.ts', content: 'hi' }, '/p')?.[0]).toEqual({ kind: 'header', text: 'src/a.ts' });
  });

  it('heads a path outside the working directory with its absolute path', () => {
    expect(diffOfToolInput('Edit', { file_path: '/q/a.ts', old_string: 'x', new_string: 'y' }, '/p')?.[0]).toEqual({ kind: 'header', text: '/q/a.ts' });
    expect(diffOfToolInput('Edit', { file_path: '../q/a.ts', old_string: 'x', new_string: 'y' }, '/p')?.[0]).toEqual({ kind: 'header', text: '/q/a.ts' });
  });

  it('heads a path in a working directory reached through a symlink relative to it', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-diff-')));
    try {
      const project = path.join(root, 'project');
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'a.ts'), 'x\n');
      const alias = path.join(root, 'alias');
      fs.symlinkSync(project, alias);
      expect(diffOfToolInput('Edit', { file_path: path.join(project, 'a.ts'), old_string: 'x', new_string: 'y' }, alias)?.[0]).toEqual({ kind: 'header', text: 'a.ts' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['another tool', 'Bash', { command: 'ls' }],
    ['a missing path', 'Edit', { old_string: 'x', new_string: 'y' }],
    ['non-text strings', 'Edit', { file_path: '/p', old_string: 1, new_string: 2 }],
    ['an input that is not an object', 'Edit', 'text'],
  ])('has no diff for %s', (_label, name, input) => {
    expect(diffOfToolInput(name, input, '/p')).toBeUndefined();
  });
});

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
