import { describe, expect, it } from 'vitest';
import { DIFF_PREVIEW_ROWS } from '../../src/tui/screen/diff.ts';
import { rowsOfEntry } from '../../src/tui/screen/entry-rows.ts';
import { createPager, entryViewLines, hasHiddenLines, OUTPUT_TAIL_MAX_BYTES, tailOf, VIEWER_UNIT_BYTES } from '../../src/tui/screen/tool-view.ts';
import { displayWidth, logicalText } from '../../src/tui/screen/wrap.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import { tickRunningTools } from '../../src/tui/transcript.ts';
import type { ToolEntry } from '../../src/tui/transcript.ts';
import { eventOf, plainOf, randomText, seeded, storeOf } from './screen-fakes.ts';

const texts = (rows: readonly Row[]): string[] => rows.map((row) => row.text);

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: { command: 'ls' }, createdAt: 1000 };
const started = { type: 'tool.started', callId: 'c1', idemKey: 'k', createdAt: 1000 };
const completed = (output: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'tool.completed', callId: 'c1', status: 'completed', output, createdAt: 9000, ...extra });

const toolOf = (events: readonly Record<string, unknown>[]): ToolEntry => {
  const entry = plainOf(storeOf(events)).entries[0];
  if (entry?.kind !== 'tool') throw new Error('the first entry is not a tool');
  return entry;
};

const numbered = (count: number): string => Array.from({ length: count }, (_, index) => `out ${index}`).join('\n');

const HOSTILE = '\u001b[2J\u001b]0;owned\u0007‮gnp.exe\u009b31m';

describe('the output under a tool line (7.2)', () => {
  it('shows a short output whole, dim, under the mark and title', () => {
    const rows = rowsOfEntry(toolOf([call, started, completed('a.ts\nb.ts\nc.ts\n')]), 40);
    expect(texts(rows)).toEqual(['✓ Bash ls', '  a.ts', '  b.ts', '  c.ts']);
    expect(rows[1]?.spans).toEqual([[0, 6, 'dim']]);
    expect(rows[1]?.prefixCols).toBe(2);
  });

  it('shows the last 5 lines of a long output and counts the hidden lines on the first row of the block', () => {
    const rows = rowsOfEntry(toolOf([call, started, completed(numbered(125))]), 60);
    expect(texts(rows)).toEqual(['✓ Bash ls', '  … +120 lines (ctrl+o to expand)', '  out 120', '  out 121', '  out 122', '  out 123', '  out 124']);
    expect(rows[1]?.spans).toEqual([[0, 33, 'dim']]);
  });

  it('shows exactly 5 lines without a count and 6 lines with one hidden', () => {
    expect(texts(rowsOfEntry(toolOf([call, completed(numbered(5))]), 60))).toEqual(['✓ Bash ls', '  out 0', '  out 1', '  out 2', '  out 3', '  out 4']);
    expect(texts(rowsOfEntry(toolOf([call, completed(numbered(6))]), 60))).toEqual(['✓ Bash ls', '  … +1 lines (ctrl+o to expand)', '  out 1', '  out 2', '  out 3', '  out 4', '  out 5']);
  });

  it('cuts each line to the width with an ellipsis and never splits a wide character', () => {
    const entry = toolOf([call, completed('abcdefghijklmnop\n漢字漢字漢字漢字\nfits')]);
    expect(texts(rowsOfEntry(entry, 10))).toEqual(['✓ Bash ls', '  abcdefg…', '  漢字漢…', '  fits']);
    expect(texts(rowsOfEntry(entry, 20))).toEqual(['✓ Bash ls', '  abcdefghijklmnop', '  漢字漢字漢字漢字', '  fits']);
    expect(texts(rowsOfEntry(entry, 3)).slice(-3)).toEqual(['  …', '  …', '  …']);
    for (const width of [3, 10, 20]) for (const row of rowsOfEntry(entry, width)) expect(displayWidth(row.text)).toBeLessThanOrEqual(width);
  });

  it('shows no block for an empty output', () => {
    expect(texts(rowsOfEntry(toolOf([call, completed('')]), 40))).toEqual(['✓ Bash ls']);
    expect(texts(rowsOfEntry(toolOf([call, completed('\n')]), 40))).toEqual(['✓ Bash ls']);
  });

  it('uses the same block for a failed tool and an unknown outcome, each with its mark', () => {
    const failed = toolOf([call, { type: 'tool.completed', callId: 'c1', status: 'failed', output: numbered(8) }]);
    expect(texts(rowsOfEntry(failed, 60))).toEqual(['✗ Bash ls', '  … +3 lines (ctrl+o to expand)', '  out 3', '  out 4', '  out 5', '  out 6', '  out 7']);
    const unknown = toolOf([call, { type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'effect unknown' }]);
    expect(texts(rowsOfEntry(unknown, 60))).toEqual(['? Bash ls', '  effect unknown']);
  });

  it('keeps the reason of a denied call in the place of its output', () => {
    const denied = toolOf([call, { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'Permission denied: no', denial: { source: 'rule', reason: 'Bash(ls) is denied' } }]);
    const rows = rowsOfEntry(denied, 80);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe('✗ Bash ls');
    expect(rows[1]?.spans[0]?.[2]).toBe('error');
  });

  it('shows whole elapsed seconds on a running tool, counted from the call event by the injected clock', () => {
    const store = storeOf([call, { ...started, createdAt: 3200 }]);
    const shownNow = (): string[] => texts(rowsOfEntry(toolOf2(store), 40));
    const toolOf2 = (from: typeof store): ToolEntry => {
      const entry = from.at(0).entry;
      if (entry.kind !== 'tool') throw new Error('not a tool');
      return entry;
    };
    expect(shownNow()).toEqual(['⠹ Bash ls · 2s']);
    tickRunningTools(store, 13_999);
    expect(shownNow()).toEqual(['⠹ Bash ls · 12s']);
    const version = store.at(0).version;
    tickRunningTools(store, 13_999);
    expect(store.at(0).version).toBe(version);
    tickRunningTools(store, 14_000);
    expect(shownNow()).toEqual(['⠸ Bash ls · 13s']);
  });

  it('does not tick a tool that only waits for its approval or has ended', () => {
    const waiting = storeOf([call]);
    tickRunningTools(waiting, 60_000);
    expect(texts(rowsOfEntry(waiting.at(0).entry, 40))).toEqual(['· Bash ls']);
    const ended = storeOf([call, started, completed('done')]);
    const before = ended.at(0).version;
    tickRunningTools(ended, 60_000);
    expect(ended.at(0).version).toBe(before);
    expect(ended.state().runningTools).toEqual([]);
  });

  it('shows the output a running tool reports before its result, and replaces it with the result', () => {
    const update = (text: string): Record<string, unknown> => ({ type: 'tool.updated', callId: 'c1', content: [{ type: 'content', content: { type: 'text', text } }] });
    const running = toolOf([call, started, update(numbered(3)), update(numbered(7))]);
    expect(texts(rowsOfEntry(running, 60))).toEqual(['⠋ Bash ls · 0s', '  … +2 lines (ctrl+o to expand)', '  out 2', '  out 3', '  out 4', '  out 5', '  out 6']);
    const done = toolOf([call, started, update(numbered(7)), completed('final')]);
    expect(texts(rowsOfEntry(done, 60))).toEqual(['✓ Bash ls', '  final']);
  });

  it('keeps hostile output inert: no control character reaches a row', () => {
    const rows = rowsOfEntry(toolOf([call, completed(`first\n${HOSTILE}\nlast\ttab`)]), 80);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(row.text)).toBe(false);
    expect(rows[3]?.text).toBe('  last    tab');
  });

  it('keeps only a bounded tail of a huge output for the row', () => {
    const huge = `${'x'.repeat(1024 * 1024)}\n${numbered(3)}`;
    const entry = toolOf([call, completed(huge)]);
    expect(entry.tail?.hidden).toBe(0);
    expect(entry.tail?.lines.slice(1)).toEqual(['out 0', 'out 1', 'out 2']);
    expect(entry.tail?.lines[0]?.startsWith('…')).toBe(true);
    expect(entry.tail?.lines.join('\n').length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX_BYTES + 1);
    const oneLine = tailOf('y'.repeat(1024 * 1024));
    expect(oneLine?.hidden).toBe(0);
    expect(oneLine?.lines).toHaveLength(1);
    expect(oneLine?.lines[0]?.length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX_BYTES + 1);
    expect(oneLine?.lines[0]?.startsWith('…')).toBe(true);
    const many = tailOf(`${numbered(100_000)}`);
    expect(many?.hidden).toBe(99_995);
    expect((many?.lines ?? []).join('\n').length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX_BYTES);
  });

  it('P15: for any output the block is its last 5 lines, the count is the lines not shown, and the viewer text is the output', () => {
    const random = seeded(11);
    for (let round = 0; round < 60; round += 1) {
      const output = randomText(random, Math.floor(random() * 400)).replace(/\n+$/, '');
      const entry = toolOf([call, completed(output)]);
      const lines = output === '' ? [] : output.split('\n');
      const rows = rowsOfEntry(entry, 2000).slice(1);
      const hidden = Math.max(0, lines.length - 5);
      expect(texts(rows)).toEqual([...(hidden > 0 ? [`  … +${hidden} lines (ctrl+o to expand)`] : []), ...lines.slice(-5).map((line) => `  ${line}`)]);
      expect(hasHiddenLines(entry)).toBe(hidden > 0);
      const pager = createPager(entryViewLines(entry), 1 + Math.floor(random() * 30));
      pager.fill(Number.POSITIVE_INFINITY);
      expect(logicalText(pager.rows).split('\n').map((line) => line.trimEnd())).toEqual((output === '' ? [''] : lines).map((line) => line.trimEnd()));
    }
  });
});

describe('the viewer rows (7.2)', () => {
  it('wraps only as far as it is asked, in units of 16 KiB', () => {
    const output = Array.from({ length: 20_000 }, (_, index) => `row ${index}`).join('\n');
    const pager = createPager(entryViewLines(toolOf([call, completed(output)])), 40);
    pager.fill(10);
    expect(pager.complete()).toBe(false);
    expect(pager.rows.length).toBeGreaterThanOrEqual(10);
    expect(pager.rows.length).toBeLessThanOrEqual(VIEWER_UNIT_BYTES / 4);
    expect(pager.rows[0]?.text).toBe('row 0');
    pager.fill(Number.POSITIVE_INFINITY);
    expect(pager.complete()).toBe(true);
    expect(pager.rows).toHaveLength(20_000);
  });

  it('handles one line larger than a unit in pieces and keeps hostile text inert', () => {
    const pager = createPager(entryViewLines(toolOf([call, completed(`${'z'.repeat(40_000)}\n${HOSTILE}`)])), 100);
    pager.fillUnit();
    expect(pager.complete()).toBe(false);
    expect(pager.rows.length).toBeLessThanOrEqual(Math.ceil(VIEWER_UNIT_BYTES / 100));
    pager.fill(Number.POSITIVE_INFINITY);
    expect(pager.rows.reduce((count, row) => count + (row.text.match(/z/g) ?? []).length, 0)).toBe(40_000);
    for (const row of pager.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(100);
    for (const row of pager.rows) expect(/[\u0000-\u001f\u007f-\u009f‪-‮]/u.test(row.text)).toBe(false);
  });
});

const edit = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit src/a.ts', rawInput: { file_path: 'src/a.ts', old_string: 'line10', new_string: 'changed10\nextra' }, createdAt: 1000 };
const EDIT_OUTPUT = 'The file src/a.ts has been updated. Here is the result of running cat -n on a snippet of the edited file:\n     9\tline9\n    10\tchanged10';
const hunk = { oldStart: 7, newStart: 7, lines: [' line7', ' line8', ' line9', '-line10', '+changed10', '+extra', ' line11', ' line12', ' line13'] };

describe('the diff of an applied change, in place (7.3)', () => {
  it('follows the tool line with the summary and the numbered hunk: new numbers, old numbers for removed lines, signs kept', () => {
    const rows = rowsOfEntry(toolOf([edit, completed(EDIT_OUTPUT, { hunks: [hunk], added: 2, removed: 1 })]), 40);
    expect(texts(rows)).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (+2 -1)', '   7  line7', '   8  line8', '   9  line9', '  10 -line10', '  10 +changed10', '  11 +extra', '  12  line11', '  13  line12', '  14  line13']);
    expect(rows[5]?.spans).toEqual([[0, 12, 'diff.removed']]);
    expect(rows[6]?.spans).toEqual([[0, 15, 'diff.added']]);
    expect(rows[2]?.spans).toEqual([]);
  });

  it('cuts each diff row to the width', () => {
    const rows = rowsOfEntry(toolOf([edit, completed(EDIT_OUTPUT, { hunks: [hunk], added: 2, removed: 1 })]), 12);
    expect(texts(rows).slice(-9)).toEqual(['   7  line7', '   8  line8', '   9  line9', '  10 -line10', '  10 +chang…', '  11 +extra', '  12  line11', '  13  line12', '  14  line13']);
    for (const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(12);
  });

  it('shows a written new file as added lines from line one, and separates two hunks', () => {
    const write = { ...edit, name: 'Write', title: 'Write notes/new.md' };
    expect(texts(rowsOfEntry(toolOf([write, completed('Created notes/new.md (2 lines)', { hunks: [{ oldStart: 1, newStart: 1, lines: ['+a', '+b'] }], added: 2, removed: 0 })]), 40))).toEqual(['✓ Write notes/new.md', '• Edited notes/new.md (+2 -0)', '  1 +a', '  2 +b']);
    const two = [
      { oldStart: 1, newStart: 1, lines: ['-x', '+y', '+z', ' b'] },
      { oldStart: 98, newStart: 99, lines: [' c', '-x', '+y'] },
    ];
    expect(texts(rowsOfEntry(toolOf([edit, completed(EDIT_OUTPUT, { hunks: two, added: 3, removed: 2 })]), 40))).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (+3 -2)', '    1 -x', '    1 +y', '    2 +z', '    3  b', '  ⋮', '   99  c', '   99 -x', '  100 +y']);
  });

  it('draws at most 40 diff rows and counts the rest; the viewer has all of them', () => {
    const added = (count: number): Record<string, unknown> => completed('Created', { hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: count }, (_, index) => `+new ${index}`) }], added: count, removed: 0 });
    const atBound = rowsOfEntry(toolOf([edit, added(DIFF_PREVIEW_ROWS)]), 60);
    expect(atBound).toHaveLength(2 + 40);
    expect(atBound.at(-1)?.text).toBe('  40 +new 39');
    const over = toolOf([edit, added(64)]);
    const rows = rowsOfEntry(over, 60);
    expect(rows).toHaveLength(2 + 40 + 1);
    expect(rows.at(-2)?.text).toBe('  40 +new 39');
    expect(rows.at(-1)?.text).toBe('  … +24 lines (ctrl+o to expand)');
    expect(hasHiddenLines(over)).toBe(true);
    expect(hasHiddenLines(toolOf([edit, added(40)]))).toBe(false);
    const pager = createPager(entryViewLines(over), 60);
    pager.fill(Number.POSITIVE_INFINITY);
    expect(pager.rows).toHaveLength(1 + 64);
    expect(pager.rows[0]?.text).toBe('• Edited src/a.ts (+64 -0)');
    expect(pager.rows.at(-1)?.text).toBe('  64 +new 63');
  });

  it('says why a diff is missing or cut', () => {
    expect(texts(rowsOfEntry(toolOf([edit, completed('Updated', { diffOmitted: 'file larger than 256 KiB' })]), 80))).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (diff omitted: file larger than 256 KiB)']);
    expect(texts(rowsOfEntry(toolOf([edit, completed('Updated', { hunks: [{ oldStart: 1, newStart: 1, lines: ['+a'] }], added: 900, removed: 0, diffOmitted: 'diff larger than 64 KiB' })]), 80))).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (+900 -0)', '  1 +a', '  (diff omitted: diff larger than 64 KiB)']);
  });

  it('shows no diff for an edit that failed, only its output like any tool', () => {
    const failed = toolOf([edit, { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'old_string was not found in src/a.ts. It must match the file exactly, including whitespace and indentation.' }]);
    expect(failed.diff).toBeUndefined();
    expect(texts(rowsOfEntry(failed, 40))).toEqual(['✗ Edit src/a.ts', '  old_string was not found in src/a.ts.…']);
  });

  it('shows a stored result without the diff fields as the tool line and its output', () => {
    expect(texts(rowsOfEntry(toolOf([edit, completed('Updated src/a.ts (3 lines)')]), 40))).toEqual(['✓ Edit src/a.ts', '  Updated src/a.ts (3 lines)']);
  });

  it('keeps hostile file text inert in the diff rows and names the path of a subagent call without the agent', () => {
    const child = { ...edit, title: 'reviewer: Edit src/a.ts' };
    const rows = rowsOfEntry(toolOf([child, completed(EDIT_OUTPUT, { hunks: [{ oldStart: 1, newStart: 1, lines: [`+${HOSTILE}`] }], added: 1, removed: 0 })]), 80);
    expect(rows[1]?.text).toBe('• Edited src/a.ts (+1 -0)');
    for (const row of rows) expect(/[\u0000-\u001f\u007f-\u009f‪-‮]/u.test(row.text)).toBe(false);
  });
});

describe('folding tool events', () => {
  it('gives the same entry live and replayed, whatever the clock ticked in between', () => {
    const events = [call, started, completed(numbered(9))];
    const live = storeOf(events.slice(0, 2));
    tickRunningTools(live, 7777);
    storeOf(events.slice(2), live);
    expect(plainOf(live).entries).toEqual(plainOf(storeOf(events)).entries);
    expect(eventOf(call).type).toBe('tool.call');
  });
});
