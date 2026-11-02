import { describe, expect, it } from 'vitest';
import { PromptInterrupted, withHiddenInput } from '../src/terminal/hidden-prompt.ts';
import type { PromptTerminal } from '../src/terminal/hidden-prompt.ts';

type Listener = (chunk: string) => void;

const recordingTerminal = (): { terminal: PromptTerminal; events: string[]; type(text: string): void } => {
  const events: string[] = [];
  let listener: Listener | undefined;
  const terminal: PromptTerminal = {
    stdin: {
      setRawMode: (mode: boolean) => {
        events.push(`raw:${mode}`);
        return terminal.stdin as never;
      },
      resume: () => {
        events.push('resume');
        return terminal.stdin as never;
      },
      pause: () => {
        events.push('pause');
        return terminal.stdin as never;
      },
      on: ((_event: string, next: Listener) => {
        events.push('listen');
        listener = next;
        return terminal.stdin;
      }) as never,
      off: ((_event: string, _next: Listener) => {
        events.push('unlisten');
        listener = undefined;
        return terminal.stdin;
      }) as never,
    },
    stdout: {
      write: ((text: string) => {
        events.push(`write:${JSON.stringify(text)}`);
        return true;
      }) as never,
    },
  };
  return {
    terminal,
    events,
    type: (text) => {
      if (listener === undefined) throw new Error('nothing is reading the terminal');
      listener(text);
    },
  };
};

describe('withHiddenInput', () => {
  it('turns echo off before the first label is written and keeps it off until every line is read', async () => {
    const { terminal, events, type } = recordingTerminal();
    const result = withHiddenInput(terminal, new AbortController().signal, async (read) => {
      const first = read('first: ');
      type('abc\r');
      const second = read('second: ');
      type('def\r');
      return [await first, await second];
    });

    await expect(result).resolves.toEqual(['abc', 'def']);
    expect(events.indexOf('raw:true')).toBeLessThan(events.findIndex((event) => event.startsWith('write:')));
    expect(events.filter((event) => event.startsWith('raw:'))).toEqual(['raw:true', 'raw:false']);
    const firstWrite = events.findIndex((event) => event.startsWith('write:'));
    expect(events.slice(0, firstWrite)).toEqual(['raw:true', 'resume']);
    expect(events.at(-1)).toBe('raw:false');
  });

  it('restores the terminal when a line is interrupted', async () => {
    const { terminal, events, type } = recordingTerminal();
    const result = withHiddenInput(terminal, new AbortController().signal, async (read) => {
      const line = read('value: ');
      type('\u0003');
      return line;
    });

    await expect(result).rejects.toBeInstanceOf(PromptInterrupted);
    expect(events.slice(-2)).toEqual(['pause', 'raw:false']);
  });

  it('does not touch the terminal when the signal is already aborted', async () => {
    const { terminal, events } = recordingTerminal();
    const controller = new AbortController();
    controller.abort();

    await expect(withHiddenInput(terminal, controller.signal, async () => 'unreachable')).rejects.toBe(controller.signal.reason);
    expect(events).toEqual([]);
  });
});
