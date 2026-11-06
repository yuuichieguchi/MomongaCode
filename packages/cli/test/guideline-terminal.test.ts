import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { responseResource } from '@momonga/testkit';
import { jsonReplyOf } from '@momonga/protocol';
import { ContextImproveError, terminalResponseOf } from '../src/commands/context.ts';

const resource = (status: 'completed' | 'incomplete', reason?: string) => ({
  ...responseResource({ id: 'resp_1', model: 'm', status }),
  incomplete_details: reason === undefined ? null : { reason },
});

describe('the terminal of a guideline completion', () => {
  it('returns a completed response with no incomplete reason', () => {
    const response = resource('completed');
    const terminal = terminalResponseOf([{ type: 'response.completed', sequence_number: 1, response } as StreamEvent]);
    expect(terminal).toBe(response);
    expect(jsonReplyOf(terminal).incomplete).toBeUndefined();
  });

  it('returns an incomplete response with its reason instead of ending the command', () => {
    const response = resource('incomplete', 'max_output_tokens');
    const terminal = terminalResponseOf([{ type: 'response.incomplete', sequence_number: 1, response } as StreamEvent]);
    expect(terminal).toBe(response);
    expect(jsonReplyOf(terminal).incomplete).toBe('max_output_tokens');
  });

  it('still fails the command when the call failed or the stream ended without a terminal event', () => {
    expect(() => terminalResponseOf([])).toThrow(ContextImproveError);
  });
});
