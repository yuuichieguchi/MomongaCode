import { describe, expect, it, vi } from 'vitest';
import { ART_GAP, ART_WIDTH, artFits, shortenHome, textLines } from '../src/tui/startup.tsx';
import type { StartupConfig } from '../src/tui/startup.tsx';
import { untilFrame } from './ink-helpers.ts';
import { start } from './tui-harness.tsx';

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

const COLORED = /\u001b\[(?:3[0-7]|9[0-7]|38;)/;

const config = (overrides: Partial<StartupConfig> = {}): StartupConfig => ({ version: '1.2.3', home: '/Users/ada', color: true, ...overrides });

const bannerRows = (output: string): string[] => output.split('\n').filter((row) => /[∩•░┬]/.test(row));

const widthOf = (app: Awaited<ReturnType<typeof start>>['app'], columns: number): void => {
  Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
};

describe('startup screen', () => {
  it('shows the squirrel, the version, the model with its target, the mode and the shortened folder side by side', async () => {
    const { app } = await start({ session: { cwd: '/Users/ada/projects/demo', modelAlias: 'smart' }, targets: ['local-fm', 'cloud'] }, { startup: config() });
    const screen = await untilFrame(app, 'smart → local-fm, cloud');
    expect(screen).toContain('MomongaCode v1.2.3');
    expect(screen).toContain('mode: manual');
    expect(screen).toContain('~/projects/demo');
    expect(screen).toContain('•ᴥ•');
    expect(screen).not.toContain('! ');
    app.unmount();
  });

  it('keeps the model line to the alias until the gateway answers, and does not block the prompt', async () => {
    const pending = Promise.withResolvers<void>();
    const { app } = await start({ modelPending: pending.promise }, { startup: config() });
    const before = await untilFrame(app, 'model: default');
    expect(before).not.toContain('→');
    expect(before).toContain('mode: manual (shift+tab)');
    pending.resolve();
    await untilFrame(app, 'model: default → primary');
    app.unmount();
  });

  it('drops the art, rather than wrapping it, below the width its own size and the text need', async () => {
    const lines = textLines(config(), { alias: 'default', targets: ['primary'] }, 'default', '/Users/ada/p');
    const needed = ART_WIDTH + ART_GAP + Math.max(...lines.map((line) => line.length)) + 4;
    expect(artFits(needed, lines)).toBe(true);
    expect(artFits(needed - 1, lines)).toBe(false);

    const { app } = await start({ session: { cwd: '/Users/ada/p' } }, { startup: config() });
    widthOf(app, needed - 1);
    const screen = await untilFrame(app, 'MomongaCode v1.2.3');
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

  it('paints in colour unless NO_COLOR asks for none', async () => {
    const coloured = await start({}, { startup: config() });
    await untilFrame(coloured.app, 'MomongaCode v1.2.3');
    expect(bannerRows(coloured.app.frames.join('\n')).join('\n')).toMatch(COLORED);
    coloured.app.unmount();

    const plain = await start({}, { startup: config({ color: false }) });
    await untilFrame(plain.app, 'MomongaCode v1.2.3');
    expect(bannerRows(plain.app.frames.join('\n')).join('\n')).not.toMatch(COLORED);
    plain.app.unmount();
  });
});

describe('shortenHome', () => {
  it('abbreviates the home folder and what is below it and leaves other folders alone', () => {
    expect(shortenHome('/Users/ada', '/Users/ada')).toBe('~');
    expect(shortenHome('/Users/ada/src/x', '/Users/ada')).toBe('~/src/x');
    expect(shortenHome('/Users/adam/src', '/Users/ada')).toBe('/Users/adam/src');
    expect(shortenHome('/srv/app', '/Users/ada')).toBe('/srv/app');
  });
});
