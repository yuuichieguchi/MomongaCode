import { Deadline } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';

const TIMER_CEILING_MS = 2_147_483_647;

export type DeadlineSignal = { readonly signal: AbortSignal; dispose(): void };

export const signalUntil = (timing: Timing, deadlineAt: number, parent: AbortSignal): DeadlineSignal => {
  const deadline = Deadline.after(Math.min(deadlineAt - timing.now(), TIMER_CEILING_MS), timing);
  return { signal: AbortSignal.any([parent, deadline.signal]), dispose: () => deadline.dispose() };
};
