import type { ErrorBody, ErrorType } from '@momonga/protocol';

export type GatewayErrorInit = {
  status: number;
  type: ErrorType;
  code: string | null;
  message: string;
  param?: string | null;
  headers?: Record<string, string>;
};

export class GatewayError extends Error {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;

  constructor(init: GatewayErrorInit) {
    super(init.message);
    this.name = 'GatewayError';
    this.status = init.status;
    this.body = { message: init.message, type: init.type, param: init.param ?? null, code: init.code };
    this.headers = init.headers ?? {};
  }
}

export const STATUS_BY_TYPE: Record<ErrorType, number> = {
  invalid_request: 400,
  not_found: 404,
  too_many_requests: 429,
  server_error: 502,
  model_error: 502,
};

const STATUS_BY_CODE: Record<string, number> = {
  deadline_exceeded: 504,
  gateway_closed: 503,
};

export const statusFor = (type: ErrorType, code: string | null): number =>
  (code === null ? undefined : STATUS_BY_CODE[code]) ?? STATUS_BY_TYPE[type];

export const gatewayErrorFromBody = (body: ErrorBody, headers: Record<string, string> = {}): GatewayError =>
  new GatewayError({
    status: statusFor(body.type, body.code),
    type: body.type,
    code: body.code,
    message: body.message,
    param: body.param,
    headers,
  });

export const invalidRequest = (code: string, message: string, param: string | null = null, status = 400): GatewayError =>
  new GatewayError({ status, type: 'invalid_request', code, message, param });

export const notFound = (code: string, message: string, param: string | null = null): GatewayError =>
  new GatewayError({ status: 404, type: 'not_found', code, message, param });

export const serverError = (status: number, code: string, message: string): GatewayError =>
  new GatewayError({ status, type: 'server_error', code, message });

export const gatewayClosedError = (): GatewayError => serverError(503, 'gateway_closed', 'the gateway is shutting down');

export const deadlineExceededError = (detail: string): GatewayError => serverError(504, 'deadline_exceeded', detail);

export const idempotencyInProgressError = (key: string): GatewayError =>
  new GatewayError({
    status: 409,
    type: 'invalid_request',
    code: 'idempotency_key_in_progress',
    message: `idempotency key "${key}" belongs to a request that is still running and can no longer be joined`,
  });

export const readerStalledError = (): GatewayError =>
  serverError(503, 'reader_stalled', 'this reader stopped consuming the shared response stream and was dropped');

export class ClientDisconnectedError extends Error {
  constructor() {
    super('the client disconnected before the response completed');
    this.name = 'ClientDisconnectedError';
  }
}
