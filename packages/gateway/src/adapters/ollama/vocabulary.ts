import { isRecord } from '@momonga/foundation';
import { CONTEXT_OVERFLOW_WORDING, HTTP_TRANSPORT_VOCABULARY } from '../chat-completions/vocabulary.ts';
import type { ErrorVocabulary } from '../chat-completions/vocabulary.ts';

export const ollamaErrorText = (body: unknown): string | undefined => {
  const error = isRecord(body) ? body['error'] : undefined;
  return typeof error === 'string' ? error : undefined;
};

export const OLLAMA_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    const text = ollamaErrorText(body);
    if (text !== undefined && CONTEXT_OVERFLOW_WORDING.test(text)) return 'context_overflow';
    return HTTP_TRANSPORT_VOCABULARY.kindOf(status, body);
  },
};
