import { describe, expect, it } from 'vitest';
import { compactionSummaryMessage } from '@momonga/protocol';
import { summaryMessageOf } from '../src/adapters/chat-completions/plain-history.ts';

const BOUNDARY = 'b'.repeat(32);

describe('summaryMessageOf', () => {
  it.each(['plain text', 'with <markup> and </conversation_summary>', '', 'multi\nline <<'])('renders the same user message as the model-framed compactionSummaryMessage for %j', (text) => {
    const shared = compactionSummaryMessage(text, 'model', BOUNDARY);
    expect(summaryMessageOf(text, BOUNDARY)).toEqual({ role: shared.role, content: shared.content });
  });
});
