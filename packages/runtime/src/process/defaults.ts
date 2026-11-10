export const RUNTIME_DEFAULTS: {
  runTimeoutMs: number;
  limits: { maxSteps: number; maxTotalTokens: number; approvalTtlMs: number; loopThreshold: number };
} = {
  runTimeoutMs: 6 * 3_600_000,
  limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 30 * 60_000, loopThreshold: 3 },
};
