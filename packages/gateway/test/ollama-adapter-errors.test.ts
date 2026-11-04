import { describe, expect, it } from 'vitest';
import { OLLAMA_VOCABULARY } from '@momonga/gateway';
import {
  OLLAMA_MODEL,
  PLACEHOLDER_CONTEXT_OVERFLOW,
  PLACEHOLDER_MODEL_NOT_FOUND,
  PLACEHOLDER_UNSUPPORTED,
  collectOllama,
  makeOllamaAdapter,
  startFakeOllama,
} from './ollama-support.ts';

const request = { model: OLLAMA_MODEL, input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }], max_output_tokens: 300 };

const classifiedReply = async (reply: { status: number; body: unknown }) => {
  const fake = await startFakeOllama({ chat: [{ kind: 'error', ...reply }] });
  const adapter = makeOllamaAdapter(fake);
  const { events, error } = await collectOllama(adapter, request);
  expect(events).toEqual([]);
  expect(error).toBeDefined();
  return adapter.classify(error);
};

describe('OLLAMA_VOCABULARY, in the ErrorVocabulary form', () => {
  it('classifies a model that is not pulled as a failure', () => {
    expect(OLLAMA_VOCABULARY.kindOf(PLACEHOLDER_MODEL_NOT_FOUND.status, PLACEHOLDER_MODEL_NOT_FOUND.body)).toBe('failure');
  });

  it('classifies the context overflow text as context_overflow', () => {
    expect(OLLAMA_VOCABULARY.kindOf(PLACEHOLDER_CONTEXT_OVERFLOW.status, PLACEHOLDER_CONTEXT_OVERFLOW.body)).toBe('context_overflow');
  });

  it('classifies the unsupported-feature text as unsupported', () => {
    expect(OLLAMA_VOCABULARY.kindOf(PLACEHOLDER_UNSUPPORTED.status, PLACEHOLDER_UNSUPPORTED.body)).toBe('unsupported');
  });
});

describe('ollama errors through the adapter', () => {
  it('fails a request for a model that is not pulled with a message that names ollama pull and the tag', async () => {
    const classified = await classifiedReply(PLACEHOLDER_MODEL_NOT_FOUND);
    expect(classified.retryable).toBe(false);
    expect(classified.error.message).toContain(`ollama pull ${OLLAMA_MODEL}`);
  });

  it('decodes a context overflow as context_window_exceeded', async () => {
    const classified = await classifiedReply(PLACEHOLDER_CONTEXT_OVERFLOW);
    expect(classified).toMatchObject({ retryable: false, error: { type: 'invalid_request', code: 'context_window_exceeded' } });
  });

  it('decodes an unsupported feature as unsupported_request', async () => {
    const classified = await classifiedReply(PLACEHOLDER_UNSUPPORTED);
    expect(classified).toMatchObject({ retryable: false, error: { type: 'invalid_request', code: 'unsupported_request' } });
  });
});
