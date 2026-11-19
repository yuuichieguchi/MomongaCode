import { describe, expect, it, vi } from 'vitest';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

const ESC = '\u001b';
const SIZE = { columns: 80, rows: 30 };
const hover = (col: number, row: number): string => `${ESC}[<35;${col};${row}M`;
const click = (col: number, row: number): string => `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`;
const rowOf = (lines: string[], text: string): number => lines.findIndex((line) => line.includes(text));
const wholeRowInverse = (app: TerminalApp, row: number): boolean => app.inverseAt(row, 0) && app.inverseAt(row, SIZE.columns - 1);

const withChild = async (): Promise<TerminalApp> => {
  const place = freshPlace();
  const app = await startOnTerminal(SIZE, { settingsPlace: { home: place.home, projectDir: place.project } });
  await app.type('go', (lines) => lines.some((line) => line.includes('go')), 'the prompt is typed');
  await app.type(KEYS.enter, () => true, 'the prompt is sent');
  await app.backend.called('openSession');
  const follow = app.backend.following();
  follow.onChildStarted?.('general-purpose', 'child-1', 0, SCRIPTED_MODEL);
  await app.type('', (lines) => lines.some((line) => line.includes('general-purpose · starting')), 'the child is listed');
  return app;
};

describe('the row under the mouse pointer', () => {
  it('lights the whole agent row under the pointer while the editor keeps the keys, and clears it when the pointer leaves', async () => {
    const app = await withChild();
    const row = rowOf(app.screen(), 'general-purpose · starting');
    expect(wholeRowInverse(app, row)).toBe(false);
    await app.type(hover(5, row + 1), () => wholeRowInverse(app, row), 'the hovered row is lit across the screen');
    expect(wholeRowInverse(app, rowOf(app.screen(), 'main'))).toBe(false);
    const typed = await app.type('x', (lines) => lines.some((line) => line.includes('> x')), 'a typed character goes to the draft');
    expect(typed.join('\n')).not.toContain('Subagent general-purpose');
    expect(wholeRowInverse(app, row)).toBe(true);
    await app.type(hover(5, 1), () => !app.inverseAt(row, SIZE.columns - 1), 'the light goes when the pointer leaves');
    app.close();
  });

  it('never selects, never opens on a move without a button, and a click still opens the row', async () => {
    const app = await withChild();
    const row = rowOf(app.screen(), 'general-purpose · starting');
    const asked = rowOf(app.screen(), 'go');
    await app.type(`${hover(1, asked + 1)}${hover(4, asked + 1)}${hover(8, asked + 1)}${hover(5, row + 1)}`, () => wholeRowInverse(app, row), 'the pointer sweeps to the row');
    for (let column = 0; column < 8; column += 1) expect(app.inverseAt(asked, column)).toBe(false);
    expect(app.screen().join('\n')).not.toContain('Subagent general-purpose');
    await app.type(click(5, row + 1), (lines) => lines.some((line) => line.includes('Subagent general-purpose')), 'a click opens the row');
    app.close();
  });

  it('moves the chosen row of a picker to the hovered row, and Enter decides that row', async () => {
    const place = freshPlace();
    const app = await startOnTerminal(SIZE, { settingsPlace: { home: place.home, projectDir: place.project } });
    await app.type('/config', (lines) => lines.some((line) => line.includes('/config')), 'the command is typed');
    await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes(SETTINGS_TITLE)), 'the settings list is shown');
    const filtered = await app.type('Automatic', (lines) => lines.some((line) => line.includes('Automatic updates')) && lines.some((line) => line.includes('› ') && line.includes('Automatic compaction')), 'the list is filtered');
    const second = rowOf(filtered, 'Automatic updates');
    await app.type(hover(10, second + 1), (lines) => (lines[second] ?? '').includes('› '), 'the chosen row follows the pointer');
    await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes('Automatic updates  off  user')), 'Enter decides the hovered row');
    expect(app.screen().join('\n')).not.toContain('Automatic compaction  off  user');
    app.close();
  });
});
