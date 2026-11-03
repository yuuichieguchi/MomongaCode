import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { runCli } from './cli.ts';
import { createE2eHome, disposeAll } from './home.ts';
import { baseSettings, writeSettingsFile } from './stack.ts';
import { E2E_TEST_TIMEOUT_MS } from './wait.ts';

describe('runCli', () => {
  it('records the daemon the CLI spawned before it returns, and the daemon is stopped when the home is disposed', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSettingsFile(home, baseSettings(home, 'none'));

    const result = await runCli(home, ['daemon', 'start']);

    expect(result.code).toBe(0);
    const pid = Number(/pid (\d+)/.exec(result.stdout)?.[1]);
    expect(home.ledger.entries().map((entry) => entry.pgid)).toContain(pid);
    await disposeAll();
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(home.root)).toBe(false);
  });
});
