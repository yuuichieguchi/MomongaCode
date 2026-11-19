import { planAccountRefOf } from '@momonga/protocol';
import type { AdapterContext, AdapterTarget, ClassifiedError, ErrorBody, HealthResult, PlanAccountRef, ProviderAdapter, ResponseError, StreamEvent } from '@momonga/protocol';
import { isRecord } from '@momonga/foundation';
import { describeError } from './describe-error.ts';
import { ClientDisconnectedError, GatewayError } from './errors.ts';
import { sealedEventOf } from './sealed-events.ts';
import type { Redactor } from './redaction.ts';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';
import { carryRequestIds } from './response-request-ids.ts';
import type { RequestIds } from './response-request-ids.ts';

const guardBrand: unique symbol = Symbol('guardedAdapter');

export type GuardedAdapter = ProviderAdapter & { readonly [guardBrand]: true };

export class GuardedAdapterError extends Error {
  readonly classified: ClassifiedError;

  constructor(classified: ClassifiedError) {
    super(classified.error.message);
    this.name = 'GuardedAdapterError';
    this.classified = classified;
  }
}

const UNNAMED_FAILURE_CODE = 'upstream_error';

const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PARAM_SHAPE = /^[A-Za-z0-9_.[\]:-]{1,128}$/;

type ShapedPlan = { plan?: PlanAccountRef };

const shapedPlan = (plan: unknown): ShapedPlan => {
  const shaped = planAccountRefOf(plan);
  return shaped === undefined ? {} : { plan: shaped };
};

const planUnchanged = (original: unknown, shaped: ShapedPlan): boolean =>
  shaped.plan === undefined ? original === undefined : isRecord(original) && Object.keys(original).length === Object.keys(shaped.plan).length;

export const redactedText = (redactor: Pick<Redactor, 'text'>, text: string): string => redactor.text(text);

export const redactedError = (redactor: Redactor, error: unknown): Error => {
  const redacted = new Error(redactor.text(describeError(error)));
  if (error instanceof Error) {
    redacted.name = error.name;
    if (error.stack !== undefined) redacted.stack = redactor.whole(error.stack);
  }
  return redacted;
};

const redactedOrNull = (redactor: Redactor, value: string | null): string | null => (value === null ? null : redactor.whole(value));

export const redactedGatewayError = (redactor: Redactor, error: GatewayError): GatewayError => {
  const message = redactor.whole(error.body.message);
  const code = redactedOrNull(redactor, error.body.code);
  const param = redactedOrNull(redactor, error.body.param);
  if (message === error.body.message && code === error.body.code && param === error.body.param) return error;
  return new GatewayError({ status: error.status, type: error.body.type, code, param, headers: { ...error.headers }, message, ...(error.body.plan === undefined ? {} : { plan: error.body.plan }), ...(error.body.measuring === undefined ? {} : { measuring: error.body.measuring }) });
};

export const redactedEvent = (redactor: Redactor, event: StreamEvent): StreamEvent => {
  if (event.type === 'error') {
    const message = redactor.whole(event.error.message);
    const code = redactedOrNull(redactor, event.error.code);
    const param = redactedOrNull(redactor, event.error.param);
    if (message === event.error.message && code === event.error.code && param === event.error.param) return event;
    return { ...event, error: { ...event.error, message, code, param } };
  }
  if (event.type !== 'response.failed') return event;
  const { error } = event.response;
  const message = redactor.whole(error.message);
  const code = redactor.whole(error.code);
  if (message === error.message && code === error.code) return event;
  return { ...event, response: { ...event.response, error: { ...error, message, code } } };
};

type ResponseRecord = { ctx: AdapterContext; requestIds: () => RequestIds };

const responseRecordOf = (ctx: AdapterContext): ResponseRecord => {
  let requestIds: RequestIds = {};
  return {
    ctx: {
      ...ctx,
      response: (found) => {
        requestIds = found;
      },
    },
    requestIds: () => requestIds,
  };
};

export const guardAdapter = (inner: ProviderAdapter, redactor: Redactor, reasoningOrigin: ReasoningOriginCodec): GuardedAdapter => {
  const shaped = (value: unknown, shape: RegExp): string | null =>
    typeof value === 'string' && shape.test(value) && redactor.text(value) === value ? value : null;

  const namedCode = (code: unknown): string => shaped(code, CODE_SHAPE) ?? UNNAMED_FAILURE_CODE;

  const guardedBody = (body: ErrorBody): ErrorBody => ({
    message: redactor.text(body.message),
    type: body.type,
    code: namedCode(body.code),
    param: shaped(body.param, PARAM_SHAPE),
    ...shapedPlan(body.plan),
  });

  const guardedClassified = (classified: ClassifiedError): ClassifiedError => ({ ...classified, error: guardedBody(classified.error) });

  const classify = (error: unknown): ClassifiedError =>
    error instanceof GuardedAdapterError ? error.classified : guardedClassified(inner.classify(error));

  const guardedGatewayError = (error: GatewayError): GatewayError => {
    const message = redactor.text(error.body.message);
    const code = namedCode(error.body.code);
    const param = shaped(error.body.param, PARAM_SHAPE);
    const plan = shapedPlan(error.body.plan);
    if (message === error.body.message && code === error.body.code && param === error.body.param && planUnchanged(error.body.plan, plan)) return error;
    return new GatewayError({ status: error.status, type: error.body.type, code, param, headers: { ...error.headers }, message, ...plan });
  };

  const guardedError = (error: unknown, requestIds: RequestIds = {}): unknown => {
    if (error instanceof ClientDisconnectedError || error instanceof GuardedAdapterError) return error;
    if (error instanceof GatewayError) return guardedGatewayError(error);
    carryRequestIds(error, requestIds);
    return new GuardedAdapterError(classify(error));
  };

  const redactedIds = (requestIds: RequestIds): Record<string, string> =>
    Object.fromEntries(Object.entries(requestIds).map(([name, id]) => [name, redactor.text(id)]));

  const guardedEvent = (event: StreamEvent, requestIds: RequestIds): StreamEvent => {
    if (event.type === 'error') return { ...event, error: guardedBody(event.error) };
    if (event.type !== 'response.failed') return event;
    const { error } = event.response;
    if (typeof error !== 'object' || error === null) return event;
    const guarded: ResponseError = {
      code: namedCode(error.code),
      ...(error.type === undefined ? {} : { type: error.type }),
      message: redactor.text(error.message),
      param: 'param' in error ? shaped(error.param, PARAM_SHAPE) : null,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(Object.keys(requestIds).length === 0 ? {} : { requestIds: redactedIds(requestIds) }),
      ...shapedPlan(error.plan),
    };
    return { ...event, response: { ...event.response, error: guarded } };
  };

  const converting = async <T>(step: () => Promise<T>, response?: ResponseRecord): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      throw guardedError(error, response?.requestIds());
    }
  };

  const convertingSync = <T>(step: () => T): T => {
    try {
      return step();
    } catch (error) {
      throw guardedError(error);
    }
  };

  const guardedIterator = (source: AsyncIterator<StreamEvent>, model: string, response: ResponseRecord): AsyncIterator<StreamEvent> => {
    const { return: sourceReturn, throw: sourceThrow } = source;
    return {
      next: async (...args) => {
        const result = await converting(() => source.next(...args), response);
        return result.done === true ? result : { done: false, value: sealedEventOf(reasoningOrigin, inner.kind, model, guardedEvent(result.value, response.requestIds())) };
      },
      return: async (value) =>
        sourceReturn === undefined ? { done: true, value } : converting(() => sourceReturn.call(source, value), response),
      ...(sourceThrow === undefined ? {} : { throw: (reason: unknown) => converting(() => sourceThrow.call(source, reason), response) }),
    };
  };

  const { countTokens, countWire, compact, renderWire, renderCompactWire, carryRefusalOf, health, roomFacts, close, servedAccount } = inner;

  const guardedHealth = (check: NonNullable<ProviderAdapter['health']>) => async (target: AdapterTarget): Promise<HealthResult> => {
    try {
      const result = await check.call(inner, target);
      return {
        ...result,
        ...(result.detail === undefined ? {} : { detail: redactor.text(result.detail) }),
        ...(result.remediation === undefined ? {} : { remediation: redactor.text(result.remediation) }),
      };
    } catch (error) {
      return { ok: false, reason: 'health_check_failed', detail: redactor.text(describeError(error)) };
    }
  };

  return {
    kind: inner.kind,
    sampling: inner.sampling,
    relaysClientBody: inner.relaysClientBody,
    capabilities: (target) => converting(() => inner.capabilities(target)),
    create: (request, ctx) => {
      const response = responseRecordOf(ctx);
      const source = convertingSync(() => inner.create(request, response.ctx));
      return { [Symbol.asyncIterator]: () => guardedIterator(convertingSync(() => source[Symbol.asyncIterator]()), ctx.target.model, response) };
    },
    classify,
    ...(countTokens === undefined ? {} : { countTokens: (request, ctx) => converting(() => countTokens.call(inner, request, ctx)) }),
    ...(countWire === undefined ? {} : { countWire: (wire, ctx) => converting(() => countWire.call(inner, wire, ctx)) }),
    ...(compact === undefined
      ? {}
      : {
          compact: (request, ctx) => {
            const response = responseRecordOf(ctx);
            return converting(() => compact.call(inner, request, response.ctx), response);
          },
        }),
    ...(renderWire === undefined ? {} : { renderWire: (request, target, options) => convertingSync(() => renderWire.call(inner, request, target, options)) }),
    ...(renderCompactWire === undefined
      ? {}
      : { renderCompactWire: (request, target, cap, origin, capabilities) => convertingSync(() => renderCompactWire.call(inner, request, target, cap, origin, capabilities)) }),
    toolChoiceWire: (capabilities, target) => inner.toolChoiceWire(capabilities, target),
    ...(carryRefusalOf === undefined
      ? {}
      : {
          carryRefusalOf: (request, target, capabilities, origin) => {
            const refused = convertingSync(() => carryRefusalOf.call(inner, request, target, capabilities, origin));
            return refused === undefined ? undefined : { ...refused, message: redactor.text(refused.message) };
          },
        }),
    ...(health === undefined ? {} : { health: guardedHealth(health) }),
    ...(roomFacts === undefined ? {} : { roomFacts: (target) => converting(() => roomFacts.call(inner, target)) }),
    ...(servedAccount === undefined ? {} : { servedAccount: (target: AdapterTarget) => planAccountRefOf(servedAccount.call(inner, target)) }),
    ...(close === undefined ? {} : { close: (stop) => close.call(inner, stop) }),
    [guardBrand]: true,
  };
};
