import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { footerRow as footerRowWith } from '../../src/tui/screen/footer.tsx';
import { allocate, inputTopOf, naturalRows, regionAt } from '../../src/tui/screen/layout.ts';
import type { RowRequests } from '../../src/tui/screen/layout.ts';
import { displayWidth } from '../../src/tui/screen/wrap.ts';
import { MIN_ROWS } from '../../src/tui/terminal/constants.ts';
import { seeded } from './screen-fakes.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const footerRow = (facts: Parameters<typeof footerRowWith>[0], width: number) => footerRowWith(facts, width, DEFAULT_KEY_TABLE);

const none: RowRequests = { waiting: 0, inputRows: 1, invitation: 0, menu: 0, subagents: 0, footerSecond: 0, lines: 0, panel: undefined };

const sumOf = (rows: ReturnType<typeof allocate>): number => rows.viewport + rows.menu + rows.waiting + rows.lines + rows.input + rows.footer + rows.subagents;

describe('row allocation', () => {
  it('gives the input three rows, the footer one and the rest to the viewport when nothing else asks', () => {
    expect(allocate(24, none)).toEqual({ viewport: 20, menu: 0, waiting: 0, lines: 0, input: 3, footer: 1, subagents: 0 });
    expect(allocate(MIN_ROWS, none)).toEqual({ viewport: 2, menu: 0, waiting: 0, lines: 0, input: 3, footer: 1, subagents: 0 });
  });

  it('serves the requests in the order waiting row, input rows, menu, subagents, second footer row, lines', () => {
    const asked: RowRequests = { waiting: 1, inputRows: 9, invitation: 0, menu: 9, subagents: 9, footerSecond: 1, lines: 9, panel: undefined };
    expect(allocate(6, asked)).toEqual({ viewport: 1, menu: 0, waiting: 1, lines: 0, input: 3, footer: 1, subagents: 0 });
    expect(allocate(7, asked)).toEqual({ viewport: 1, menu: 0, waiting: 1, lines: 0, input: 4, footer: 1, subagents: 0 });
    expect(allocate(30, asked)).toEqual({ viewport: 1, menu: 9, waiting: 1, lines: 1, input: 11, footer: 2, subagents: 5 });
    expect(allocate(60, asked)).toEqual({ viewport: 23, menu: 9, waiting: 1, lines: 9, input: 11, footer: 2, subagents: 5 });
  });

  it('caps the input rows and the menu at a third of the height and the subagent rows at five or a sixth', () => {
    const asked: RowRequests = { ...none, inputRows: 100, menu: 100, subagents: 100 };
    const rows = allocate(24, asked);
    expect(rows.input).toBe(2 + 8);
    expect(rows.menu).toBeLessThanOrEqual(8);
    expect(rows.subagents).toBeLessThanOrEqual(4);
    expect(allocate(60, asked).subagents).toBe(5);
  });

  it('gives a prompt panel the place of the input and the menu, at most the height less four', () => {
    expect(allocate(24, { ...none, panel: 9, menu: 5, inputRows: 4 })).toEqual({ viewport: 14, menu: 0, waiting: 0, lines: 0, input: 9, footer: 1, subagents: 0 });
    expect(allocate(24, { ...none, panel: 90, waiting: 1 }).input).toBe(20);
    expect(allocate(24, { ...none, panel: 90, waiting: 1 }).viewport).toBe(2);
  });

  it('always leaves the viewport a row, sums to the height and keeps each part within its request, for any height and requests', () => {
    const random = seeded(23);
    for (let round = 0; round < 2000; round += 1) {
      const height = MIN_ROWS + Math.floor(random() * 80);
      const asked: RowRequests = {
        waiting: Math.floor(random() * 2),
        inputRows: 1 + Math.floor(random() * 30),
        invitation: Math.floor(random() * 2),
        menu: Math.floor(random() * 30),
        subagents: Math.floor(random() * 12),
        footerSecond: Math.floor(random() * 2),
        lines: Math.floor(random() * 10),
        panel: random() < 0.3 ? 1 + Math.floor(random() * 100) : undefined,
      };
      const rows = allocate(height, asked);
      expect(sumOf(rows)).toBe(height);
      expect(rows.viewport).toBeGreaterThanOrEqual(1);
      expect(rows.waiting).toBeLessThanOrEqual(asked.waiting);
      expect(rows.menu).toBeLessThanOrEqual(asked.invitation + asked.menu);
      if (asked.panel === undefined) expect(rows.menu).toBeGreaterThanOrEqual(asked.invitation);
      expect(rows.subagents).toBeLessThanOrEqual(asked.subagents);
      expect(rows.lines).toBeLessThanOrEqual(asked.lines);
      expect(rows.footer).toBeLessThanOrEqual(1 + asked.footerSecond);
      const more = allocate(height, { ...asked, waiting: 1, menu: asked.menu + 3 });
      if (asked.panel === undefined && more.subagents === rows.subagents && more.footer === rows.footer && more.input === rows.input) expect(more.viewport + more.menu + more.waiting + more.lines).toBe(rows.viewport + rows.menu + rows.waiting + rows.lines);
    }
  });

  it('gives the line of an open invitation its row before any other request, at 15 rows and at the smallest height', () => {
    const crowded: RowRequests = { waiting: 1, inputRows: 9, invitation: 1, menu: 0, subagents: 9, footerSecond: 1, lines: 9, panel: undefined };
    expect(allocate(15, crowded).menu).toBe(1);
    expect(allocate(MIN_ROWS, crowded)).toEqual({ viewport: 1, menu: 1, waiting: 0, lines: 0, input: 3, footer: 1, subagents: 0 });
    expect(allocate(MIN_ROWS, { ...crowded, menu: 9 }).menu).toBe(1);
    expect(allocate(24, { ...crowded, panel: 5 }).menu).toBe(0);
  });

  it('gives the top row of the input from the rows above it, in the fullscreen allocation and in the natural rows of scrollback', () => {
    const rows = allocate(24, { ...none, waiting: 1, menu: 2, lines: 1 });
    expect(inputTopOf(rows)).toBe(rows.viewport + 4);
    expect(regionAt(rows, inputTopOf(rows) + 1)).toEqual({ region: 'input', row: 0 });
    expect(inputTopOf(naturalRows(7, { waiting: 1, invitation: 1, menu: 0, lines: 2 }))).toBe(11);
    expect(inputTopOf(naturalRows(0, { waiting: 0, invitation: 0, menu: 30, lines: 0 }))).toBe(30);
  });

  it('names the region of a screen row from the allocation, top to bottom', () => {
    const rows = allocate(24, { ...none, waiting: 1, menu: 2, subagents: 1 });
    expect(regionAt(rows, 1)).toEqual({ region: 'viewport', row: 0 });
    expect(regionAt(rows, rows.viewport)).toEqual({ region: 'viewport', row: rows.viewport - 1 });
    expect(regionAt(rows, rows.viewport + 1)).toEqual({ region: 'menu', row: 0 });
    expect(regionAt(rows, rows.viewport + 3)).toEqual({ region: 'waiting', row: 0 });
    expect(regionAt(rows, rows.viewport + 4)).toEqual({ region: 'input', row: 0 });
    expect(regionAt(rows, 23)).toEqual({ region: 'footer', row: 0 });
    expect(regionAt(rows, 24)).toEqual({ region: 'subagents', row: 0 });
    expect(regionAt(rows, 25)).toBeUndefined();
  });
});

describe('the footer row', () => {
  const NEWLINE = 'ctrl+j: new line';
  const facts = { mode: 'manual', tokens: 0, contextPercent: 0 as number | undefined, imageInput: false, answer: undefined as string | undefined, newline: NEWLINE as string | undefined };
  const TASK_RUNNING = 'A run is working. Esc stops it.';

  it('shows the mode, the tokens and the context share, and the newline hint at the right end', () => {
    const row = footerRow(facts, 80);
    expect(row.startsWith('mode: manual (shift+tab) · tokens: 0 · context: 0%')).toBe(true);
    expect(row.endsWith('ctrl+j: new line')).toBe(true);
    expect(displayWidth(row)).toBe(80);
    expect(footerRow({ ...facts, tokens: 1600, contextPercent: 20, newline: 'shift+enter: new line' }, 80)).toMatch(/^mode: manual \(shift\+tab\) · tokens: 1\.6k · context: 20% +shift\+enter: new line$/);
  });

  it('says the context is unknown while the window is, never a guessed share', () => {
    expect(footerRow({ ...facts, contextPercent: undefined }, 80)).toContain('context: unknown');
  });

  it('shows the answer to the last key in the place of the newline hint', () => {
    const row = footerRow({ ...facts, answer: 'Copied 120 characters' }, 80);
    expect(row.endsWith('Copied 120 characters')).toBe(true);
    expect(row).not.toContain('new line');
  });

  it('drops whole segments as the row narrows: the newline hint first, then the image hint, the context, the tokens; then the mode loses its key and its label (P10)', () => {
    const wide = { ...facts, imageInput: true };
    const full = 'mode: manual (shift+tab) · tokens: 0 · context: 0% · image input: paste a file path';
    expect(footerRow(wide, full.length + 1 + NEWLINE.length)).toBe(`${full} ${NEWLINE}`);
    expect(footerRow(wide, full.length + NEWLINE.length)).toBe(full);
    expect(footerRow(wide, full.length - 1)).toBe('mode: manual (shift+tab) · tokens: 0 · context: 0%');
    expect(footerRow(wide, 49)).toBe('mode: manual (shift+tab) · tokens: 0');
    expect(footerRow(wide, 30)).toBe('mode: manual (shift+tab)');
    expect(footerRow(wide, 23)).toBe('mode: manual');
    expect(footerRow(wide, 11)).toBe('manual');
    for (let width = 6; width < 140; width += 1) expect(displayWidth(footerRow(wide, width))).toBeLessThanOrEqual(width);
  });

  it('keeps the answer to the last key while anything else can yield: at 80 columns the context share goes and the answer stays', () => {
    const row = footerRow({ ...facts, answer: TASK_RUNNING }, 80);
    expect(row.endsWith(TASK_RUNNING)).toBe(true);
    expect(row.startsWith('mode: manual (shift+tab) · tokens: 0 ')).toBe(true);
    expect(row).not.toContain('context');
    expect(displayWidth(row)).toBe(80);
  });

  it('shortens the mode to its id beside the answer and never cuts a word of it', () => {
    expect(footerRow({ ...facts, answer: 'Copied' }, 20)).toBe('mode: manual  Copied');
    expect(footerRow({ ...facts, answer: 'Copied 9 chars' }, 24)).toBe('manual    Copied 9 chars');
    expect(footerRow({ ...facts, answer: TASK_RUNNING }, 39)).toBe(`manual  ${TASK_RUNNING}`);
    expect(footerRow({ ...facts, answer: TASK_RUNNING }, 33)).toBe(TASK_RUNNING);
    expect(footerRow({ ...facts, answer: TASK_RUNNING }, 20)).toBe(TASK_RUNNING);
  });
});
