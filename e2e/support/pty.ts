import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcessByStdio } from '@momonga/testkit/child-process';
import { createTerminalScreen } from '@momonga/testkit/terminal-screen';
import type { TerminalScreen } from '@momonga/testkit/terminal-screen';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CLI_BUNDLE, CLI_FAKES_BUNDLE, cliEnv, commandOf, fakePortsEnv } from './cli.ts';
import { registerE2eCleanup } from './home.ts';
import { requirePosixHost } from './posix-host.ts';
import type { E2eHome } from './home.ts';
import { trackStreamErrors } from './stream-errors.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, until, withinBound } from './wait.ts';

export const PYTHON_BINARY = '/usr/bin/python3';
export const PTY_HOST = path.join(import.meta.dirname, 'pty-host.py');

export const PTY_COLUMNS = 100;
export const PTY_ROWS = 40;

export const KEYS = {
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  down: '\u001b[B',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlJ: '\n',
  ctrlHome: '\u001b[1;5H',
  ctrlEnd: '\u001b[1;5F',
} as const;

export type KeyName = keyof typeof KEYS;

export type Choice = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export type PtyExit = { code: number | null; signal: NodeJS.Signals | null };

export const REGIONS = ['screen', 'transcript', 'input', 'footer'] as const;

export type Region = (typeof REGIONS)[number];

export type Pattern = string | RegExp;

export type Condition = { readonly shows: Pattern; readonly in?: Region } | { readonly lacks: Pattern; readonly in?: Region } | { readonly caretOn: Pattern } | { readonly changed: Region };

export type Proof = Pattern | Condition | readonly Condition[];

export type Frame = { readonly rows: readonly string[]; readonly lines: readonly string[]; readonly caretRow: number; region(name: Region): string[] };

export type Exited = { readonly status: PtyExit; readonly frame: Frame };

export type WaitOptions = { readonly boundMs?: number };

export type PtySession = {
  write(text: string): Promise<void>;
  type(text: string, options?: WaitOptions): Promise<Frame>;
  paste(text: string, options: WaitOptions & { readonly until: Proof }): Promise<Frame>;
  key(key: KeyName | Choice, options: WaitOptions & { readonly until: 'exit' }): Promise<Exited>;
  key(key: KeyName | Choice, options: WaitOptions & { readonly until: Proof }): Promise<Frame>;
  waitFor(proof: Proof, options?: WaitOptions): Promise<Frame>;
  waitForGone(pattern: Pattern, options?: WaitOptions & { readonly in?: Region }): Promise<Frame>;
  waitForPrompt(pattern: Pattern, options?: WaitOptions): Promise<Frame>;
  exit(options?: WaitOptions): Promise<Exited>;
};

const FOOTER_ROW = /^mode: \S+/;
const BOX_TOP = '╭';
const BOX_BOTTOM = '╰';
const BOX_SIDE = /^│ ?|\s?│\s*$/g;
const SETTLED_PROMPT_HINT = /to choose|to move|to confirm the value/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

const lastIndexWhere = (rows: readonly string[], before: number, test: (row: string) => boolean): number => {
  for (let index = before - 1; index >= 0; index -= 1) if (test(rows[index] ?? '')) return index;
  return -1;
};

const trimTrailingBlank = (rows: readonly string[]): string[] => rows.slice(0, rows.findLastIndex((row) => row.trim() !== '') + 1);

const regionsOf = (rows: readonly string[]): Record<Exclude<Region, 'screen'>, string[]> => {
  const footerAt = rows.findLastIndex((row) => FOOTER_ROW.test(row));
  const above = footerAt === -1 ? rows.length : footerAt;
  const footer = footerAt === -1 ? [] : trimTrailingBlank(rows.slice(footerAt));
  const bottomAt = lastIndexWhere(rows, above, (row) => row.trim() !== '');
  const topAt = rows[bottomAt]?.startsWith(BOX_BOTTOM) === true ? lastIndexWhere(rows, bottomAt, (row) => row.startsWith(BOX_TOP)) : -1;
  if (topAt === -1) return { transcript: rows.slice(0, above), input: [], footer };
  return { transcript: rows.slice(0, topAt), input: rows.slice(topAt + 1, bottomAt).map((row) => row.replace(BOX_SIDE, '').trimEnd()), footer };
};

const frameOf = (rows: readonly string[], lines: readonly string[], caretRow: number): Frame => {
  const regions = regionsOf(rows);
  return { rows, lines, caretRow, region: (name) => (name === 'screen' ? [...lines] : [...regions[name]]) };
};

const EMPTY_FRAME = frameOf([], [], -1);

const matches = (pattern: Pattern, text: string): boolean => (typeof pattern === 'string' ? text.includes(pattern) : new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text));

type Check = { describe: string; holds(frame: Frame): boolean; witness(frame: Frame): string };

const conditionsOf = (proof: Proof): readonly Condition[] => {
  if (typeof proof === 'string' || proof instanceof RegExp) return [{ shows: proof }];
  if ('shows' in proof || 'lacks' in proof || 'caretOn' in proof || 'changed' in proof) return [proof as Condition];
  return proof as readonly Condition[];
};

const checkOf = (condition: Condition, beforeWrite: () => Frame): Check => {
  if ('changed' in condition) {
    const shown = (frame: Frame): string => frame.region(condition.changed).join('\n');
    return { describe: `the ${condition.changed} region to differ from its rows before the write`, holds: (frame) => frame !== beforeWrite() && shown(frame) !== shown(beforeWrite()), witness: shown };
  }
  if ('caretOn' in condition) {
    const caretRow = (frame: Frame): string => frame.rows[frame.caretRow] ?? '';
    return { describe: `the caret to stand on a row showing ${String(condition.caretOn)}`, holds: (frame) => matches(condition.caretOn, caretRow(frame)), witness: caretRow };
  }
  const region = condition.in ?? 'screen';
  const pattern = 'shows' in condition ? condition.shows : condition.lacks;
  const shown = (frame: Frame): boolean => matches(pattern, frame.region(region).join('\n'));
  const witness = (frame: Frame): string => {
    const rows = frame.region(region);
    return 'shows' in condition ? (rows.find((row) => matches(pattern, row)) ?? rows.join('\n')) : `no row of the ${region} region shows it`;
  };
  return 'shows' in condition
    ? { describe: `the ${region} region to show ${String(pattern)}`, holds: shown, witness }
    : { describe: `the ${region} region to no longer show ${String(pattern)}`, holds: (frame) => !shown(frame), witness };
};


const promptCheck = (pattern: Pattern): Check => {
  const rowOf = (frame: Frame, test: (row: string) => boolean, from: number): number => frame.rows.findIndex((row, index) => index > from && test(row));
  const settled = (frame: Frame): boolean => {
    const at = rowOf(frame, (row) => matches(pattern, row), -1);
    return at !== -1 && rowOf(frame, (row) => SETTLED_PROMPT_HINT.test(row), at) !== -1;
  };
  return {
    describe: `the prompt ${String(pattern)} to show its settled hint row (${String(SETTLED_PROMPT_HINT)}) below it`,
    holds: settled,
    witness: (frame) => frame.rows.find((row) => matches(pattern, row)) ?? '',
  };
};

const refuseControl = (text: string): void => {
  if (CONTROL_CHARACTER.test(text)) throw new Error(`${JSON.stringify(text)} holds a state-changing key; send it with key(name, { until }) so the state it must produce is awaited`);
};

export type PtyIo = { readonly input: Writable; readonly output: Readable; readonly closed: Promise<PtyExit>; readonly terminal: TerminalScreen };

export const attachPtySession = ({ input, output, closed, terminal }: PtyIo): PtySession => {
  const inputPipe = trackStreamErrors(input, 'the input pipe of the pty');
  let rendering = Promise.resolve();
  let beforeWrite = EMPTY_FRAME;
  terminal.onAnswer((answer) => {
    if (input.writable) input.write(answer);
  });
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    rendering = rendering.then(() => terminal.write(chunk));
  });

  const current = async (): Promise<Frame> => {
    await rendering;
    return frameOf(terminal.text(), terminal.everyLine(), terminal.cursor().row);
  };
  const withScreen = (error: unknown): Error =>
    new Error(`${error instanceof Error ? error.message : String(error)}\nscreen:\n${terminal.text().join('\n')}`, { cause: error });

  const checksOf = (proof: Proof): Check[] => conditionsOf(proof).map((condition) => checkOf(condition, () => beforeWrite));

  const refuseProven = (checks: readonly Check[], before: Frame): void => {
    if (!checks.every((check) => check.holds(before))) return;
    const held = checks.map((check) => `${check.describe} (row: ${JSON.stringify(check.witness(before))})`).join(' and ');
    throw new Error(`the wait for ${held} was already true before the write; it proves nothing\nscreen before the write:\n${before.rows.join('\n')}`);
  };

  const awaitChecks = async (checks: readonly Check[], boundMs: number): Promise<Frame> => {
    refuseProven(checks, beforeWrite);
    let proved = EMPTY_FRAME;
    await until(
      async () => {
        proved = await current();
        return checks.every((check) => check.holds(proved));
      },
      { deadlineMs: boundMs, description: checks.map((check) => check.describe).join(' and ') },
    ).catch((error: unknown) => {
      throw withScreen(error);
    });
    return proved;
  };

  const send = async (bytes: string, checks: readonly Check[] = []): Promise<void> => {
    inputPipe.assertHealthy();
    beforeWrite = await current();
    if (checks.length > 0) refuseProven(checks, beforeWrite);
    input.write(bytes);
  };

  const exit = async ({ boundMs = E2E_RUN_COMPLETED_BOUND_MS }: WaitOptions = {}): Promise<Exited> => {
    const status = await withinBound(closed, boundMs, 'the command in the pty to exit').catch((error: unknown) => {
      throw withScreen(error);
    });
    const frame = await current();
    inputPipe.assertHealthy();
    return { status, frame };
  };

  const sendProven = async (bytes: string, proof: Proof, boundMs: number): Promise<Frame> => {
    const checks = checksOf(proof);
    await send(bytes, checks);
    return awaitChecks(checks, boundMs);
  };

  function key(name: KeyName | Choice, options: WaitOptions & { readonly until: 'exit' }): Promise<Exited>;
  function key(name: KeyName | Choice, options: WaitOptions & { readonly until: Proof }): Promise<Frame>;
  async function key(name: KeyName | Choice, options: WaitOptions & { readonly until: Proof | 'exit' }): Promise<Frame | Exited> {
    const proof: unknown = options.until;
    if (proof === undefined) throw new Error(`the key ${name} was sent without the state it must produce; give it { until }`);
    const bytes = name in KEYS ? KEYS[name as KeyName] : name;
    const boundMs = options.boundMs ?? E2E_RUN_COMPLETED_BOUND_MS;
    if (options.until === 'exit') {
      await send(bytes);
      return exit({ boundMs });
    }
    return sendProven(bytes, options.until, boundMs);
  }

  return {
    write: (text) => {
      refuseControl(text);
      return send(text);
    },
    type: async (text, { boundMs = E2E_RUN_COMPLETED_BOUND_MS } = {}) => {
      refuseControl(text);
      return sendProven(text, { shows: text, in: 'input' }, boundMs);
    },
    paste: async (text, { until: proof, boundMs = E2E_RUN_COMPLETED_BOUND_MS }) => sendProven(`${PASTE_START}${text}${PASTE_END}`, proof, boundMs),
    key,
    waitFor: (proof, { boundMs = E2E_RUN_COMPLETED_BOUND_MS } = {}) => awaitChecks(checksOf(proof), boundMs),
    waitForGone: (pattern, { boundMs = E2E_RUN_COMPLETED_BOUND_MS, in: region = 'screen' } = {}) => awaitChecks(checksOf({ lacks: pattern, in: region }), boundMs),
    waitForPrompt: (pattern, { boundMs = E2E_RUN_COMPLETED_BOUND_MS } = {}) => awaitChecks([promptCheck(pattern)], boundMs),
    exit,
  };
};

const WAITING_ROW = /\d+s · esc to cancel/;

export const untilRunEnds = (pty: PtySession, mode: string): Promise<Frame> =>
  pty.waitFor([{ shows: new RegExp(`^mode: ${mode} \\(shift\\+tab\\) · tokens: [\\d.]+k?( · context: \\d+%)?( |$)`, 'm'), in: 'footer' }, { lacks: WAITING_ROW }, { changed: 'footer' }]);

const TRUST_PROMPT = 'Do you trust the files in';

export const answerTrust = async (pty: PtySession, answer: 'trust' | 'decline'): Promise<Frame> => {
  await pty.waitForPrompt(TRUST_PROMPT);
  if (answer === 'decline') await pty.key('down', { until: /› 2\. / });
  return pty.key('enter', { until: { lacks: TRUST_PROMPT } });
};

export const spawnPty = async (home: E2eHome, args: readonly string[], env: Readonly<Record<string, string>> = {}, options: { fakes?: true; bundle?: string; executable?: string } = {}): Promise<PtySession> => {
  requirePosixHost('the pty helper (e2e/support/pty.ts)');
  const [file, argv] = commandOf(options, args, options.fakes === true ? CLI_FAKES_BUNDLE : CLI_BUNDLE);
  const childEnv = options.fakes === true ? { ...fakePortsEnv(home), ...env } : env;
  const ptyEnv = { ...cliEnv(home, childEnv), TERM: 'xterm-256color' };
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    PYTHON_BINARY,
    [PTY_HOST, String(PTY_COLUMNS), String(PTY_ROWS), file, ...argv],
    { cwd: home.project, env: ptyEnv, detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const terminal = createTerminalScreen({ columns: PTY_COLUMNS, rows: PTY_ROWS });
  const closed = new Promise<PtyExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const session = attachPtySession({ input: child.stdin, output: child.stdout, closed, terminal });
  const inputPipe = trackStreamErrors(child.stdin, 'the input pipe of the pty');
  registerE2eCleanup(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    await closed;
    terminal.dispose();
    inputPipe.assertHealthy();
  });
  return session;
};
