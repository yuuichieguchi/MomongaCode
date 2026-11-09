import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { runCli, startCli } from './cli.ts';
import type { CliResult } from './cli.ts';
import { createE2eHome, disposeAll } from './home.ts';
import { baseSettings, writeSettingsFile } from './stack.ts';
import { E2E_MARGIN_MS, E2E_TEST_TIMEOUT_MS, abortableWait, until } from './wait.ts';

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

  it('rejects with both the collection failure and the result of the CLI when the collection fails', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSettingsFile(home, baseSettings(home, 'none'));
    const collectionFailure = new Error('ledger collection broke');
    const failing = { ...home, ledger: { ...home.ledger, collect: () => Promise.reject(collectionFailure) } };

    const error: unknown = await runCli(failing, ['--version']).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    const aggregate = (error as Error).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    const failure = aggregate as AggregateError & { cause: CliResult };
    expect(failure.errors).toContain(collectionFailure);
    expect(failure.cause).toMatchObject({ code: 0, signal: null, stderr: '' });
    await disposeAll();
  });

  it('bounds a started CLI from when the test waits for its result, not from its start', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const ready = path.join(home.root, 'held.ready');
    const release = path.join(home.root, 'held.release');
    const held = path.join(home.root, 'held.mjs');
    fs.writeFileSync(
      held,
      [
        "import fs from 'node:fs';",
        'const [ready, release] = process.argv.slice(2);',
        "fs.writeFileSync(ready, '');",
        'const timer = setInterval(() => {',
        '  if (fs.existsSync(release)) clearInterval(timer);',
        '}, 20);',
        '',
      ].join('\n'),
    );
    const boundMs = E2E_MARGIN_MS;
    const quiet = { ...home, ledger: { ...home.ledger, collect: () => Promise.resolve() } };

    const running = startCli(quiet, [ready, release], { bundle: held, boundMs });
    await until(() => fs.existsSync(ready), { deadlineMs: E2E_TEST_TIMEOUT_MS, description: 'the held CLI to start' });
    await abortableWait(boundMs);
    fs.writeFileSync(release, '');

    await expect(running.result).resolves.toMatchObject({ code: 0, signal: null });
    await disposeAll();
  });
});
