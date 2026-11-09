import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as testkit from '@momonga/testkit';
import { ROOT, fileLevelTestTimeout, importsFromTestkit, repositoryTests, timeoutFormOffences } from './support/test-timeout-source.ts';

const PRODUCT_STARTS = ['startGatewayProcess', 'runGatewayEntry', 'startRuntimeProcess', 'runRuntimeEntry'] as const;
const TEST_HELPER_STARTS: Readonly<Record<string, readonly string[]>> = {
  'gateway-process-helpers.ts': ['launchGateway'],
  'run-helpers.ts': ['startRuntimeProcess', 'launchRuntime', 'startGateway', 'startStack'],
};

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;

const realStartsImported = (source: string): string[] =>
  [...source.matchAll(IMPORT)].flatMap(([, names = '', from = '']) => {
    const imported = names.split(',').map((name) => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '').filter((name) => name !== '');
    const helperFile = Object.keys(TEST_HELPER_STARTS).find((file) => from.endsWith(`/${file}`));
    const starts: readonly string[] = helperFile === undefined ? PRODUCT_STARTS : [...PRODUCT_STARTS, ...(TEST_HELPER_STARTS[helperFile] ?? [])];
    return imported.filter((name) => starts.includes(name));
  });

const callsRealStart = (source: string): boolean =>
  realStartsImported(source).some((name) => new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(source));

const IN_PROCESS_HARNESS_FILES: readonly string[] = ['packages/gateway/test/close-budget.test.ts'];

const namesRealProcessGuard = (source: string): boolean => /\bREAL_PROCESS_TEST_TIMEOUT_MS\b/.test(source);

const realProcessTests = (): Array<{ file: string; source: string }> =>
  repositoryTests().filter(
    ({ file, source }) =>
      (callsRealStart(source) || namesRealProcessGuard(source)) && !file.startsWith('test/real-process-timeout-single-rule') && !IN_PROCESS_HARNESS_FILES.includes(file),
  );

const offendersOf = (file: string, source: string): string[] => {
  const reasons: string[] = [];
  if (!importsFromTestkit(source, 'REAL_PROCESS_TEST_TIMEOUT_MS')) reasons.push('does not import REAL_PROCESS_TEST_TIMEOUT_MS from @momonga/testkit');
  if (!fileLevelTestTimeout(source, 'REAL_PROCESS_TEST_TIMEOUT_MS')) reasons.push('has no file-level vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS })');
  reasons.push(...timeoutFormOffences(source, 'REAL_PROCESS_TEST_TIMEOUT_MS'));
  return reasons.map((reason) => `${file}: ${reason}`);
};

describe('every test file that starts a real gateway or runtime sets REAL_PROCESS_TEST_TIMEOUT_MS at file level', () => {
  it('testkit exports one real-process hang guard, REAL_PROCESS_TEST_TIMEOUT_MS, and no DAEMON_PROCESS_TEST_TIMEOUT_MS', () => {
    expect(typeof (testkit as Record<string, unknown>)['REAL_PROCESS_TEST_TIMEOUT_MS']).toBe('number');
    expect(testkit).not.toHaveProperty('DAEMON_PROCESS_TEST_TIMEOUT_MS');
  });

  it('testkit exports no BUILT_BINARY_TEST_TIMEOUT_MS and sets the one guard to 90 000 ms, the largest that existed', () => {
    expect(testkit).not.toHaveProperty('BUILT_BINARY_TEST_TIMEOUT_MS');
    expect((testkit as Record<string, unknown>)['REAL_PROCESS_TEST_TIMEOUT_MS']).toBe(90_000);
  });

  it('no file outside this check names BUILT_BINARY_TEST_TIMEOUT_MS', () => {
    const naming = repositoryTests()
      .filter(({ file, source }) => source.includes('BUILT_BINARY_TEST_TIMEOUT_MS') && !file.startsWith('test/real-process-timeout-single-rule'))
      .map(({ file }) => file);

    expect(naming).toEqual([]);
  });

  it('covers a file that names REAL_PROCESS_TEST_TIMEOUT_MS without starting a gateway or runtime', () => {
    expect(realProcessTests().map((entry) => entry.file)).toEqual(expect.arrayContaining(['packages/tools/test/builtins/bash.test.ts']));
  });

  it('no file outside this check names DAEMON_PROCESS_TEST_TIMEOUT_MS', () => {
    const naming = repositoryTests()
      .filter(({ file, source }) => source.includes('DAEMON_PROCESS_TEST_TIMEOUT_MS') && !file.startsWith('test/real-process-timeout-single-rule'))
      .map(({ file }) => file);

    expect(naming).toEqual([]);
  });

  it('testkit sources do not declare DAEMON_PROCESS_TEST_TIMEOUT_MS', () => {
    const source = fs.readFileSync(path.join(ROOT, 'packages/testkit/src/test-support.ts'), 'utf8');

    expect(source).not.toMatch(/\bDAEMON_PROCESS_TEST_TIMEOUT_MS\b/);
  });

  it('finds the files the feature review named', () => {
    expect(realProcessTests().map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        'packages/gateway/test/gateway-process-fm.test.ts',
        'packages/gateway/test/gateway-process-plan-target.test.ts',
        'packages/gateway/test/gateway-process-secrets.test.ts',
        'packages/gateway/test/gateway-process-align.test.ts',
        'packages/gateway/test/entry.test.ts',
        'packages/runtime/test/gateway-client/real-gateway.test.ts',
        'packages/runtime/test/gateway-client/real-gateway-liveness.test.ts',
        'packages/runtime/test/gateway-client/meter-split-orphan-output.test.ts',
      ]),
    );
  });

  it('counts a call of a real start helper and not a type that names it or a same-named in-process harness', () => {
    expect(callsRealStart("import { startGatewayProcess } from '@momonga/gateway';\ntype Handle = Awaited<ReturnType<typeof startGatewayProcess>>;\n")).toBe(false);
    expect(callsRealStart("import { startGateway } from './gateway-helpers.ts';\nawait startGateway({});\n")).toBe(false);
    expect(callsRealStart("import { startGateway } from './run-helpers.ts';\nawait startGateway(temp);\n")).toBe(true);
    expect(callsRealStart("import { startGatewayProcess } from '@momonga/gateway';\nawait startGatewayProcess({ home });\n")).toBe(true);
  });

  it.each([
    ['a describe options object', "describe('x', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {});"],
    ['a per-test identifier', "it('x', async () => {}, PROCESS_TIMEOUT);"],
    ['a per-test number', "it('x', async () => {}, 20_000);"],
    ['an options object before the body', "it('x', { timeout: 5e3 }, async () => {});"],
  ])('refuses %s beside the file-level form', (_form, line) => {
    const source = `import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';\nvi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });\n${line}\n`;

    expect(offendersOf('fixture.test.ts', source)).not.toEqual([]);
  });

  it('refuses a file that starts a real process with only a per-test timeout', () => {
    const source = "import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';\nit('x', async () => { await launchGateway({}); }, REAL_PROCESS_TEST_TIMEOUT_MS);\n";

    expect(offendersOf('fixture.test.ts', source)).not.toEqual([]);
  });

  it('every such file sets vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS }) at file level', () => {
    expect(realProcessTests().flatMap(({ file, source }) => offendersOf(file, source))).toEqual([]);
  });
});
