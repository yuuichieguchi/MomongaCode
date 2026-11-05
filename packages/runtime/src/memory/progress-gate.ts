export type ProgressGateOptions = { now(): number; intervalMs: number; post(): void };

export type ProgressGate = { unit(): void };

export const createProgressGate = ({ now, intervalMs, post }: ProgressGateOptions): ProgressGate => {
  let lastPostAt = now();
  return {
    unit: () => {
      const current = now();
      if (current - lastPostAt < intervalMs) return;
      lastPostAt = current;
      post();
    },
  };
};
