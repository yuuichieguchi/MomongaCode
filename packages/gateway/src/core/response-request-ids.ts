export type RequestIds = Readonly<Record<string, string>>;

const carried = new WeakMap<object, RequestIds>();

export const carryRequestIds = (error: unknown, requestIds: RequestIds): void => {
  if (typeof error !== 'object' || error === null || Object.keys(requestIds).length === 0) return;
  carried.set(error, requestIds);
};

export const requestIdsCarriedBy = (error: unknown): RequestIds => (typeof error === 'object' && error !== null ? (carried.get(error) ?? {}) : {});
