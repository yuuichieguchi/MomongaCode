import { EventEmitter } from 'node:events';
import { Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { waitFor } from '@momonga/testkit';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import { createTerminalLayer } from '../../src/tui/terminal/layer.ts';
import { BEGIN_SYNCHRONIZED_UPDATE, END_SYNCHRONIZED_UPDATE, synchronizedFramesOf } from '../../src/tui/terminal/synchronized.ts';

const fakeTty = () => {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  });
  return { stream, writes };
};

describe('synchronized output follows the terminal answer to 2026 (2.3)', () => {
  it('writes the sequences as they are when the terminal reported 2026', () => {
    const { stream, writes } = fakeTty();
    const wrapped = synchronizedFramesOf(stream as unknown as NodeJS.WriteStream, () => true);
    wrapped.write(BEGIN_SYNCHRONIZED_UPDATE);
    wrapped.write('frame');
    wrapped.write(END_SYNCHRONIZED_UPDATE);
    expect(writes).toEqual([BEGIN_SYNCHRONIZED_UPDATE, 'frame', END_SYNCHRONIZED_UPDATE]);
  });

  it('writes no synchronized-update sequence while the terminal has not reported 2026, and the frame still', () => {
    const { stream, writes } = fakeTty();
    const wrapped = synchronizedFramesOf(stream as unknown as NodeJS.WriteStream, () => false);
    wrapped.write(BEGIN_SYNCHRONIZED_UPDATE);
    wrapped.write('frame');
    wrapped.write(END_SYNCHRONIZED_UPDATE);
    expect(writes).toEqual(['frame']);
  });

  it('wraps each frame Ink draws only after the answer, and keeps the stream readable for Ink', async () => {
    const { stream, writes } = fakeTty();
    let reported = false;
    const wrapped = synchronizedFramesOf(stream as unknown as NodeJS.WriteStream, () => reported);
    expect(wrapped.isTTY).toBe(true);
    expect(wrapped.columns).toBe(80);
    const instance = render(<Text>first</Text>, { stdout: wrapped, interactive: true, patchConsole: false });
    await waitFor(() => writes.join('').includes('first'), { description: 'the first frame is drawn' });
    expect(writes.join('')).not.toContain(BEGIN_SYNCHRONIZED_UPDATE);
    reported = true;
    writes.length = 0;
    instance.rerender(<Text>second</Text>);
    await waitFor(() => writes.join('').includes('second'), { description: 'the second frame is drawn' });
    const drawn = writes.join('');
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeLessThan(drawn.indexOf('second'));
    expect(drawn.indexOf(END_SYNCHRONIZED_UPDATE)).toBeGreaterThan(drawn.indexOf('second'));
    instance.unmount();
  });

  it('wraps the very first frame in BSU/ESU when 2026 and OSC 11 answer before render()', async () => {
    const stdin = new EventEmitter();
    const { stream, writes } = fakeTty();
    const input = createScreenInput();
    const layer = createTerminalLayer({
      input: { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, on: (event, listener) => stdin.on(event, listener), off: (event, listener) => stdin.off(event, listener) },
      output: { writeSync: () => undefined, size: () => ({ columns: 80, rows: 24 }), onResize: () => () => undefined },
      process: { on: () => undefined, off: () => undefined, kill: () => undefined, deliverable: () => true },
      timers: systemTiming,
      screen: 'scrollback',
      screenSetByUser: true,
      mouse: false,
      onEvents: input.push,
      onFailure: (error) => {
        throw error;
      },
    });
    layer.start();
    const answered = layer.startAnswered();
    stdin.emit('data', Buffer.from('\u001b[?2026;1$y\u001b]11;rgb:0000/0000/0000\u001b\\', 'utf8'));
    await answered;
    expect(layer.state().backgroundColor).toBe('rgb:0000/0000/0000');
    const wrapped = synchronizedFramesOf(stream as unknown as NodeJS.WriteStream, () => layer.state().synchronizedOutput);
    const instance = render(<Text>first</Text>, { stdout: wrapped, interactive: true, patchConsole: false });
    await waitFor(() => writes.join('').includes('first'), { description: 'first synchronized frame' });
    const drawn = writes.join('');
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeLessThan(drawn.indexOf('first'));
    expect(drawn.indexOf(END_SYNCHRONIZED_UPDATE)).toBeGreaterThan(drawn.indexOf('first'));
    instance.unmount();
    await layer.close();
  });
});
