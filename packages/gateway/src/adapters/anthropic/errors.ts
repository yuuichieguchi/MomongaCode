import { UpstreamHttpError, UpstreamProtocolError } from '../shared/failures.ts';
import { isRecord } from '@momonga/foundation';
import type { ErrorDetailReader } from '../shared/http-error.ts';

const STATUS_BY_ERROR_TYPE: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

export const anthropicErrorDetail: ErrorDetailReader = (parsed) => {
  const detail = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(detail)) return {};
  return {
    ...(typeof detail['message'] === 'string' ? { message: detail['message'] } : {}),
    ...(typeof detail['type'] === 'string' ? { code: detail['type'] } : {}),
  };
};

export const streamErrorOf = (errorType: string, message: string): UpstreamHttpError | UpstreamProtocolError => {
  const status = STATUS_BY_ERROR_TYPE[errorType];
  if (status === undefined) {
    return new UpstreamProtocolError(`the upstream sent an error event of the unknown type ${JSON.stringify(errorType)}: ${message}`);
  }
  return new UpstreamHttpError(status, errorType, message, undefined, false);
};
