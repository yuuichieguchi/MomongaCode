import type { ErrorType } from '@momonga/protocol';

export class StreamFailure extends Error {
  readonly code: string;
  readonly errorType: ErrorType;
  readonly requestIds: Readonly<Record<string, string>>;

  constructor(code: string, errorType: ErrorType, message: string, requestIds: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'StreamFailure';
    this.code = code;
    this.errorType = errorType;
    this.requestIds = requestIds;
  }
}
