import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, WORKING_STATE_MESSAGE_MIN_TOKENS, textOfContent, workingStateMessage } from '@momonga/context';
import { MIN_SUMMARY_TOKENS, summaryItemTokensFor, tokensForText } from '@momonga/protocol';

const MIN_ITEM_TOKENS = 64;

describe('MIN_ROOM_TOKENS', () => {
  it('is one item, the summary item of the smallest summary, and the smallest working-state message', () => {
    expect(MIN_ROOM_TOKENS).toBe(MIN_ITEM_TOKENS + summaryItemTokensFor(MIN_SUMMARY_TOKENS) + WORKING_STATE_MESSAGE_MIN_TOKENS);
  });

  it('holds the post-compaction state of a run that passes the room check', () => {
    expect(MIN_ROOM_TOKENS).toBeGreaterThanOrEqual(198);
  });

  it('counts the framing and the tags of the working-state message, not only its lines', () => {
    const empty = tokensForText(textOfContent(workingStateMessage('').content));
    expect(WORKING_STATE_MESSAGE_MIN_TOKENS).toBeGreaterThan(empty);
  });
});
