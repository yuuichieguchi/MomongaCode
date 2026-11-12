import { describe, expect, it } from 'vitest';
import { MOMONGA_ATTRIBUTES, SPAN_ATTRIBUTE_RENAMES, withCurrentNames } from '@momonga/protocol';
import { createRequestValidator } from '../../src/core/validation.ts';

const input = [{ type: 'message', role: 'user', content: 'hi' }];

describe('the wire names of the gateway extensions', () => {
  it('the retry link is momonga.retry_of_seq', () => {
    expect(MOMONGA_ATTRIBUTES.retryOf).toBe('momonga.retry_of_seq');
    expect(withCurrentNames({ 'momonga.retry_of': 4 }, SPAN_ATTRIBUTE_RENAMES)).toEqual({ 'momonga.retry_of_seq': 4 });
  });

  it('momonga.max_cost_nano is read and the design-text spelling is refused with its path', () => {
    const validator = createRequestValidator();
    expect(() => validator.parseCreate({ model: 'm', input, momonga: { max_cost_nano: 10, max_input_tokens: 100 } })).not.toThrow();
    expect(() => validator.parseCreate({ model: 'm', input, momonga: { maxCostNano: 10 } })).toThrow(/momonga\.maxCostNano/);
  });
});
