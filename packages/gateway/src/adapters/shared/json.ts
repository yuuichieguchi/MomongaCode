import { JsonDepthError, parseOutsideJson } from '@momonga/foundation';

export const MALFORMED_JSON = 'malformed_json';

export type MalformedJsonReason = 'syntax' | 'depth';

export class MalformedJsonError extends Error {
  readonly code = MALFORMED_JSON;
  readonly reason: MalformedJsonReason;

  constructor(reason: MalformedJsonReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MalformedJsonError';
    this.reason = reason;
  }
}

export const parseExternalJson = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw new MalformedJsonError('depth', error.message, { cause: error });
    if (error instanceof SyntaxError) throw new MalformedJsonError('syntax', 'it is not valid JSON', { cause: error });
    throw error;
  }
};
