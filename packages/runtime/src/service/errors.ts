import { MOVED_CODE } from '@momonga/foundation';
import { TARGET_NOT_READY } from '@momonga/protocol';

export type ApiErrorInit = {
  status: number;
  type: string;
  code: string;
  message: string;
  param?: string;
  headers?: Record<string, string>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | undefined;
  readonly headers: Record<string, string>;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.headers = init.headers ?? {};
  }
}

export const invalidRequest = (message: string, param?: string): ApiError =>
  new ApiError({ status: 400, type: 'invalid_request', code: 'invalid_request', message, ...(param === undefined ? {} : { param }) });

export const modeNotAllowed = (message: string): ApiError =>
  new ApiError({ status: 403, type: 'forbidden', code: 'mode_not_allowed', message });

export const notFound = (message: string): ApiError => new ApiError({ status: 404, type: 'not_found', code: 'not_found', message });

export const methodNotAllowed = (allowed: readonly string[]): ApiError =>
  new ApiError({
    status: 405,
    type: 'invalid_request',
    code: 'method_not_allowed',
    message: `this route only accepts ${allowed.join(', ')}`,
    headers: { allow: allowed.join(', ') },
  });

export const conflict = (
  code: 'approval_not_pending' | 'child_session' | 'duplicate_charge' | 'guideline_conflict' | 'memory_state' | 'mode_unavailable' | 'run_cancelled' | 'skill_target' | 'value_unknown',
  message: string,
): ApiError =>
  new ApiError({ status: 409, type: 'conflict', code, message });

export const targetNotReady = (message: string): ApiError => new ApiError({ status: 409, type: 'conflict', code: TARGET_NOT_READY, message });

export const bodyTooLarge = (maxBytes: number): ApiError =>
  new ApiError({ status: 413, type: 'invalid_request', code: 'body_too_large', message: `the request body exceeds the limit of ${maxBytes} bytes` });

export const unsupportedMediaType = (accepted: readonly string[]): ApiError =>
  new ApiError({
    status: 415,
    type: 'invalid_request',
    code: 'unsupported_media_type',
    message: `the content type must be ${accepted.join(' or ')}`,
  });

export const idempotencyKeyReused = (): ApiError =>
  new ApiError({
    status: 422,
    type: 'invalid_request',
    code: 'idempotency_key_reused',
    message: 'the Idempotency-Key was already used with a different request body',
  });

export const serviceUnavailable = (code: 'draining' | 'gateway_unavailable', message: string): ApiError =>
  new ApiError({ status: 503, type: 'server_error', code, message, headers: { 'retry-after': '1' } });

export const gatewayAnswer = (answer: { status: number; type: string; code: string; message: string }): ApiError => new ApiError(answer);
export const MOVED_MESSAGE = 'This daemon has been replaced by a newer version and accepts no new work. The request was not run; send it again.';

export const moved = (): ApiError => new ApiError({ status: 503, type: 'server_error', code: MOVED_CODE, message: MOVED_MESSAGE, headers: { 'retry-after': '1' } });

export const contributionUnavailable = (message: string): ApiError =>
  new ApiError({ status: 503, type: 'server_error', code: 'contribution_unavailable', message, headers: { 'retry-after': '1' } });

export const unknownSkill = (message: string): ApiError =>
  new ApiError({ status: 422, type: 'invalid_request', code: 'unknown_skill', message, param: 'skill' });

export const skillUnavailable = (message: string): ApiError =>
  new ApiError({ status: 422, type: 'invalid_request', code: 'skill_unavailable', message, param: 'skill' });

export const imageInputUnsupported = (alias: string): ApiError =>
  new ApiError({
    status: 422,
    type: 'invalid_request',
    code: 'image_input_unsupported',
    message: `the model alias ${alias} does not declare image input`,
    param: 'images',
  });

export const configError = (message: string, param?: string): ApiError =>
  new ApiError({ status: 422, type: 'invalid_request', code: 'config_error', message, ...(param === undefined ? {} : { param }) });

export const errorResponse = (error: ApiError): Response =>
  new Response(
    JSON.stringify({
      error: { type: error.type, code: error.code, message: error.message, ...(error.param === undefined ? {} : { param: error.param }) },
    }),
    { status: error.status, headers: { 'content-type': 'application/json', ...error.headers } },
  );

export const internalErrorResponse = (): Response =>
  new Response(JSON.stringify({ error: { type: 'internal_error', code: 'internal_error', message: 'the service failed to handle the request' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
