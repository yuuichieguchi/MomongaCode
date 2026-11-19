import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, startPlan, untilRow } from '../fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP = { startup: { version: '1.2.3', home: '/Users/ada' } };
const VERSION = 'MomongaCode v1.2.3';
const WELCOME_TITLE = 'Connect a model to start';
const TRUST_ROW = '1. Yes, I trust this folder';
const FIGURE_ROWS = 7;
const DESCRIPTION = 'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.';
const HINT_ROW = 'esc: go back';
const LIST_ROWS = ['1. Continue with ChatGPT', '2. Use an API key', '3. Use a local server', HINT_ROW];

const rowsOf = (frame: string): string[] => frame.split('\n');

const rowIndexOf = (rows: readonly string[], text: string): number => {
  const index = rows.findIndex((row) => row.includes(text));
  if (index === -1) throw new Error(`no row with ${text} in:\n${rows.join('\n')}`);
  return index;
};

const bannerEndOf = (rows: readonly string[]): number => rows.findIndex((row) => row.trimStart().startsWith('╰') && row.trimEnd().endsWith('╯'));

const expectListUnderStartScreen = (frame: string, firstListText: string): void => {
  const rows = rowsOf(frame);
  expect(rowIndexOf(rows, VERSION)).toBeLessThan(8);
  const end = bannerEndOf(rows);
  expect(end).toBeGreaterThan(rowIndexOf(rows, VERSION));
  expect(rows.slice(end + 1).findIndex((row) => row.includes(firstListText))).toBeLessThanOrEqual(1);
  expect(rows.slice(end + 1, rowIndexOf(rows, firstListText)).every((row) => !/[\w›]/.test(row.replace(/[│╭╮─]/g, '')))).toBe(true);
};

const SCREENS = [
  ['100x50', { columns: 100, rows: 50 }],
  ['40x24', { columns: 40, rows: 24 }],
] as const;

describe('the first screen shows the start screen at the top with the list directly under it', () => {
  it.each(SCREENS)('the welcome list at %s', async (_name, screen) => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, screen);
    const frame = await untilFrame(app, (shown) => shown.includes(WELCOME_TITLE) && shown.includes(VERSION));
    expectListUnderStartScreen(frame, WELCOME_TITLE);
    expect(frame).toContain('model: not connected');
    expect(frame).not.toContain('(use /login)');
    app.unmount();
  });

  it.each(SCREENS)('the folder trust prompt at %s', async (_name, screen) => {
    const { app } = await startPlan({ models: [], accounts: [], trust: { path: '/work/project', decision: null } }, STARTUP, screen);
    const frame = await untilFrame(app, (shown) => shown.includes(TRUST_ROW) && shown.includes(VERSION));
    const rows = rowsOf(frame);
    expect(rowIndexOf(rows, VERSION)).toBeLessThan(8);
    expect(rowIndexOf(rows, TRUST_ROW)).toBeLessThan(bannerEndOf(rows) + 12);
    expect(frame).not.toContain('model:');
    expect(frame).not.toContain('(use /login)');
    app.unmount();
  });

  it('on a short terminal the figure gives way and every row of the welcome list stays visible', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, { columns: 100, rows: 12 });
    const frame = await untilFrame(app, (shown) => shown.includes(WELCOME_TITLE) && shown.includes(VERSION) && shown.includes('esc: go back') && !shown.includes('∩'));
    expect(frame).toContain('1. Continue with ChatGPT');
    expect(frame).toContain('2. Use an API key');
    expect(frame).toContain('3. Use a local server');
    expectListUnderStartScreen(frame, WELCOME_TITLE);
    app.unmount();
  });

  it('at 40 columns the description of the sign-in row is wrapped under it, dimmed, within the width', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, { columns: 40, rows: 40 });
    const frame = await untilFrame(app, (shown) => shown.includes(WELCOME_TITLE) && shown.includes('3. Use a local server'));
    const rows = rowsOf(frame);
    const first = rowIndexOf(rows, '1. Continue with ChatGPT');
    const second = rowIndexOf(rows, '2. Use an API key');
    const between = rows.slice(first + 1, second);
    expect(between.length).toBeGreaterThan(1);
    expect(between.join(' ').replace(/[│]/g, ' ').replace(/\s+/g, ' ').trim()).toBe(DESCRIPTION);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
    app.unmount();
  });

  it('after esc the start screen is shown exactly once and points to /login', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, { columns: 100, rows: 50 });
    await untilRow(app, 'Continue with ChatGPT');
    app.stdin.write(KEYS.escape);
    const frame = await untilFrame(app, (shown) => !shown.includes(WELCOME_TITLE) && shown.includes('(use /login)'));
    expect(frame.split(VERSION)).toHaveLength(2);
    app.unmount();
  });

  it.each([
    ['100x12', { columns: 100, rows: 12 }],
    ['100x50', { columns: 100, rows: 50 }],
  ] as const)('every frame from launch at %s shows the figure whole or not at all, and the list whole', async (_name, screen) => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, screen);
    await untilFrame(app, (shown) => shown.includes(WELCOME_TITLE) && shown.includes('esc: go back'));
    const shown = app.frames.filter((frame) => frame.includes(VERSION));
    expect(shown.length).toBeGreaterThan(0);
    for (const frame of shown) {
      const figureRows = rowsOf(frame).filter((row) => /[∩•░┬]|╰─╮/.test(row)).length;
      expect([0, FIGURE_ROWS]).toContain(figureRows);
      if (frame.includes(WELCOME_TITLE)) for (const row of LIST_ROWS.filter((row) => row !== HINT_ROW || frame.includes('to choose'))) expect(frame).toContain(row);
    }
    app.unmount();
  });
});
