export class LeaseLostError extends Error {
  constructor() {
    super('the run lease was lost');
    this.name = 'LeaseLostError';
  }
}

export class GatewayFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayFailureError';
  }
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ShutdownError extends Error {
  constructor() {
    super('the worker is shutting down');
    this.name = 'ShutdownError';
  }
}
