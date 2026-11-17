import { configDefaults, defineConfig } from 'vitest/config';
import { DEFAULT_TEST_TIMEOUT_MS, E2E_HOOK_TIMEOUT_MS } from './e2e/support/vitest-timeouts.ts';
import { hostE2eFileWorkers } from './e2e/support/parallelism.ts';
import { hostTlcRowsAtOnce } from './test/formal/tlc-rows.ts';
import { RUN_CLASS_KEY } from './scripts/support/run-class.ts';
import { testReusePlan } from './test/support/test-reuse.ts';

const CALIBRATION_TESTS = 'packages/*/test/calibration/**/*.test.ts';

const REUSE = testReusePlan(import.meta.dirname, ['unit', 'calibration', 'packaging', 'e2e']);

const replayedIn = (project: string): readonly string[] => REUSE.replayed.get(project) ?? [];

const replaysAny = [...REUSE.replayed.values()].some((files) => files.length > 0);

export default defineConfig({
  test: {
    pool: 'forks',
    includeTaskLocation: true,
    reporters: ['default', './test/support/skip-ledger.ts', './test/support/reuse-reporter.ts'],
    passWithNoTests: replaysAny,
    teardownTimeout: E2E_HOOK_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          provide: { [RUN_CLASS_KEY]: 'heavy-when-whole' },
          setupFiles: ['test/support/reuse-recorder.ts', 'test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/required-tools.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/pinned-ripgrep.ts', 'test/support/leak-guard.ts', 'test/support/lock-proof.ts'],
          include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, CALIBRATION_TESTS, ...replayedIn('unit')],
          maxConcurrency: hostTlcRowsAtOnce(),
        },
      },
      {
        extends: true,
        test: {
          name: 'calibration',
          provide: { [RUN_CLASS_KEY]: 'heavy' },
          include: [CALIBRATION_TESTS],
          exclude: [...configDefaults.exclude, ...replayedIn('calibration')],
          setupFiles: ['test/support/reuse-recorder.ts', 'test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/required-tools.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/leak-guard.ts', 'test/support/lock-proof.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'packaging',
          provide: { [RUN_CLASS_KEY]: 'heavy' },
          include: ['scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...replayedIn('packaging')],
          setupFiles: ['test/support/reuse-recorder.ts', 'test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/required-tools.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/leak-guard.ts', 'e2e/support/run-setup.ts', 'test/support/lock-proof.ts'],
          fileParallelism: false,
          hookTimeout: E2E_HOOK_TIMEOUT_MS,
          testTimeout: DEFAULT_TEST_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          provide: { [RUN_CLASS_KEY]: 'heavy' },
          include: ['e2e/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...replayedIn('e2e')],
          setupFiles: ['test/support/reuse-recorder.ts', 'test/support/child-process-guard.ts', 'e2e/support/file-programs.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/required-tools.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/pinned-ripgrep.ts', 'e2e/global-setup.ts', 'test/support/lock-proof.ts'],
          maxWorkers: hostE2eFileWorkers(),
          sequence: { groupOrder: 1 },
          hookTimeout: E2E_HOOK_TIMEOUT_MS,
          testTimeout: DEFAULT_TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
