import { isTransientErrno } from '@momonga/foundation';

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export const rethrowIfTransient = (error: unknown): void => {
  if (isTransientErrno(error)) throw error;
};

export const toConfigError = (error: unknown): ConfigError => {
  if (error instanceof ConfigError) return error;
  return new ConfigError(error instanceof Error ? error.message : String(error), { cause: error });
};
