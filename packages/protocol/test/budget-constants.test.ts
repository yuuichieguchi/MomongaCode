import { describe, expect, it } from 'vitest';
import { SUMMARY_ITEM_OVERHEAD, compactionSummaryMessage, tokensForText } from '@momonga/protocol';

const emptyTokens = (origin: 'model' | 'code'): number => tokensForText(String(compactionSummaryMessage('', origin).content));

describe('SUMMARY_ITEM_OVERHEAD', () => {
  it('is the token estimate of the larger empty framed summary message', () => {
    expect(SUMMARY_ITEM_OVERHEAD).toBe(Math.max(emptyTokens('model'), emptyTokens('code')));
  });

  it('counts the framing sentence, so it exceeds the bare wrapper of 20', () => {
    expect(SUMMARY_ITEM_OVERHEAD).toBeGreaterThan(20);
  });
});
