import { CONTEXT_OVERFLOW_WORDING, HTTP_TRANSPORT_VOCABULARY, upstreamErrorText } from '../chat-completions/vocabulary.ts';
import type { ErrorVocabulary } from '../chat-completions/vocabulary.ts';

export const ollamaErrorText = (body: unknown): string | undefined => upstreamErrorText(body);

export const OLLAMA_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    const text = ollamaErrorText(body);
    if (text !== undefined && CONTEXT_OVERFLOW_WORDING.test(text)) return 'context_overflow';
    return HTTP_TRANSPORT_VOCABULARY.kindOf(status, body);
  },
};
