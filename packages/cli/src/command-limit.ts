import { HOST_READ_BOUND_MS, StoreCallEndedError, operationLimit } from '@momonga/foundation';

const COMMAND_LIMIT_LABEL = 'the command limit';
const AFTER_AN_UNFINISHED_STORE_CALL = 'run the command again';

export const commandStoreFailureOf = (error: unknown): unknown =>
  error instanceof StoreCallEndedError ? new StoreCallEndedError(error.call, error.limit, AFTER_AN_UNFINISHED_STORE_CALL) : error;

export const withinCommandLimit = async <T>(interrupt: AbortSignal, storePhase: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const limit = operationLimit(interrupt, HOST_READ_BOUND_MS, COMMAND_LIMIT_LABEL);
  try {
    return await storePhase(limit.signal);
  } catch (error) {
    throw commandStoreFailureOf(error);
  } finally {
    limit.dispose();
  }
};
