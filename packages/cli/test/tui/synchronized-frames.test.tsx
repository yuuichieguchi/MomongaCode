import { EventEmitter } from 'node:events';
import { Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes.join('')).toContain('first');
    expect(writes.join('')).not.toContain(BEGIN_SYNCHRONIZED_UPDATE);
    reported = true;
    writes.length = 0;
    instance.rerender(<Text>second</Text>);
    for (let waited = 0; !writes.join('').includes('second') && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const drawn = writes.join('');
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf(BEGIN_SYNCHRONIZED_UPDATE)).toBeLessThan(drawn.indexOf('second'));
    expect(drawn.indexOf(END_SYNCHRONIZED_UPDATE)).toBeGreaterThan(drawn.indexOf('second'));
    instance.unmount();
  });
});
