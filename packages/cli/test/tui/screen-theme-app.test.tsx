import { systemTiming } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { ColourHost } from '../../src/tui/screen/theme.ts';
import type { TerminalState } from '../../src/tui/terminal/layer.ts';
import { fakeBackend } from '../fake-backend.ts';
import { renderObservable, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

const SGR = /\u001b\[([0-9;]*)m/g;

const isColourParameter = (parameter: number): boolean => (parameter >= 30 && parameter <= 49) || (parameter >= 90 && parameter <= 107);

const colourSequencesOf = (written: string): string[] =>
  [...written.matchAll(SGR)].map((match) => match[1] ?? '').filter((parameters) => parameters.split(';').some((parameter) => isColourParameter(Number(parameter))));

const DARK = 'rgb:1e1e/1e1e/1e1e';
const LIGHT = 'rgb:ffff/ffff/ffff';

const NOTICE = 'Project skills were skipped because the folder is not trusted';

const startOn = async (backgroundColor: string | undefined, colour: ColourHost | undefined) => {
  const backend = fakeBackend({ startupNotices: [NOTICE] });
  const terminal = fakeScreenTerminal({ columns: 100, rows: 30 });
  let seen: TerminalState | undefined;
  let shown: TerminalState | undefined;
  let reported = backgroundColor;
  const state = (): TerminalState => {
    const inner = terminal.state();
    if (inner !== seen || shown?.backgroundColor !== reported) {
      seen = inner;
      shown = { ...inner, backgroundColor: reported };
    }
    return shown as TerminalState;
  };
  const app = renderObservable(
    <App backend={backend} terminal={{ ...terminal, state }} initialMode={undefined} now={Date.now} timers={systemTiming} startup={{ version: '1.2.3', home: '/home/none', color: true }} {...(colour === undefined ? {} : { colour })} onExit={() => undefined} />,
  );
  await untilFrame(app, 'mode: manual');
  await untilFrame(app, NOTICE);
  app.stdin.write('hello there');
  await untilFrame(app, '> hello there');
  app.stdin.write('\r');
  await backend.called('openSession');
  await untilOutput(app, /> hello there[\s\S]*> hello there/);
  return {
    app,
    report: (next: string): void => {
      reported = next;
      terminal.resize(100, 31);
    },
  };
};

const everythingWritten = (app: Instance): string => app.frames.join('\n');

const userRowOf = (app: Instance): string => (app.lastFrame() ?? '').split('\n').find((line) => line.includes('> hello there') && !line.includes('│')) ?? '';

describe('colour on the screen', () => {
  it('writes no colour sequence anywhere when NO_COLOR is asked, and keeps the attributes', async () => {
    const { app } = await startOn(DARK, { noColor: true, level: 3 });
    const written = everythingWritten(app);
    expect(colourSequencesOf(written)).toEqual([]);
    expect(written).toContain('\u001b[1m');
    expect(written).toContain('\u001b[7m');
    app.unmount();
  });

  it('writes colour sequences for the same screen when NO_COLOR is not asked', async () => {
    const { app } = await startOn(DARK, { noColor: false, level: 3 });
    expect(colourSequencesOf(everythingWritten(app)).length).toBeGreaterThan(0);
    app.unmount();
  });

  it('paints a token with its dark value on a background reported dark', async () => {
    const { app } = await startOn(DARK, { noColor: false, level: 3 });
    expect(userRowOf(app)).toContain('\u001b[38;2;86;182;194m');
    app.unmount();
  });

  it('paints a token with its light value on a background reported light', async () => {
    const { app } = await startOn(LIGHT, { noColor: false, level: 3 });
    expect(userRowOf(app)).toContain('\u001b[38;2;11;107;120m');
    app.unmount();
  });

  it('uses the 256-colour value when the host reports that level', async () => {
    const { app } = await startOn(DARK, { noColor: false, level: 2 });
    expect(userRowOf(app)).toContain('\u001b[38;5;73m');
    app.unmount();
  });

  it('uses the terminal palette while the terminal has not reported its background, also when no colour host is given', async () => {
    for (const colour of [{ noColor: false, level: 3 } as const, undefined]) {
      const { app } = await startOn(undefined, colour);
      expect(userRowOf(app)).toContain('\u001b[36m');
      expect(everythingWritten(app)).not.toMatch(/\u001b\[38;/);
      app.unmount();
    }
  });

  it('repaints with the other values when the terminal reports another background', async () => {
    const { app, report } = await startOn(DARK, { noColor: false, level: 3 });
    report(LIGHT);
    await untilFrame(app, (frame) => frame.includes('\u001b[38;2;11;107;120m'));
    expect(userRowOf(app)).not.toContain('\u001b[38;2;86;182;194m');
    app.unmount();
  });
});
