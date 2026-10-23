export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void; settled(): boolean };

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = (value) => {
      done = true;
      onResolve(value);
    };
    reject = (error) => {
      done = true;
      onReject(error);
    };
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject, settled: () => done };
};

export const within = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(handle);
  }
};

export const waitUntil = async (condition: () => boolean, ms: number, label: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};
