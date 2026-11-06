import { systemTiming } from '../system-timing.ts';

export const REAP_POLL_INTERVAL_MS = 25;

export type ProbeTiming = {
  now(): number;
  sleep(ms: number): Promise<void>;
  unrefSleep?(ms: number): Promise<void>;
};

export const hostProbeTiming: ProbeTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  unrefSleep: (ms) =>
    new Promise((resolve) => {
      systemTiming.setTimeout(resolve, ms);
    }),
};

export const deadlineSignal = (timing: Pick<ProbeTiming, 'sleep' | 'unrefSleep'>, ms: number): AbortSignal => {
  const controller = new AbortController();
  const wait = timing.unrefSleep ?? timing.sleep;
  void wait.call(timing, ms).then(() => controller.abort(new Error(`the deadline of ${ms} ms passed`)));
  return controller.signal;
};

export type OperationSignal = { signal: AbortSignal; end(): void };

export const operationSignal = (given: AbortSignal | undefined): OperationSignal => {
  const own = new AbortController();
  return { signal: given === undefined ? own.signal : given, end: () => own.abort() };
};
