import { isRecord } from '@momonga/foundation';
import type { ErrorVerdicts } from '../shared/http-error.ts';

export type UpstreamErrorKind = 'context_overflow' | 'unsupported' | 'failure';

export type ErrorVocabulary = {
  readonly kindOf: (status: number, body: unknown) => UpstreamErrorKind;
};

const HTTP_ERROR_FROM = 400;
const BAD_REQUEST_STATUS = 400;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';
export const CONTEXT_OVERFLOW_WORDING = /\bcontext (?:length|size|window)\b/i;
const FM_CONTEXT_OVERFLOW_MESSAGE = "The session's transcript exceeded the model's context size.";
const FM_UNSUPPORTED_GUIDE_MESSAGE = 'An unsupported generation guide was used.';

export const errorObjectOf = (body: unknown): Record<string, unknown> | undefined => {
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) ? error : undefined;
};

export const upstreamErrorText = (body: unknown): string | undefined => {
  const error = isRecord(body) ? body['error'] : undefined;
  if (typeof error === 'string') return error;
  const message = isRecord(error) ? error['message'] : undefined;
  return typeof message === 'string' ? message : undefined;
};

const transportKindOf = (status: number): UpstreamErrorKind => {
  if (status === PAYLOAD_TOO_LARGE_STATUS) return 'context_overflow';
  return status === BAD_REQUEST_STATUS ? 'unsupported' : 'failure';
};

export const CHAT_COMPLETIONS_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    if (status === PAYLOAD_TOO_LARGE_STATUS) return 'context_overflow';
    const message = upstreamErrorText(body);
    if (errorObjectOf(body)?.['code'] === CONTEXT_OVERFLOW_CODE || (message !== undefined && CONTEXT_OVERFLOW_WORDING.test(message))) return 'context_overflow';
    return transportKindOf(status);
  },
};

export const FM_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    if (status >= HTTP_ERROR_FROM) return transportKindOf(status);
    const message = upstreamErrorText(body);
    if (message === FM_CONTEXT_OVERFLOW_MESSAGE) return 'context_overflow';
    return message === FM_UNSUPPORTED_GUIDE_MESSAGE ? 'unsupported' : 'failure';
  },
};

export const HTTP_TRANSPORT_VOCABULARY: ErrorVocabulary = { kindOf: (status) => transportKindOf(status) };

export const verdictsOf = (vocabulary: ErrorVocabulary, guardrail: ErrorVerdicts['guardrail']): ErrorVerdicts => ({
  guardrail,
  contextOverflow: (status, body) => vocabulary.kindOf(status, body) === 'context_overflow',
  unsupported: (status, body) => vocabulary.kindOf(status, body) === 'unsupported',
});
