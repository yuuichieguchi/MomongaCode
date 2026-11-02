import { createUpstreamClassifier } from '../shared/classify.ts';

export const classifyChatCompletionsError = createUpstreamClassifier('chat-completions');

export const matchesGuardrailCode = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return (error as Record<string, unknown>)['code'] === 'guardrail_violation';
};
