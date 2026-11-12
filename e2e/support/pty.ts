import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcessByStdio } from '@momonga/testkit/child-process';
import { createTerminalScreen } from '@momonga/testkit/terminal-screen';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CLI_BUNDLE, CLI_FAKES_BUNDLE, cliEnv, fakePortsEnv } from './cli.ts';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { trackStreamErrors } from './stream-errors.ts';
import { KEY_SETTLE_MS } from '../../packages/cli/src/tui/terminal/constants.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, abortableWait, until, withinBound } from './wait.ts';

export const PYTHON_BINARY = '/usr/bin/python3';
export const PTY_HOST = path.join(import.meta.dirname, 'pty-host.py');

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
  ctrlHome: '\u001b[1;5H',
  ctrlEnd: '\u001b[1;5F',
} as const;

export type PtyExit = { code: number | null; signal: NodeJS.Signals | null };

export type PtySession = {
  write(text: string): void;
  screen(): string;
  visible(): string[];
  raw(): string;
  sinceLastWrite(): string;
  waitFor(pattern: string | RegExp, boundMs?: number): Promise<void>;
  waitForPrompt(pattern: string | RegExp): Promise<void>;
  exit(boundMs?: number): Promise<PtyExit>;
};

const WAITING_ROW = /\d+s · esc to cancel/;

export const untilRunEnds = async (pty: PtySession, mode: string): Promise<void> => {
  const footer = new RegExp(`^mode: ${mode} \\(shift\\+tab\\) · tokens: [\\d.]+k?( · context: \\d+%)?( |$)`);
  await until(() => pty.visible().some((line) => footer.test(line)) && !pty.visible().some((line) => WAITING_ROW.test(line)), {
    deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
    description: `the run to end with the footer of mode ${mode} and no waiting row`,
  });
};

const TRUST_ROWS = { trust: '1', decline: '2' } as const;

export const answerTrust = async (pty: PtySession, row: keyof typeof TRUST_ROWS): Promise<void> => {
  await pty.waitForPrompt('Do you trust the files in');
  pty.write(TRUST_ROWS[row]);
  pty.write(KEYS.enter);
};

export const spawnPty = async (home: E2eHome, args: readonly string[], env: Readonly<Record<string, string>> = {}, options: { fakes?: true; bundle?: string } = {}): Promise<PtySession> => {
  const bundle = options.bundle ?? (options.fakes === true ? CLI_FAKES_BUNDLE : CLI_BUNDLE);
  const childEnv = options.fakes === true ? { ...fakePortsEnv(home), ...env } : env;
  const ptyEnv = { ...cliEnv(home, childEnv), TERM: 'xterm-256color' };
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    PYTHON_BINARY,
    [PTY_HOST, String(PTY_COLUMNS), String(PTY_ROWS), process.execPath, bundle, ...args],
    { cwd: home.project, env: ptyEnv, detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const terminal = createTerminalScreen({ columns: PTY_COLUMNS, rows: PTY_ROWS });
  const inputPipe = trackStreamErrors(child.stdin, 'the input pipe of the pty');
  let rawOutput = '';
  let rendering = Promise.resolve();
  terminal.onAnswer((answer) => {
    if (child.stdin.writable) child.stdin.write(answer);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    rawOutput += chunk;
    rendering = rendering.then(() => terminal.write(chunk));
  });
  const closed = new Promise<PtyExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const screen = (): string => terminal.everyLine().join('\n');
  let writtenAt = 0;
  const sinceLastWrite = (): string => stripEscapes(rawOutput.slice(writtenAt));
  const withScreen = (error: unknown): Error =>
    new Error(`${error instanceof Error ? error.message : String(error)}\nscreen:\n${terminal.text().join('\n')}`, { cause: error });

  const exit = async (boundMs = E2E_RUN_COMPLETED_BOUND_MS): Promise<PtyExit> => {
    const result = await withinBound(closed, boundMs, 'the command in the pty to exit').catch((error: unknown) => {
      throw withScreen(error);
    });
    await rendering;
    inputPipe.assertHealthy();
    return result;
  };

  registerE2eCleanup(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    await closed;
    terminal.dispose();
    inputPipe.assertHealthy();
  });

  const waitFor = async (pattern: string | RegExp, boundMs = E2E_RUN_COMPLETED_BOUND_MS): Promise<void> => {
    await until(
      async () => {
        await rendering;
        const shown = screen();
        return typeof pattern === 'string' ? shown.includes(pattern) : pattern.test(shown);
      },
      { deadlineMs: boundMs, description: `the terminal screen to show ${String(pattern)}` },
    ).catch((error: unknown) => {
      throw withScreen(error);
    });
  };

  const waitForPrompt = async (pattern: string | RegExp): Promise<void> => {
    await waitFor(pattern);
    await abortableWait(KEY_SETTLE_MS);
  };

  return {
    write: (text) => {
      inputPipe.assertHealthy();
      writtenAt = rawOutput.length;
      child.stdin.write(text);
    },
    screen,
    visible: () => terminal.text(),
    raw: () => rawOutput,
    sinceLastWrite,
    waitFor,
    waitForPrompt,
    exit,
  };
};
