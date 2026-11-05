import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import type { AdapterCompactRequest, AdapterInputItem, ToolCallingMode } from '@momonga/protocol';
import { TARGET, completionBodies, lastCompletionBody, startFake, userText } from './cc-support.ts';
import {
  RESTATE_CLAUSE,
  TRANSCRIPT_TAIL,
  callReply,
  ccAdapterFor,
  emptyReply,
  instructionsFor,
  lengthReply,
  textReply,
} from './cc-compact-support.ts';

const ctx = { signal: new AbortController().signal, target: TARGET, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN };

const conversation: AdapterInputItem[] = [
  userText('Fix the parser bug'),
  { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"src/parse.ts"}' },
  { type: 'function_call_output', call_id: 'c1', output: 'export const parse = 1;' },
];

const compactRequest = (overrides: Partial<AdapterCompactRequest> = {}): AdapterCompactRequest => ({
  model: 'system',
  input: conversation,
  ...overrides,
});

describe('chat-completions adapter compact', () => {
  it('classifies a content_filter outcome as non-retryable content_filter', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'part' } }, { delta: {}, finishReason: 'content_filter' }] }],
    });
    const adapter = ccAdapterFor(fake);
    const failure = await adapter.compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(adapter.classify(failure).error.code).toBe('content_filter');
    expect(adapter.classify(failure).retryable).toBe(false);
  });

  it.for(['native', 'constrained', 'none'] as const)(
    'sends one system and one user message, no tools or response_format, max_completion_tokens = cap and stream for a %s target',
    async (mode: ToolCallingMode) => {
      const fake = await startFake({ scenario: 'tools-ok', script: [textReply('The user wants the parser fixed.')] });
      const adapter = ccAdapterFor(fake, mode);
      expect(adapter.compact).toBeTypeOf('function');
      const result = await adapter.compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx);
      expect(result?.summary).toBe('The user wants the parser fixed.');
      const body = lastCompletionBody(fake);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toEqual({ role: 'system', content: instructionsFor(64, RESTATE_CLAUSE) });
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content.startsWith('<transcript>')).toBe(true);
      expect(body.messages[1].content.endsWith(TRANSCRIPT_TAIL)).toBe(true);
      expect('tools' in body).toBe(false);
      expect('tool_choice' in body).toBe(false);
      expect('response_format' in body).toBe(false);
      expect(body.max_completion_tokens).toBe(64);
      expect(body.stream).toBe(true);
    },
  );

  it('reports the upstream usage of the summary call', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [textReply('note', { prompt_tokens: 321, completion_tokens: 7, total_tokens: 328 })],
    });
    const result = await ccAdapterFor(fake).compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx);
    expect(result?.usage).toMatchObject({ input_tokens: 321, output_tokens: 7, total_tokens: 328 });
  });

  it('falls back to the window cap of the target without momonga.max_summary_tokens', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('note')] });
    await ccAdapterFor(fake).compact?.(compactRequest(), ctx);
    expect(lastCompletionBody(fake).max_completion_tokens).toBe(246);
  });

  it.for([
    ['finish_reason length', lengthReply('cut off'), 'compaction_summary_too_long', false],
    ['a reply above ceil(1.3 cap) tokens', textReply('w'.repeat(4 * 84 + 4)), 'compaction_summary_too_long', false],
    ['an empty reply', emptyReply(), 'compaction_invalid_reply', true],
    ['a whitespace reply', textReply('   \n '), 'compaction_invalid_reply', true],
    ['a reply with a function call', callReply(), 'compaction_invalid_reply', true],
  ] as const)('rejects %s as %s with retryable %s', async ([, reply, code, retryable]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [reply] });
    const adapter = ccAdapterFor(fake);
    const failure = await adapter.compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    const classified = adapter.classify(failure);
    expect(classified.error.code).toBe(code);
    expect(classified.retryable).toBe(retryable);
    expect(completionBodies(fake)).toHaveLength(1);
  });

  it('accepts a reply exactly at the acceptance bound ceil(1.3 cap)', async () => {
    const atBound = 'w'.repeat(4 * 84);
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(atBound)] });
    const result = await ccAdapterFor(fake).compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx);
    expect(result?.summary).toBe(atBound);
  });

  it('lets classify see an upstream 500 as a retryable server error', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status: 500, body: { error: { message: 'boom', type: 'server_error', param: null, code: null } } }],
    });
    const adapter = ccAdapterFor(fake);
    const failure = await adapter.compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    const classified = adapter.classify(failure);
    expect(classified.retryable).toBe(true);
    expect(classified.error.type).toBe('server_error');
  });

  it('lets classify see a stream that ends without a finish reason as a typed upstream failure', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'partial' } }], done: false }],
    });
    const adapter = ccAdapterFor(fake);
    const failure = await adapter.compact?.(compactRequest({ momonga: { max_summary_tokens: 64 } }), ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(adapter.classify(failure).error.code).toBe('upstream_protocol_error');
    expect(adapter.classify(failure).retryable).toBe(true);
  });
});
