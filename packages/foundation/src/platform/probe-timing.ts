export type OperationSignal = { signal: AbortSignal; end(): void };

export const operationSignal = (given: AbortSignal | undefined): OperationSignal => {
  const own = new AbortController();
  return { signal: given === undefined ? own.signal : given, end: () => own.abort() };
};
