import { describe, expect, it, vi } from 'vitest';
import { defaultTuiSettings } from '@momonga/config';
import type { ResolvedTuiSettings } from '@momonga/config';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { runView } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';

const READY = 'mode: manual (shift+tab)';
const WIDE = { columns: 120, rows: 40 };
const FILES = ['src/app.tsx', 'src/lib/util.ts', 'README.md', '.env'];
const SWITCH_ON = 'Attach file contents: on (enter to turn off)';
const SWITCH_OFF = 'Attach file contents: off (enter to turn on)';
const COMPLETION_HINT = 'tab: complete · esc: close the list';
const PNG = { mediaType: 'image/png' as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64') };

const LEFT_PRESS = { type: 'mouse', kind: 'press', button: 'left', col: 6, ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false } as const;
const pressAt = (row: number): TerminalEvent => ({ ...LEFT_PRESS, row });
const screenRowOf = (shown: string, text: string): number => shown.split('\n').findIndex((line) => line.includes(text)) + 1;

const inputLines = (shown: string): string[] =>
  shown
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.replace(/^│ /, '').replace(/\s*│$/, ''));

const storedSettings = (initial: Partial<ResolvedTuiSettings> = {}) => {
  const saved: { name: string; value: unknown }[] = [];
  const port: TuiSettingsPort = {
    initial: { ...defaultTuiSettings(), ...initial },
    save: async (name, value) => {
      saved.push({ name, value });
    },
  };
  return { port, saved };
};

const ready = async (options: FakeBackendOptions = {}, initial: Partial<ResolvedTuiSettings> = {}) => {
  const settings = storedSettings(initial);
  const started = await start({ files: FILES, ...options }, { tuiSettings: settings.port }, WIDE);
  await untilFrame(started.app, (frame) => frame.includes(READY) && /context: \d+%/.test(frame));
  return { ...started, saved: settings.saved };
};

describe('@ completion (design 5.7)', () => {
  it('lists the matching files above the input, with the switch as the last row', async () => {
    const { app } = await ready();
    await type(app, 'see @ap', '> see @ap');
    const shown = await untilFrame(app, '@src/app.tsx');
    expect(shown).toContain(SWITCH_ON);
    expect(shown).not.toContain('@README.md');
    expect(shown.indexOf('@src/app.tsx')).toBeLessThan(shown.indexOf(SWITCH_ON));
    expect(shown.indexOf(SWITCH_ON)).toBeLessThan(shown.indexOf('╭'));
    app.unmount();
  });

  it('lists a hidden file only when the text after @ starts with a dot', async () => {
    const { app } = await ready();
    await type(app, '@', '> @');
    const all = await untilFrame(app, '@README.md');
    expect(all).not.toContain('@.env');
    await type(app, '.', '> @.');
    await untilFrame(app, '@.env');
    app.unmount();
  });

  it('replaces the token with the path at Tab and closes the list', async () => {
    const { app, backend } = await ready();
    await type(app, 'see @ap', '> see @ap');
    await untilFrame(app, '@src/app.tsx');
    app.stdin.write(KEYS.tab);
    const shown = await untilFrame(app, (now) => inputLines(now)[0] === '> see @src/app.tsx' && !now.includes(SWITCH_ON));
    expect(shown).not.toContain(SWITCH_ON);
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('a press on a row of the list completes that path into the input and sends nothing', async () => {
    const { app, backend, terminal } = await ready();
    await type(app, 'see @', '> see @');
    const shown = await untilFrame(app, '@src/lib/util.ts');
    expect(terminal.emit(pressAt(screenRowOf(shown, '@src/lib/util.ts')))).toBe(true);
    await untilFrame(app, (now) => inputLines(now)[0] === '> see @src/lib/util.ts');
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('replaces the token at Enter instead of sending, and sends at the next Enter with the files to attach', async () => {
    const { app, backend } = await ready();
    await type(app, 'see @ap', '> see @ap');
    await untilFrame(app, '@src/app.tsx');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (now) => inputLines(now)[0] === '> see @src/app.tsx' && !now.includes(SWITCH_ON));
    expect(backend.started).toEqual([]);
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started).toEqual([{ text: 'see @src/app.tsx ', options: { attachMentions: true } }]);
    app.unmount();
  });

  it('keeps the list open after a directory and goes on inside it', async () => {
    const { app } = await ready();
    await type(app, '@sr', '> @sr');
    await untilFrame(app, '@src/');
    app.stdin.write(KEYS.tab);
    const inside = await untilFrame(app, (now) => inputLines(now)[0] === '> @src/' && now.includes('@src/app.tsx'));
    expect(inside).toContain('@src/lib/');
    expect(inside).toContain(SWITCH_ON);
    app.unmount();
  });

  it('moves with the arrows and closes at Esc, after which Enter sends', async () => {
    const { app, backend } = await ready();
    await type(app, '@src/', '> @src/');
    await untilFrame(app, '@src/app.tsx');
    app.stdin.write(KEYS.down);
    app.stdin.write(KEYS.tab);
    await untilFrame(app, (now) => inputLines(now)[0]?.startsWith('> @src/lib/') === true);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (now) => !now.includes(SWITCH_ON));
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started[0]?.text).toBe('@src/lib/');
    app.unmount();
  });

  it('does not open for a token that matches no file, so Enter sends', async () => {
    const { app, backend } = await ready();
    await type(app, 'ask @nobody', '> ask @nobody');
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(app.lastFrame()).not.toContain(SWITCH_ON);
    expect(backend.started[0]?.text).toBe('ask @nobody');
    app.unmount();
  });

  it('completes at Tab while a run works and does not queue or steer, and names the keys of the list', async () => {
    const { app, backend } = await ready();
    await runStarted(backend, app, 'one');
    await type(app, 'and @READ', '> and @READ');
    const open = await untilFrame(app, (now) => now.includes('@README.md') && now.includes(COMPLETION_HINT));
    expect(open).toContain(SWITCH_ON);
    app.stdin.write(KEYS.tab);
    await untilFrame(app, (now) => inputLines(now)[0] === '> and @README.md');
    expect(backend.calls.filter((call) => call.startsWith('inbox:'))).toEqual([]);
    app.unmount();
  });
});

describe('@ attach (design 5.8)', () => {
  it('sends the text unchanged and asks for the files, then shows one dim row per attached file and the notice of a refused one', async () => {
    const { app, backend } = await ready();
    await type(app, 'explain @src/app.tsx and @.env now', '> explain @src/app.tsx and @.env now');
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started).toEqual([{ text: 'explain @src/app.tsx and @.env now', options: { attachMentions: true } }]);
    backend.emit(
      frame({
        type: 'user.message',
        text: 'explain @src/app.tsx and @.env now',
        attachments: [
          { type: 'attached_file', path: 'src/app.tsx', lines: 412 },
          { type: 'attachment_note', path: '.env', shown: '.env: not attached (denied by a rule)' },
        ],
      }),
    );
    const shown = await untilFrame(app, 'attached src/app.tsx (412 lines)');
    expect(shown).toContain('.env: not attached (denied by a rule)');
    expect(shown.match(/> explain @src\/app\.tsx and @\.env now/g)).toHaveLength(1);
    backend.finish(runView());
    app.unmount();
  });

  it('does not ask for files when the text names none', async () => {
    const { app, backend } = await ready();
    await runStarted(backend, app, 'mail me@example.com');
    expect(backend.started).toEqual([{ text: 'mail me@example.com' }]);
    app.unmount();
  });

  it('turns attaching off from the last row of the list, stores the choice, and then sends the text alone', async () => {
    const { app, backend, saved } = await ready();
    await type(app, '@READ', '> @READ');
    await untilFrame(app, SWITCH_ON);
    app.stdin.write(KEYS.down);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, SWITCH_OFF);
    expect(saved).toEqual([{ name: 'attachFileMentions', value: false }]);
    expect(backend.started).toEqual([]);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (now) => !now.includes(SWITCH_OFF));
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started).toEqual([{ text: '@READ' }]);
    app.unmount();
  });

  it('starts with attaching off when the setting says so', async () => {
    const { app, backend } = await ready({}, { attachFileMentions: false });
    await type(app, '@READ', '> @READ');
    await untilFrame(app, SWITCH_OFF);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (now) => !now.includes(SWITCH_OFF));
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started).toEqual([{ text: '@READ' }]);
    app.unmount();
  });
});

describe('image paste (design 5.7)', () => {
  it('puts an image of the clipboard into the draft as one span and sends it with the message', async () => {
    const { app, backend } = await ready({ imageInput: true, clipboard: { kind: 'image', image: PNG } });
    await type(app, 'look ', '> look');
    app.stdin.write(KEYS.ctrlV);
    const shown = await untilFrame(app, (now) => inputLines(now)[0] === '> look [Image #1]');
    expect(shown).toContain('attached [Image #1] (image/png, 11 bytes)');
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toHaveLength(1));
    expect(backend.started).toEqual([{ text: 'look [Image #1]', options: { images: [PNG] } }]);
    app.unmount();
  });

  it('writes the note of the attached image after the message it belongs to', async () => {
    const { app, backend } = await ready({ imageInput: true, clipboard: { kind: 'image', image: PNG } });
    await type(app, 'look ', '> look');
    app.stdin.write(KEYS.ctrlV);
    await untilFrame(app, (now) => inputLines(now)[0] === '> look [Image #1]');
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, (now) => inputLines(now)[0] === '>' && now.includes('> look [Image #1]') && now.includes('attached [Image #1]'));
    expect(shown.indexOf('> look [Image #1]')).toBeLessThan(shown.indexOf('attached [Image #1]'));
    backend.finish(runView());
    app.unmount();
  });

  it('gives a waiting message taken back its image again, so the next send carries it', async () => {
    const { app, backend } = await ready({ imageInput: true, clipboard: { kind: 'image', image: PNG } });
    await runStarted(backend, app, 'one');
    await type(app, 'and ', '> and');
    app.stdin.write(KEYS.ctrlV);
    await untilFrame(app, (now) => inputLines(now)[0] === '> and [Image #1]');
    app.stdin.write(KEYS.tab);
    await untilFrame(app, 'queued  and [Image #1]');
    app.stdin.write(KEYS.up);
    const back = await untilFrame(app, (now) => inputLines(now)[0] === '> and [Image #1]' && !now.includes('queued  and'));
    expect(back).toContain('attached [Image #1] (image/png, 11 bytes)');
    app.stdin.write(KEYS.tab);
    await untilFrame(app, 'queued  and [Image #1]');
    expect(backend.inboxRows.at(-1)?.images).toEqual([{ mediaType: 'image/png', byteLength: PNG.data.length }]);
    app.unmount();
  });

  it('removes the span whole at Backspace, and the image with it', async () => {
    const { app, backend } = await ready({ imageInput: true, clipboard: { kind: 'image', image: PNG } });
    app.stdin.write(KEYS.ctrlV);
    await untilFrame(app, 'attached [Image #1]');
    app.stdin.write(KEYS.backspace);
    await untilFrame(app, (now) => inputLines(now)[0] === '>' && !now.includes('attached [Image #1]'));
    await runStarted(backend, app, 'no image');
    expect(backend.started).toEqual([{ text: 'no image' }]);
    app.unmount();
  });

  it('says so when the model does not accept images, and creates no span', async () => {
    const { app } = await ready({ clipboard: { kind: 'image', image: PNG } });
    app.stdin.write(KEYS.ctrlV);
    const shown = await untilFrame(app, 'This model does not accept images');
    expect(inputLines(shown)[0]).toBe('>');
    expect(shown).not.toContain('[Image #1]');
    app.unmount();
  });

  it('pastes text when the clipboard holds no image', async () => {
    const { app } = await ready({ imageInput: true, clipboard: { kind: 'text', text: 'copied words' } });
    app.stdin.write(KEYS.ctrlV);
    await untilFrame(app, (now) => inputLines(now)[0] === '> copied words');
    app.unmount();
  });
});
