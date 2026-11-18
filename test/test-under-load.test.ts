import { describe, expect, it } from 'vitest';
import { budgetShareCpuSeconds, failureListOf, failuresOfReport, helperCountOf, loadRequestOf, runFailureOf } from '../scripts/test-under-load.ts';

const ROOT = '/repo';

describe('test-under-load arguments', () => {
  it('reads repeat, project and files', () => {
    expect(loadRequestOf(['--repeat', '5', '--project', 'unit', 'test/a.test.ts'], {})).toEqual({ repeat: 5, project: 'unit', files: ['test/a.test.ts'] });
  });

  it('defaults to three repetitions of the e2e project', () => {
    expect(loadRequestOf(['e2e/b2-bash.test.ts'], {})).toEqual({ repeat: 3, project: 'e2e', files: ['e2e/b2-bash.test.ts'] });
  });

  it('refuses no files without the whole-run switch and accepts them with it', () => {
    expect(() => loadRequestOf(['--project', 'e2e'], {})).toThrow(/MOMONGA_WHOLE_RUN=1/);
    expect(loadRequestOf(['--project', 'e2e'], { MOMONGA_WHOLE_RUN: '1' }).files).toEqual([]);
  });

  it('refuses a bad repeat, an unknown project or option, a directory and a file of another project', () => {
    expect(() => loadRequestOf(['--repeat', '0', 'e2e/a.test.ts'], {})).toThrow(/--repeat/);
    expect(() => loadRequestOf(['--project', 'packaging', 'e2e/a.test.ts'], {})).toThrow(/--project/);
    expect(() => loadRequestOf(['--bail', 'e2e/a.test.ts'], {})).toThrow(/unknown option/);
    expect(() => loadRequestOf(['e2e'], {})).toThrow(/not a test file/);
    expect(() => loadRequestOf(['--project', 'e2e', 'test/a.test.ts'], {})).toThrow(/not a test file of the e2e project/);
    expect(() => loadRequestOf(['--project', 'unit', 'packages/runtime/test/calibration/x.test.ts'], {})).toThrow(/not a test file/);
  });
});

describe('test-under-load budget', () => {
  it('is the project budget times the repetitions for a whole run', () => {
    expect(budgetShareCpuSeconds({ projectBudgetCpuSeconds: 1000, repeat: 3, namedFiles: 0, projectFiles: 100, workers: 9 })).toBe(3000);
  });

  it('is the share of the worker rounds the named files take', () => {
    expect(budgetShareCpuSeconds({ projectBudgetCpuSeconds: 1000, repeat: 3, namedFiles: 1, projectFiles: 100, workers: 9 })).toBe(270);
    expect(budgetShareCpuSeconds({ projectBudgetCpuSeconds: 1000, repeat: 2, namedFiles: 10, projectFiles: 100, workers: 9 })).toBe(360);
    expect(budgetShareCpuSeconds({ projectBudgetCpuSeconds: 1000, repeat: 1, namedFiles: 100, projectFiles: 100, workers: 9 })).toBe(1000);
  });
});

describe('test-under-load helpers', () => {
  it('fill the processors the files leave idle and are never none', () => {
    expect(helperCountOf({ processors: 10, workers: 9, files: 1 })).toBe(9);
    expect(helperCountOf({ processors: 10, workers: 9, files: 0 })).toBe(1);
    expect(helperCountOf({ processors: 10, workers: 9, files: 20 })).toBe(1);
    expect(helperCountOf({ processors: 2, workers: 1, files: 3 })).toBe(1);
  });
});

describe('test-under-load collector', () => {
  const report = {
    testResults: [
      {
        name: `${ROOT}/e2e/a.test.ts`,
        status: 'failed',
        message: '',
        assertionResults: [
          { status: 'passed', fullName: 'a works', failureMessages: [] },
          { status: 'failed', fullName: 'a races', failureMessages: ['\nAssertionError: expected 1 to be 2\n    at x'] },
        ],
      },
      { name: `${ROOT}/e2e/b.test.ts`, status: 'failed', message: 'Error: hook timed out\nmore', assertionResults: [] },
      { name: `${ROOT}/e2e/c.test.ts`, status: 'passed', message: '', assertionResults: [{ status: 'passed', fullName: 'c', failureMessages: [] }] },
    ],
  };

  it('collects every failing test and every failed file with its first error line', () => {
    expect(failuresOfReport(report, 2, ROOT)).toEqual([
      { file: 'e2e/a.test.ts', test: 'a races', error: 'AssertionError: expected 1 to be 2', repetition: 2 },
      { file: 'e2e/b.test.ts', test: '(file)', error: 'Error: hook timed out', repetition: 2 },
    ]);
  });

  it('refuses a report that is not an object', () => {
    expect(() => failuresOfReport('x', 1, ROOT)).toThrow(/not an object/);
  });

  it('counts a failed vitest that reported no failing test', () => {
    expect(runFailureOf(1, 1, null, 0)).toEqual({ file: '(run)', test: '(vitest)', error: 'vitest ended with exit code 1 and reported no failing test', repetition: 1 });
    expect(runFailureOf(1, null, 'SIGKILL', 0)?.error).toMatch(/SIGKILL/);
    expect(runFailureOf(1, 1, null, 2)).toBeUndefined();
    expect(runFailureOf(1, 0, null, 0)).toBeUndefined();
  });

  it('prints one list grouped by test with the repetitions that failed, and the count', () => {
    const list = failureListOf(
      [
        { file: 'e2e/b.test.ts', test: 't', error: 'E2', repetition: 3 },
        { file: 'e2e/a.test.ts', test: 'u', error: 'E1', repetition: 1 },
        { file: 'e2e/b.test.ts', test: 't', error: 'E2b', repetition: 1 },
      ],
      3,
    );
    expect(list.split('\n')).toEqual(['LOAD_FAILURE e2e/a.test.ts | u | failed in 1 of 3 (repetition 1) | E1', 'LOAD_FAILURE e2e/b.test.ts | t | failed in 2 of 3 (repetition 1, 3) | E2', 'LOAD_FAILURES=2']);
    expect(failureListOf([], 3)).toBe('LOAD_FAILURES=0');
  });
});
