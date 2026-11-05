export type UpstreamErrorKind = 'guardrail' | 'context_overflow' | 'payload_too_large' | 'unsupported' | 'failure';

export type ErrorVocabulary = {
  readonly kindOf: (status: number, body: unknown) => UpstreamErrorKind;
};

const BAD_REQUEST_STATUS = 400;
const PAYLOAD_TOO_LARGE_STATUS = 413;

export const transportKindOf = (status: number): UpstreamErrorKind => {
  if (status === PAYLOAD_TOO_LARGE_STATUS) return 'payload_too_large';
  return status === BAD_REQUEST_STATUS ? 'unsupported' : 'failure';
};

export const HTTP_TRANSPORT_VOCABULARY: ErrorVocabulary = { kindOf: (status) => transportKindOf(status) };
