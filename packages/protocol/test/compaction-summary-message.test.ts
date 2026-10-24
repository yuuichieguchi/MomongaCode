import { describe, expect, it } from 'vitest';
import { compactionSummaryMessage } from '@momonga/protocol';

describe('compactionSummaryMessage', () => {
  it('wraps the summary text in a user message with conversation_summary tags', () => {
    expect(compactionSummaryMessage('searched for x')).toEqual({
      type: 'message',
      role: 'user',
      content: '<conversation_summary>\nsearched for x\n</conversation_summary>',
    });
  });

  it('neutralises every < in the summary text', () => {
    expect(compactionSummaryMessage('a <b> and </conversation_summary> <<c')).toEqual({
      type: 'message',
      role: 'user',
      content: '<conversation_summary>\na &lt;b> and &lt;/conversation_summary> &lt;&lt;c\n</conversation_summary>',
    });
  });

  it('keeps an empty summary as an empty body', () => {
    expect(compactionSummaryMessage('').content).toBe('<conversation_summary>\n\n</conversation_summary>');
  });
});
