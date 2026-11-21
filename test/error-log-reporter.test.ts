import fs from 'node:fs';
import path from 'node:path';
import type { SerializedError, TestCase, TestModule } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import ErrorLogReporter, { ERROR_LOG_ENV } from './support/error-log-reporter.ts';

const fakeTestCase = (options: {
  readonly file: string;
  readonly fullName: string;
  readonly project?: string;
  readonly line?: number;
  readonly state: 'passed' | 'failed' | 'skipped';
  readonly errors?: readonly SerializedError[];
}): TestCase =>
  ({
    fullName: options.fullName,
    location: options.line === undefined ? undefined : { line: options.line, column: 1 },
    module: { moduleId: options.file },
    project: { name: options.project ?? 'unit' },
    result: () =>
      options.state === 'failed'
        ? { state: 'failed', errors: options.errors ?? [] }
        : { state: options.state },
  }) as unknown as TestCase;

const fakeTestModule = (file: string, errors: readonly SerializedError[], project = 'unit'): TestModule =>
  ({
    moduleId: file,
    project: { name: project },
    errors: () => errors,
  }) as unknown as TestModule;

describe('ErrorLogReporter', () => {
  it('writes nothing when MOMONGA_TEST_ERROR_LOG is unset or blank', (context) => {
    const dir = withTempDir(context);
    const reporter = new ErrorLogReporter({ env: {} });
    reporter.onInit({ config: { root: dir } });
    reporter.onTestCaseResult(fakeTestCase({ file: path.join(dir, 'a.test.ts'), fullName: 'suite > fails', state: 'failed', errors: [{ message: 'boom' }] }));
    expect(fs.readdirSync(dir)).toEqual([]);

    const blankReporter = new ErrorLogReporter({ env: { [ERROR_LOG_ENV]: '   ' } });
    blankReporter.onInit({ config: { root: dir } });
    blankReporter.onTestCaseResult(fakeTestCase({ file: path.join(dir, 'a.test.ts'), fullName: 'suite > fails', state: 'failed', errors: [{ message: 'boom' }] }));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('creates parent directories, truncates previous content on init, and streams only failures as they happen', (context) => {
    const dir = withTempDir(context);
    const logPath = path.join(dir, 'nested', 'error.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'stale error from previous run\n', 'utf8');

    const reporter = new ErrorLogReporter({ env: { [ERROR_LOG_ENV]: logPath } });
    reporter.onInit({ config: { root: dir } });
    expect(fs.readFileSync(logPath, 'utf8')).toBe('');

    reporter.onTestCaseResult(fakeTestCase({ file: path.join(dir, 'pass.test.ts'), fullName: 'ok', state: 'passed' }));
    reporter.onTestCaseResult(fakeTestCase({ file: path.join(dir, 'skip.test.ts'), fullName: 'skipped', state: 'skipped' }));
    expect(fs.readFileSync(logPath, 'utf8')).toBe('');

    reporter.onTestCaseResult(
      fakeTestCase({
        file: path.join(dir, 'packages', 'gateway', 'test', 'sample.test.ts'),
        fullName: 'suite > rejects minimal',
        line: 158,
        state: 'failed',
        errors: [{ name: 'AssertionError', message: 'expected 200 to be 400', stack: 'AssertionError: expected 200 to be 400\n    at sample.test.ts:161' }],
      }),
    );
    const afterFirst = fs.readFileSync(logPath, 'utf8');
    expect(afterFirst).toContain('FAIL [unit] packages/gateway/test/sample.test.ts:158 > suite > rejects minimal');
    expect(afterFirst).toContain('AssertionError: expected 200 to be 400');

    reporter.onTestModuleEnd(fakeTestModule(path.join(dir, 'broken.test.ts'), [{ name: 'Error', message: 'beforeAll failed' }], 'e2e'));
    const afterModule = fs.readFileSync(logPath, 'utf8');
    expect(afterModule).toContain('FAIL [e2e] broken.test.ts (module error)');
    expect(afterModule).toContain('Error: beforeAll failed');

    reporter.onTestRunEnd([], [{ name: 'Error', message: 'unhandled rejection' }]);
    const afterEnd = fs.readFileSync(logPath, 'utf8');
    expect(afterEnd).toContain('FAIL [unhandled]');
    expect(afterEnd).toContain('Error: unhandled rejection');
  });
});
