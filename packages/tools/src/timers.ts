export const cancellableTimer = (ms: number): { done: Promise<void>; cancel(): void } => {
  let handle: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
};
