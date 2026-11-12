import { describe, expect, it } from 'vitest';
import { parsePolicyOverlay } from '../src/context-policy.ts';

describe('context.unboundedOutputReserve is a token policy overlay key (P2 item 7, token design rule 3)', () => {
  it('accepts the overlay that turns it off and refuses one that restates its default', () => {
    expect(parsePolicyOverlay('{"context":{"unboundedOutputReserve":false}}', 'policy.json')).toEqual({ context: { unboundedOutputReserve: false } });
    expect(() => parsePolicyOverlay('{"context":{"unboundedOutputReserve":true}}', 'policy.json')).toThrow(/context\.unboundedOutputReserve restates its default/);
  });
});
