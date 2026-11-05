import type { AdapterTarget, ClassifiedError, ErrorBody, HealthResult, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError } from './errors.ts';
import type { Redactor } from './redaction.ts';

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
const upstreamCodes = new WeakMap<object, string>();

export const upstreamCodeOf = (event: StreamEvent & { type: 'response.failed' }): string => upstreamCodes.get(event) ?? event.response.error.code;

const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PARAM_SHAPE = /^[A-Za-z0-9_.[\]:-]{1,128}$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const guardAdapter = (inner: ProviderAdapter, redactor: Redactor): GuardedAdapter => {
  const shaped = (value: unknown, shape: RegExp): string | null =>
    typeof value === 'string' && shape.test(value) && redactor.text(value) === value ? value : null;

  const guardedBody = (body: ErrorBody): ErrorBody => ({
    message: redactor.text(body.message),
    type: body.type,
    code: shaped(body.code, CODE_SHAPE),
    param: shaped(body.param, PARAM_SHAPE),
  });

  const guardedClassified = (classified: ClassifiedError): ClassifiedError => ({ ...classified, error: guardedBody(classified.error) });

  const classify = (error: unknown): ClassifiedError =>
    error instanceof GuardedAdapterError ? error.classified : guardedClassified(inner.classify(error));

  const guardedGatewayError = (error: GatewayError): GatewayError => {
    const message = redactor.text(error.body.message);
    const code = shaped(error.body.code, CODE_SHAPE);
    const param = shaped(error.body.param, PARAM_SHAPE);
    if (message === error.body.message && code === error.body.code && param === error.body.param) return error;
    return new GatewayError({ status: error.status, type: error.body.type, code, param, headers: { ...error.headers }, message });
  };

  const guardedError = (error: unknown): unknown => {
    if (error instanceof ClientDisconnectedError || error instanceof GuardedAdapterError) return error;
    if (error instanceof GatewayError) return guardedGatewayError(error);
    return new GuardedAdapterError(classify(error));
  };

  const guardedEvent = (event: StreamEvent): StreamEvent => {
    if (event.type === 'error') return { ...event, error: { ...guardedBody(event.error), code: guardedBody(event.error).code ?? UNNAMED_FAILURE_CODE } };
    if (event.type !== 'response.failed') return event;
    const { error } = event.response;
    if (typeof error !== 'object' || error === null) return event;
    const rebuilt = {
      ...event,
      response: {
        ...event.response,
        error: {
          code: shaped(error.code, CODE_SHAPE) ?? UNNAMED_FAILURE_CODE,
          type: error.type,
          message: redactor.text(error.message),
          param: 'param' in error ? shaped(error.param, PARAM_SHAPE) : null,
        },
      },
    };
    upstreamCodes.set(rebuilt, error.code);
    return rebuilt as unknown as StreamEvent;
  };

  const converting = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      throw guardedError(error);
    }
  };

  const convertingSync = <T>(step: () => T): T => {
    try {
      return step();
    } catch (error) {
      throw guardedError(error);
    }
  };

  const guardedIterator = (source: AsyncIterator<StreamEvent>): AsyncIterator<StreamEvent> => {
    const { return: sourceReturn, throw: sourceThrow } = source;
    return {
      next: async (...args) => {
        const result = await converting(() => source.next(...args));
        return result.done === true ? result : { done: false, value: guardedEvent(result.value) };
      },
      return: async (value) =>
        sourceReturn === undefined ? { done: true, value } : converting(() => sourceReturn.call(source, value)),
      ...(sourceThrow === undefined ? {} : { throw: (reason: unknown) => converting(() => sourceThrow.call(source, reason)) }),
    };
  };

  const { countTokens, countWire, compact, renderWire, renderCompactWire, health, close } = inner;

  const guardedHealth = (check: NonNullable<ProviderAdapter['health']>) => async (target: AdapterTarget): Promise<HealthResult> => {
    try {
      const result = await check.call(inner, target);
      return {
        ...result,
        ...(result.detail === undefined ? {} : { detail: redactor.text(result.detail) }),
        ...(result.remediation === undefined ? {} : { remediation: redactor.text(result.remediation) }),
      };
    } catch (error) {
      return { ok: false, reason: 'health_check_failed', detail: redactor.text(messageOf(error)) };
    }
  };

  return {
    kind: inner.kind,
    capabilities: (target) => converting(() => inner.capabilities(target)),
    create: (request, ctx) => {
      const source = convertingSync(() => inner.create(request, ctx));
      return { [Symbol.asyncIterator]: () => guardedIterator(convertingSync(() => source[Symbol.asyncIterator]())) };
    },
    classify,
    ...(countTokens === undefined ? {} : { countTokens: (request, ctx) => converting(() => countTokens.call(inner, request, ctx)) }),
    ...(countWire === undefined ? {} : { countWire: (wire, ctx) => converting(() => countWire.call(inner, wire, ctx)) }),
    ...(compact === undefined ? {} : { compact: (request, ctx) => converting(() => compact.call(inner, request, ctx)) }),
    ...(renderWire === undefined ? {} : { renderWire: (request, target, options) => convertingSync(() => renderWire.call(inner, request, target, options)) }),
    ...(renderCompactWire === undefined
      ? {}
      : { renderCompactWire: (request, target, cap) => convertingSync(() => renderCompactWire.call(inner, request, target, cap)) }),
    ...(health === undefined ? {} : { health: guardedHealth(health) }),
    ...(close === undefined ? {} : { close: () => close.call(inner) }),
    [guardBrand]: true,
  };
};
