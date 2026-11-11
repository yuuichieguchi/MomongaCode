import { GENERATION_RETIRED_CODE, createUdsClient, decodeSse, parseRetryAfter } from '@momonga/foundation';
import type { SocketResolver, UdsClient, UdsResponse } from '@momonga/foundation';
import {
  COMPACTION_RESULT_EVENT,
  DEFERRED_HEADER,
  ERROR_TYPES,
  QUOTE_ROUTE,
  ROLE_HEADER,
  RUN_ID_HEADER,
  STREAM_IDLE_HEADER,
  TARGET_ANSWERS,
  TARGET_PROBING,
  isProbingCapabilities,
  isToolCallingState,
  isUnavailableCapabilities,
  planAccountRefOf,
} from '@momonga/protocol';
import type {
  BilledCallsCursorView,
  BilledCallsPageView,
  Capabilities,
  CompactRequest,
  CompactResource,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  ErrorType,
  GatewayCostReportView,
  GatewayHealth,
  HeaderRole,
  ModelQuote,
  ModelView,
  ModelViews,
  MomongaModelRoles,
  PlanAccountRef,
  StreamEvent,
  TargetAnswers,
} from '@momonga/protocol';
import type { Clock, GatewayCallOptions, GatewayPort, TargetFacts } from './ports.ts';
import { systemTimers } from './service/timers.ts';
import type { ServiceTimers } from './service/timers.ts';

const MS_PER_SECOND = 1000;

export const MODEL_NOT_FOUND_CODE = 'model_not_found';

export type GatewayRequestErrorFields = {
  status: number;
  type: ErrorType | 'transport';
  code: string;
  message: string;
  param?: string;
  retryAfterMs?: number;
  provenNotSent?: boolean;
  deferred?: boolean;
  plan?: PlanAccountRef;
};

export class GatewayRequestError extends Error {
  readonly status: number;
  readonly type: ErrorType | 'transport';
  readonly code: string;
  readonly param?: string;
  readonly retryAfterMs?: number;
  readonly provenNotSent?: boolean;
  readonly deferred?: boolean;
  declare readonly plan?: PlanAccountRef;

  constructor(fields: GatewayRequestErrorFields) {
    super(fields.message);
    this.name = 'GatewayRequestError';
    this.status = fields.status;
    this.type = fields.type;
    this.code = fields.code;
    if (fields.param !== undefined) this.param = fields.param;
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
    if (fields.provenNotSent !== undefined) this.provenNotSent = fields.provenNotSent;
    if (fields.deferred !== undefined) this.deferred = fields.deferred;
    if (fields.plan !== undefined) this.plan = fields.plan;
  }
}

export class ModelUnlistedError extends GatewayRequestError {
  constructor(fields: GatewayRequestErrorFields) {
    super(fields);
    this.name = 'ModelUnlistedError';
  }
}

const SERVICE_UNAVAILABLE_STATUS = 503;

export const isTargetProbing = (error: GatewayRequestError): boolean => error.status === SERVICE_UNAVAILABLE_STATUS && error.code === TARGET_PROBING;
export const GATEWAY_UNAVAILABLE_CODE = 'gateway_unavailable';

export const isGenerationRetiredRefusal = (error: unknown): error is GatewayRequestError => error instanceof GatewayRequestError && error.code === GENERATION_RETIRED_CODE;

export const isGatewayNeverReached = (error: unknown): error is GatewayRequestError =>
  error instanceof GatewayRequestError && error.type === 'transport' && error.code === GATEWAY_UNAVAILABLE_CODE && error.provenNotSent === true;

export type GatewayClientOptions = {
  resolveSocket: SocketResolver;
  clock: Clock;
  timers?: ServiceTimers;
  version: string;
  unaryTimeoutMs?: number;
  cancelTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

export type ChainMemberBilling = { billing: string; provider?: string; upstream: string };

export type ListedChainMember = { model: string; counter: string; adapter: string; answers: TargetAnswers; upstream: string; capabilities: Record<string, unknown>; billing?: string; provider?: string };

export type ListedGatewayModel = ModelView & { id: string; capabilities: Record<string, unknown>; chain: ListedChainMember[] };

export type GatewayListing = { models: ListedGatewayModel[]; views: ModelViews; start: string | null; roles: MomongaModelRoles };

export type GatewayChainMember = { model: string; counter: string; capabilities: Capabilities; billed?: ChainMemberBilling };

export type GatewayModel = {
  id: string;
  capabilities: Capabilities;
  chain: GatewayChainMember[];
  targets: Record<string, TargetFacts>;
  roles: MomongaModelRoles;
  views: ModelViews;
};

export type GatewayClient = GatewayPort & {
  models(): Promise<ListedGatewayModel[]>;
  health(): Promise<GatewayHealth>;
  cost(runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean): Promise<{ report: GatewayCostReportView; text: string }>;
  billedCalls(runIds: readonly string[], cursor: BilledCallsCursorView, limit: number, includeRunless: boolean, signal: AbortSignal): Promise<BilledCallsPageView>;
  destroy(): Promise<void>;
};

type TimeoutCode = 'deadline_exceeded' | 'gateway_timeout' | 'stream_interrupted';

const DEFAULT_UNARY_TIMEOUT_MS = 5000;
const DEFAULT_CANCEL_TIMEOUT_MS = 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

const NEVER_SENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isStreamEvent = (value: unknown): value is StreamEvent => isRecord(value) && typeof value['type'] === 'string';

const isErrorType = (value: unknown): value is ErrorType => ERROR_TYPES.some((type) => type === value);

const errorCodeOf = (error: unknown): string | undefined => {
  if (!isRecord(error) && !(error instanceof Error)) return undefined;
  const record: Record<string, unknown> = error as unknown as Record<string, unknown>;
  if (typeof record['code'] === 'string') return record['code'];
  return record['cause'] === undefined ? undefined : errorCodeOf(record['cause']);
};

export const transportFailureOf = (error: unknown): GatewayRequestError | undefined => {
  const code = errorCodeOf(error);
  if (code === undefined) return undefined;
  if (NEVER_SENT_CODES.has(code)) return transportError(GATEWAY_UNAVAILABLE_CODE, 'the gateway socket is unavailable', true);
  return transportError(GATEWAY_UNAVAILABLE_CODE, 'the gateway connection was lost', false);
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const transportError = (code: string, message: string, provenNotSent?: boolean): GatewayRequestError =>
  new GatewayRequestError({ status: 0, type: 'transport', code, message, ...(provenNotSent === undefined ? {} : { provenNotSent }) });

const invalidResponse = (detail: string): GatewayRequestError => transportError('invalid_response', `the gateway sent a malformed reply: ${detail}`);

export const gatewayProtocolError = invalidResponse;

const isUnitsText = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

const quoteOfReply = (parsed: unknown): ModelQuote => {
  if (!isRecord(parsed) || typeof parsed['model'] !== 'string' || typeof parsed['priced'] !== 'boolean') throw invalidResponse('the quote reply has no model and no boolean "priced"');
  if (!parsed['priced']) return { model: parsed['model'], priced: false };
  const { inUnits, outUnits, priceVersions } = parsed;
  if (!isUnitsText(inUnits) || !isUnitsText(outUnits) || !Array.isArray(priceVersions) || !priceVersions.every((version): version is string => typeof version === 'string')) {
    throw invalidResponse('the quote reply of a priced model has no whole-number inUnits and outUnits and no priceVersions list');
  }
  return { model: parsed['model'], priced: true, inUnits, outUnits, priceVersions };
};

const sfString = (value: string): string => {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new TypeError('the idempotency key must be printable ASCII to be an sf-string');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
};

const errorFromBody = (response: UdsResponse, text: string, nowMs: number): GatewayRequestError => {
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'], nowMs);
  const retry = {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(response.headers[DEFERRED_HEADER] === 'true' ? { deferred: true } : {}),
  };
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
  const plan = planAccountRefOf(body['plan']);
  return new GatewayRequestError({
    status: response.status,
    type: body['type'],
    code: body['code'],
    message: body['message'],
    ...(typeof body['param'] === 'string' ? { param: body['param'] } : {}),
    ...retry,
    ...(plan === undefined ? {} : { plan }),
  });
};

const errorFromEvent = (event: Extract<StreamEvent, { type: 'error' }>): GatewayRequestError => {
  const { error } = event;
  if (event.status === undefined || !isRecord(error) || typeof error.message !== 'string' || typeof error.code !== 'string' || !isErrorType(error.type)) {
    throw invalidResponse('an error event does not carry a status, a typed error and a code');
  }
  const plan = planAccountRefOf(error.plan);
  return new GatewayRequestError({
    status: event.status,
    type: error.type,
    code: error.code,
    message: error.message,
    ...(typeof error.param === 'string' ? { param: error.param } : {}),
    ...(event.retry_after_ms === undefined ? {} : { retryAfterMs: event.retry_after_ms }),
    ...(event.deferred === true ? { deferred: true } : {}),
    ...(plan === undefined ? {} : { plan }),
  });
};

const holdsMalformedUnavailable = (capabilities: unknown): boolean => {
  if (!isRecord(capabilities)) return false;
  const toolCalling = capabilities['toolCalling'];
  return isRecord(toolCalling) && toolCalling['state'] === 'unavailable' && !isToolCallingState(toolCalling);
};

const MODEL_ROLE_NAMES = ['compaction', 'reflection', 'analysis'] as const;

const isAnswers = (value: unknown): value is TargetAnswers => (TARGET_ANSWERS as readonly unknown[]).includes(value);

const listedMemberOf = (member: unknown): ListedChainMember => {
  if (
    !isRecord(member) ||
    typeof member['model'] !== 'string' ||
    typeof member['counter'] !== 'string' ||
    typeof member['adapter'] !== 'string' ||
    typeof member['upstream'] !== 'string' ||
    !isAnswers(member['answers']) ||
    !isRecord(member['capabilities'])
  ) {
    throw invalidResponse('the model list holds an entry without its chain members and their counters');
  }
  return {
    model: member['model'],
    counter: member['counter'],
    adapter: member['adapter'],
    answers: member['answers'],
    upstream: member['upstream'],
    capabilities: member['capabilities'],
    ...(typeof member['billing'] === 'string' ? { billing: member['billing'] } : {}),
    ...(typeof member['provider'] === 'string' ? { provider: member['provider'] } : {}),
  };
};

const listedModelOf = (entry: unknown): ListedGatewayModel => {
  if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['provider'] !== 'string' || typeof entry['ownName'] !== 'string') {
    throw invalidResponse('the model list holds a malformed entry');
  }
  const defaultTag = entry['defaultTag'];
  if (defaultTag !== undefined && typeof defaultTag !== 'string') throw invalidResponse('the model list holds a malformed entry');
  const members = entry['chain'];
  if (!Array.isArray(members) || members.length === 0) throw invalidResponse('the model list holds an entry without its chain members and their counters');
  const chain = members.map(listedMemberOf);
  if (!isRecord(entry['capabilities'])) throw invalidResponse('the model list holds a malformed entry');
  if ([entry['capabilities'], ...chain.map((member) => member.capabilities)].some(holdsMalformedUnavailable)) {
    throw invalidResponse('the model list holds a malformed unavailable entry');
  }
  return {
    id: entry['id'],
    canon: entry['id'],
    provider: entry['provider'],
    ownName: entry['ownName'],
    ...(defaultTag === undefined ? {} : { defaultTag }),
    capabilities: entry['capabilities'],
    chain,
  };
};

const listedRolesOf = (value: unknown): MomongaModelRoles => {
  if (!isRecord(value)) throw invalidResponse('the model list has no roles object');
  const roles: MomongaModelRoles = {};
  for (const role of MODEL_ROLE_NAMES) {
    const model = value[role];
    if (model === undefined) continue;
    if (typeof model !== 'string') throw invalidResponse('the model list holds a malformed role');
    roles[role] = model;
  }
  return roles;
};

const viewOf = ({ canon, provider, ownName, defaultTag }: ModelView): ModelView => ({ canon, provider, ownName, ...(defaultTag === undefined ? {} : { defaultTag }) });

export const gatewayListingOf = (parsed: unknown): GatewayListing => {
  const data = isRecord(parsed) ? parsed['data'] : undefined;
  if (!isRecord(parsed) || !Array.isArray(data)) throw invalidResponse('the model list has no data array');
  const start = parsed['start'];
  if (start !== null && typeof start !== 'string') throw invalidResponse('the model list has no start model');
  const models = data.map(listedModelOf);
  return { models, views: models.map(viewOf), start, roles: listedRolesOf(parsed['roles']) };
};

const unlistedErrorOf = (capabilities: Record<string, unknown>): ModelUnlistedError | undefined => {
  const { toolCalling } = capabilities;
  if (!isToolCallingState(toolCalling)) return undefined;
  const listed = { toolCalling };
  if (isProbingCapabilities(listed)) {
    return new ModelUnlistedError({
      status: 503,
      type: 'server_error',
      code: TARGET_PROBING,
      message: listed.toolCalling.message,
      retryAfterMs: listed.toolCalling.retryAfterSeconds * MS_PER_SECOND,
    });
  }
  if (!isUnavailableCapabilities(listed)) return undefined;
  const { status, type, code, message, param } = listed.toolCalling;
  return new ModelUnlistedError({ status, type, code, message, ...(param === undefined ? {} : { param }) });
};

const listedModelIn = (listing: GatewayListing, model: string): ListedGatewayModel => {
  const found = listing.models.find((listed) => listed.id === model);
  if (found === undefined) {
    throw new GatewayRequestError({ status: 404, type: 'not_found', code: MODEL_NOT_FOUND_CODE, message: `the gateway does not list the model "${model}"`, param: 'model' });
  }
  return found;
};

export const gatewayModelIn = (listing: GatewayListing, model: string): GatewayModel => {
  const found = listedModelIn(listing, model);
  const unlisted = unlistedErrorOf(found.capabilities);
  if (unlisted !== undefined) throw unlisted;
  return {
    id: found.id,
    capabilities: found.capabilities as Capabilities,
    chain: found.chain
      .filter((member, index) => index === 0 || unlistedErrorOf(member.capabilities) === undefined)
      .map((member) => ({
        model: member.model,
        counter: member.counter,
        capabilities: member.capabilities as Capabilities,
        ...(member.billing === undefined ? {} : { billed: { billing: member.billing, upstream: member.upstream, ...(member.provider === undefined ? {} : { provider: member.provider }) } }),
      })),
    targets: Object.fromEntries(found.chain.map((member) => [member.model, { adapter: member.adapter, model: member.upstream, answers: member.answers }])),
    roles: listing.roles,
    views: listing.views,
  };
};

export const isModelNotFound = (error: unknown): error is GatewayRequestError => error instanceof GatewayRequestError && error.status === 404 && error.code === MODEL_NOT_FOUND_CODE;

export const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
  const { clock, version } = options;
  const timers = options.timers ?? systemTimers;
  const unaryTimeoutMs = options.unaryTimeoutMs ?? DEFAULT_UNARY_TIMEOUT_MS;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const uds: UdsClient = createUdsClient(options.resolveSocket, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
  let destroyed = false;

  const clientDestroyed = (): GatewayRequestError => transportError('client_destroyed', 'the gateway client was destroyed');

  const createGuard = (callerSignal: AbortSignal) => {
    const controller = new AbortController();
    let expired: GatewayRequestError | undefined;
    let timer: unknown;
    let deadlineTimer: unknown;
    const onCallerAbort = (): void => controller.abort();
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const disarm = (): void => {
      timers.clearTimeout(timer);
      timer = undefined;
    };
    const expire = (code: TimeoutCode, ms: number): void => {
      expired ??= transportError(code, `the gateway call timed out (${code}) after ${ms} ms`);
      controller.abort();
    };
    return {
      signal: controller.signal,
      armDeadline: (ms: number): void => {
        deadlineTimer = timers.setTimeout(() => expire('deadline_exceeded', ms), ms);
      },
      arm: (ms: number, code: TimeoutCode): void => {
        disarm();
        timer = timers.setTimeout(() => expire(code, ms), ms);
      },
      disarm,
      abort: (): void => controller.abort(),
      dispose: (): void => {
        disarm();
        timers.clearTimeout(deadlineTimer);
        callerSignal.removeEventListener('abort', onCallerAbort);
      },
      translate: (error: unknown, midStream = false): unknown => {
        if (error instanceof GatewayRequestError) return error;
        if (callerSignal.aborted) return callerSignal.reason;
        if (expired !== undefined) return expired;
        if (destroyed) return clientDestroyed();
        if (midStream) return transportError('stream_interrupted', `the gateway stream was interrupted: ${describeError(error)}`);
        return transportFailureOf(error) ?? error;
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

  const callHeaders = (call: { idempotencyKey: string; deadlineAt: number; traceparent?: string; runId?: string; role?: HeaderRole }): Record<string, string> => ({
    'idempotency-key': sfString(call.idempotencyKey),
    'momonga-deadline-ms': String(Math.max(1, call.deadlineAt - clock.now())),
    ...(call.traceparent === undefined ? {} : { traceparent: call.traceparent }),
    ...(call.runId === undefined ? {} : { [RUN_ID_HEADER]: call.runId }),
    ...(call.role === undefined ? {} : { [ROLE_HEADER]: call.role }),
  });

  const assertDeadlineOpen = (deadlineAt: number): void => {
    if (deadlineAt - clock.now() <= 0) throw transportError('deadline_exceeded', 'the run deadline has already passed');
  };

  const unaryBound = (): { ms: number; code: TimeoutCode } => ({ ms: unaryTimeoutMs, code: 'gateway_timeout' });

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

  const listModels = async (signal: AbortSignal): Promise<GatewayListing> =>
    gatewayListingOf(await unary({ method: 'GET', path: '/v1/momonga/models', headers: {} }, signal, unaryBound()));

  const modelOf = async (model: string, callOptions: { signal: AbortSignal }): Promise<GatewayModel> => gatewayModelIn(await listModels(callOptions.signal), model);

  const timedChunksOf = async function* (guard: Guard, response: UdsResponse): AsyncGenerator<Uint8Array> {
    const iterator = response.body[Symbol.asyncIterator]();
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

  const isEventStream = (response: UdsResponse): boolean => (response.headers['content-type'] ?? '').toLowerCase().startsWith('text/event-stream');

  const compactFromStream = async (guard: Guard, response: UdsResponse): Promise<CompactResource> => {
    let resource: CompactResource | undefined;
    for await (const frame of decodeSse(timedChunksOf(guard, response))) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        throw invalidResponse('a compact stream frame is not JSON');
      }
      if (frame.event === COMPACTION_RESULT_EVENT) {
        if (!isRecord(data)) throw invalidResponse('the compact reply is not an object');
        resource = data as CompactResource;
      } else if (isStreamEvent(data) && data.type === 'error' && data.status !== undefined) {
        throw errorFromEvent(data);
      }
    }
    if (resource === undefined) throw transportError('stream_interrupted', 'the gateway ended the compact stream without a result');
    return resource;
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
        headers: { ...callHeaders(call), [STREAM_IDLE_HEADER]: String(streamIdleTimeoutMs) },
        body: JSON.stringify(body),
      });
      guard.disarm();
      if (response.status >= 400) {
        guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
        throw errorFromBody(response, await response.text(), clock.now());
      }
      if (!isEventStream(response)) {
        throw transportError('unexpected_content_type', `expected text/event-stream but received "${response.headers['content-type'] ?? ''}"`);
      }
      for await (const frame of decodeSse(timedChunksOf(guard, response))) {
        let event: unknown;
        try {
          event = JSON.parse(frame.data);
        } catch {
          throw invalidResponse('a stream frame is not JSON');
        }
        if (!isStreamEvent(event)) throw invalidResponse('a stream event has no string type');
        if (event.type === 'error' && event.status !== undefined) throw errorFromEvent(event);
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
      const guard = createGuard(call.signal);
      try {
        guard.armDeadline(call.deadlineAt - clock.now());
        guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
        const response = await send(guard, {
          method: 'POST',
          path: '/v1/responses/compact',
          headers: { ...callHeaders(call), [STREAM_IDLE_HEADER]: String(streamIdleTimeoutMs) },
          body: JSON.stringify(request),
        });
        guard.disarm();
        if (response.status >= 400) {
          guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
          throw errorFromBody(response, await response.text(), clock.now());
        }
        if (isEventStream(response)) return await compactFromStream(guard, response);
        guard.arm(streamIdleTimeoutMs, 'stream_interrupted');
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw invalidResponse('the body is not JSON');
        }
        if (!isRecord(parsed)) throw invalidResponse('the compact reply is not an object');
        return parsed as CompactResource;
      } catch (error) {
        guard.abort();
        throw guard.translate(error);
      } finally {
        guard.dispose();
      }
    },

    countTokens: async (request: CountTokensRequest, callOptions: { signal: AbortSignal }): Promise<CountTokensResult> => {
      const parsed = await unary(
        { method: 'POST', path: '/v1/momonga/count_tokens', headers: {}, body: JSON.stringify(request) },
        callOptions.signal,
        unaryBound(),
      );
      if (!isRecord(parsed)) throw invalidResponse('the count_tokens reply is not an object');
      const shape = parsed['error_shape'];
      if (!isRecord(shape) || typeof shape['ratio'] !== 'number' || typeof shape['minimum'] !== 'number') {
        throw invalidResponse('the count_tokens reply has an error_shape without a numeric ratio and minimum');
      }
      return parsed as CountTokensResult;
    },

    model: modelOf,

    listing: (callOptions: { signal: AbortSignal }): Promise<GatewayListing> => listModels(callOptions.signal),

    capabilities: async (model: string, callOptions: { signal: AbortSignal; target?: string }): Promise<Capabilities> => {
      const listing = await listModels(callOptions.signal);
      if (callOptions.target === undefined) return gatewayModelIn(listing, model).capabilities;
      const own = listedModelIn(listing, model).chain.find((member) => member.model === callOptions.target);
      if (own === undefined) {
        throw new GatewayRequestError({ status: 404, type: 'not_found', code: 'invalid_target', message: `the gateway lists no model "${callOptions.target}" that the model "${model}" falls back to`, param: 'target' });
      }
      const unlisted = unlistedErrorOf(own.capabilities);
      if (unlisted !== undefined) throw unlisted;
      return own.capabilities as Capabilities;
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

    quote: async (model: string, callOptions: { signal: AbortSignal }): Promise<ModelQuote> => {
      const parsed = await unary({ method: 'POST', path: QUOTE_ROUTE, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }, callOptions.signal, unaryBound());
      return quoteOfReply(parsed);
    },

    models: async () => (await listModels(noSignal)).models,
    cost: async (runs, signal, includeRunless) => {
      const parsed = await unary({ method: 'POST', path: '/v1/momonga/cost', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs, includeRunless }) }, signal, unaryBound());
      if (!isRecord(parsed) || !isRecord(parsed['report']) || typeof parsed['text'] !== 'string') throw invalidResponse('the cost answer has no report and text');
      return { report: parsed['report'] as GatewayCostReportView, text: parsed['text'] };
    },

    billedCalls: async (runIds, cursor, limit, includeRunless, signal) => {
      const parsed = await unary({ method: 'POST', path: '/v1/momonga/cost/calls', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runIds, cursor, limit, includeRunless }) }, signal, unaryBound());
      if (!isRecord(parsed) || !Array.isArray(parsed['calls'])) throw invalidResponse('the billed calls answer has no calls list');
      return parsed as BilledCallsPageView;
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
