export const TEST_TOOL_LIMITS = {
  bash: { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, onTimeout: 'background', backgroundTimeoutMs: 1_800_000, maxBackgroundTimeoutMs: 7_200_000 },
  search: { timeoutMs: 60_000 },
  operations: { timeoutMs: 120_000 },
} as const;

export const TEST_BUILTIN_TOOL_OFFER = {
  sandbox: 'seatbelt',
  sandboxNetwork: 'ask',
  bash: { kind: 'resolved', path: '/bin/bash' },
} as const;
