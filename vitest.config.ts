import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx', 'test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 60000,
        },
      },
    ],
  },
});
