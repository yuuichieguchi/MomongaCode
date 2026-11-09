import { describe, expect, it } from 'vitest';
import { parsePolicyOverlay } from '../src/context-policy.ts';

describe('context.unboundedOutputReserve is a token policy overlay key (P2 item 7, token design rule 3)', () => {
  it('accepts the overlay the token gate runs with', () => {
    expect(parsePolicyOverlay('{"context":{"unboundedOutputReserve":true}}', 'policy.json')).toEqual({ context: { unboundedOutputReserve: true } });
  });
});
