export const abandoned = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const leave = (): void => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', leave);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
