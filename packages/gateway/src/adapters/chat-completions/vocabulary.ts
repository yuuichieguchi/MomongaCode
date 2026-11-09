import { isRecord } from '@momonga/foundation';
import { transportKindOf } from '../shared/vocabulary.ts';
import type { ErrorVocabulary } from '../shared/vocabulary.ts';
import type { ManagedServerDescription } from '@momonga/protocol';

const HTTP_ERROR_FROM = 400;
const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';
export const CONTEXT_OVERFLOW_WORDING = /\bcontext (?:length|size|window)\b/i;

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

export const vocabularyOf = (description: Pick<ManagedServerDescription, 'errors'>): ErrorVocabulary => ({
  kindOf: (status, body) => {
    const message = upstreamErrorText(body);
    const known = description.errors.find((entry) => entry.message === message);
    if (known !== undefined) return known.kind;
    return status >= HTTP_ERROR_FROM ? transportKindOf(status) : 'failure';
  },
});

export const withGuardrailMatcher = (vocabulary: ErrorVocabulary, isGuardrail: (status: number, body: unknown) => boolean): ErrorVocabulary => ({
  kindOf: (status, body) => {
    const kind = vocabulary.kindOf(status, body);
    if (kind === 'context_overflow' || kind === 'guardrail') return kind;
    return isGuardrail(status, body) ? 'guardrail' : kind;
  },
});
