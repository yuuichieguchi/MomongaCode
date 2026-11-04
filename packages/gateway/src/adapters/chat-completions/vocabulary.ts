import { isRecord } from '@momonga/foundation';

export type UpstreamErrorKind = 'context_overflow' | 'unsupported' | 'failure';

export type ErrorVocabulary = {
  readonly kindOf: (status: number, body: unknown) => UpstreamErrorKind;
};

const HTTP_ERROR_FROM = 400;
const BAD_REQUEST_STATUS = 400;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';
const CONTEXT_OVERFLOW_WORDING = /\bcontext (?:length|size|window)\b/i;
const FM_CONTEXT_OVERFLOW_MESSAGE = "The session's transcript exceeded the model's context size.";
const FM_UNSUPPORTED_GUIDE_MESSAGE = 'An unsupported generation guide was used.';

const errorOf = (body: unknown): Record<string, unknown> | undefined => {
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) ? error : undefined;
};

const transportKindOf = (status: number): UpstreamErrorKind => {
  if (status === PAYLOAD_TOO_LARGE_STATUS) return 'context_overflow';
  return status === BAD_REQUEST_STATUS ? 'unsupported' : 'failure';
};

export const CHAT_COMPLETIONS_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    if (status === PAYLOAD_TOO_LARGE_STATUS) return 'context_overflow';
    const { code, message } = errorOf(body) ?? {};
    if (code === CONTEXT_OVERFLOW_CODE || (typeof message === 'string' && CONTEXT_OVERFLOW_WORDING.test(message))) return 'context_overflow';
    return transportKindOf(status);
  },
};

export const FM_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    if (status >= HTTP_ERROR_FROM) return transportKindOf(status);
    const message = errorOf(body)?.['message'];
    if (message === FM_CONTEXT_OVERFLOW_MESSAGE) return 'context_overflow';
    return message === FM_UNSUPPORTED_GUIDE_MESSAGE ? 'unsupported' : 'failure';
  },
};
