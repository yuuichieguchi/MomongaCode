import { describe, expect, it } from 'vitest';
import { hostProcessOn, terminalOutputOf, TerminalWriteError } from '../../src/tui/terminal/host.ts';

const stdoutWith = (fd: unknown): NodeJS.WriteStream => ({ fd, columns: 80, rows: 24, on: () => undefined, off: () => undefined }) as unknown as NodeJS.WriteStream;

describe('the output of the host terminal', () => {
  it('is a typed refusal, not a throw, when the output has no file descriptor', () => {
    expect(terminalOutputOf(stdoutWith(undefined), () => 0)).toEqual({ kind: 'no-descriptor' });
  });

  it('writes the whole text when the descriptor takes it in parts', () => {
    const taken: string[] = [];
    const output = terminalOutputOf(stdoutWith(1), (_fd, buffer, offset) => {
      const part = Math.min(3, buffer.length - offset);
      taken.push(buffer.subarray(offset, offset + part).toString('utf8'));
      return part;
    });
    if (output.kind !== 'output') throw new Error('expected an output');
    output.port.writeSync('abcdefgh');
    expect(taken.join('')).toBe('abcdefgh');
  });

  it('reports a descriptor that takes no more output as an error that names it', () => {
    const output = terminalOutputOf(stdoutWith(1), () => {
      throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, write'), { code: 'EAGAIN' });
    });
    if (output.kind !== 'output') throw new Error('expected an output');
    expect(() => output.port.writeSync('x')).toThrow(TerminalWriteError);
  });
});

describe('the signals of the host process', () => {
  it('has no stop and continue on Windows, and every signal of the layer on macOS and Linux', () => {
    const windows = hostProcessOn('win32');
    expect(windows.deliverable('SIGSTOP')).toBe(false);
    expect(windows.deliverable('SIGCONT')).toBe(false);
    expect(windows.deliverable('SIGINT')).toBe(true);
    for (const platform of ['darwin', 'linux'] as const) for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGSTOP', 'SIGCONT'] as const) expect(hostProcessOn(platform).deliverable(signal), `${platform} ${signal}`).toBe(true);
  });
});
