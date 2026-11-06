import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { responseResource } from '@momonga/testkit';
import { ContextImproveError, terminalResponseOf } from '../src/commands/context.ts';

const resource = (status: 'completed' | 'incomplete', reason?: string) => ({
  ...responseResource({ id: 'resp_1', model: 'm', status }),
  incomplete_details: reason === undefined ? null : { reason },
});

describe('the terminal of a guideline completion', () => {
  it('returns a completed response with no incomplete reason', () => {
    const response = resource('completed');
    expect(terminalResponseOf([{ type: 'response.completed', sequence_number: 1, response } as StreamEvent])).toEqual({ response, incomplete: undefined });
  });

  it('returns an incomplete response with its reason instead of ending the command', () => {
    const response = resource('incomplete', 'max_output_tokens');
    expect(terminalResponseOf([{ type: 'response.incomplete', sequence_number: 1, response } as StreamEvent])).toEqual({ response, incomplete: 'max_output_tokens' });
  });

  it('still fails the command when the call failed or the stream ended without a terminal event', () => {
    expect(() => terminalResponseOf([])).toThrow(ContextImproveError);
  });
});
