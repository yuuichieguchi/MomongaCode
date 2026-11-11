import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, withTempDir } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import type { launchApart } from '@momonga/foundation';
import { launchProgram, launchProgramThrough } from '../src/node-ports.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('launchProgram starts a program detached and reports how it ended (P-C7)', () => {
  it('resolves with the exit code of a program that exits 3', async () => {
    await expect(launchProgram(process.execPath, ['-e', 'process.exit(3)'])).resolves.toEqual({ exitCode: 3, signal: null });
  });

  it('resolves with 0 for a program that exits 0', async () => {
    await expect(launchProgram(process.execPath, ['-e', 'process.exit(0)'])).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it('rejects when the file does not exist', async (context) => {
    const missing = path.join(withTempDir(context), 'no-such-program');
    await expect(launchProgram(missing, [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts apart from the terminal with no streams and no window, and lets the process go', async () => {
    const started: { file: string; args: readonly string[]; options: unknown }[] = [];
    let unrefs = 0;
    const child = Object.assign(new EventEmitter(), {
      unref: () => {
        unrefs += 1;
      },
    }) as unknown as ReturnType<typeof launchApart>;
    const launch = launchProgramThrough((file, args, options) => {
      started.push({ file, args, options });
      return child;
    });
    const end = launch('/stand-in/xdg-open', ['https://example.com/']);
    expect(started).toEqual([{ file: '/stand-in/xdg-open', args: ['https://example.com/'], options: { stdio: 'ignore', windowsHide: true } }]);
    expect(unrefs).toBe(1);
    child.emit('exit', 0, null);
    await expect(end).resolves.toEqual({ exitCode: 0, signal: null });
  });
});
