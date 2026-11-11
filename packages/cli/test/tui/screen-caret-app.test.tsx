import { describe, expect, it, vi } from 'vitest';
import { untilFrame } from '../ink-helpers.ts';
import { start } from '../tui-harness.tsx';

type CaretPosition = { x: number; y: number } | undefined;

const caret = vi.hoisted(() => ({ latest: undefined as { x: number; y: number } | undefined }));

vi.mock('ink', async (original) => ({
  ...(await original<typeof import('ink')>()),
  useCursor: () => ({
    setCursorPosition: (position: CaretPosition): void => {
      caret.latest = position;
    },
  }),
}));

const INPUT_ROW = /^│ > /;
const BOX_TOP_ROWS = 1;

const inputRowOf = (frame: string): number => frame.split('\n').findLastIndex((line) => INPUT_ROW.test(line));

describe('the caret of the input in scrollback mode (P-199)', () => {
  it('is on the row of the input in every frame, also in the frame that puts the command menu above the input', async () => {
    const { app } = await start({}, {}, { columns: 80, rows: 24, screen: 'scrollback' });
    const settled = await untilFrame(app, 'mode: manual');
    const offset = inputRowOf(settled) - ((caret.latest?.y ?? Number.NaN) - BOX_TOP_ROWS);
    const seen: { row: number; caretRow: number | undefined; frame: string }[] = [];
    app.stdout.on('write', (frame: string) => {
      const row = inputRowOf(frame);
      if (row >= 0) seen.push({ row, caretRow: caret.latest === undefined ? undefined : caret.latest.y - BOX_TOP_ROWS + offset, frame });
    });
    app.stdin.write('/');
    const menu = await untilFrame(app, '/help');
    expect(inputRowOf(menu)).toBeGreaterThan(inputRowOf(settled));
    expect(seen.length).toBeGreaterThan(0);
    for (const { row, caretRow, frame } of seen) expect(caretRow, frame).toBe(row);
    app.unmount();
  });
});
