import { describe, expect, it } from 'vitest';
import { DIFF_FILE_TOO_LARGE, DIFF_HUNK_TEXT_MAX_BYTES, DIFF_MAX_BYTES, DIFF_TOO_LARGE, diffOfContents, diffOfReplacements } from '../../src/builtins/applied-diff.ts';
import { makeBuiltins, range, resultOf } from './fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;

const numbered = (from: number, to: number): string => range(from, to).map((n) => `line${n}\n`).join('');

describe('the diff an applied change carries in its result', () => {
  it('Edit: one hunk over the changed region with three lines of context and both start lines', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('e.txt', numbered(1, 20));
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'line10', new_string: 'changed10\nextra' }, ACCEPT));
    expect(result.hunks).toEqual([{ oldStart: 7, newStart: 7, lines: [' line7', ' line8', ' line9', '-line10', '+changed10', '+extra', ' line11', ' line12', ' line13'] }]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.diffOmitted).toBeUndefined();
  });

  it('Edit: the text the model reads is the same as before the diff was added', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('m.txt', 'one\ntwo\nthree\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'two', new_string: 'TWO' }, ACCEPT));
    expect(result.output).toBe(`The file m.txt has been updated. Here is the result of running cat -n on a snippet of the edited file:\n     1\tone\n     2\tTWO\n     3\tthree`);
  });

  it('Edit with replace_all: one hunk per distant place, the later hunk shifted by the lines added before it', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('all.txt', `x\n${numbered(2, 19)}x\n`);
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'x\n', new_string: 'y\nz\n', replace_all: true }, ACCEPT));
    expect(result.hunks).toEqual([
      { oldStart: 1, newStart: 1, lines: ['-x', '+y', '+z', ' line2', ' line3', ' line4'] },
      { oldStart: 17, newStart: 18, lines: [' line17', ' line18', ' line19', '-x', '+y', '+z'] },
    ]);
    expect(result.added).toBe(4);
    expect(result.removed).toBe(2);
  });

  it('two replacements on one line are one changed line', () => {
    expect(diffOfReplacements('a a\nb\n', [
      { position: 0, length: 1, text: 'c' },
      { position: 2, length: 1, text: 'c' },
    ])).toEqual({ hunks: [{ oldStart: 1, newStart: 1, lines: ['-a a', '+c c', ' b'] }], added: 1, removed: 1 });
  });

  it('a replacement that removes whole lines shows only those lines as removed', () => {
    expect(diffOfReplacements('a\nb\nc\n', [{ position: 2, length: 2, text: '' }])).toEqual({ hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', ' c'] }], added: 0, removed: 1 });
  });

  it('Write of a new file: every line added, from line one', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Write', { file_path: 'new.txt', content: 'a\nb\nc\n' }, ACCEPT));
    expect(result.hunks).toEqual([{ oldStart: 1, newStart: 1, lines: ['+a', '+b', '+c'] }]);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.output).toBe('Created new.txt (3 lines)');
  });

  it('Write over a file: the diff against the previous content', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('w.txt', 'keep\nold\nend\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'keep\nnew 1\nnew 2\nend\n' }, ACCEPT));
    expect(result.hunks).toEqual([{ oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new 1', '+new 2', ' end'] }]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
  });

  it('a file of exactly 256 KiB is compared; one byte more on either side is omitted with the reason', () => {
    const atBound = 'x'.repeat(DIFF_MAX_BYTES);
    expect(diffOfContents('a\n', atBound).diffOmitted).toBe(DIFF_TOO_LARGE);
    expect(diffOfContents('a\n', atBound).added).toBe(1);
    expect(diffOfContents('a\n', `${atBound}y`)).toEqual({ diffOmitted: DIFF_FILE_TOO_LARGE });
    expect(diffOfContents(`${atBound}y`, 'a\n')).toEqual({ diffOmitted: 'file larger than 256 KiB' });
  });

  it('keeps at most 64 KiB of hunk text and still counts every line', () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `${String(index).padStart(5, '0')} ${'y'.repeat(40)}`);
    const diff = diffOfContents(null, `${lines.join('\n')}\n`);
    const stored = (diff.hunks ?? []).flatMap((hunk) => hunk.lines);
    expect(stored.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0)).toBeLessThanOrEqual(DIFF_HUNK_TEXT_MAX_BYTES);
    expect(stored.length).toBe(Math.floor(DIFF_HUNK_TEXT_MAX_BYTES / 47));
    expect(diff.added).toBe(3000);
    expect(diff.diffOmitted).toBe('diff larger than 64 KiB');
  });

  it('a failed Edit carries no diff', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('f.txt', 'a\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'missing', new_string: 'b' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.hunks).toBeUndefined();
    expect(result.added).toBeUndefined();
    expect(result.diffOmitted).toBeUndefined();
  });
});
