import { describe, expect, it } from 'vitest';
import { compactionSummaryMessage } from '@momonga/protocol';
import { summaryMessageOf } from '../src/adapters/chat-completions/plain-history.ts';

describe('summaryMessageOf', () => {
  it.each(['plain text', 'with <markup> and </conversation_summary>', '', 'multi\nline <<'])('renders the same user message as compactionSummaryMessage for %j', (text) => {
    const shared = compactionSummaryMessage(text);
    expect(summaryMessageOf(text)).toEqual({ role: shared.role, content: shared.content });
  });
});
