import { execFile } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '@momonga/testkit';

const run = promisify(execFile);
const MAIN = path.resolve(import.meta.dirname, '..', 'src', 'main.ts');
const CHILD_TIMEOUT_MS = 60_000;

let home = '';
let settingsFile = '';

beforeAll(() => {
  home = createTempDir({ asHome: true });
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  settingsFile = path.join(home, '.momonga', 'settings.json');
  fs.writeFileSync(settingsFile, '{ "network": ', { mode: 0o600 });
});

afterAll(async () => {
  await removeTempDir(home);
});

const momonga = (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  run(process.execPath, [MAIN, ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: os.tmpdir() }, timeout: CHILD_TIMEOUT_MS }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: unknown; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );

describe('the CLI with an invalid user settings file', { timeout: CHILD_TIMEOUT_MS * 2 }, () => {
  it('still prints the help', async () => {
    const result = await momonga(['--help']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  it('still prints the version, which makes no outbound connection', async () => {
    const result = await momonga(['--version']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('fails a command that makes an outbound connection, naming the settings file', async () => {
    const result = await momonga(['models', 'detect', 'http://127.0.0.1:9', '--json']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(settingsFile);
  });
});
