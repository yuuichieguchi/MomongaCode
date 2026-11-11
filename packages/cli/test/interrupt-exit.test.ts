import { EXIT_FAILURE, EXIT_INTERRUPTED } from '@momonga/foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitOfFailure } from '../src/program.ts';
import { runMain } from '../src/run-main.ts';

const initialExitCode = process.exitCode;
const initialInterruptListeners = process.listeners('SIGINT');

afterEach(() => {
  process.exitCode = initialExitCode;
  for (const listener of process.listeners('SIGINT')) if (!initialInterruptListeners.includes(listener)) process.off('SIGINT', listener);
  vi.restoreAllMocks();
});

const recorder = (): { written: string[]; write(text: string): void } => {
  const written: string[] = [];
  return { written, write: (text) => void written.push(text) };
};

describe('the exit of a command that an interrupt stopped', () => {
  it('is 130, with no failure text, when the command ended with the reason of the interrupt', () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const stderr = recorder();

    expect(exitOfFailure(interrupt.signal.reason, stderr, interrupt.signal)).toBe(EXIT_INTERRUPTED);
    expect(stderr.written).toEqual([]);
  });

  it('is 130 when the reason of the interrupt is the cause of the failure', () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const stderr = recorder();

    expect(exitOfFailure(new Error('the wait was aborted', { cause: interrupt.signal.reason }), stderr, interrupt.signal)).toBe(EXIT_INTERRUPTED);
  });

  it('stays the exit of the failure when the failure is not the interrupt', () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const stderr = recorder();

    expect(exitOfFailure(new Error('the disk is full'), stderr, interrupt.signal)).toBe(EXIT_FAILURE);
    expect(stderr.written).toEqual(['momonga: the disk is full\n']);
  });

  it('stays the exit of the failure when no interrupt arrived', () => {
    const interrupt = new AbortController();
    const stderr = recorder();

    expect(exitOfFailure(new Error('the disk is full'), stderr, interrupt.signal)).toBe(EXIT_FAILURE);
  });
});

describe('the interrupt handler of the entry', () => {
  it('stays in place after the first interrupt, so that a second one does not end the process while the command cleans up', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = process.listenerCount('SIGINT');
    let afterFirst = 0;

    await runMain('1.2.3', {
      get self(): never {
        process.emit('SIGINT');
        afterFirst = process.listenerCount('SIGINT');
        process.emit('SIGINT');
        throw new Error('the command failed after the interrupts');
      },
    });

    expect(afterFirst).toBe(before + 1);
    expect(process.exitCode).toBe(EXIT_FAILURE);
  });
});
