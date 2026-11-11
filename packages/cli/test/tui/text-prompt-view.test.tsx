import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { emptyEditor } from '../../src/tui/editor.ts';
import type { EditorState } from '../../src/tui/editor.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { OverlayView } from '../../src/tui/picker.tsx';
import type { PanelOverlay, TextRequest } from '../../src/tui/picker.tsx';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

const INVERSE = '\u001b[7m';
const STYLE_SEQUENCE = /\u001b\[[0-9;]*m/g;

const editorWith = (text: string, cursor = text.length): EditorState => ({ ...emptyEditor(), text, cursor });

const textOverlay = (request: Partial<TextRequest> = {}): PanelOverlay => ({ kind: 'text', request: { title: 'Value', validate: () => undefined, ...request }, resolve: () => undefined });

const drawn = (overlay: PanelOverlay, editor: EditorState, rows = 20): { styled: string; plain: string; unmount: () => void } => {
  const { lastFrame, unmount } = render(<OverlayView overlay={overlay} editor={editor} keys={DEFAULT_KEY_TABLE} columns={60} rows={rows} />);
  const styled = lastFrame() ?? '';
  return { styled, plain: styled.replaceAll(STYLE_SEQUENCE, ''), unmount };
};

describe('the text editor view of a prompt', () => {
  it('draws the caret on the character under it', () => {
    const { styled, unmount } = drawn(textOverlay(), editorWith('abc', 1));
    expect(styled).toContain(`${INVERSE}b`);
    unmount();
  });

  it('draws the caret after the end of the value as a blank cell', () => {
    const { styled, plain, unmount } = drawn(textOverlay(), editorWith('abc'));
    expect(plain).toContain('> abc');
    expect(styled).toContain(`${INVERSE} `);
    unmount();
  });

  it('shows a hidden value as one mark per character, never the value', () => {
    const { plain, unmount } = drawn(textOverlay({ hidden: true }), editorWith('sk-secret-👍'));
    expect(plain).toContain('> •••••••••••');
    expect(plain).not.toContain('••••••••••••');
    expect(plain).not.toContain('secret');
    unmount();
  });

  it('scrolls a value taller than the panel so the caret line is shown', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `"line${index + 1}": ${index},`);
    const text = lines.join('\n');
    const { plain, styled, unmount } = drawn(textOverlay({ structured: true }), editorWith(text), 12);
    expect(plain).toContain('"line40": 39,');
    expect(plain).not.toContain('"line1": 0,');
    expect(styled).toContain(INVERSE);
    expect(plain.split('\n').length).toBeLessThanOrEqual(12);
    unmount();
  });

  it('wraps a line wider than the panel', () => {
    const { plain, unmount } = drawn(textOverlay(), editorWith('x'.repeat(120)));
    expect(Math.max(...plain.split('\n').map((line) => line.length))).toBeLessThanOrEqual(60);
    expect(plain.replaceAll(/[\s>]/g, '')).toContain('x'.repeat(120));
    unmount();
  });

  it('names the keys of the structured editor in its hint row', () => {
    const { plain, unmount } = drawn(textOverlay({ structured: true }), editorWith('{}'));
    expect(plain).toContain('ctrl+x enter to confirm');
    expect(plain).toContain('enter: new line');
    expect(plain).toContain('ctrl+g edits it in $EDITOR');
    unmount();
  });
});
