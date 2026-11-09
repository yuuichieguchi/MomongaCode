export type WaitForOptions = { maxTurns?: number; description?: string };

const DEFAULT_MAX_TURNS = 200_000;

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const afterMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const waitFor = async (predicate: () => boolean | Promise<boolean>, options: WaitForOptions = {}): Promise<void> => {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  for (let count = 0; count < maxTurns; count += 1) {
    if (await predicate()) return;
    await turn();
  }
  if (await predicate()) return;
  throw new Error(`waitFor: condition not met after ${maxTurns} event-loop turns${options.description === undefined ? '' : `: ${options.description}`}`);
};
