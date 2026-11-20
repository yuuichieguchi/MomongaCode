import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/tui/app.tsx';
import type { TuiOutcome } from '../../src/tui/app.tsx';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import { NEWLINE_HINT } from '../../src/tui/terminal/negotiation.ts';
import { TerminalFrame } from '../../src/tui/terminal/frame.tsx';
import { createInkStdin } from '../../src/tui/terminal/ink-stdin.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
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

const startOnLayer = (options: FakeBackendOptions = {}) => {
  const terminalInput = new EventEmitter();
  const processListeners = new Map<string, Set<() => void>>();
  const kills: string[] = [];
  const stdout = new FakeStdout();
  const control: string[] = [];
  const inkStdin = createInkStdin();
  const input = createScreenInput();
  const layer = createTerminalLayer({
    input: { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, on: (event, listener) => terminalInput.on(event, listener), off: (event, listener) => terminalInput.off(event, listener) },
    output: { writeSync: (text) => control.push(text), size: () => ({ columns: stdout.columns, rows: stdout.rows }), onResize: () => () => undefined },
    process: {
      on: (event, listener) => void processListeners.set(event, new Set([...(processListeners.get(event) ?? []), listener])),
      off: (event, listener) => void processListeners.get(event)?.delete(listener),
      kill: (signal) => void kills.push(signal),
      deliverable: () => true,
    },
    timers: systemTiming,
    screen: 'scrollback',
    screenSetByUser: true,
    mouse: true,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (events) => input.push(events),
  });
  layer.start();
  const outcomes: TuiOutcome[] = [];
  const instance = render(
    <TerminalFrame layer={layer}>
      <App backend={fakeBackend(options)} terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, enable: layer.enable, disable: layer.disable, input }} now={Date.now} timers={systemTiming} initialMode={undefined} onExit={(outcome) => outcomes.push(outcome)} />
    </TerminalFrame>,
    { stdin: inkStdin.stream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, onRender: () => input.framed() },
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
  const raise = (event: string): void => {
    for (const listener of [...(processListeners.get(event) ?? [])]) listener();
  };
  return { feed, shows, redrawn, instance, outcomes, control, layer, raise, kills, processListeners };
};

describe('the existing screen on top of the terminal layer', () => {
  it('echoes typed text, takes Shift+Enter in the kitty form as a new line, and exits on Ctrl+C with the terminal restored', async () => {
    const app = startOnLayer();
    await app.shows('mode: manual');
    app.feed('hi');
    await app.shows('> hi');
    await app.shows(`${ESC}[?25h`);
    app.feed(`${ESC}[13;2u`);
    app.feed('yo');
    await app.shows('yo');
    expect(NEWLINE_HINT[app.layer.state().negotiation]).toBe('shift+enter');
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

describe('a signal ends the screen through the one exit path, picker or waiting run alike', () => {
  it('restores the terminal and ends the process with SIGTERM while a picker is open', async () => {
    const app = startOnLayer({ trust: { path: '/work/project', decision: null } });
    await app.shows('Do you trust the files in /work/project?');
    app.raise('SIGTERM');
    expect(app.kills).toEqual([]);
    app.feed(`${ESC}[?1;2c`);
    expect(app.kills).toEqual(['SIGTERM']);
    expect(app.control.join('')).toContain(`${ESC}[?2004l`);
    expect(app.processListeners.get('SIGTERM')?.size ?? 0).toBe(0);
    app.instance.unmount();
  });

  it('restores the terminal and ends the process with SIGTERM while a run is waiting', async () => {
    const app = startOnLayer();
    await app.shows('mode: manual');
    app.feed('go');
    await app.shows('> go');
    app.feed('\r');
    await app.shows('esc to cancel');
    app.raise('SIGTERM');
    expect(app.kills).toEqual([]);
    app.feed(`${ESC}[?1;2c`);
    expect(app.kills).toEqual(['SIGTERM']);
    expect(app.control.join('')).toContain(`${ESC}[?2004l`);
    expect(app.processListeners.get('SIGTERM')?.size ?? 0).toBe(0);
    app.instance.unmount();
  });
});
