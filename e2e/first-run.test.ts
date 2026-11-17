import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG } from '@momonga/foundation';
import { messageOf } from '@momonga/protocol';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

describe('the first run with nothing configured', () => {
  it(titleOf('first-run-headless-empty-home'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    expect(fs.existsSync(home.paths.settingsFile)).toBe(false);

    const result = await runCli(home, ['-p', 'hello']);

    expect(result.code).toBe(EXIT_CONFIG);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`momonga: ${messageOf('noModelConnected', 'cli')}\n`);
    expect(result.stderr).not.toMatch(/probe/i);
    expect(result.stderr).not.toContain('\\u000a');
    expect(fs.existsSync(home.paths.settingsFile)).toBe(false);
  });

  it(titleOf('first-run-headless-json'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();

    const result = await runCli(home, ['-p', 'hello', '--output-format', 'json']);

    expect(result.code).toBe(EXIT_CONFIG);
    const reply = JSON.parse(result.stdout) as { error?: { code?: string; message?: string } };
    expect(reply.error?.code).toBe('target_not_ready');
    expect(reply.error?.message).toContain(messageOf('noModelConnected', 'cli'));
  });
});
