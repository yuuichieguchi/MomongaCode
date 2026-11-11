import type { ToolTimers } from './ports.ts';

export const cancellableTimer = (timers: ToolTimers, ms: number): { done: Promise<void>; cancel(): void } => {
  let handle: unknown;
  const done = new Promise<void>((resolve) => {
    handle = timers.setTimeout(resolve, ms);
  });
  return { done, cancel: () => timers.clearTimeout(handle) };
};
