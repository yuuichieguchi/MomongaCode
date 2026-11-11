import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR, floorRatio, tokensForText } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { lowerBoundTokens } from '@momonga/store';

const MARKER_FLOOR_TOKENS = 30;

const outputOf = (output: string): InputItem => ({ type: 'function_call_output', call_id: 'c1', output });

const discounted = (tokens: number): number => floorRatio({ num: ESTIMATED_ERROR.den, den: ESTIMATED_ERROR.den + ESTIMATED_ERROR.num }, tokens);

describe('the floor of a tool output in an inherited history is the shortest form the builder can render for it', () => {
  it.each(['', 'ok', 'one line of output from the tool'])('bounds the output %j from below by its own size when that is under the size of the marker', (output) => {
    const bound = lowerBoundTokens(outputOf(output), MARKER_FLOOR_TOKENS);

    expect(bound).toBeLessThanOrEqual(Math.max(1, Math.min(MARKER_FLOOR_TOKENS, tokensForText(output))));
    expect(bound).toBe(Math.max(1, Math.min(MARKER_FLOOR_TOKENS, discounted(tokensForText(output)))));
  });

  it('bounds a long output by the size of the marker it can be replaced with', () => {
    expect(lowerBoundTokens(outputOf('x'.repeat(10_000)), MARKER_FLOOR_TOKENS)).toBe(MARKER_FLOOR_TOKENS);
  });
});
