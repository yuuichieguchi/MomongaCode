import { describe, expect, it } from 'vitest';
import { PromptInterrupted, withHiddenInput } from '../src/terminal/hidden-prompt.ts';
import type { PromptTerminal } from '../src/terminal/hidden-prompt.ts';

type Listener = (chunk: Buffer | string) => void;

const recordingTerminal = (): { terminal: PromptTerminal; events: string[]; type(text: Buffer | string): void } => {
  const events: string[] = [];
  let listener: Listener | undefined;
  const undelivered: Array<Buffer | string> = [];
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
        for (const chunk of undelivered.splice(0)) next(chunk);
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
      if (listener === undefined) undelivered.push(text);
      else listener(text);
    },
  };
};

const readAfterTyping = (chunks: ReadonlyArray<Buffer | string>): Promise<string> => {
  const { terminal, type } = recordingTerminal();
  return withHiddenInput(terminal, new AbortController().signal, async (read) => {
    const line = read('value: ');
    for (const chunk of chunks) type(chunk);
    return line;
  });
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

describe('withHiddenInput with both entries pasted as one chunk', () => {
  const readTwo = (pasted: string, afterSecondPrompt: string): Promise<string[]> => {
    const { terminal, type } = recordingTerminal();
    return withHiddenInput(terminal, new AbortController().signal, async (read) => {
      const first = read('first: ');
      type(pasted);
      const firstValue = await first;
      const second = read('second: ');
      type(afterSecondPrompt);
      return [firstValue, await second];
    });
  };

  it('gives the rest of the chunk to the next prompt', async () => {
    await expect(readTwo('secret\nsecret\n', '\r')).resolves.toEqual(['secret', 'secret']);
  });

  it('continues a partial second line with what is typed next', async () => {
    await expect(readTwo('secret\nsec', 'ret\r')).resolves.toEqual(['secret', 'secret']);
  });

  it('treats a carriage return and line feed as one line end', async () => {
    await expect(readTwo('secret\r\nsecret\r\n', '\r')).resolves.toEqual(['secret', 'secret']);
  });

  it('honours an interrupt that follows the first line in the same chunk', async () => {
    await expect(readTwo('secret\n\u0003', 'late\r')).rejects.toBeInstanceOf(PromptInterrupted);
  });
});

describe('withHiddenInput with escape sequences and split characters', () => {
  it('drops a CSI cursor key', async () => {
    await expect(readAfterTyping(['\u001b[Aab\r'])).resolves.toBe('ab');
  });

  it('drops an SS3 cursor key', async () => {
    await expect(readAfterTyping(['\u001bOAab\r'])).resolves.toBe('ab');
  });

  it('honours Ctrl-C right after ESC O', async () => {
    await expect(readAfterTyping(['\u001bO\u0003'])).rejects.toBeInstanceOf(PromptInterrupted);
  });

  it('honours Enter right after ESC O', async () => {
    await expect(readAfterTyping(['ab\u001bO\r'])).resolves.toBe('ab');
  });

  it('drops a CSI sequence with parameters', async () => {
    await expect(readAfterTyping(['a\u001b[1;5Cb\r'])).resolves.toBe('ab');
  });

  it('drops a sequence split across chunks', async () => {
    await expect(readAfterTyping(['a\u001b', '[', 'Ab\r'])).resolves.toBe('ab');
  });

  it('decodes a character split across chunks', async () => {
    const bytes = Buffer.from('é');
    await expect(readAfterTyping([bytes.subarray(0, 1), bytes.subarray(1), Buffer.from('\r')])).resolves.toBe('é');
  });
});
