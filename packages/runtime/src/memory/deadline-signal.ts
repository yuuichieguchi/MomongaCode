const TIMER_CEILING_MS = 2_147_483_647;

export const signalUntil = (deadlineAt: number, now: number, parent: AbortSignal): AbortSignal =>
  AbortSignal.any([parent, AbortSignal.timeout(Math.min(Math.max(deadlineAt - now, 0), TIMER_CEILING_MS))]);
