import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_BUNDLE, cliEnv } from './cli.ts';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, until } from './wait.ts';

export const SCRIPT_BINARY = '/usr/bin/script';
export const MKFIFO_BINARY = '/usr/bin/mkfifo';

let fifoCounter = 0;
export const PTY_COLUMNS = 100;
export const PTY_ROWS = 40;

const ESCAPE_SEQUENCES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*\u0007|[()][A-Z0-9]|[=>])/g;

export const stripEscapes = (text: string): string => text.replace(ESCAPE_SEQUENCES, '').replaceAll('\r', '');

export const KEYS = {
  enter: '\r',
  escape: '\u001b',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  down: '\u001b[B',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlJ: '\n',
} as const;

export type PtyExit = { code: number | null; signal: NodeJS.Signals | null };

export type PtySession = {
  write(text: string): void;
  screen(): string;
  sinceLastWrite(): string;
  waitFor(pattern: string | RegExp, boundMs?: number): Promise<void>;
  exit(boundMs?: number): Promise<PtyExit>;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const spawnPty = async (home: E2eHome, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<PtySession> => {
  fifoCounter += 1;
  const fifo = path.join(home.root, `pty-input-${fifoCounter}`);
  execFileSync(MKFIFO_BINARY, [fifo]);
  const transcript = path.join(home.root, `pty-output-${fifoCounter}`);
  const exitFile = path.join(home.root, `pty-exit-${fifoCounter}`);
  const command = `stty cols ${PTY_COLUMNS} rows ${PTY_ROWS}; ${shellQuote(process.execPath)} ${shellQuote(CLI_BUNDLE)} ${args.map(shellQuote).join(' ')}; echo $? > ${shellQuote(exitFile)}`;
  const child: ChildProcessByStdio<null, null, null> = spawn(
    '/bin/sh',
    ['-c', 'cat "$3" | "$1" -q -F "$4" /bin/sh -c "$2"', 'sh', SCRIPT_BINARY, command, fifo, transcript],
    {
      cwd: home.project,
      env: { ...cliEnv(home, env), TERM: 'xterm-256color' },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  const input = fs.createWriteStream(fifo);
  input.on('error', () => undefined);
  const shellClosed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  const exit = async (boundMs = E2E_RUN_COMPLETED_BOUND_MS): Promise<PtyExit> => {
    const { code } = await until(
      () => {
        if (!fs.existsSync(exitFile)) return undefined;
        const text = fs.readFileSync(exitFile, 'utf8').trim();
        return text === '' ? undefined : { code: Number(text) };
      },
      { deadlineMs: boundMs, description: 'the command in the pty to exit' },
    ).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nscreen tail:\n${screen().slice(-1500)}`, { cause: error });
    });
    input.end();
    await shellClosed;
    return { code, signal: null };
  };

  registerE2eCleanup(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    input.destroy();
    await shellClosed;
  });
  const rawOutput = (): string => (fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : '');
  let writtenAt = 0;
  const screen = (): string => stripEscapes(rawOutput());
  const sinceLastWrite = (): string => stripEscapes(rawOutput().slice(writtenAt));
  const waitFor = async (pattern: string | RegExp, boundMs = E2E_RUN_COMPLETED_BOUND_MS): Promise<void> => {
    const found = until(() => (typeof pattern === 'string' ? sinceLastWrite().includes(pattern) : pattern.test(sinceLastWrite())), {
      deadlineMs: boundMs,
      description: `terminal output ${String(pattern)}`,
    });
    try {
      await found;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nscreen tail:\n${screen().slice(-1500)}`, { cause: error });
    }
  };
  return { sinceLastWrite, write: (text) => {
      writtenAt = rawOutput().length;
      input.write(text);
    }, screen, waitFor, exit };
};
