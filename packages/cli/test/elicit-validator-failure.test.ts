import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { decide, enterValue, startFlow } from '../src/elicit/flow.ts';

const THROWING_FORM: ElicitationRequestView = {
  key: 'profile',
  mode: 'form',
  message: 'Tell me about you',
  requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, if: { anyOf: [{ properties: { a: {} } }], not: {} }, then: false },
};

describe('elicitation flow with a requestedSchema whose validator throws', () => {
  it('answers decline for the request instead of accepting unchecked content or throwing the engine error', () => {
    const flow = decide(enterValue(startFlow([THROWING_FORM]), 'Ada'), 'accept');
    expect(flow.complete).toBe(true);
    expect(flow.answers).toEqual({ profile: { action: 'decline' } });
  });
});
