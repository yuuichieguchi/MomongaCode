import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { ScreenRequest } from '../../src/tui/terminal/layer.ts';
import { manualClock } from './screen-clock.ts';

const ESC = '\u001b';

const startLayer = () => {
  const terminalInput = new EventEmitter();
  const written: string[] = [];
  const raw: boolean[] = [];
  const flow: string[] = [];
  const events: TerminalEvent[] = [];
  const layer = createTerminalLayer({
    input: {
      setRawMode: (on) => raw.push(on),
      resume: () => flow.push('resume'),
      pause: () => flow.push('pause'),
      on: (event, listener) => terminalInput.on(event, listener),
      off: (event, listener) => terminalInput.off(event, listener),
    },
    output: { writeSync: (text) => written.push(text), size: () => ({ columns: 100, rows: 30 }), onResize: () => () => undefined },
    process: { on: () => undefined, off: () => undefined, kill: () => undefined },
    timers: manualClock().timers,
    screen: 'fullscreen',
    screenSetByUser: true,
    mouse: false,
    onEvents: (delivered) => events.push(...delivered),
  });
  layer.start();
  const requests: ScreenRequest[] = [];
  layer.subscribeScreen((request) => requests.push(request));
  const feed = (text: string): boolean => terminalInput.emit('data', Buffer.from(text, 'utf8'));
  return { layer, written, raw, flow, events, requests, feed };
};

describe('leaving the screen for a program that takes the terminal', () => {
  it('restores every mode, stops reading, and on return enters the same modes, reads again and asks for a redraw', () => {
    const { layer, written, raw, flow, events, requests, feed } = startLayer();
    const before = layer.state().enabled;
    const mark = written.length;
    const returnToScreen = layer.leaveForProgram();
    expect(layer.state().enabled).toEqual([]);
    expect(written.slice(mark).join('')).toContain(`${ESC}[?1049l`);
    expect(raw.at(-1)).toBe(false);
    expect(flow.at(-1)).toBe('pause');
    feed('typed in the program');
    expect(events).toEqual([]);
    const back = written.length;
    returnToScreen();
    expect(layer.state().enabled).toEqual(before);
    expect(written.slice(back).join('')).toContain(`${ESC}[?1049h`);
    expect(raw.at(-1)).toBe(true);
    expect(flow.at(-1)).toBe('resume');
    expect(requests).toEqual([{ type: 'redraw' }]);
    feed('a');
    expect(events).toEqual([{ type: 'key', text: 'a', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false }]);
    layer.close();
  });

  it('does not re-enter a screen that was closed while the program ran', () => {
    const { layer, written } = startLayer();
    const returnToScreen = layer.leaveForProgram();
    layer.close();
    const mark = written.length;
    returnToScreen();
    expect(written.slice(mark)).toEqual([]);
  });
});
