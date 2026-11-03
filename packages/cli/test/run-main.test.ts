import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TerminalWriter from '../src/terminal-writer.ts';
import { runMain } from '../src/run-main.ts';
import { terminalSink } from '../src/terminal-writer.ts';

vi.mock('../src/terminal-writer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalWriter>();
  return { ...actual, terminalSink: vi.fn(actual.terminalSink) };
});

const initialExitCode = process.exitCode;
const initialInterruptListeners = process.listeners('SIGINT');

afterEach(() => {
  process.exitCode = initialExitCode;
  for (const listener of process.listeners('SIGINT')) if (!initialInterruptListeners.includes(listener)) process.off('SIGINT', listener);
  vi.restoreAllMocks();
});

describe('runMain', () => {
  it('reports a failure through the terminal sink, escaped, and exits 1', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });

    await runMain('1.2.3', {
      get self(): never {
        throw new Error('boom \u001b[31mred');
      },
    });

    expect(vi.mocked(terminalSink)).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^momonga: .*boom .*red\n$/);
    expect(written[0]).not.toContain('\u001b');
    expect(process.exitCode).toBe(1);
  });
});
