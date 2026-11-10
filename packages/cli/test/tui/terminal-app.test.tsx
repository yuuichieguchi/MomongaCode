import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { TuiOutcome } from '../../src/tui/app.tsx';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import { TerminalFrame } from '../../src/tui/terminal/frame.tsx';
import { createInkStdin } from '../../src/tui/terminal/ink-stdin.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import { fakeBackend } from '../fake-backend.ts';
import { systemTiming } from '@momonga/foundation';

const ESC = '\u001b';

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  written: string[] = [];
  write = (data: string, done?: () => void): boolean => {
    this.written.push(data);
    done?.();
    return true;
  };
}

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const startOnLayer = () => {
  const terminalInput = new EventEmitter();
  const stdout = new FakeStdout();
  const control: string[] = [];
  const inkStdin = createInkStdin();
  const input = createScreenInput();
  const layer = createTerminalLayer({
    input: { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, on: (event, listener) => terminalInput.on(event, listener), off: (event, listener) => terminalInput.off(event, listener) },
    output: { writeSync: (text) => control.push(text), size: () => ({ columns: stdout.columns, rows: stdout.rows }), onResize: () => () => undefined },
    process: { on: () => undefined, off: () => undefined, kill: () => undefined },
    screen: 'scrollback',
    screenSetByUser: true,
    mouse: true,
    onEvents: (events) => input.push(events),
  });
  layer.start();
  const outcomes: TuiOutcome[] = [];
  const instance = render(
    <TerminalFrame layer={layer}>
      <App backend={fakeBackend()} terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, enable: layer.enable, disable: layer.disable, input }} now={Date.now} timers={systemTiming} initialMode={undefined} onExit={(outcome) => outcomes.push(outcome)} />
    </TerminalFrame>,
    { stdin: inkStdin.stream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  );
  closers.push(() => {
    instance.unmount();
    layer.close();
  });
  const feed = (text: string): boolean => terminalInput.emit('data', Buffer.from(text, 'utf8'));
  const shows = (text: string): Promise<void> => vi.waitFor(() => expect(stdout.written.join('')).toContain(text), { timeout: 3000 });
  const redrawn = (): Promise<void> => {
    const before = stdout.written.length;
    return vi.waitFor(() => expect(stdout.written.length).toBeGreaterThan(before), { timeout: 3000 });
  };
  return { feed, shows, redrawn, instance, outcomes, control, layer };
};

describe('the existing screen on top of the terminal layer', () => {
  it('echoes typed text, takes Shift+Enter in the kitty form as a new line, and exits on Ctrl+C with the terminal restored', async () => {
    const app = startOnLayer();
    await app.shows('>');
    app.feed('hi');
    await app.shows('> hi');
    await app.shows(`${ESC}[?25h`);
    app.feed(`${ESC}[13;2u`);
    app.feed('yo');
    await app.shows('yo');
    expect(app.layer.state().newlineHint).toBe('shift+enter');
    app.feed(`${ESC}[?7u${ESC}[?1;2c`);
    const cleared = app.redrawn();
    app.feed('\u0003');
    await cleared;
    app.feed('\u0003');
    await app.shows('Press ctrl+c again to exit');
    app.feed('\u0003');
    await vi.waitFor(() => expect(app.outcomes).toEqual([{}]), { timeout: 3000 });
    await app.instance.waitUntilExit();
    app.layer.close();
    expect(app.outcomes).toEqual([{}]);
    expect(app.control.at(-1)).toBe(`${ESC}[?2004l${ESC}[<u${ESC}[23;2t`);
  });
});
