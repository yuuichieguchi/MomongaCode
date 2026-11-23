import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import type { ScreenRequest } from '../../src/tui/terminal/layer.ts';
import { titleSequence } from '../../src/tui/terminal/title.ts';
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
    process: { on: () => undefined, off: () => undefined, kill: () => undefined, deliverable: () => true },
    timers: manualClock().timers,
    screen: 'fullscreen',
    screenSetByUser: true,
    mouse: false,
    onFailure: (error) => {
      throw error;
    },
    onEvents: (delivered) => events.push(...delivered),
  });
  layer.start();
  const requests: ScreenRequest[] = [];
  layer.subscribeScreen((request) => requests.push(request));
  const feed = (text: string): boolean => terminalInput.emit('data', Buffer.from(text, 'utf8'));
  feed(`${ESC}[?1;2c`);
  events.length = 0;
  return { layer, written, raw, flow, events, requests, feed };
};

describe('leaving the screen for a program that takes the terminal', () => {
  it('restores every mode, stops reading, and on return enters the same modes, reads again and asks for a redraw', async () => {
    const { layer, written, raw, flow, events, requests, feed } = startLayer();
    const before = layer.state().enabled;
    const mark = written.length;
    const returnToScreen = await layer.leaveForProgram();
    expect(layer.state().enabled).toEqual([]);
    expect(written.slice(mark).join('')).toContain(`${ESC}[?1049l`);
    expect(raw.at(-1)).toBe(false);
    expect(flow.at(-1)).toBe('pause');
    feed('typed in the program');
    expect(events).toEqual([]);
    const back = written.length;
    await returnToScreen();
    expect(layer.state().enabled).toEqual(before);
    expect(written.slice(back).join('')).toContain(`${ESC}[?1049h`);
    expect(raw.at(-1)).toBe(true);
    expect(flow.at(-1)).toBe('resume');
    expect(requests).toEqual([{ type: 'redraw' }]);
    feed('a');
    expect(events).toEqual([{ type: 'key', text: 'a', ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false }]);
    layer.close();
  });

  it('suspends Ink by its own call before the layer leaves the modes, and resumes it after the modes are entered again', async () => {
    const { layer, written } = startLayer();
    const order: string[] = [];
    const mark = written.length;
    layer.attachInk({
      suspendTerminal: async () => {
        order.push(`ink suspended after ${written.length - mark} writes`);
        return {
          resume: async () => {
            order.push(`ink resumed after ${written.length - mark} writes`);
          },
        };
      },
    });
    const returnToScreen = await layer.leaveForProgram();
    const lent = written.length - mark;
    await returnToScreen();
    expect(order).toEqual(['ink suspended after 0 writes', `ink resumed after ${written.length - mark} writes`]);
    expect(lent).toBeGreaterThan(0);
    expect(written.length - mark).toBeGreaterThan(lent);
    layer.close();
  });

  it('does not re-enter a screen that was closed while the program ran', async () => {
    const { layer, written } = startLayer();
    const returnToScreen = await layer.leaveForProgram();
    await layer.close();
    const mark = written.length;
    await returnToScreen();
    expect(written.slice(mark)).toEqual([]);
  });
  it('writes no title while the terminal is lent, and on return pushes once and writes only the latest title', async () => {
    const { layer, written } = startLayer();
    layer.setTitle('one - momonga');
    const returnToScreen = await layer.leaveForProgram();
    const lent = written.length;
    layer.setTitle('two - momonga');
    layer.setTitle('three - momonga');
    expect(written.slice(lent)).toEqual([]);
    expect(layer.state().enabled).not.toContain('title');
    await returnToScreen();
    const back = written.slice(lent).join('');
    expect(back.split(`${ESC}[22;2t`)).toHaveLength(2);
    expect(back.split(`${ESC}]2;`)).toHaveLength(2);
    expect(back).toContain(titleSequence('three - momonga'));
    expect(back.indexOf(titleSequence('three - momonga'))).toBeGreaterThan(back.indexOf(`${ESC}[22;2t`));
    layer.close();
  });

  it('writes no title after a screen closed while lent, even when taken back', async () => {
    const { layer, written } = startLayer();
    layer.setTitle('one - momonga');
    const returnToScreen = await layer.leaveForProgram();
    await layer.close();
    const mark = written.length;
    layer.setTitle('two - momonga');
    await returnToScreen();
    layer.setTitle('three - momonga');
    expect(written.slice(mark)).toEqual([]);
  });
});
