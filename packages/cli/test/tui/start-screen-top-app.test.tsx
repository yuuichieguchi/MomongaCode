import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, startPlan, untilRow } from '../fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP = { startup: { version: '1.2.3', home: '/Users/ada' } };
const VERSION = 'MomongaCode v1.2.3';
const WELCOME_TITLE = 'Connect a model to start';
const TRUST_ROW = '1. Yes, I trust this folder';

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
    expect(frame).toContain('model: not connected');
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

  it('after esc the start screen is shown exactly once and points to /login', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, STARTUP, { columns: 100, rows: 50 });
    await untilRow(app, 'Continue with ChatGPT');
    app.stdin.write(KEYS.escape);
    const frame = await untilFrame(app, (shown) => !shown.includes(WELCOME_TITLE) && shown.includes('(use /login)'));
    expect(frame.split(VERSION)).toHaveLength(2);
    app.unmount();
  });
});
