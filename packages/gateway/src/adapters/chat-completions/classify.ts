import { createUpstreamClassifier } from '../shared/classify.ts';

export const classifyChatCompletionsError = createUpstreamClassifier('chat-completions');

export const matchesGuardrailCode = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return (error as Record<string, unknown>)['code'] === 'guardrail_violation';
};

const PAYLOAD_TOO_LARGE_STATUS = 413;
const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';
const CONTEXT_OVERFLOW_WORDING = /\bcontext (?:length|size|window)\b/i;

export const matchesContextOverflow = (status: number, body: unknown): boolean => {
  if (status === PAYLOAD_TOO_LARGE_STATUS) return true;
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as Record<string, unknown>;
  return code === CONTEXT_OVERFLOW_CODE || (typeof message === 'string' && CONTEXT_OVERFLOW_WORDING.test(message));
};
