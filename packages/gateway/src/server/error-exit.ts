import { ClientDisconnectedError, GatewayError } from '../core/errors.ts';
import type { StreamEvent } from '@momonga/protocol';
import { redactedError, redactedEvent, redactedGatewayError } from '../core/guarded-adapter.ts';
import type { Redactor } from '../core/redaction.ts';

export type ErrorExit = {
  shown(error: unknown): unknown;
  shownEvent(event: StreamEvent): StreamEvent;
  shownFrom(source: AsyncIterator<StreamEvent>): AsyncIterator<StreamEvent>;
  report(error: unknown): void;
  answer(error: unknown): GatewayError;
};

export const createErrorExit = (redactor: Redactor, onError: ((error: unknown) => void) | undefined): ErrorExit => {
  const shown = (error: unknown): unknown => {
    if (error instanceof ClientDisconnectedError) return error;
    return error instanceof GatewayError ? redactedGatewayError(redactor, error) : redactedError(redactor, error);
  };
  const shownEvent = (event: StreamEvent): StreamEvent => redactedEvent(redactor, event);
  const report = (error: unknown): void => onError?.(shown(error));
  return {
    shown,
    shownEvent,
    shownFrom: (source) => {
      const { return: sourceReturn } = source;
      return {
        next: async () => {
          try {
            const step = await source.next();
            return step.done === true ? step : { done: false, value: shownEvent(step.value) };
          } catch (error) {
            throw shown(error);
          }
        },
        ...(sourceReturn === undefined ? {} : { return: (value) => sourceReturn.call(source, value) }),
      };
    },
    report,
    answer: (error) => {
      if (error instanceof GatewayError) return redactedGatewayError(redactor, error);
      report(error);
      return new GatewayError({ status: 500, type: 'server_error', code: 'internal_error', message: redactedError(redactor, error).message });
    },
  };
};
