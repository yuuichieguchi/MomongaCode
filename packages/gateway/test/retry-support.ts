import { driveFakeTime, textResponseEvents } from '@momonga/testkit';
import type { PendingTimer } from '@momonga/testkit';
import type { Harness } from './gateway-helpers.ts';
import { userInput } from './gateway-helpers.ts';

export const TOTAL_WAIT_MS = 84_000;
export const BASE_MS = 500;
export const MAX_MS = 8000;
export const BUDGET = { totalWaitMs: TOTAL_WAIT_MS, baseMs: BASE_MS, maxMs: MAX_MS };
export const BREAKER_OUT_OF_THE_WAY = { failureThreshold: 1000, openMs: 30_000 };
export const DEFERRED_HEADER = 'momonga-deferred';

export const capOf = (retryIndex: number): number => Math.min(MAX_MS, BASE_MS * 2 ** retryIndex);

export const request = { model: 'fast', input: userInput('hi') };

export const unavailable = (count: number, retryAfterMs?: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    failure: { status: 503, message: `down ${index + 1}`, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  }));

export const rateLimited = (count: number, retryAfterMs: number) =>
  Array.from({ length: count }, (_unused, index) => ({ failure: { status: 429, message: `slow down ${index + 1}`, retryAfterMs } }));

export const ok = (text: string, model = 'scripted-primary') => ({ events: textResponseEvents({ model, chunks: [text] }) });

export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

export const driveTimers = async (
  harness: Pick<Harness, 'timers' | 'clock'>,
  pending: readonly Promise<unknown>[],
  ignored: (timer: PendingTimer) => boolean = () => false,
  horizonMs: number = TOTAL_WAIT_MS,
): Promise<number[]> => {
  const settled = pending.map(() => false);
  pending.forEach((promise, index) => {
    const mark = (): void => {
      settled[index] = true;
    };
    void promise.then(mark, mark);
  });
  const unsettled = (): number => settled.filter((done) => !done).length;
  const considered = (timer: PendingTimer): boolean => !ignored(timer);
  const watched = (): PendingTimer[] => harness.timers.pending().filter(considered);
  const keyOf = (): string => watched().map((timer) => timer.id).join(',');
  const seen = new Set<number>();
  const delays: number[] = [];
  let lastKey = '';
  await driveFakeTime(harness.timers, {
    done: () => unsettled() === 0,
    horizonAt: harness.clock.now() + horizonMs,
    description: `every answer of ${pending.length} pending requests`,
    ready: () => watched().length >= unsettled() && keyOf() !== lastKey,
    considered,
    beforeAdvance: () => {
      for (const timer of watched()) {
        if (seen.has(timer.id)) continue;
        seen.add(timer.id);
        delays.push(timer.delayMs);
      }
      lastKey = keyOf();
    },
  });
  return delays;
};
