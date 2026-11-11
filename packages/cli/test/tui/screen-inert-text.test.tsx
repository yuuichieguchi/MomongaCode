import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { startFlow } from '../../src/elicit/flow.ts';
import { emptyEditor } from '../../src/tui/editor.ts';
import type { EditorState } from '../../src/tui/editor.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { TAB_COLUMNS } from '../../src/tui/screen/constants.ts';
import { InputBox, PanelInputBox, inputOffsetAt, layoutInput } from '../../src/tui/screen/input-box.tsx';
import { ElicitationFields } from '../../src/tui/screen/prompt-panel.tsx';
import { displayWidth, inertText } from '../../src/tui/screen/wrap.ts';
import { untilFrame } from '../ink-helpers.ts';
import { start } from '../tui-harness.tsx';

const ESC = '\u001b';
const BEL = '\u0007';
const OSC_52 = `${ESC}]52;c;AA==${BEL}`;
const UNKNOWN_CSI = `${ESC}[29~`;
const HOSTILE = `a${OSC_52}\tb${UNKNOWN_CSI}c`;
const SHOWN = `a\\u001b]52;c;AA==\\u0007${' '.repeat(TAB_COLUMNS)}b\\u001b[29~c`;

const FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const STYLE_SEQUENCE = /\u001b\[[0-9;]*m/g;

const drawnOf = (frame: string | undefined): string => (frame ?? '').replaceAll(STYLE_SEQUENCE, '');

const editorWith = (text: string, cursor = text.length): EditorState => ({ ...emptyEditor(), text, cursor });

describe('the one escaping function', () => {
  it('shows control characters as visible text and a tab as the columns of the design', () => {
    expect(inertText(HOSTILE)).toBe(SHOWN);
    expect(inertText('a\r\nb\u009b1m')).toBe('a\nb\\u009b1m');
  });
});

describe('the draft in the input box', () => {
  it('is drawn with no control character and its tabs as columns', () => {
    const { lastFrame, unmount } = render(<InputBox editor={editorWith(HOSTILE)} columns={120} rows={undefined} top={0} framed={false} mark=">" />);
    const drawn = drawnOf(lastFrame());
    expect(drawn).toContain(`> ${SHOWN}`);
    expect(drawn.replaceAll('\n', '')).not.toMatch(FORBIDDEN);
    unmount();
  });

  it('counts a tab and an escaped character by the columns they are drawn in', () => {
    const layout = layoutInput('\t\tab', 2, 15);
    expect(layout.rows.map((row) => row.drawn)).toEqual([' '.repeat(2 * TAB_COLUMNS), 'ab']);
    expect(layout.rows.map((row) => [row.start, row.end])).toEqual([[0, 2], [2, 4]]);
    expect(layoutInput('\tx', 1, 80).caretCol).toBe(TAB_COLUMNS);
    expect(layoutInput(`${ESC}x`, 1, 80).caretCol).toBe('\\u001b'.length);
  });

  it('never draws a row wider than the box, whatever the draft holds', () => {
    const alphabet = ['a', ' ', '\t', ESC, BEL, '[', ']', '\u009b', 'あ', '😀', '\n', '\r', '‮', '\u0000'];
    let state = 7;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return Math.floor(state / 65536);
    };
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: 1 + (next() % 40) }, () => alphabet[next() % alphabet.length] ?? '').join('');
      const columns = 14 + (next() % 30);
      const layout = layoutInput(text, text.length, columns);
      expect(layout.rows.map((row) => row.text).join(''), `round ${round}`).toBe(text.replaceAll('\n', ''));
      for (const row of layout.rows) {
        expect(row.drawn, `round ${round}`).not.toMatch(FORBIDDEN);
        expect(row.drawn).toBe(inertText(row.text));
        expect(displayWidth(row.drawn), `round ${round}`).toBeLessThanOrEqual(columns - 7);
      }
    }
  });

  it('finds the character under a column that follows a tab', () => {
    const editor = editorWith('\tab');
    expect(inputOffsetAt(editor, 80, 1, 1, 1 + 2 + 2 + TAB_COLUMNS)).toBe(1);
    expect(inputOffsetAt(editor, 80, 1, 1, 1 + 2 + 2 + TAB_COLUMNS + 1)).toBe(2);
  });
});

describe('the value in a prompt panel', () => {
  it('is drawn with no control character, with the caret on its character', () => {
    const { lastFrame, unmount } = render(<PanelInputBox editor={editorWith(`${HOSTILE}\nsecond`, 1)} />);
    const drawn = drawnOf(lastFrame());
    expect(drawn).toContain(`> ${SHOWN}`);
    expect(drawn).toContain('  second');
    expect(drawn.replaceAll('\n', '')).not.toMatch(FORBIDDEN);
    unmount();
  });

  it('keeps a NUL and a SOH of the value as visible text beside the caret', () => {
    const { lastFrame, unmount } = render(<PanelInputBox editor={editorWith('a\u0000b\u0001c', 1)} />);
    expect(drawnOf(lastFrame())).toContain('> a\\u0000b\\u0001c');
    unmount();
  });
});

describe('the field panel of an MCP server', () => {
  it('expands the tabs of the texts the server sent and shows their control characters as text', () => {
    const flow = startFlow([{ key: 'k', mode: 'form', message: `fill\t${OSC_52}in`, requestedSchema: { type: 'object', properties: { name: { type: 'string', title: `Na\tme`, description: `the\t${UNKNOWN_CSI}name` } }, required: ['name'] } }], 'fx');
    const { lastFrame, unmount } = render(<ElicitationFields elicitation={{ inputId: 'i1', callId: 'c1', server: 'fx', flow, submitted: false }} title={'ti\ttle'} editor={editorWith('')} waiting={0} settling={false} keys={DEFAULT_KEY_TABLE} />);
    const drawn = drawnOf(lastFrame());
    expect(drawn).toContain(`fill${' '.repeat(TAB_COLUMNS)}\\u001b]52;c;AA==\\u0007in`);
    expect(drawn).toContain(`Na${' '.repeat(TAB_COLUMNS)}me`);
    expect(drawn).toContain(`the${' '.repeat(TAB_COLUMNS)}\\u001b[29~name`);
    expect(drawn).toContain(`ti${' '.repeat(TAB_COLUMNS)}tle`);
    expect(drawn.replaceAll('\n', '')).not.toMatch(FORBIDDEN);
    unmount();
  });
});

describe('the command menu', () => {
  it('names a draft that matches no command with no control character', async () => {
    const { app } = await start({}, {}, { columns: 100, rows: 20 });
    await untilFrame(app, 'mode: manual');
    app.stdin.write(`${ESC}[200~/zz${OSC_52}${ESC}[201~`);
    const frame = await untilFrame(app, 'No commands match');
    expect(frame).toContain('No commands match "/zz\\u001b]52;c;AA==\\u0007"');
    expect(frame).not.toContain(`${ESC}]52`);
    expect(frame).not.toContain(BEL);
    app.unmount();
  });
});
