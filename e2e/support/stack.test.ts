import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_AFTER_READY_CODE } from './fixtures/exit-after-ready-supervisor.ts';
import { createE2eHome } from './home.ts';
import { STRUCTURED_TARGET, UPSTREAM_TARGET, baseSettings, startStack, withClassifierAlias, withStructuredRole } from './stack.ts';
import { E2E_TEST_TIMEOUT_MS } from './wait.ts';

const EXIT_AFTER_READY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'exit-after-ready-supervisor.ts');

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('startStack readiness', () => {
  it('rejects at once when the supervisor exits after its ready line, not at the readiness deadline', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const failure = await failureOf(startStack({ home, supervisorScript: EXIT_AFTER_READY_PATH }));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(new RegExp(`^the supervisor exited \\(code ${EXIT_AFTER_READY_CODE}, signal null\\) while waiting for readiness`));
  });
});

describe('withClassifierAlias', () => {
  it('points the alias at a target that declares json_schema structured output and keeps the upstream target as it was', async () => {
    const home = await createE2eHome();
    const base = baseSettings(home, 'none');
    const settings = withClassifierAlias(base, 'guard');
    const models = settings['models'] as { aliases: Record<string, unknown>; targets: Record<string, { socketPath: string; capabilities: Record<string, unknown> }> };
    expect(models.aliases['guard']).toEqual([STRUCTURED_TARGET]);
    expect(models.targets[STRUCTURED_TARGET]?.capabilities).toMatchObject({ structuredOutput: 'json_schema' });
    expect(models.targets[STRUCTURED_TARGET]?.socketPath).toBe(home.upstreamSocket);
    expect(models.targets[UPSTREAM_TARGET]).toEqual((base['models'] as { targets: Record<string, unknown> }).targets[UPSTREAM_TARGET]);
    expect(settings['autoMode']).toEqual({ classifier: 'guard' });
  });
});

describe('withStructuredRole', () => {
  it.each(['reflection', 'analysis'] as const)('points models.roles.%s at an alias whose target declares json_schema structured output and keeps the run alias on the upstream target', async (role) => {
    const home = await createE2eHome();
    const base = baseSettings(home, 'none');
    const settings = withStructuredRole(base, role, 'thinker');
    const models = settings['models'] as { aliases: Record<string, unknown>; roles: Record<string, unknown>; targets: Record<string, { socketPath: string; capabilities: Record<string, unknown> }> };
    expect(models.roles).toEqual({ [role]: 'thinker' });
    expect(models.aliases['thinker']).toEqual([STRUCTURED_TARGET]);
    expect(models.aliases['default']).toEqual([UPSTREAM_TARGET]);
    expect(models.targets[STRUCTURED_TARGET]?.capabilities).toMatchObject({ structuredOutput: 'json_schema' });
    expect(models.targets[STRUCTURED_TARGET]?.socketPath).toBe(home.upstreamSocket);
    expect(models.targets[UPSTREAM_TARGET]).toEqual((base['models'] as { targets: Record<string, unknown> }).targets[UPSTREAM_TARGET]);
    expect(settings['autoMode']).toBeUndefined();
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
