import { createUdsClient, decodeSse, parseRetryAfter } from '@momonga/foundation';
import type { UdsClient, UdsResponse } from '@momonga/foundation';
import { ERROR_TYPES } from '@momonga/protocol';
import type { CostReportView } from '@momonga/protocol';
import type {
  Capabilities,
  CompactRequest,
  CompactResource,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  ErrorType,
  GatewayHealth,
  StreamEvent,
} from '@momonga/protocol';
import type { Clock, GatewayCallOptions, GatewayPort } from './ports.ts';

export type GatewayRequestErrorFields = {
  status: number;
  type: ErrorType | 'transport';
  code: string;
  message: string;
  param?: string;
  retryAfterMs?: number;
  provenNotSent?: boolean;
};

export class GatewayRequestError extends Error {
  readonly status: number;
  readonly type: ErrorType | 'transport';
  readonly code: string;
  readonly param?: string;
  readonly retryAfterMs?: number;
  readonly provenNotSent?: boolean;

  constructor(fields: GatewayRequestErrorFields) {
    super(fields.message);
    this.name = 'GatewayRequestError';
    this.status = fields.status;
    this.type = fields.type;
    this.code = fields.code;
    if (fields.param !== undefined) this.param = fields.param;
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
    if (fields.provenNotSent !== undefined) this.provenNotSent = fields.provenNotSent;
  }
}

export type GatewayClientOptions = {
  socketPath: string;
  clock: Clock;
  version: string;
  unaryTimeoutMs?: number;
  cancelTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

export type GatewayModel = { id: string; capabilities: Capabilities };

export type GatewayClient = GatewayPort & {
  models(): Promise<GatewayModel[]>;
  health(): Promise<GatewayHealth>;
  cost(runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal): Promise<{ report: CostReportView; text: string }>;
  destroy(): Promise<void>;
};

type TimeoutCode = 'deadline_exceeded' | 'gateway_timeout' | 'stream_interrupted';

const DEFAULT_UNARY_TIMEOUT_MS = 5000;
const DEFAULT_CANCEL_TIMEOUT_MS = 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

const NEVER_SENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isStreamEvent = (value: unknown): value is StreamEvent => isRecord(value) && typeof value['type'] === 'string';

const isErrorType = (value: unknown): value is ErrorType => ERROR_TYPES.some((type) => type === value);

const errorCodeOf = (error: unknown): string | undefined => {
  if (!isRecord(error) && !(error instanceof Error)) return undefined;
  const record: Record<string, unknown> = error as unknown as Record<string, unknown>;
  if (typeof record['code'] === 'string') return record['code'];
  return record['cause'] === undefined ? undefined : errorCodeOf(record['cause']);
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const transportError = (code: string, message: string, provenNotSent?: boolean): GatewayRequestError =>
  new GatewayRequestError({ status: 0, type: 'transport', code, message, ...(provenNotSent === undefined ? {} : { provenNotSent }) });

const invalidResponse = (detail: string): GatewayRequestError => transportError('invalid_response', `the gateway sent a malformed reply: ${detail}`);

const sfString = (value: string): string => {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new TypeError('the idempotency key must be printable ASCII to be an sf-string');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
};

const errorFromBody = (response: UdsResponse, text: string, nowMs: number): GatewayRequestError => {
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'], nowMs);
  const retry = retryAfterMs === undefined ? {} : { retryAfterMs };
  const fallback = (): GatewayRequestError =>
    new GatewayRequestError({
      status: response.status,
      type: response.status >= 500 ? 'server_error' : 'invalid_request',
      code: `http_${response.status}`,
      message: `the gateway answered HTTP ${response.status}`,
      ...retry,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback();
  }
  const body = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(body) || typeof body['message'] !== 'string' || typeof body['code'] !== 'string' || !isErrorType(body['type'])) return fallback();
  return new GatewayRequestError({
    status: response.status,
    type: body['type'],
    code: body['code'],
    message: body['message'],
    ...(typeof body['param'] === 'string' ? { param: body['param'] } : {}),
    ...retry,
  });
};

export const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
  const { clock, version } = options;
  const unaryTimeoutMs = options.unaryTimeoutMs ?? DEFAULT_UNARY_TIMEOUT_MS;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const uds: UdsClient = createUdsClient(options.socketPath, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
  let destroyed = false;

  const clientDestroyed = (): GatewayRequestError => transportError('client_destroyed', 'the gateway client was destroyed');

  const createGuard = (callerSignal: AbortSignal) => {
    const controller = new AbortController();
    let expired: GatewayRequestError | undefined;
    let timer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const onCallerAbort = (): void => controller.abort();
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const disarm = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };
    const expire = (code: TimeoutCode, ms: number): void => {
      expired ??= transportError(code, `the gateway call timed out (${code}) after ${ms} ms`);
      controller.abort();
    };
    return {
      signal: controller.signal,
      armDeadline: (ms: number): void => {
        deadlineTimer = setTimeout(() => expire('deadline_exceeded', ms), ms);
      },
      arm: (ms: number, code: TimeoutCode): void => {
        disarm();
        timer = setTimeout(() => expire(code, ms), ms);
      },
      disarm,
      abort: (): void => controller.abort(),
      dispose: (): void => {
        disarm();
        clearTimeout(deadlineTimer);
        callerSignal.removeEventListener('abort', onCallerAbort);
      },
      translate: (error: unknown, midStream = false): unknown => {
        if (error instanceof GatewayRequestError) return error;
        if (callerSignal.aborted) return callerSignal.reason;
        if (expired !== undefined) return expired;
        if (destroyed) return clientDestroyed();
        if (midStream) return transportError('stream_interrupted', `the gateway stream was interrupted: ${describeError(error)}`);
        const code = errorCodeOf(error);
        if (code !== undefined && NEVER_SENT_CODES.has(code)) return transportError('gateway_unavailable', 'the gateway socket is unavailable', true);
        if (code !== undefined && CONNECTION_LOST_CODES.has(code)) return transportError('gateway_unavailable', 'the gateway connection was lost', false);
        return error;
      },
    };
  };

  type Guard = ReturnType<typeof createGuard>;

  const send = (
    guard: Guard,
    spec: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string },
  ): Promise<UdsResponse> => {
    if (destroyed) throw clientDestroyed();
    return uds.request({
      method: spec.method,
      path: spec.path,
      headers: { 'user-agent': `momonga-runtime/${version}`, ...spec.headers, ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(spec.body === undefined ? {} : { body: spec.body }),
      signal: guard.signal,
    });
  };

  const callHeaders = (call: { idempotencyKey: string; deadlineAt: number; traceparent?: string }): Record<string, string> => ({
    'idempotency-key': sfString(call.idempotencyKey),
    'momonga-deadline-ms': String(Math.max(1, call.deadlineAt - clock.now())),
    ...(call.traceparent === undefined ? {} : { traceparent: call.traceparent }),
  });

  const assertDeadlineOpen = (deadlineAt: number): void => {
    if (deadlineAt - clock.now() <= 0) throw transportError('deadline_exceeded', 'the run deadline has already passed');
  };

  const unaryBound = (deadlineAt?: number): { ms: number; code: TimeoutCode } => {
    if (deadlineAt === undefined) return { ms: unaryTimeoutMs, code: 'gateway_timeout' };
    const remaining = deadlineAt - clock.now();
    return remaining <= unaryTimeoutMs ? { ms: remaining, code: 'deadline_exceeded' } : { ms: unaryTimeoutMs, code: 'gateway_timeout' };
  };

  const unary = async (
    spec: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string },
    signal: AbortSignal,
    bound: { ms: number; code: TimeoutCode },
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const guard = createGuard(signal);
    try {
      guard.arm(bound.ms, bound.code);
      const response = await send(guard, spec);
      if (response.status >= 400) throw errorFromBody(response, await response.text(), clock.now());
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw invalidResponse('the body is not JSON');
      }
    } catch (error) {
      throw guard.translate(error);
    } finally {
      guard.dispose();
    }
  };

  const noSignal = new AbortController().signal;

  const listModels = async (signal: AbortSignal): Promise<GatewayModel[]> => {
    const parsed = await unary({ method: 'GET', path: '/v1/momonga/models', headers: {} }, signal, unaryBound());
    const data = isRecord(parsed) ? parsed['data'] : undefined;
    if (!Array.isArray(data)) throw invalidResponse('the model list has no data array');
    return data.map((entry: unknown): GatewayModel => {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || !isRecord(entry['capabilities'])) {
        throw invalidResponse('the model list holds a malformed entry');
      }
      return { id: entry['id'], capabilities: entry['capabilities'] as Capabilities };
    });
  };

  async function* stream(body: CreateResponseBody, call: GatewayCallOptions): AsyncGenerator<StreamEvent> {
    call.signal.throwIfAborted();
    assertDeadlineOpen(call.deadlineAt);
    const guard = createGuard(call.signal);
    let finished = false;
    try {
      guard.armDeadline(call.deadlineAt - clock.now());
      guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
      const response = await send(guard, {
        method: 'POST',
        path: '/v1/responses',
        headers: callHeaders(call),
        body: JSON.stringify(body),
      });
      guard.disarm();
      if (response.status >= 400) {
        guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
        throw errorFromBody(response, await response.text(), clock.now());
      }
      const contentType = response.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('text/event-stream')) {
        throw transportError('unexpected_content_type', `expected text/event-stream but received "${contentType}"`);
      }
      const iterator = response.body[Symbol.asyncIterator]();
      const timedChunks = async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
          let step: IteratorResult<Uint8Array>;
          try {
            step = await iterator.next();
          } catch (error) {
            throw guard.translate(error, true);
          }
          guard.disarm();
          if (step.done === true) return;
          yield step.value;
        }
      };
      for await (const frame of decodeSse(timedChunks())) {
        let event: unknown;
        try {
          event = JSON.parse(frame.data);
        } catch {
          throw invalidResponse('a stream frame is not JSON');
        }
        if (!isStreamEvent(event)) throw invalidResponse('a stream event has no string type');
        yield event;
      }
      if (call.signal.aborted) throw call.signal.reason;
      finished = true;
    } catch (error) {
      throw guard.translate(error);
    } finally {
      if (!finished) guard.abort();
      guard.dispose();
    }
  }

  return {
    stream,

    compact: async (request: CompactRequest, call: GatewayCallOptions): Promise<CompactResource> => {
      call.signal.throwIfAborted();
      assertDeadlineOpen(call.deadlineAt);
      const parsed = await unary(
        { method: 'POST', path: '/v1/responses/compact', headers: callHeaders(call), body: JSON.stringify(request) },
        call.signal,
        unaryBound(call.deadlineAt),
      );
      if (!isRecord(parsed)) throw invalidResponse('the compact reply is not an object');
      return parsed as CompactResource;
    },

    countTokens: async (request: CountTokensRequest, callOptions: { signal: AbortSignal }): Promise<CountTokensResult> => {
      const parsed = await unary(
        { method: 'POST', path: '/v1/momonga/count_tokens', headers: {}, body: JSON.stringify(request) },
        callOptions.signal,
        unaryBound(),
      );
      if (!isRecord(parsed)) throw invalidResponse('the count_tokens reply is not an object');
      return parsed as CountTokensResult;
    },

    capabilities: async (alias: string, callOptions: { signal: AbortSignal }): Promise<Capabilities> => {
      const found = (await listModels(callOptions.signal)).find((model) => model.id === alias);
      if (found === undefined) {
        throw new GatewayRequestError({ status: 404, type: 'not_found', code: 'model_not_found', message: `the gateway does not list the model "${alias}"`, param: 'model' });
      }
      return found.capabilities;
    },

    cancel: async (idempotencyKey: string, callOptions: { signal: AbortSignal }): Promise<boolean> => {
      const parsed = await unary(
        { method: 'POST', path: '/v1/momonga/responses/cancel', headers: { 'idempotency-key': sfString(idempotencyKey) } },
        callOptions.signal,
        { ms: cancelTimeoutMs, code: 'gateway_timeout' },
      );
      if (!isRecord(parsed) || typeof parsed['cancelled'] !== 'boolean') throw invalidResponse('the cancel reply has no boolean "cancelled"');
      return parsed['cancelled'];
    },

    models: () => listModels(noSignal),
    cost: async (runs, signal) => {
      const parsed = await unary({ method: 'POST', path: '/v1/momonga/cost', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs }) }, signal, unaryBound());
      if (!isRecord(parsed) || !isRecord(parsed['report']) || typeof parsed['text'] !== 'string') throw invalidResponse('the cost answer has no report and text');
      return { report: parsed['report'] as CostReportView, text: parsed['text'] };
    },

    health: async (): Promise<GatewayHealth> => {
      const parsed = await unary({ method: 'GET', path: '/v1/momonga/health', headers: {} }, noSignal, unaryBound());
      if (!isRecord(parsed)) throw invalidResponse('the health reply is not an object');
      return parsed as GatewayHealth;
    },

    destroy: () => {
      destroyed = true;
      return uds.destroy();
    },
  };
};
