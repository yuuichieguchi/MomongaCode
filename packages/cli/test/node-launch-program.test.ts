import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, withTempDir } from '@momonga/testkit';
import { launchProgram } from '../src/node-ports.ts';

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
});
