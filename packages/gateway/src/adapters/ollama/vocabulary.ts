import { CONTEXT_OVERFLOW_WORDING, upstreamErrorText } from '../chat-completions/vocabulary.ts';
import { HTTP_TRANSPORT_VOCABULARY } from '../shared/vocabulary.ts';
import type { ErrorVocabulary } from '../shared/vocabulary.ts';

export const ollamaErrorText = (body: unknown): string | undefined => upstreamErrorText(body);

export const OLLAMA_VOCABULARY: ErrorVocabulary = {
  kindOf: (status, body) => {
    const text = ollamaErrorText(body);
    if (text !== undefined && CONTEXT_OVERFLOW_WORDING.test(text)) return 'context_overflow';
    return HTTP_TRANSPORT_VOCABULARY.kindOf(status, body);
  },
};
