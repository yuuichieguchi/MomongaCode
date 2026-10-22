import { globalErrorHandler } from '@opentelemetry/core';

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const reportError = (error: unknown): void => {
  globalErrorHandler(toError(error));
};

export { toError };
