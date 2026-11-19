import { describe, expect, it, vi } from 'vitest';
import { MODEL_SETTINGS_ROW } from '@momonga/protocol';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { command, freshPlace, press, startAt } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const COLUMNS = 40;

const inner = (line: string): string => line.replace(/^│ ?/, '').replace(/ ?│\s*$/, '');

type Numbered = { readonly line: string; readonly marker: number; readonly dot: number; readonly label: number; readonly text: string };

const numberedRows = (frame: string): Numbered[] =>
  frame.split('\n').map(inner).flatMap((line) => {
    const match = /^([› ]) +(\d+)\. (.*)$/.exec(line);
    if (match === null) return [];
    const dot = line.indexOf(`${match[2]}.`) + (match[2]?.length ?? 0);
    return [{ line, marker: line.indexOf(match[1] ?? ''), dot, label: dot + 2, text: match[3] ?? '' }];
  });

const rowOf = (rows: readonly Numbered[], number: number): Numbered => {
  const row = rows.find((candidate) => new RegExp(`^[› ] +${number}\\. `).test(candidate.line));
  if (row === undefined) throw new Error(`no row ${number} in ${rows.map((candidate) => candidate.line).join('\n')}`);
  return row;
};

describe('a numbered list reads as one column of labels and a tree of child rows', () => {
  it('right-aligns the numbers, keeps the marker in the first column and indents child rows under their parent, at 40 columns', async () => {
    const started = await startAt(freshPlace(), { models: ['ollama/qwen3.8:27b', 'ollama/gemma-3-4b', 'lmstudio/devstral'] }, undefined, { size: { columns: COLUMNS, rows: 40 } });
    await command(started, '/model', MODEL_SETTINGS_ROW);
    await press(started, KEYS.up, new RegExp(`› +\\d+\\. ${MODEL_SETTINGS_ROW}`));
    const hub = await press(started, KEYS.enter, 'Check the servers');
    const rows = numberedRows(hub);
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of hub.split('\n').map(inner)) expect(row.length, row).toBeLessThanOrEqual(COLUMNS);
    const nine = rowOf(rows, 9);
    const ten = rowOf(rows, 10);
    expect(nine.label).toBe(ten.label);
    expect(nine.dot).toBe(ten.dot);
    for (const row of rows) expect(row.dot, row.line).toBe(ten.dot);
    const chosen = rows.find((row) => row.line.startsWith('›'));
    expect(chosen?.marker).toBe(0);
    const server = rowOf(rows, 1);
    const first = rowOf(rows, 2);
    const second = rowOf(rows, 3);
    expect(server.text).toMatch(/^ollama/);
    const childIndent = (row: Numbered): number => row.text.search(/[a-z0-9]/i);
    expect(childIndent(first)).toBeGreaterThanOrEqual(2);
    expect(childIndent(second)).toBe(childIndent(first));
    expect(first.text).toMatch(/^[├└]─ /);
    expect(second.text).toMatch(/^└─ /);
    expect(rowOf(rows, 4).text).toMatch(/^lmstudio/);
    expect(rowOf(rows, 5).text).toMatch(/^└─ /);
    started.app.unmount();
  });
});
