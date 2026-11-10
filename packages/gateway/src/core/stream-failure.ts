import type { ErrorType } from '@momonga/protocol';

export class StreamFailure extends Error {
  readonly code: string;
  readonly errorType: ErrorType;

  constructor(code: string, errorType: ErrorType, message: string) {
    super(message);
    this.name = 'StreamFailure';
    this.code = code;
    this.errorType = errorType;
  }
}
