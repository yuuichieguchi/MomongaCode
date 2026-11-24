import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_AFTER_READY_CODE } from './fixtures/exit-after-ready-supervisor.ts';
import { createE2eHome } from './home.ts';
import { UPSTREAM_MODEL, UPSTREAM_MODEL_REF, UPSTREAM_PROVIDER, baseSettings, startStack, upstreamEntryOf, upstreamModelRef, withClassifierModel, withInheritedClassifier, withStructuredRole, withStructuredSessionModel } from './stack.ts';
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

type WrittenModels = { start: string; roles?: Record<string, unknown>; connections: { provider: string; socketPath: string; models: { id: string; capabilities: Record<string, unknown> }[] }[] };

const writtenModelsOf = (settings: Record<string, unknown>): WrittenModels => settings['models'] as WrittenModels;

describe('withClassifierModel', () => {
  it('adds a model that declares json_schema structured output to the upstream connection, names it as the classifier and keeps the upstream model as it was', async () => {
    const home = await createE2eHome();
    const base = baseSettings(home, 'none');
    const settings = withClassifierModel(base, 'guard');
    const [connection, ...others] = writtenModelsOf(settings).connections;
    expect(others).toEqual([]);
    expect(connection?.provider).toBe(UPSTREAM_PROVIDER);
    expect(connection?.socketPath).toBe(home.upstreamSocket);
    expect(connection?.models.map((entry) => entry.id)).toEqual([UPSTREAM_MODEL, 'guard']);
    expect(connection?.models[1]?.capabilities).toMatchObject({ structuredOutput: 'json_schema' });
    expect(connection?.models[0]).toEqual(upstreamEntryOf(base));
    expect(settings['autoMode']).toEqual({ classifier: upstreamModelRef('guard') });
  });
});

describe('withStructuredSessionModel', () => {
  it('declares json_schema structured output on the upstream model, adds no model and names no classifier', async () => {
    const home = await createE2eHome();
    const base = baseSettings(home, 'none');
    const settings = withStructuredSessionModel(base);
    const [connection] = writtenModelsOf(settings).connections;
    expect(connection?.models.map((entry) => entry.id)).toEqual([UPSTREAM_MODEL]);
    expect(connection?.models[0]?.capabilities).toEqual({ ...upstreamEntryOf(base).capabilities, structuredOutput: 'json_schema' });
    expect(writtenModelsOf(settings).start).toBe(writtenModelsOf(base).start);
    expect(settings['autoMode']).toBeUndefined();
  });
});

describe('withInheritedClassifier', () => {
  it('writes the classifier as inherit over a session model that declares json_schema structured output', async () => {
    const home = await createE2eHome();
    const settings = withInheritedClassifier(baseSettings(home, 'none'));
    expect(writtenModelsOf(settings).connections[0]?.models.map((entry) => entry.id)).toEqual([UPSTREAM_MODEL]);
    expect(writtenModelsOf(settings).connections[0]?.models[0]?.capabilities).toMatchObject({ structuredOutput: 'json_schema' });
    expect(settings['autoMode']).toEqual({ classifier: 'inherit' });
  });
});

describe('withStructuredRole', () => {
  it.each(['reflection', 'analysis'] as const)('points models.roles.%s at a model that declares json_schema structured output and keeps new sessions on the upstream model', async (role) => {
    const home = await createE2eHome();
    const base = baseSettings(home, 'none');
    const settings = withStructuredRole(base, role, 'thinker');
    const models = writtenModelsOf(settings);
    const [connection, ...others] = models.connections;
    expect(others).toEqual([]);
    expect(models.roles).toEqual({ [role]: upstreamModelRef('thinker') });
    expect(models.start).toBe(UPSTREAM_MODEL_REF);
    expect(connection?.socketPath).toBe(home.upstreamSocket);
    expect(connection?.models.map((entry) => entry.id)).toEqual([UPSTREAM_MODEL, 'thinker']);
    expect(connection?.models[1]?.capabilities).toMatchObject({ structuredOutput: 'json_schema' });
    expect(connection?.models[0]).toEqual(upstreamEntryOf(base));
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
