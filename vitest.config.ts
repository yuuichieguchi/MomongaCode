import { defineConfig } from 'vitest/config';
import { E2E_HOOK_TIMEOUT_MS } from './e2e/support/wait.ts';

export default defineConfig({
  test: {
    pool: 'forks',
    teardownTimeout: E2E_HOOK_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          globalSetup: ['test/support/journal-thread-module.ts', 'test/support/pinned-ripgrep.ts', 'test/support/leak-guard.ts'],
          include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'packaging',
          include: ['scripts/**/*.test.ts'],
          globalSetup: ['test/support/journal-thread-module.ts', 'test/support/leak-guard.ts'],
          fileParallelism: false,
          hookTimeout: E2E_HOOK_TIMEOUT_MS,
          testTimeout: 60000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          globalSetup: ['test/support/journal-thread-module.ts', 'test/support/pinned-ripgrep.ts', 'e2e/global-setup.ts'],
          fileParallelism: false,
          hookTimeout: E2E_HOOK_TIMEOUT_MS,
          testTimeout: 60000,
        },
      },
    ],
  },
});
