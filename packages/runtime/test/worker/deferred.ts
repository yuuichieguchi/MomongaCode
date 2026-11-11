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
