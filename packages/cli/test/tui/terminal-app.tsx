import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { systemTiming } from '@momonga/foundation';
import { pollUntil } from '@momonga/testkit';
import { createTerminalScreen } from '@momonga/testkit/terminal-screen';
import { App } from '../../src/tui/app.tsx';
import { createInputParser } from '../../src/tui/terminal/parser.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

const SHOWN_BOUND_MS = 20_000;

export type TerminalApp = {
  screen(): string[];
  type(text: string, shown: (screen: string[]) => boolean, description: string): Promise<string[]>;
  close(): void;
};

export const startOnTerminal = async (size: { columns: number; rows: number }, options: FakeBackendOptions): Promise<TerminalApp> => {
  const shown = createTerminalScreen(size);
  let pending: Promise<void> = Promise.resolve();
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: size.columns,
    rows: size.rows,
    write: (bytes: string): boolean => {
      pending = pending.then(() => shown.write(bytes));
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, setEncoding: () => undefined, setRawMode: () => undefined, ref: () => undefined, unref: () => undefined, read: () => null, resume: () => undefined, pause: () => undefined });
  const terminal = fakeScreenTerminal(size);
  const instance = render(<App backend={fakeBackend(options)} terminal={terminal} initialMode={undefined} now={Date.now} timers={systemTiming} onExit={() => undefined} />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, incrementalRendering: true });
  const parser = createInputParser();
  const screen = (): string[] => shown.text();
  const until = async (holds: (lines: string[]) => boolean, description: string): Promise<string[]> => {
    await pollUntil(async () => {
      await pending;
      return holds(screen());
    }, { description, boundMs: SHOWN_BOUND_MS });
    return screen();
  };
  await until((lines) => lines.some((line) => line.includes('mode: manual')), 'the app is ready');
  return {
    screen,
    type: async (text, holds, description) => {
      for (const event of parser.push(Buffer.from(text, 'utf8'))) terminal.emit(event);
      return until(holds, description);
    },
    close: () => {
      instance.unmount();
      shown.dispose();
    },
  };
};
