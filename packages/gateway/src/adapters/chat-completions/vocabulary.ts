import { FM_SCHEMA_DIALECT } from '../../probe/schema-dialect.ts';
import { isRecord } from '@momonga/foundation';
import { transportKindOf } from '../shared/vocabulary.ts';
import type { ErrorVocabulary } from '../shared/vocabulary.ts';

const HTTP_ERROR_FROM = 400;
const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';
export const CONTEXT_OVERFLOW_WORDING = /\bcontext (?:length|size|window)\b/i;
const FM_CONTEXT_OVERFLOW_MESSAGE = "The session's transcript exceeded the model's context size.";
const FM_GUARDRAIL_MESSAGE = "The model's safety guardrails were triggered.";
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

export const CHAT_COMPLETIONS_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    const message = upstreamErrorText(body);
    if (errorObjectOf(body)?.['code'] === CONTEXT_OVERFLOW_CODE || (message !== undefined && CONTEXT_OVERFLOW_WORDING.test(message))) return 'context_overflow';
    return transportKindOf(status);
  },
};

export const FM_VOCABULARY: ErrorVocabulary = {
  schemaDialect: FM_SCHEMA_DIALECT,
  kindOf: (status, body) => {
    const message = upstreamErrorText(body);
    if (message === FM_GUARDRAIL_MESSAGE) return 'guardrail';
    if (message === FM_CONTEXT_OVERFLOW_MESSAGE) return 'context_overflow';
    if (message === FM_UNSUPPORTED_GUIDE_MESSAGE) return 'unsupported';
    return status >= HTTP_ERROR_FROM ? transportKindOf(status) : 'failure';
  },
};

export const withGuardrailMatcher = (vocabulary: ErrorVocabulary, isGuardrail: (status: number, body: unknown) => boolean): ErrorVocabulary => ({
  kindOf: (status, body) => {
    const kind = vocabulary.kindOf(status, body);
    if (kind === 'context_overflow' || kind === 'guardrail') return kind;
    return isGuardrail(status, body) ? 'guardrail' : kind;
  },
});
