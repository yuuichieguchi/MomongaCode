import fs from 'node:fs';
import path from 'node:path';
import { loadUserSettings, writeTuiSetting } from '@momonga/config';
import { momongaLayout, systemTiming } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { ColourHost } from '../../src/tui/screen/theme.ts';
import type { TerminalState } from '../../src/tui/terminal/layer.ts';
import { fakeBackend, runView } from '../fake-backend.ts';
import { freshHome } from '../fresh-home.ts';
import { KEYS, renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';
import { testKernelLock } from '@momonga/testkit';
const UNABORTED = { lock: testKernelLock(), signal: new AbortController().signal };


vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

const SGR = /\u001b\[([0-9;]*)m/g;

const isColourParameter = (parameter: number): boolean => (parameter >= 30 && parameter <= 49) || (parameter >= 90 && parameter <= 107);

const colourSequencesOf = (written: string): string[] =>
  [...written.matchAll(SGR)].map((match) => match[1] ?? '').filter((parameters) => parameters.split(';').some((parameter) => isColourParameter(Number(parameter))));

const USER_PAINT = {
  palette: '\u001b[36m',
  dark: '\u001b[38;2;86;182;194m',
  light: '\u001b[38;2;11;107;120m',
  'dark-colorblind': '\u001b[38;2;86;180;233m',
  'light-colorblind': '\u001b[38;2;0;114;178m',
} as const;

const LIGHT = 'rgb:ffff/ffff/ffff';
const TRUECOLOR: ColourHost = { noColor: false, level: 3 };

const settingsFileOf = (home: string): string => momongaLayout(home, process.platform, {}).settingsFile;

const storedIn = (home: string): unknown => JSON.parse(fs.readFileSync(settingsFileOf(home), 'utf8'));

const portOf = async (home: string): Promise<TuiSettingsPort> => ({
  initial: (await loadUserSettings({ home, signal: new AbortController().signal })).settings.tui,
  save: (name, value, signal) => writeTuiSetting(home, settingsFileOf(home), name, value, { lock: testKernelLock(), signal }),
});

const userRowOf = (app: Instance): string => (app.lastFrame() ?? '').split('\n').find((line) => line.includes('> hello there') && !line.includes('│')) ?? '';

const paints = (app: Instance, paint: string): Promise<string> => untilFrame(app, () => userRowOf(app).includes(paint));

const startIn = async (home: string, colour: ColourHost = TRUECOLOR, backgroundColor: string | undefined = undefined) => {
  const backend = fakeBackend();
  const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
  let seen: TerminalState | undefined;
  let shown: TerminalState | undefined;
  const state = (): TerminalState => {
    const inner = terminal.state();
    if (inner !== seen) {
      seen = inner;
      shown = { ...inner, backgroundColor };
    }
    return shown as TerminalState;
  };
  const app = renderObservable(<App backend={backend} terminal={{ ...terminal, state }} initialMode={undefined} now={Date.now} timers={systemTiming} colour={colour} tuiSettings={await portOf(home)} onExit={() => undefined} />);
  await untilFrame(app, 'mode: manual');
  app.stdin.write('hello there');
  await untilFrame(app, '> hello there');
  app.stdin.write(KEYS.enter);
  await backend.called('openSession');
  await untilOutput(app, /> hello there[\s\S]*> hello there/);
  backend.finish(runView());
  return { app, backend };
};

const openThemes = async (app: Instance): Promise<void> => {
  app.stdin.write('/theme');
  await untilFrame(app, '> /theme');
  app.stdin.write(KEYS.enter);
  await untilFrame(app, 'Theme');
};

describe('/theme', () => {
  it('lists the five sets with the one in force highlighted, and enter is the key that chooses', async () => {
    const { app } = await startIn(freshHome());
    await openThemes(app);
    const shown = await untilFrame(app, '5. light-colorblind');
    expect(shown).toContain('› 1. auto');
    expect(shown).toContain('  2. dark');
    expect(shown).toContain('  3. light');
    expect(shown).toContain('  4. dark-colorblind');
    expect(shown).toContain('up/down to move · enter to choose · esc: go back');
    app.unmount();
  });

  it('previews the highlighted set on the screen and esc restores the one in force without storing anything', async () => {
    const home = freshHome();
    const { app } = await startIn(home);
    await paints(app, USER_PAINT.palette);
    await openThemes(app);
    app.stdin.write(KEYS.down);
    await paints(app, USER_PAINT.dark);
    app.stdin.write(KEYS.down);
    await paints(app, USER_PAINT.light);
    app.stdin.write('5');
    await paints(app, USER_PAINT['light-colorblind']);
    app.stdin.write(KEYS.escape);
    await paints(app, USER_PAINT.palette);
    expect(app.lastFrame()).not.toContain('light-colorblind');
    expect(fs.existsSync(settingsFileOf(home))).toBe(false);
    app.unmount();
  });

  it('applies the chosen set on enter and writes tui.theme into the user settings file, keeping its other keys', async () => {
    const home = freshHome();
    fs.mkdirSync(path.dirname(settingsFileOf(home)), { recursive: true });
    fs.writeFileSync(settingsFileOf(home), JSON.stringify({ autoUpdates: false, tui: { notify: 'bell' } }));
    const { app } = await startIn(home);
    await openThemes(app);
    app.stdin.write('4');
    await paints(app, USER_PAINT['dark-colorblind']);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'theme: dark-colorblind');
    await paints(app, USER_PAINT['dark-colorblind']);
    expect(storedIn(home)).toEqual({ autoUpdates: false, tui: { notify: 'bell', theme: 'dark-colorblind' } });
    app.unmount();
  });

  it('shows the stored theme after a reload, whatever background the terminal reports', async () => {
    const home = freshHome();
    const first = await startIn(home);
    await openThemes(first.app);
    first.app.stdin.write('2');
    await paints(first.app, USER_PAINT.dark);
    first.app.stdin.write(KEYS.enter);
    await untilOutput(first.app, 'theme: dark');
    first.app.unmount();
    expect((await loadUserSettings({ home, signal: new AbortController().signal })).settings.tui.theme).toBe('dark');
    const second = await startIn(home, TRUECOLOR, LIGHT);
    await paints(second.app, USER_PAINT.dark);
    second.app.unmount();
  });

  it('takes a set by name and refuses a name that is not one of the five', async () => {
    const home = freshHome();
    const { app } = await startIn(home);
    app.stdin.write('/theme light');
    await untilFrame(app, '> /theme light');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'theme: light');
    await paints(app, USER_PAINT.light);
    expect(storedIn(home)).toEqual({ tui: { theme: 'light' } });
    app.stdin.write('/theme solarized');
    await untilFrame(app, '> /theme solarized');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'unknown theme solarized; available: auto, dark, light, dark-colorblind, light-colorblind');
    expect(storedIn(home)).toEqual({ tui: { theme: 'light' } });
    app.unmount();
  });

  it('NO_COLOR wins over a stored theme and over a preview: no colour sequence is written', async () => {
    const home = freshHome();
    await writeTuiSetting(home, settingsFileOf(home), 'theme', 'dark-colorblind', UNABORTED);
    const { app } = await startIn(home, { noColor: true, level: 3 });
    await openThemes(app);
    app.stdin.write(KEYS.down);
    await untilFrame(app, '› 5. light-colorblind');
    expect(colourSequencesOf(app.frames.join('\n'))).toEqual([]);
    app.unmount();
  });
});
