import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { emptyEditor } from '../../src/tui/editor.ts';
import { overlayPanelRows } from '../../src/tui/picker.tsx';
import type { PanelOverlay } from '../../src/tui/picker.tsx';
import { allocate, panelRowsCap } from '../../src/tui/screen/layout.ts';
import type { RowAllocation, RowRequests } from '../../src/tui/screen/layout.ts';
import { Screen } from '../../src/tui/screen/screen.tsx';
import { DetailView, SelectView, detailPanelRows, selectLayout, selectPanelRows, selectStart, selectText } from '../../src/tui/select.tsx';
import type { SelectSpec } from '../../src/tui/select.tsx';

const ROWS = 14;
const COLUMNS = 30;

const none: RowRequests = { header: 0, waiting: 0, inputRows: 1, invitation: 0, menu: 0, subagents: 0, footerSecond: 0, lines: 0, panel: undefined };

const rowsOf = (name: string, count: number): ReactNode[] => Array.from({ length: count }, (_, index) => <Text key={index}>{`${name} ${index + 1}`}</Text>);

const numbered = (name: string, count: number): ReactNode => <Box flexDirection="column">{rowsOf(name, count)}</Box>;

const transcriptOf = (rows: number): ReactNode => (
  <Box height={rows} flexDirection="column">
    {rowsOf('answer', rows)}
  </Box>
);

const screenOf = (allocation: RowAllocation, panel: ReactNode | undefined, transcriptRows = allocation.viewport) => (
  <Screen
    view="fullscreen"
    columns={COLUMNS}
    rows={ROWS}
    panelFollows={undefined}
    allocation={allocation}
    panel={panel}
    regions={{ header: null, transcript: transcriptOf(transcriptRows), menu: null, waiting: null, lines: null, input: <Text>the input</Text>, footer: <Text>the footer</Text>, subagents: null }}
  />
);

const linesOf = (frame: string | undefined): string[] => (frame ?? '').split('\n').map((line) => line.trimEnd());

describe('the height of a prompt panel (P-094)', () => {
  it('draws a panel whole in the first frame that holds it, in the place of the input, with the newest rows of the transcript above it', () => {
    const withInput = allocate(ROWS, none);
    const app = render(screenOf(withInput, undefined));
    const before = app.frames.length;
    app.rerender(screenOf(withInput, numbered('choice', 5)));
    const first = linesOf(app.frames[before]);
    expect(first).toHaveLength(ROWS);
    expect(first.slice(-6)).toEqual(['choice 1', 'choice 2', 'choice 3', 'choice 4', 'choice 5', 'the footer']);
    expect(first[ROWS - 7]).toBe(`answer ${withInput.viewport}`);
    expect(first.join('\n')).not.toContain('the input');
    app.unmount();
  });

  it('draws a panel that grew at its new height in the first frame, before the allocation knows it', () => {
    const small = allocate(ROWS, { ...none, panel: 2 });
    const app = render(screenOf(small, numbered('choice', 2)));
    const before = app.frames.length;
    app.rerender(screenOf(small, numbered('choice', 7)));
    const first = linesOf(app.frames[before]);
    expect(first).toHaveLength(ROWS);
    expect(first.slice(-8)).toEqual(['choice 1', 'choice 2', 'choice 3', 'choice 4', 'choice 5', 'choice 6', 'choice 7', 'the footer']);
    expect(first[ROWS - 9]).toBe(`answer ${small.viewport}`);
    app.unmount();
  });

  it('keeps a transcript shorter than its place at the top, above the room the panel leaves', () => {
    const withInput = allocate(ROWS, none);
    const app = render(screenOf(withInput, undefined, 2));
    const before = app.frames.length;
    app.rerender(screenOf(withInput, numbered('choice', 3), 2));
    const first = linesOf(app.frames[before]);
    expect(first).toHaveLength(ROWS);
    expect(first.slice(0, 3)).toEqual(['answer 1', 'answer 2', '']);
    expect(first.slice(-4)).toEqual(['choice 1', 'choice 2', 'choice 3', 'the footer']);
    app.unmount();
  });

  it('keeps the footer and a row of the transcript when a panel asks for more than the screen', () => {
    const full = allocate(ROWS, { ...none, panel: 40 });
    const app = render(screenOf(full, numbered('choice', 40)));
    const shown = linesOf(app.lastFrame());
    expect(shown).toHaveLength(ROWS);
    expect(shown.at(-1)).toBe('the footer');
    expect(shown.filter((line) => line.startsWith('choice'))).toHaveLength(panelRowsCap(ROWS));
    expect(shown[0]).toMatch(/^answer /);
    app.unmount();
  });

  it('computes SelectView, DetailView and OverlayView panel heights matching their rendered lines synchronously', () => {
    const spec: SelectSpec = {
      title: 'Pick one',
      lines: ['First description line'],
      rows: [
        { label: 'Alpha', description: 'Short detail' },
        { label: 'Beta' },
      ],
      initial: 0,
      decideOn: 'enter',
      escape: 'back',
      interrupt: 'exit',
      filter: true,
    };
    const frame = { width: 50, rows: 20, border: true };
    const state = selectStart(spec);
    const text = selectText(spec, frame);
    const layout = selectLayout(spec, state, text, frame, 0, false);
    const view = render(<SelectView spec={spec} state={state} layout={layout} border={true} sending={false} keys={DEFAULT_KEY_TABLE} />);
    expect(selectPanelRows(spec, state, layout, true, undefined, false)).toBe(linesOf(view.lastFrame()).length);
    view.unmount();

    const detail = render(<DetailView text={text} frame={frame} top={0} keys={DEFAULT_KEY_TABLE} />);
    expect(detailPanelRows(text, frame, 0)).toBe(linesOf(detail.lastFrame()).length);
    detail.unmount();

    const loading: PanelOverlay = { kind: 'loading', title: 'Reading', line: 'wait', hint: 'readingAndCancel', cancel: () => undefined };
    expect(overlayPanelRows(loading, emptyEditor(), DEFAULT_KEY_TABLE, { columns: 50, rows: 20 })).toBe(3);
  });
});
