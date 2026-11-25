import { describe, expect, it } from 'vitest';
import { ART_GAP, artFits, bannerRows, textLines } from '../src/tui/startup.tsx';
import { ART_WIDTH } from '../src/tui/figure.ts';
import type { StartupConfig } from '../src/tui/startup.tsx';
import type { Row } from '../src/tui/screen/wrap.ts';
import { SCROLLBAR_COLUMNS } from '../src/tui/screen/transcript-view.tsx';
import { untilFrame } from './ink-helpers.ts';
import { start } from './tui-harness.tsx';

const COLORED = /\u001b\[(?:3[0-7]|9[0-7]|38;)/;

const config = (overrides: Partial<StartupConfig> = {}): StartupConfig => ({ version: '1.2.3', home: '/Users/ada', ...overrides });

const figureRowsOf = (output: string): string[] => output.split('\n').filter((row) => /[∩•░┬]/.test(row));

const FIGURE = [
  '     ∩   ∩',
  '╭────(•ᴥ•)────╮',
  '╰╮░░░░░░░░░░░╭╯',
  ' ╰─╮░░░░░░░╭─╯',
  '   ╰─╮░░░╭─╯',
  '     ╰─┬─╯',
  '       ╰─╮',
];

const FIGURE_TOKENS = [
  '     f   f',
  'mmmmmfaaafmmmmm',
  'mmmmmmmmmmmmmmm',
  ' mmmmmmmmmmmmm',
  '   mmmmmmmmm',
  '     mmfmm',
  '       fff',
];

const TOKEN_LETTERS: Readonly<Record<string, string>> = { 'banner.fur': 'f', 'banner.face': 'a', 'banner.membrane': 'm' };

const FIGURE_LEFT = 2;

const CENTRE_COLUMN = 7;

const TAIL_ROW = FIGURE.length - 1;

const drawnBanner = (): Row[] => bannerRows({ config: config(), model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: [], figure: true }, 80);

const figureOf = (rows: readonly Row[]): string[] => rows.slice(1, -1).map((row) => row.text.slice(FIGURE_LEFT, FIGURE_LEFT + ART_WIDTH).trimEnd());

const tokenLetterAt = (row: Row, column: number): string => {
  const span = row.spans.find(([from, to]) => column >= from && column < to);
  if (span === undefined) return ' ';
  const letter = TOKEN_LETTERS[span[2]];
  if (letter === undefined) throw new Error(`the figure uses an unexpected token: ${span[2]}`);
  return letter;
};

const figureTokensOf = (rows: readonly Row[]): string[] =>
  rows.slice(1, -1).map((row, index) =>
    [...(figureOf(rows)[index] ?? '')].map((character, column) => (character === ' ' ? ' ' : tokenLetterAt(row, FIGURE_LEFT + column))).join(''),
  );

const extentOf = (row: string): { first: number; last: number; width: number } => {
  const first = row.search(/\S/);
  const last = row.trimEnd().length - 1;
  return { first, last, width: last - first + 1 };
};

const gapsInside = (row: string): number => row.trim().split(/ +/).length - 1;

export const startupCases = (forceColor: 'set' | 'cleared'): void => {
  describe(`startup screen with FORCE_COLOR ${forceColor}`, () => {
  it('shows the squirrel, the version, the model by its name, its effort and the shortened folder side by side, and no mode line', async () => {
    const { app } = await start({ session: { cwd: '/Users/ada/projects/demo', model: 'lmstudio/smart' }, models: ['lmstudio/smart', 'openai/cloud'], chain: ['lmstudio/smart', 'openai/cloud'] }, { startup: config() }, { columns: 80, rows: 16 });
    const screen = await untilFrame(app, 'mode: manual (shift+tab)');
    const text = screen
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((row) => row.startsWith('│'))
      .map((row) => row.slice(ART_WIDTH + ART_GAP + 2).replace(/ *│.*$/, ''));
    expect(text.slice(0, 4)).toEqual(['MomongaCode v1.2.3', 'model: lmstudio/smart', 'effort: not available for this model', '~/projects/demo']);
    expect(screen).not.toContain('→');
    expect(screen.split('mode: ')).toHaveLength(2);
    expect(screen).toContain('•ᴥ•');
    expect(screen).not.toContain('! ');
    app.unmount();
  });

  it('shows the model line before the gateway answers, does not block the prompt and does not rewrite the line afterwards', async () => {
    const pending = Promise.withResolvers<void>();
    const { app } = await start({ modelPending: pending.promise }, { startup: config() });
    const before = await untilFrame(app, 'model: scripted-model');
    expect(before).toContain('mode: manual (shift+tab)');
    pending.resolve();
    const after = await untilFrame(app, 'context: 0%');
    expect(after).toContain('model: scripted-model');
    expect(after).not.toContain('→');
    app.unmount();
  });

  it('draws the gliding momonga in exactly seven rows inside a box of nine rows', () => {
    const rows = drawnBanner();
    expect(figureOf(rows)).toEqual(FIGURE);
    expect(rows).toHaveLength(FIGURE.length + 2);
    expect(ART_WIDTH).toBe(15);
  });

  it('paints the ears, the parentheses of the head, the tail joint and the tail as fur, the face as face and the outline and the membrane as membrane', () => {
    expect(figureTokensOf(drawnBanner())).toEqual(FIGURE_TOKENS);
  });

  it('keeps the shape of a glide: the body tapers around one centre column down to the tail and no row has more than one gap', () => {
    const figure = figureOf(drawnBanner());
    const extents = figure.map(extentOf);
    for (let index = 2; index < figure.length; index += 1) {
      expect(extents[index]?.width).toBeLessThanOrEqual(extents[index - 1]?.width ?? 0);
    }
    for (let index = 1; index < TAIL_ROW; index += 1) {
      expect((extents[index]?.first ?? 0) + (extents[index]?.last ?? 0)).toBe(2 * CENTRE_COLUMN);
    }
    expect(figure[TAIL_ROW - 1]?.[CENTRE_COLUMN]).toBe('┬');
    expect(extents[TAIL_ROW]?.first).toBe(CENTRE_COLUMN);
    for (const row of figure) expect(gapsInside(row)).toBeLessThanOrEqual(1);
    for (const row of figure.slice(1)) expect(gapsInside(row)).toBe(0);
  });

  it('says that no model is connected on the model line', () => {
    expect(textLines(config(), { kind: 'not-connected', login: true }, '/Users/ada/p')).toEqual(['MomongaCode v1.2.3', 'model: not connected  (use /login)', '', '~/p']);
  });

  it('names no command on the model line before the person can type one', () => {
    expect(textLines(config(), { kind: 'not-connected', login: false }, '/Users/ada/p')).toEqual(['MomongaCode v1.2.3', 'model: not connected', '', '~/p']);
  });

  it.each([
    ['unread', { kind: 'unread' }, ['MomongaCode v1.2.3', '', '', '~/p']],
    ['not connected before the person can type', { kind: 'not-connected', login: false }, ['MomongaCode v1.2.3', 'model: not connected', '', '~/p']],
    ['not connected with the /login pointer', { kind: 'not-connected', login: true }, ['MomongaCode v1.2.3', 'model: not connected  (use /login)', '', '~/p']],
    ['connected before its capabilities are read', { kind: 'connected', name: 'scripted-model' }, ['MomongaCode v1.2.3', 'model: scripted-model', '', '~/p']],
    ['connected with its effort', { kind: 'connected', name: 'scripted-model', effort: { kind: 'sent', level: 'medium' } }, ['MomongaCode v1.2.3', 'model: scripted-model', 'effort: medium', '~/p']],
  ] as const)('holds four text lines at fixed places for a model that is %s', (_name, model, expected) => {
    expect(textLines(config(), model, '/Users/ada/p')).toEqual(expected);
  });

  it.each([
    ['with the figure', 80],
    ['without the figure', 38],
  ] as const)('draws the same number of rows with the folder on the same row for every model kind %s', (_name, columns) => {
    const models = [
      { kind: 'unread' },
      { kind: 'not-connected', login: false },
      { kind: 'not-connected', login: true },
      { kind: 'connected', name: 'scripted-model' },
      { kind: 'connected', name: 'scripted-model', effort: { kind: 'sent', level: 'medium' } },
    ] as const;
    const drawn = models.map((model) => bannerRows({ config: config(), model, cwd: '/Users/ada/p', notices: [], figure: true }, columns));
    expect(drawn.map((rows) => rows.some((row) => row.text.includes('∩')))).toEqual(models.map(() => columns === 80));
    expect(drawn.map((rows) => rows.length)).toEqual(models.map(() => drawn[0]?.length));
    const folderRows = drawn.map((rows) => rows.findIndex((row) => row.text.includes('~/p')));
    expect(folderRows).toEqual(models.map(() => 4));
    if (columns !== 80) expect(drawn.map((rows) => rows.length)).toEqual(models.map(() => 6));
  });

  it('drops the art, rather than wrapping it, below the width its own size and the text need', async () => {
    const lines = textLines(config(), { kind: 'connected', name: 'scripted-model' }, '/Users/ada/p');
    const needed = ART_WIDTH + ART_GAP + Math.max(...lines.map((line) => line.length)) + 4;
    expect(needed).toBe(42);
    expect(artFits(needed, lines)).toBe(true);
    expect(artFits(needed - 1, lines)).toBe(false);

    const { app } = await start({ session: { cwd: '/Users/ada/p' } }, { startup: config() }, { columns: needed - 1 + SCROLLBAR_COLUMNS });
    const screen = await untilFrame(app, 'model: scripted-model');
    expect(screen).not.toContain('•ᴥ•');
    app.unmount();
  });

  it('lists the notices below the text and shows nothing when there are none', async () => {
    const { app } = await start(
      { startupNotices: ['unknown setting "colour" was ignored'], skills: [], skillWarnings: ['Project skills were skipped because the folder is not trusted'] },
      { startup: config() },
    );
    const screen = await untilFrame(app, '! Project skills were skipped');
    expect(screen).toContain('! unknown setting "colour" was ignored');
    app.unmount();
  });

  it('places up to 3 notice lines in the right column directly below the folder without changing the 9-row box height', () => {
    const notice = 'momonga: momonga was updated to 0.4.2 in the background';
    const one = bannerRows({ config: config(), model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: [notice], figure: true }, 100);
    expect(one).toHaveLength(FIGURE.length + 2);
    expect(one[4]?.text).toContain('~/p');
    expect(one[5]?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain(`! ${notice}`);
    expect(one[5]?.spans.some(([from, to, token]) => token === 'warning' && one[5]!.text.slice(from, to).includes('updated to 0.4.2'))).toBe(true);

    const three = bannerRows(
      { config: config(), model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: ['first warning', 'second warning', 'third warning'], figure: true },
      100,
    );
    expect(three).toHaveLength(FIGURE.length + 2);
    expect(three[5]?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain('! first warning');
    expect(three[6]?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain('! second warning');
    expect(three[7]?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain('! third warning');
    expect(three[7]?.swing?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain('! third warning');

    const four = bannerRows(
      { config: config(), model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: ['n1', 'n2', 'n3', 'n4'], figure: true },
      100,
    );
    expect(four).toHaveLength(10);
    expect(four[8]?.text.slice(FIGURE_LEFT, FIGURE_LEFT + ART_WIDTH).trim()).toBe('');
    expect(four[8]?.text.slice(FIGURE_LEFT + ART_WIDTH + ART_GAP)).toContain('! n4');

    const narrow = bannerRows({ config: config(), model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: ['narrow notice'], figure: true }, 38);
    expect(narrow).toHaveLength(7);
    expect(narrow[4]?.text).toContain('~/p');
    expect(narrow[5]?.text).toContain('! narrow notice');
    expect(narrow[5]?.text.indexOf('! narrow notice')).toBe(2);
  });

  it('is shown once at the top: after the first message it scrolls into the output and does not come back', async () => {
    const { app, backend } = await start({}, { startup: config() });
    await untilFrame(app, 'MomongaCode v1.2.3');
    app.stdin.write('hi\r');
    await backend.called('openSession');
    await untilFrame(app, '> hi');
    const frame = app.lastFrame() ?? '';
    expect(frame.split('MomongaCode v1.2.3')).toHaveLength(2);
    expect(frame.indexOf('MomongaCode v1.2.3')).toBeLessThan(frame.indexOf('> hi'));
    app.unmount();
  });

  it(forceColor === 'set' ? 'paints in colour unless NO_COLOR asks for none' : 'paints nothing in colour when the output is no colour terminal, with or without NO_COLOR', async () => {
    const coloured = await start({}, { startup: config() });
    await untilFrame(coloured.app, 'MomongaCode v1.2.3');
    const figure = figureRowsOf(coloured.app.frames.join('\n')).join('\n');
    if (forceColor === 'set') expect(figure).toMatch(COLORED);
    else expect(figure).not.toMatch(COLORED);
    coloured.app.unmount();

    const plain = await start({}, { startup: config(), colour: { noColor: true, level: 3 } });
    await untilFrame(plain.app, 'MomongaCode v1.2.3');
    expect(figureRowsOf(plain.app.frames.join('\n')).join('\n')).not.toMatch(COLORED);
    plain.app.unmount();
  });
});
};
