import { spawn } from '@momonga/testkit/child-process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, HELPER_COMMAND, helperCommandLine } from '@momonga/foundation';
import { createTempDir, removeTempDir } from '@momonga/testkit';

const PRODUCT_ENTRY = path.resolve(import.meta.dirname, '..', 'src', 'main.ts');
const ENTRY_WITH_TEST_HELPER = path.resolve(import.meta.dirname, 'helper-mode-entry.ts');
const CHILD_TIMEOUT_MS = 60_000;

let home = '';

beforeAll(() => {
  home = createTempDir({ asHome: true });
});

afterAll(async () => {
  await removeTempDir(home);
});

type Ended = { code: number | null; stdout: string; stderr: string };

const started = (commandLine: readonly string[], input: string): Promise<Ended> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = commandLine;
    if (file === undefined) throw new Error('the command line is empty');
    const child = spawn(file, args, { env: { PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: os.tmpdir(), HELPER_MODE_MARKER: 'from the caller' }, timeout: CHILD_TIMEOUT_MS });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(input);
  });

const helperOf = (script: string, name: string, args: readonly string[]): readonly string[] => helperCommandLine({ execPath: process.execPath, script }, name, args);

describe('the helper mode of the executable', { timeout: CHILD_TIMEOUT_MS * 2 }, () => {
  it('runs the named helper with its arguments, standard streams and environment unchanged, and ends with the code the helper returns', async () => {
    const args = ["Password for 'https://person@example.test': ", '-p', '--version', '--model', 'x', '--', '--help', '', '-h'];

    const ended = await started(helperOf(ENTRY_WITH_TEST_HELPER, 'report', args), 'line one\nline two');

    expect(ended.stderr).toBe('the helper wrote this');
    expect(JSON.parse(ended.stdout)).toEqual({ args, input: 'line one\nline two', marker: 'from the caller' });
    expect(ended.code).toBe(7);
  });

  it('refuses a name no helper has with a usage error and runs nothing', async () => {
    const ended = await started(helperOf(ENTRY_WITH_TEST_HELPER, 'no-such-helper', ['argument']), '');

    expect(ended.stdout).toBe('');
    expect(ended.stderr).toBe('momonga: there is no helper named no-such-helper\n');
    expect(ended.code).toBe(EXIT_USAGE);
  });

  it('refuses the helper mode without a name with a usage error', async () => {
    const ended = await started([process.execPath, ENTRY_WITH_TEST_HELPER, HELPER_COMMAND], '');

    expect(ended.stdout).toBe('');
    expect(ended.stderr).toBe('momonga: the helper mode needs the name of a helper\n');
    expect(ended.code).toBe(EXIT_USAGE);
  });

  it('refuses the helper mode that is not the first argument, because the arguments before it would not reach the helper', async () => {
    const ended = await started([process.execPath, ENTRY_WITH_TEST_HELPER, '--verbose', HELPER_COMMAND, 'report'], '');

    expect(ended.stdout).toBe('');
    expect(ended.stderr).toBe(`momonga: ${HELPER_COMMAND} must be the first argument\n`);
    expect(ended.code).toBe(EXIT_USAGE);
  });

  it('refuses a name it does not know in the product entry, whose helpers are the ones the tools package registers', async () => {
    const ended = await started(helperOf(PRODUCT_ENTRY, 'no-such-helper', []), '');

    expect(ended.stdout).toBe('');
    expect(ended.stderr).toBe('momonga: there is no helper named no-such-helper\n');
    expect(ended.code).toBe(EXIT_USAGE);
  });

  it('takes no part in the help of the product', async () => {
    const ended = await started([process.execPath, PRODUCT_ENTRY, '--help'], '');

    expect(ended.code).toBe(EXIT_OK);
    expect(ended.stdout).toContain('Usage');
    expect(ended.stdout).not.toContain(HELPER_COMMAND);
  });
});
