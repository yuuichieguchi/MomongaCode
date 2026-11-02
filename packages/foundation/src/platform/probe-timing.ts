export const PS_PROBE_TIMEOUT_MS = 2000;

export const REAP_POLL_INTERVAL_MS = 25;

export type ProbeTiming = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const hostProbeTiming: ProbeTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
