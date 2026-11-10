import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_EVERY_MODE, enterSequenceOf, leaveSequenceOf } from '../../src/tui/terminal/modes.ts';

const SCRIPT_BINARY = '/usr/bin/script';
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'exec-terminal.ts');
const ESC = '\u001b';
const ADOPTED = ['alt-screen', 'mouse', 'bracketed-paste', 'kitty-keys'] as const;
const PTY_TEST_TIMEOUT_MS = 60_000;

const underPty = (args: readonly string[]): readonly string[] =>
  process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, ...args] : ['-q', '-e', '-c', [process.execPath, ...args].join(' '), '/dev/null'];

const runUnderPty = (args: readonly string[]): Promise<{ status: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(SCRIPT_BINARY, underPty([FIXTURE, ...args]), { env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, output }));
  });

const canRun = process.platform !== 'win32' && typeof process.execve === 'function' && fs.existsSync(SCRIPT_BINARY);

const partsOf = (output: string): { before: string; between: string; after: string; beforeLine: string; afterLine: string } => {
  const beforeAt = output.indexOf('before-exec');
  const afterAt = output.indexOf('after-exec');
  const beforeEnd = output.indexOf('\n', beforeAt);
  const afterEnd = output.indexOf('\n', afterAt);
  return { before: output.slice(0, beforeAt), between: output.slice(beforeEnd + 1, afterAt), after: output.slice(afterEnd + 1), beforeLine: output.slice(beforeAt, beforeEnd), afterLine: output.slice(afterAt, afterEnd) };
};

describe.skipIf(!canRun)('the terminal across a real exec (V3 extended, red test 24)', () => {
  it('keeps the modes of the set and raw mode, and the new process writes no enter sequence and no query', { timeout: PTY_TEST_TIMEOUT_MS }, async () => {
    const { status, output } = await runUnderPty([]);
    const parts = partsOf(output);
    expect(status).toBe(0);
    expect(parts.before).toContain(enterSequenceOf(['alt-screen', 'bracketed-paste']));
    expect(parts.before).toContain(enterSequenceOf(['mouse']));
    expect(parts.beforeLine).toContain('icanon=off echo=off');
    expect(parts.between).toBe('');
    expect(parts.afterLine).toContain(`adopted enabled=${ADOPTED.join(',')} value=undefined icanon=off echo=off`);
    expect(parts.afterLine.match(/pid=(\d+)/)?.[1]).toBe(parts.beforeLine.match(/pid=(\d+)/)?.[1]);
    expect(parts.after).toBe(leaveSequenceOf(ADOPTED));
  });

  it('leaves every mode of the table once before anything else when the value was lost, then starts as an ordinary client', { timeout: PTY_TEST_TIMEOUT_MS }, async () => {
    const { status, output } = await runUnderPty(['lose-value']);
    const parts = partsOf(output);
    expect(status).toBe(0);
    expect(parts.between.startsWith(LEAVE_EVERY_MODE)).toBe(true);
    expect(parts.between.split(LEAVE_EVERY_MODE).length - 1).toBe(1);
    expect(parts.between.slice(LEAVE_EVERY_MODE.length).startsWith(enterSequenceOf(['alt-screen', 'bracketed-paste']))).toBe(true);
    expect(parts.afterLine).toContain('lost enabled=alt-screen,bracketed-paste,kitty-keys');
    expect(parts.after.startsWith(`${ESC}[?1049l`)).toBe(true);
  });
});
