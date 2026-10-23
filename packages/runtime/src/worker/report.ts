import { describeError } from './errors.ts';
import type { WorkerErrorContext, WorkerOptions } from './types.ts';

export const reportError = (options: WorkerOptions, error: unknown, context: WorkerErrorContext): string | undefined => {
  try {
    options.onError?.(error, context);
    return undefined;
  } catch (hookError) {
    return describeError(hookError);
  }
};
