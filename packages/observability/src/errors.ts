import { globalErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const reportError = (error: unknown): void => {
  globalErrorHandler(toError(error));
};

export const installOtelErrorHandler = (onError: (error: Error) => void): void => {
  setGlobalErrorHandler((error) => onError(toError(error)));
};

export { toError };
