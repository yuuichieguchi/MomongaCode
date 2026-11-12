import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEditor } from '../../src/tui/editor.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { OverlayView } from '../../src/tui/picker.tsx';
import { appearanceOf, applyAppearance, colourOffWhenAsked } from '../../src/tui/screen/theme.ts';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

const COLOUR_SEQUENCE = /\u001b\[(?:[0-9;]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[0-9;]*)?m/;

afterEach(() => applyAppearance(appearanceOf({ noColor: false, level: 3 }, undefined)));

const promptWithError = () => (
  <OverlayView overlay={{ kind: 'text', request: { title: 'Address:', validate: () => undefined }, error: 'That is not an address.', resolve: () => undefined }} editor={emptyEditor()} keys={DEFAULT_KEY_TABLE} columns={60} rows={10} />
);

describe('NO_COLOR', () => {
  it('leaves no colour in a prompt that shows an error', () => {
    applyAppearance(appearanceOf({ noColor: true, level: 3 }, undefined));
    const { lastFrame, unmount } = render(promptWithError());
    expect(lastFrame()).toContain('That is not an address.');
    expect(lastFrame()).not.toMatch(COLOUR_SEQUENCE);
    unmount();
  });

  it('draws the error of a prompt in the error token when colour is on', () => {
    const { lastFrame, unmount } = render(promptWithError());
    expect(lastFrame()).toMatch(COLOUR_SEQUENCE);
    unmount();
  });

  it('turns the colour of the terminal output off before the interface is loaded, and only when it is asked', () => {
    const turned: string[] = [];
    const terminal = { colourOff: () => void turned.push('off') };
    colourOffWhenAsked({ NO_COLOR: '' }, terminal);
    expect(turned).toEqual([]);
    colourOffWhenAsked({ NO_COLOR: '1' }, terminal);
    expect(turned).toEqual(['off']);
  });
});
