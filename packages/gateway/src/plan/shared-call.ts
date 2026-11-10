export type SharedCall<T> = {
  readonly work: Promise<T>;
  join(signal: AbortSignal): Promise<T>;
};

const settledEitherWay = (): void => undefined;

export const startSharedCall = <T>(lifetime: AbortSignal, run: (signal: AbortSignal) => Promise<T>, abandoned: () => void): SharedCall<T> => {
  const controller = new AbortController();
  const endWithLifetime = (): void => controller.abort(lifetime.reason);
  if (lifetime.aborted) endWithLifetime();
  else lifetime.addEventListener('abort', endWithLifetime, { once: true });
  let waiters = 0;
  let settled = false;
  const work = run(controller.signal).finally(() => {
    settled = true;
    lifetime.removeEventListener('abort', endWithLifetime);
  });
  work.then(settledEitherWay, settledEitherWay);
  return {
    work,
    join: (signal) => {
      waiters += 1;
      return new Promise<T>((resolve, reject) => {
        const leave = (): void => {
          waiters -= 1;
          if (waiters === 0 && !settled && !controller.signal.aborted) {
            abandoned();
            controller.abort(signal.reason);
          }
          reject(signal.reason as Error);
        };
        if (signal.aborted) {
          leave();
          return;
        }
        signal.addEventListener('abort', leave, { once: true });
        work.then(
          (value) => {
            signal.removeEventListener('abort', leave);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', leave);
            reject(error as Error);
          },
        );
      });
    },
  };
};
