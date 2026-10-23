export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export const toConfigError = (error: unknown): ConfigError =>
  error instanceof ConfigError ? error : new ConfigError(error instanceof Error ? error.message : String(error), { cause: error });
