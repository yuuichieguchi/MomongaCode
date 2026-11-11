import { configDefaults, defineConfig } from 'vitest/config';
import { DEFAULT_TEST_TIMEOUT_MS, E2E_HOOK_TIMEOUT_MS } from './e2e/support/wait.ts';
import { RUN_CLASS_KEY } from './scripts/support/run-class.ts';

const CALIBRATION_TESTS = 'packages/*/test/calibration/**/*.test.ts';

export default defineConfig({
  test: {
    pool: 'forks',
    teardownTimeout: E2E_HOOK_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          provide: { [RUN_CLASS_KEY]: 'heavy-when-whole' },
          setupFiles: ['test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/pinned-ripgrep.ts', 'test/support/leak-guard.ts'],
          include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, CALIBRATION_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'calibration',
          provide: { [RUN_CLASS_KEY]: 'heavy' },
          include: [CALIBRATION_TESTS],
          setupFiles: ['test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/leak-guard.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'packaging',
          include: ['scripts/**/*.test.ts'],
          setupFiles: ['test/support/child-process-guard.ts', 'test/support/temp-entry-recorder.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/leak-guard.ts'],
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
          setupFiles: ['test/support/child-process-guard.ts'],
          globalSetup: ['test/support/run-lock.ts', 'test/support/fake-secret-programs.ts', 'test/support/thread-modules.ts', 'test/support/pinned-ripgrep.ts', 'e2e/global-setup.ts'],
          fileParallelism: false,
          hookTimeout: E2E_HOOK_TIMEOUT_MS,
          testTimeout: DEFAULT_TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
