export const PAUSE_BUDGET_MS = 100;

const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;

export const LARGE_RUN_SETUP_TEST_TIMEOUT_MS = 24 * VITEST_DEFAULT_TEST_TIMEOUT_MS;

export const threadCpuMillisOf = async <T>(work: () => T | Promise<T>): Promise<{ value: T; millis: number }> => {
  const before = process.threadCpuUsage();
  const value = await work();
  const used = process.threadCpuUsage(before);
  return { value, millis: (used.user + used.system) / 1000 };
};
