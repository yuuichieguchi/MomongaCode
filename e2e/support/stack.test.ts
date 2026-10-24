import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_AFTER_READY_CODE } from './fixtures/exit-after-ready-supervisor.ts';
import { createE2eHome } from './home.ts';
import { startStack } from './stack.ts';
import { E2E_CHILD_READY_BOUND_MS, E2E_MARGIN_MS, E2E_TEST_TIMEOUT_MS } from './wait.ts';

const EXIT_AFTER_READY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'exit-after-ready-supervisor.ts');

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('startStack readiness', () => {
  it('rejects at once when the supervisor exits after its ready line, not at the readiness deadline', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const startedAt = Date.now();
    const failure = await failureOf(startStack({ home, supervisorScript: EXIT_AFTER_READY_PATH, readinessDeadlineMs: E2E_CHILD_READY_BOUND_MS }));
    const elapsed = Date.now() - startedAt;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(new RegExp(`^the supervisor exited \\(code ${EXIT_AFTER_READY_CODE}, signal null\\) while waiting for readiness`));
    expect(elapsed).toBeLessThan(E2E_MARGIN_MS);
  });
});

describe('startStack settings', () => {
  it('refuses a sandbox key in settings before it starts anything: the sandbox option is the only channel', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const failure = await failureOf(startStack({ home, settings: { sandbox: 'none' } }));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('sandbox');
    expect(home.ledger.entries()).toEqual([]);
    expect(fs.existsSync(path.join(home.root, 'deps-1.json'))).toBe(false);
    expect(fs.existsSync(home.paths.settingsFile)).toBe(false);
  });
});
